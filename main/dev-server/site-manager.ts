import path from 'node:path';
import {
    ROLE_LABEL,
    SITE_LABEL,
    SITE_ROLE,
    WORKSPACE_LABEL,
    siteContainerNameFor,
    workspaceSlugFor,
} from './argv';
import { GENIE_DEV_BASE_IMAGE, WORKSPACE_MOUNT_TARGET } from './images';
import { DEFAULT_READY_TIMEOUT_MS, waitForHttp, waitForPort } from './port-probe';
import { planHostAllowlist } from './host-allowlist';
import { resolveSiteRun } from './site-def';
import { ensureWorkspaceSandbox } from './workspace-sandbox';
import type { ContainerRuntime, RuntimeDetection } from './container-runtime';
import type { HostIds } from './host-ids';
import type { DevSiteConfig, DevSites } from './sites-config';
import type { ImagePullConsent } from './workspace-sandbox';

/**
 * The DEV SITE MANAGER (Tynn #234, P2 items 3 + 4) — "this workspace defines a
 * site" becomes "a container is serving it, and the Genie Browser routes there".
 *
 * ## The whole phase, in one object
 *
 * {@link DevSiteManager.genSites} returns rows that are structurally
 * `EnabledGenSite` — the SAME shape `sites/local-sites.ts` already overlays,
 * `localTargetsBySiteId` already keys by `siteId`, and the local carrier already
 * dials. So routing a container to `https://web.acme.gen` required no new
 * resolution path, no proxy, and no change to the Testing Browser: a running
 * site is a row whose `port` is the container's PUBLISHED LOOPBACK port, and
 * everything downstream was already built to carry it. That is what "salvage the
 * beta.218 seam" meant, and it is why this file is small.
 *
 * It also makes local and remote the same code. A remote client reads the host's
 * `/api/sites/enabled`, which is that same aggregation — so a container dev
 * server is reachable from another machine the moment it is reachable from this
 * one, with nothing added here.
 *
 * ## Why a site gets its own container
 *
 * See `argv.ts#siteContainerNameFor`. Short version: a published port is fixed
 * at container CREATE time, so a dev server exec'd into the long-lived workspace
 * dev container could never be dialled from the host. The site container joins
 * the workspace's network, mounts the workspace at the same target and carries
 * the workspace label — it IS in the sandbox — and its lifecycle maps one-to-one
 * onto container verbs.
 *
 * ## Failures are STATUSES
 *
 * The same house rule as `hosting/manager.ts`, and for a stronger reason: this
 * is driven by an MCP agent, and an exception crossing that boundary becomes a
 * tool error with no state attached. Every outcome here is a
 * {@link DevSiteStatus} carrying enough to act on — including `ready`, which is
 * deliberately separate from `state`, because a container that is up and a dev
 * server that has bound its port are different events (see `port-probe.ts`).
 */

// --- what a caller sees -----------------------------------------------------

export type DevSiteState = 'running' | 'stopped' | 'failed';

export interface DevSiteStatus {
    siteId: string;
    workspaceId: string;
    name: string;
    genName: string;
    state: DevSiteState;
    /** True when the published port accepted a connection. Only meaningful
     *  while `state` is `running`. */
    ready?: boolean;
    containerId?: string;
    /** The loopback port the runtime published. */
    hostPort?: number;
    /** The routable origin through the Genie Browser (`http` sites only). */
    origin?: string;
    /** The direct loopback origin — what a local browser or curl can hit. */
    localOrigin?: string;
    error?: string;
}

/** One configured site plus whatever is currently true about it. */
export interface DevSiteRow extends DevSiteStatus {
    repo: string;
    runMode: DevSiteConfig['runMode'];
    kind: DevSiteConfig['kind'];
    enabled: boolean;
    command?: string[];
    port?: number;
    image?: string;
}

/** A running site as the Testing Browser reads it. Structurally the
 *  `EnabledGenSite` of `main/remote`, rebuilt here so this module does not
 *  depend on the remote stack (exactly as `hosting/manager.ts` does). */
export interface DevGenSite {
    workspaceId: string;
    genName: string;
    siteId: string;
    hostname: string;
    scheme: 'http' | 'https';
    port: number;
    loopback?: '127.0.0.1' | '::1';
}

// --- deps -------------------------------------------------------------------

export interface DevWorkspace {
    id: string;
    /** The workspace root on disk — what gets bind-mounted. */
    path: string;
    /** Human name, used for the default `<site>.<workspace>.gen`. */
    label?: string;
}

export interface ResolvedRuntimeLike {
    runtime: ContainerRuntime | null;
    detection: RuntimeDetection;
}

export interface DevSiteManagerDeps {
    /**
     * Which runtime, and is it usable.
     *
     * Called per action rather than resolved once: a user who installs Docker,
     * or starts Docker Desktop, must not have to restart Genie for a site to
     * start working.
     */
    resolveRuntime: () => Promise<ResolvedRuntimeLike>;
    listWorkspaces: () => DevWorkspace[];
    devSitesFor: (workspaceId: string) => DevSites;
    platform?: NodeJS.Platform | string;
    /** The workspace dev image a site runs in when it brings no image. */
    image?: string;
    mountTarget?: string;
    hostIds?: HostIds | null;
    /** Consent for fetching a missing dev image, threaded to the sandbox. */
    confirmImagePull?: (req: ImagePullConsent) => Promise<boolean> | boolean;
    onImagePullProgress?: (chunk: string) => void;
    /**
     * Readiness probe. Injected so tests never open a socket.
     *
     * Takes the surface KIND, because an http surface cannot be probed with a
     * TCP connect — on Docker Desktop that answers `true` for a container whose
     * server has not started. See `port-probe.ts`.
     */
    probeReady?: (req: {
        port: number;
        kind: 'http' | 'tcp';
        hostHeader?: string;
        timeoutMs: number;
    }) => Promise<boolean>;
    readyTimeoutMs?: number;
    /**
     * The workspace's provisioned SERVICES, as environment (#234 P3).
     *
     * Called just before a site container is created, and expected to ENSURE
     * those services are up before answering — a `DATABASE_URL` naming an
     * engine that is not running is worse than no `DATABASE_URL` at all. The
     * result is merged UNDER the site's own `env`, so a value the user pinned
     * always wins.
     *
     * Injected rather than imported so P2's behaviour is unchanged when it is
     * absent, and so this module still knows nothing about what a service is.
     */
    serviceEnvFor?: (workspaceId: string) => Promise<Record<string, string>>;
    /** Fired whenever the live set changes, so the UX and other agents follow. */
    onChanged?: () => void;
}

export interface DevSiteManager {
    /** Start one configured site. Never throws — a failure is a failed status. */
    start(workspaceId: string, siteId: string): Promise<DevSiteStatus>;
    stop(siteId: string): Promise<void>;
    restart(workspaceId: string, siteId: string): Promise<DevSiteStatus>;
    /**
     * Re-attach to site containers that are ALREADY running — never start one.
     *
     * A site container carries no restart policy, so it does not survive a
     * reboot; but it easily survives a Genie restart or an app update, and a
     * manager that does not know about it reports the site as stopped while it
     * serves — which means {@link genSites} drops it and `<name>.gen` resolves
     * nowhere. This is the counterpart of quitting without stopping anything.
     */
    adopt(): Promise<void>;
    /** Configured sites + live state. All workspaces, or one. */
    list(workspaceId?: string): DevSiteRow[];
    /** A bounded log tail for a running site. Never throws. */
    logs(siteId: string, tail?: number): Promise<string>;
    /** Start every enabled site and stop everything that no longer is. */
    reconcile(): Promise<void>;
    /** RUNNING http sites as Testing-Browser rows. Synchronous — the browser
     *  reads this while building its resolver map. */
    genSites(): DevGenSite[];
    stopAll(): Promise<void>;
}

// --- implementation ---------------------------------------------------------

interface Live {
    workspaceId: string;
    siteId: string;
    config: DevSiteConfig;
    containerId: string;
    hostPort: number;
    ready: boolean;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How long an ADOPTED container gets to answer before it is reported not-ready.
 *  Far shorter than a start's budget — see {@link DevSiteManager.adopt}. */
const ADOPT_PROBE_MS = 2_000;

export function createDevSiteManager(deps: DevSiteManagerDeps): DevSiteManager {
    const devImage = deps.image ?? GENIE_DEV_BASE_IMAGE;
    const mountTarget = deps.mountTarget ?? WORKSPACE_MOUNT_TARGET;
    const platform = deps.platform ?? process.platform;
    const probe =
        deps.probeReady ??
        (({ port, kind, hostHeader, timeoutMs }) =>
            kind === 'http'
                ? waitForHttp(port, timeoutMs, hostHeader)
                : waitForPort(port, timeoutMs));
    const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

    /** Sites that are up, keyed by siteId. */
    const live = new Map<string, Live>();
    /**
     * Why a site is NOT running, kept until it starts or is stopped.
     *
     * A failed site never enters `live`, so reading state only from there would
     * report it as a plain `stopped` — a user shown a site that "isn't on" when
     * in fact its image failed to build, with the build log discarded.
     */
    const lastFailure = new Map<string, DevSiteStatus>();
    /** In-flight starts, so two agents starting one site do not race two
     *  containers onto the same name. */
    const starting = new Map<string, Promise<DevSiteStatus>>();

    const changed = () => {
        try {
            deps.onChanged?.();
        } catch {
            /* a listener must not be able to fail a lifecycle call */
        }
    };

    function findSite(
        workspaceId: string,
        siteId: string,
    ): { workspace: DevWorkspace; config: DevSiteConfig } | null {
        const workspace = deps.listWorkspaces().find((w) => w.id === workspaceId);
        if (!workspace) return null;
        const config = deps.devSitesFor(workspaceId)[siteId];
        return config ? { workspace, config } : null;
    }

    const failed = (
        workspaceId: string,
        siteId: string,
        config: DevSiteConfig | null,
        error: string,
    ): DevSiteStatus => ({
        siteId,
        workspaceId,
        name: config?.name ?? siteId,
        genName: config?.genName ?? '',
        state: 'failed',
        error,
    });

    async function startOnce(workspaceId: string, siteId: string): Promise<DevSiteStatus> {
        const found = findSite(workspaceId, siteId);
        if (!found) {
            return failed(
                workspaceId,
                siteId,
                null,
                `Site ${siteId} is not configured in workspace ${workspaceId}.`,
            );
        }
        const { workspace, config } = found;

        const { runtime, detection } = await deps.resolveRuntime();
        if (!runtime || detection.kind === 'none') {
            // The guided-install path, not an error — the message has to carry
            // the remedy, because an agent has nothing else to act on.
            return failed(
                workspaceId,
                siteId,
                config,
                detection.installHint ??
                    'No container runtime (Docker or Podman) is available on this machine.',
            );
        }

        // Resolve BEFORE creating anything: a site with no port would otherwise
        // leave a sandbox and a half-built container behind for nothing.
        const run = resolveSiteRun(config, { devImage, workdir: mountTarget });
        if (!run.ok) return failed(workspaceId, siteId, config, run.error);

        try {
            // The site runs INSIDE the workspace sandbox, so the sandbox has to
            // exist. Idempotent, and it is what creates the network the site
            // container joins.
            const sandbox = await ensureWorkspaceSandbox(workspaceId, workspace.path, {
                runtime,
                platform,
                image: devImage,
                mountTarget,
                ...(deps.hostIds === undefined ? {} : { hostIds: deps.hostIds }),
                ...(deps.confirmImagePull ? { confirmImagePull: deps.confirmImagePull } : {}),
                ...(deps.onImagePullProgress
                    ? { onImagePullProgress: deps.onImagePullProgress }
                    : {}),
            });
            if (!sandbox.ok) {
                return failed(
                    workspaceId,
                    siteId,
                    config,
                    sandbox.installHint
                        ? `${sandbox.message} ${sandbox.installHint}`
                        : sandbox.message,
                );
            }

            let image = run.image;
            if (run.needsBuild) {
                // Layer 1: the repo told us how to build itself. Rebuilt on every
                // start — a dev loop that serves a stale image is worse than one
                // that costs a cached-layer rebuild.
                const context = config.repo
                    ? path.join(workspace.path, 'repos', config.repo)
                    : workspace.path;
                const tag = siteImageTagFor(workspaceId, config.name);
                const built = await runtime.buildImage(
                    { tag, context },
                    {
                        ...(deps.onImagePullProgress
                            ? { onProgress: deps.onImagePullProgress }
                            : {}),
                    },
                );
                if (!built.ok) {
                    return failed(
                        workspaceId,
                        siteId,
                        config,
                        `Building ${config.repo || 'the workspace'}'s Dockerfile failed: ${built.error ?? 'unknown error'}`,
                    );
                }
                image = tag;
            }

            // The workspace's services, brought up and turned into env. A
            // failure here does NOT stop the site: a dev server is often
            // exactly where a missing database is diagnosed, and refusing to
            // start hides the error behind a second one.
            let serviceEnv: Record<string, string> = {};
            if (deps.serviceEnvFor) {
                try {
                    serviceEnv = await deps.serviceEnvFor(workspaceId);
                } catch {
                    serviceEnv = {};
                }
            }

            const name = siteContainerNameFor(workspaceId, config.name);
            const existing = (await runtime.ps(workspaceId)).find((c) => c.name === name);
            if (existing) {
                if (existing.state === 'running') {
                    // Adopt: a site already up (a second window, a restarted
                    // Genie) must not get a second container on the same name.
                    const adopted = await recordLive(runtime, workspaceId, siteId, config, existing.id);
                    return adopted;
                }
                // Replace rather than restart. The published port is fixed at
                // create time, so a config whose port changed can only take
                // effect on a fresh container — and the code lives in the bind
                // mount, so the old layer holds nothing worth keeping.
                await runtime.remove(existing.id);
            }

            const container = await runtime.runContainer({
                workspaceId,
                name,
                image,
                ...(run.command ? { command: run.command } : {}),
                network: sandbox.network,
                labels: {
                    [WORKSPACE_LABEL]: workspaceId,
                    [ROLE_LABEL]: SITE_ROLE,
                    [SITE_LABEL]: siteId,
                },
                mounts: [{ source: workspace.path, target: mountTarget }],
                workdir: run.workdir,
                // Loopback + ephemeral: the ONLY port this container exposes,
                // never on the LAN, and never a fixed number two workspaces
                // could fight over.
                ports: [{ container: run.port, hostIp: '127.0.0.1' }],
                // Layered, and the ORDER is the contract. The allow-host plan
                // is the weakest — it is Genie's guess at making a framework
                // accept the `.gen` Host — so services override it and the
                // site's OWN env overrides everything. A value the user pinned
                // always wins.
                ...(() => {
                    const env = {
                        ...planHostAllowlist({
                            genName: config.genName,
                            ...(config.framework ? { framework: config.framework } : {}),
                            ...(config.command ? { command: config.command } : {}),
                            ...(config.upstreamHost ? { upstreamHost: config.upstreamHost } : {}),
                        }).env,
                        ...serviceEnv,
                        ...(config.env ?? {}),
                    };
                    return Object.keys(env).length ? { env } : {};
                })(),
                // A dev server spawns compilers and watchers; without a reaper
                // their orphans accumulate as zombies.
                init: true,
            });

            return await recordLive(runtime, workspaceId, siteId, config, container.id);
        } catch (e) {
            return failed(workspaceId, siteId, config, messageOf(e));
        }
    }

    /** Read the published port back, probe it, and remember the site as live. */
    async function recordLive(
        runtime: ContainerRuntime,
        workspaceId: string,
        siteId: string,
        config: DevSiteConfig,
        containerId: string,
        probeTimeoutMs: number = readyTimeoutMs,
    ): Promise<DevSiteStatus> {
        const mappings = await runtime.portMappings(containerId);
        const mapping =
            mappings.find((m) => m.container === config.port && m.protocol === 'tcp') ??
            mappings.find((m) => m.protocol === 'tcp');
        if (!mapping) {
            return failed(
                workspaceId,
                siteId,
                config,
                `The container for "${config.name}" started but published no port, so nothing can reach it.`,
            );
        }
        const ready = await probe({
            port: mapping.hostPort,
            kind: config.kind,
            hostHeader: config.upstreamHost ?? config.genName,
            timeoutMs: probeTimeoutMs,
        });
        live.set(siteId, {
            workspaceId,
            siteId,
            config,
            containerId,
            hostPort: mapping.hostPort,
            ready,
        });
        changed();
        return statusOf(workspaceId, siteId, config, live.get(siteId)!);
    }

    function statusOf(
        workspaceId: string,
        siteId: string,
        config: DevSiteConfig,
        entry: Live,
    ): DevSiteStatus {
        return {
            siteId,
            workspaceId,
            name: config.name,
            genName: config.genName,
            state: 'running',
            ready: entry.ready,
            containerId: entry.containerId,
            hostPort: entry.hostPort,
            // The `.gen` origin exists only for an HTTP surface — a TCP one is
            // published and listed, but the browser has nothing to open.
            ...(config.kind === 'http' ? { origin: `https://${config.genName}` } : {}),
            localOrigin: `http://127.0.0.1:${entry.hostPort}`,
        };
    }

    async function start(workspaceId: string, siteId: string): Promise<DevSiteStatus> {
        const inFlight = starting.get(siteId);
        if (inFlight) return inFlight;
        const promise = startOnce(workspaceId, siteId)
            .then((status) => {
                if (status.state === 'running') lastFailure.delete(siteId);
                else lastFailure.set(siteId, status);
                return status;
            })
            .finally(() => starting.delete(siteId));
        starting.set(siteId, promise);
        return promise;
    }

    async function stop(siteId: string): Promise<void> {
        // A stop clears the remembered failure: the site is off because it was
        // asked to be, which is not the same as being broken.
        lastFailure.delete(siteId);
        const entry = live.get(siteId);
        if (!entry) return;
        live.delete(siteId);
        const { runtime } = await deps.resolveRuntime();
        if (runtime) {
            try {
                await runtime.stop(entry.containerId);
                // Removed, not just stopped: an exited container still holds the
                // published port reservation and the container name.
                await runtime.remove(entry.containerId);
            } catch {
                /* tolerant — the adapter already treats "already gone" as success */
            }
        }
        changed();
    }

    return {
        start,
        stop,

        async restart(workspaceId, siteId) {
            await stop(siteId);
            return start(workspaceId, siteId);
        },

        async adopt() {
            const { runtime } = await deps.resolveRuntime();
            if (!runtime) return;
            for (const workspace of deps.listWorkspaces()) {
                let running: Awaited<ReturnType<ContainerRuntime['ps']>>;
                try {
                    running = await runtime.ps(workspace.id);
                } catch {
                    // One unreadable workspace must not abandon the others —
                    // this runs once at boot and gets no second chance.
                    continue;
                }
                for (const [siteId, config] of Object.entries(deps.devSitesFor(workspace.id))) {
                    if (live.has(siteId)) continue;
                    const name = siteContainerNameFor(workspace.id, config.name);
                    const found = running.find((c) => c.name === name && c.state === 'running');
                    if (!found) continue;
                    // A SHORT probe, unlike a start's. The container is already
                    // up, so a healthy site answers at once; one that does not
                    // is reported `ready: false` — a visible, recoverable state
                    // — rather than holding boot for the full start budget once
                    // per broken site.
                    await recordLive(runtime, workspace.id, siteId, config, found.id, ADOPT_PROBE_MS);
                }
            }
        },

        list(workspaceId) {
            const rows: DevSiteRow[] = [];
            for (const workspace of deps.listWorkspaces()) {
                if (workspaceId && workspace.id !== workspaceId) continue;
                for (const [siteId, config] of Object.entries(deps.devSitesFor(workspace.id))) {
                    const entry = live.get(siteId);
                    const status = entry
                        ? statusOf(workspace.id, siteId, config, entry)
                        : lastFailure.get(siteId) ?? {
                              siteId,
                              workspaceId: workspace.id,
                              name: config.name,
                              genName: config.genName,
                              state: 'stopped' as const,
                          };
                    rows.push({
                        ...status,
                        // The stored intent always comes from CONFIG, so a row
                        // never shows a stale copy carried on an old failure.
                        name: config.name,
                        genName: config.genName,
                        repo: config.repo,
                        runMode: config.runMode,
                        kind: config.kind,
                        enabled: config.enabled,
                        ...(config.command ? { command: config.command } : {}),
                        ...(config.port ? { port: config.port } : {}),
                        ...(config.image ? { image: config.image } : {}),
                    });
                }
            }
            return rows;
        },

        async logs(siteId, tail) {
            const entry = live.get(siteId);
            if (!entry) {
                const failure = lastFailure.get(siteId);
                return failure?.error
                    ? `This site is not running. It last failed with:\n${failure.error}`
                    : 'This site is not running, so it has no container log.';
            }
            const { runtime } = await deps.resolveRuntime();
            if (!runtime) return 'No container runtime is available, so the log cannot be read.';
            try {
                return await runtime.logs(entry.containerId, ...(tail ? [{ tail }] : []));
            } catch (e) {
                return `Could not read the container log: ${messageOf(e)}`;
            }
        },

        async reconcile() {
            const wanted = new Set<string>();
            for (const workspace of deps.listWorkspaces()) {
                for (const [siteId, config] of Object.entries(deps.devSitesFor(workspace.id))) {
                    if (!config.enabled) continue;
                    wanted.add(siteId);
                    await start(workspace.id, siteId);
                }
            }
            for (const siteId of [...live.keys()]) {
                if (!wanted.has(siteId)) await stop(siteId);
            }
        },

        genSites() {
            const rows: DevGenSite[] = [];
            for (const entry of live.values()) {
                // ONLY http surfaces, and only running ones: a hosted row
                // DISPLACES a discovered one in the overlay, so advertising a
                // dead target would replace a working site with a closed port.
                if (entry.config.kind !== 'http') continue;
                rows.push({
                    workspaceId: entry.workspaceId,
                    genName: entry.config.genName,
                    siteId: entry.siteId,
                    // What upstream is told it is. Defaults to the browser-facing
                    // name so origins line up; overridable for a framework with a
                    // Host allowlist. See `sites-config.ts`.
                    hostname: entry.config.upstreamHost ?? entry.config.genName,
                    scheme: 'http',
                    port: entry.hostPort,
                    loopback: '127.0.0.1',
                });
            }
            return rows;
        },

        async stopAll() {
            for (const siteId of [...live.keys()]) await stop(siteId);
        },
    };
}

/** The image tag a repo's own Dockerfile is built into. Derived + workspace-
 *  scoped, so two workspaces building a `web` do not clobber each other. */
export function siteImageTagFor(workspaceId: string, siteName: string): string {
    return `genie-site-${workspaceSlugFor(workspaceId)}-${workspaceSlugFor(siteName)}:latest`;
}

// --- the process-wide instance ---------------------------------------------

let instance: DevSiteManager | null = null;

/**
 * Create the one dev-site manager for this process. Idempotent: a second call
 * returns the existing instance rather than orphaning the first one's containers.
 */
export function initDevSites(deps: DevSiteManagerDeps): DevSiteManager {
    instance ??= createDevSiteManager(deps);
    return instance;
}

/** The live manager, or null when the dev server was never initialised (a test,
 *  an early boot path, a headless build that does not want it). */
export function devSiteManager(): DevSiteManager | null {
    return instance;
}

/**
 * RUNNING dev sites, for `sites/local-sites.ts`.
 *
 * Returns `[]` rather than throwing when nothing was initialised, so the
 * existing discovery + hosting paths keep working untouched — that is what makes
 * the Testing-Browser wiring purely additive.
 */
export function devServerGenSites(): DevGenSite[] {
    return instance?.genSites() ?? [];
}

/** Test-only: drop the process-wide instance. */
export function resetDevSitesForTests(): void {
    instance = null;
}
