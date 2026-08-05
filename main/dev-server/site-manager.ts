import { devContainerNameFor } from './argv';
import { CADDY_HTTPS_PORT, type CaddySite } from './caddyfile';
import { applyCaddyConfig } from './caddy-proxy';
import { GENIE_DEV_BASE_IMAGE, WORKSPACE_MOUNT_TARGET } from './images';
import { DEFAULT_READY_TIMEOUT_MS, waitForHttp, waitForHttpsSni, waitForPort } from './port-probe';
import { planHostAllowlist } from './host-allowlist';
import {
    readSiteProcessLog,
    siteProcessAlive,
    startSiteProcess,
    stopSiteProcess,
} from './site-process';
import { ensureWorkspaceSandbox } from './workspace-sandbox';
import { sandboxCommandFor } from './sites-config';
import type { ContainerRuntime, RuntimeDetection } from './container-runtime';
import type { HostIds } from './host-ids';
import type { DevSiteConfig, DevSites } from './sites-config';
import type { ImagePullConsent } from './workspace-sandbox';

/**
 * The DEV SITE MANAGER — "this workspace defines a site" becomes "its command is
 * running against the LIVE repo, Caddy fronts it over https at `<name>.gen`, and
 * the Genie Browser routes there".
 *
 * ## One sandbox per workspace, one process per site
 *
 * There is no per-site container and no build. A workspace has ONE long-lived
 * sandbox (`workspace-sandbox.ts`) with the whole workspace bind-mounted LIVE at
 * {@link WORKSPACE_MOUNT_TARGET}. A site is the user's own `command` run as a
 * detached process inside that sandbox, in the repo's live-mounted dir
 * (`site-process.ts`) — `npm run dev`, `php artisan serve`, a binary, whatever
 * they choose. Genie makes no assumptions: no forced dev server, no `--no-dev`,
 * no copy of the tree. This is a DEVELOPMENT server; it serves the source as it
 * is on disk, and an edit is live without a rebuild.
 *
 * ## Caddy is the one front door, and it forces https
 *
 * The app binds a private loopback port INSIDE the sandbox. A Caddy instance in
 * that same container (`caddy-proxy.ts`) publishes ONE https port to the host,
 * TLS-terminates every `<name>.gen`, and reverse-proxies each to its app's
 * loopback port. So app ports are MASKED — the browser only ever talks to Caddy
 * on the shared port — and https is FORCED regardless of the app speaking plain
 * http behind it. The sandbox re-points Caddy at exactly the live set on every
 * start and stop.
 *
 * ## What the BROWSER reads is unchanged
 *
 * {@link DevSiteManager.genSites} still returns `EnabledGenSite`-shaped rows, so
 * `sites/local-sites.ts` overlays them and the local carrier dials them with no
 * code of its own. The only difference from the old model is WHERE a row points:
 * every site now shares the sandbox's published Caddy port and is distinguished
 * by TLS SNI = its `.gen` name (which the carrier already sends), scheme `https`.
 *
 * ## Failures are STATUSES
 *
 * Driven by an MCP agent, so an exception crossing that boundary becomes a tool
 * error with no state attached. Every outcome is a {@link DevSiteStatus} carrying
 * enough to act on — including `ready`, kept separate from `state` because a
 * process being up and its port answering through Caddy are different events.
 */

// --- what a caller sees -----------------------------------------------------

export type DevSiteState = 'running' | 'stopped' | 'failed';

/**
 * The transient stages a START passes through, surfaced so the card can show
 * something the instant the button is clicked (Gap 2).
 *
 *   pulling  — resolving the runtime + ensuring the workspace sandbox (a cold
 *              image pull streams here)
 *   building — RETAINED for the renderer's union; the sandbox-serve model runs
 *              no build, so it is never emitted
 *   starting — the site process is being started and its port probed through Caddy
 *   ready    — terminal: the process is up and the `.gen` answered through Caddy
 *   failed   — terminal: it did not come up, and `error` says why
 */
export type DevSitePhase = 'pulling' | 'building' | 'starting' | 'ready' | 'failed';

/** One live progress tick for a starting site, pushed to the renderer (and the
 *  remote bridge) so a card reflects a start as it happens rather than at the end. */
export interface DevSiteProgress {
    workspaceId: string;
    siteId: string;
    name: string;
    genName: string;
    phase: DevSitePhase;
    /** The accumulated pull/start log tail, when there is one to tail. */
    log?: string;
    /** Set on `failed`: the reason the start did not complete. */
    error?: string;
}

export interface DevSiteStatus {
    siteId: string;
    workspaceId: string;
    name: string;
    genName: string;
    state: DevSiteState;
    /** True when the `.gen` answered through Caddy. Only meaningful while `state`
     *  is `running`. */
    ready?: boolean;
    /** The sandbox container the site's process runs in. */
    containerId?: string;
    /** The sandbox's published Caddy port — the one door every `.gen` is reached
     *  through. */
    hostPort?: number;
    /** The routable origin through the Genie Browser (`http` sites only). */
    origin?: string;
    /** The direct loopback origin — kept optional for callers that still read it;
     *  no longer set, since a site is reached only through Caddy (with SNI). */
    localOrigin?: string;
    /** RETAINED for shape compatibility; the sandbox-serve model runs no build. */
    buildLog?: string;
    /** RETAINED for shape compatibility; raw extra surfaces are not published in
     *  the secure-only model. */
    exposed?: ExposedRoute[];
    error?: string;
}

/** One extra browser-facing surface. RETAINED for shape compatibility. */
export interface ExposedRoute {
    name: string;
    protocol: string;
    genName: string;
    hostPort?: number;
}

/** One configured site plus whatever is currently true about it. */
export interface DevSiteRow extends DevSiteStatus {
    repo: string;
    runMode: DevSiteConfig['runMode'];
    kind: DevSiteConfig['kind'];
    enabled: boolean;
    stack?: DevSiteConfig['stack'];
    server?: DevSiteConfig['server'];
    build?: DevSiteConfig['build'];
    /** The user-controlled startup argv the manager actually runs. */
    command?: string[];
    /** LEGACY: the pre-rework serve argv, still surfaced for the Edit form. */
    serve?: string[];
    port?: number;
    image?: string;
    env?: DevSiteConfig['env'];
    upstreamHost?: DevSiteConfig['upstreamHost'];
    /** Set ONLY while a start is in flight (Gap 2). */
    phase?: DevSitePhase;
}

/** A running site as the Testing Browser reads it. Structurally the
 *  `EnabledGenSite` of `main/remote`, rebuilt here so this module does not depend
 *  on the remote stack. */
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
     * Which runtime, and is it usable. Called per action rather than resolved
     * once: a user who installs Docker must not have to restart Genie.
     */
    resolveRuntime: () => Promise<ResolvedRuntimeLike>;
    listWorkspaces: () => DevWorkspace[];
    devSitesFor: (workspaceId: string) => DevSites;
    platform?: NodeJS.Platform | string;
    /** The workspace dev image the sandbox runs. */
    image?: string;
    mountTarget?: string;
    hostIds?: HostIds | null;
    /** Consent for fetching a missing dev image, threaded to the sandbox. */
    confirmImagePull?: (req: ImagePullConsent) => Promise<boolean> | boolean;
    onImagePullProgress?: (chunk: string) => void;
    /**
     * Readiness probe. Injected so tests never open a socket.
     *
     * An http site is probed THROUGH Caddy: an https request to the sandbox's
     * published port with TLS `servername` = the `.gen` name, so it exercises the
     * exact loopback→Caddy→app path the browser will. See `port-probe.ts`.
     */
    probeReady?: (req: {
        port: number;
        kind: 'http' | 'tcp';
        servername?: string;
        hostHeader?: string;
        timeoutMs: number;
    }) => Promise<boolean>;
    readyTimeoutMs?: number;
    /**
     * The workspace's provisioned SERVICES, as environment (#234 P3). Ensured up
     * before the site starts and merged UNDER the site's own env, so a value the
     * user pinned wins but the real engine address is authoritative.
     */
    serviceEnvFor?: (workspaceId: string) => Promise<Record<string, string>>;
    /** Fired whenever the live set changes, so the UX and other agents follow. */
    onChanged?: () => void;
    /**
     * A live START tick (Gap 2), fired at each phase boundary and on every
     * pull/start log chunk. A listener must never throw.
     */
    onProgress?: (progress: DevSiteProgress) => void;
}

export interface DevSiteManager {
    /** Start one configured site. Never throws — a failure is a failed status. */
    start(workspaceId: string, siteId: string): Promise<DevSiteStatus>;
    stop(siteId: string): Promise<void>;
    restart(workspaceId: string, siteId: string): Promise<DevSiteStatus>;
    /**
     * Apply an edited config (Gap 1). Restart it when the change requires it,
     * otherwise leave the running process exactly as it is. `previousSiteId`
     * differs from `siteId` only on a RENAME. Never throws.
     */
    reconfigure(
        workspaceId: string,
        siteId: string,
        opts: { previousSiteId: string; restart: boolean },
    ): Promise<DevSiteStatus>;
    /**
     * Re-attach to site processes ALREADY running in a sandbox — never start one.
     * Survives a Genie restart / app update (the sandbox has `restart:
     * unless-stopped`, so the container and its processes outlive the app), so the
     * manager must re-learn what is up or `genSites` would drop it.
     */
    adopt(): Promise<void>;
    /** Configured sites + live state. All workspaces, or one. */
    list(workspaceId?: string): DevSiteRow[];
    /** A bounded log tail for a running site. Never throws. */
    logs(siteId: string, tail?: number): Promise<string>;
    /** Start every enabled site and stop everything that no longer is. */
    reconcile(): Promise<void>;
    /** RUNNING http sites as Testing-Browser rows. Synchronous. */
    genSites(): DevGenSite[];
    stopAll(): Promise<void>;
}

// --- implementation ---------------------------------------------------------

interface Live {
    workspaceId: string;
    siteId: string;
    config: DevSiteConfig;
    /** The SANDBOX container the process runs in (shared by every site in the
     *  workspace). */
    containerId: string;
    /** The sandbox's published Caddy port — the one door every `.gen` is reached
     *  through. */
    caddyHostPort: number;
    /** The app's own loopback port INSIDE the sandbox — what Caddy proxies to. */
    internalPort: number;
    ready: boolean;
    /** The `.gen` rows this site contributes (its own). Resolved at start so
     *  `genSites()` stays synchronous. */
    routes: DevGenSite[];
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A repo name safe to append to the container-side mount point. */
const SAFE_REPO = /^[A-Za-z0-9._-]+$/;

/** The repo's live-mounted dir inside the sandbox, or null when the repo name is
 *  unsafe (it becomes a path segment under the mount). */
function repoCwd(mountTarget: string, repo: string): string | null {
    if (!repo) return mountTarget;
    if (!SAFE_REPO.test(repo) || repo === '.' || repo === '..') return null;
    return `${mountTarget}/repos/${repo}`;
}

/**
 * How long an ADOPTED site gets to answer before it is reported not-ready.
 *
 * NOT short: an adopted process is up, but "up" does not mean "answers at once".
 * A single-threaded dev server (`php artisan serve`) re-bootstraps per request,
 * so a healthy site still takes ~2.5s to respond (the cold first hit ~7s). A
 * budget below that reports a serving site as not-ready — the `ready:false`
 * false-negative — so it must clear real per-request latency, like the start
 * probe's per-attempt cap in port-probe.ts.
 */
const ADOPT_PROBE_MS = 12_000;

export function createDevSiteManager(deps: DevSiteManagerDeps): DevSiteManager {
    // --- observable startup (Gap 2) -----------------------------------------
    const originalPull = deps.onImagePullProgress;
    const inFlight = new Map<
        string,
        { workspaceId: string; name: string; genName: string; phase: DevSitePhase; log: string }
    >();
    let chunkTarget: string | null = null;
    const MAX_PROGRESS_LOG = 16_000;

    const emitProgress = (siteId: string, extra: Partial<DevSiteProgress> = {}): void => {
        const f = inFlight.get(siteId);
        if (!f || !deps.onProgress) return;
        try {
            deps.onProgress({
                workspaceId: f.workspaceId,
                siteId,
                name: f.name,
                genName: f.genName,
                phase: f.phase,
                ...(f.log ? { log: f.log } : {}),
                ...extra,
            });
        } catch {
            /* a progress listener must never be able to fail a start */
        }
    };

    const beginPhase = (
        workspaceId: string,
        siteId: string,
        config: DevSiteConfig,
        phase: DevSitePhase,
    ): void => {
        const prev = inFlight.get(siteId);
        inFlight.set(siteId, {
            workspaceId,
            name: config.name,
            genName: config.genName,
            phase,
            log: prev?.log ?? '',
        });
        chunkTarget = siteId;
        emitProgress(siteId);
    };

    const pump = (chunk: string): void => {
        originalPull?.(chunk);
        const siteId = chunkTarget;
        if (!siteId) return;
        const f = inFlight.get(siteId);
        if (!f) return;
        f.log = (f.log + chunk).slice(-MAX_PROGRESS_LOG);
        emitProgress(siteId, { log: f.log });
    };

    const finishProgress = (siteId: string, status: DevSiteStatus): void => {
        const f = inFlight.get(siteId);
        if (!f) return;
        const phase: DevSitePhase = status.state === 'running' ? 'ready' : 'failed';
        const log = f.log || undefined;
        if (deps.onProgress) {
            try {
                deps.onProgress({
                    workspaceId: f.workspaceId,
                    siteId,
                    name: f.name,
                    genName: f.genName,
                    phase,
                    ...(log ? { log } : {}),
                    ...(status.error ? { error: status.error } : {}),
                });
            } catch {
                /* never let a listener fail a start */
            }
        }
        inFlight.delete(siteId);
        if (chunkTarget === siteId) chunkTarget = null;
    };

    // Everything below reads `deps.onImagePullProgress`; from here it is the pump.
    deps = { ...deps, onImagePullProgress: pump };

    const devImage = deps.image ?? GENIE_DEV_BASE_IMAGE;
    const mountTarget = deps.mountTarget ?? WORKSPACE_MOUNT_TARGET;
    const platform = deps.platform ?? process.platform;
    const probe =
        deps.probeReady ??
        (({ port, kind, servername, hostHeader, timeoutMs }) =>
            kind === 'http'
                ? servername
                    ? waitForHttpsSni(port, servername, timeoutMs, hostHeader)
                    : waitForHttp(port, timeoutMs, hostHeader)
                : waitForPort(port, timeoutMs));
    const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

    /** Sites that are up, keyed by siteId. */
    const live = new Map<string, Live>();
    const lastFailure = new Map<string, DevSiteStatus>();
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

    /** Every live http site in a workspace, as Caddy vhosts (host + app port,
     *  with an upstream-Host rewrite when the site pins one). */
    function caddySitesFor(workspaceId: string): CaddySite[] {
        const sites: CaddySite[] = [];
        for (const e of live.values()) {
            if (e.workspaceId !== workspaceId || e.config.kind !== 'http') continue;
            sites.push({
                host: e.config.genName,
                port: e.internalPort,
                ...(e.config.upstreamHost && e.config.upstreamHost !== e.config.genName
                    ? { upstreamHost: e.config.upstreamHost }
                    : {}),
            });
        }
        return sites;
    }

    /** Re-point a workspace sandbox's Caddy at its current live set. Never throws. */
    async function reapplyCaddy(
        runtime: ContainerRuntime,
        workspaceId: string,
        containerId: string,
    ) {
        return applyCaddyConfig(runtime, containerId, caddySitesFor(workspaceId));
    }

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

        // The instant a start begins — so the card leaves "off" the moment the
        // button is clicked (Gap 2). Covers runtime resolution + the sandbox
        // ensure, where a cold image pull streams its progress.
        beginPhase(workspaceId, siteId, config, 'pulling');

        const { runtime, detection } = await deps.resolveRuntime();
        if (!runtime || detection.kind === 'none') {
            return failed(
                workspaceId,
                siteId,
                config,
                detection.installHint ??
                    'No container runtime (Docker or Podman) is available on this machine.',
            );
        }

        // Validate BEFORE creating anything: a site is a command + a port + a
        // valid repo dir. A site missing any of these has nothing to run.
        // `sandboxCommandFor` also migrates a pre-rework FrankenPHP/nginx recipe
        // to a sandbox-runnable dev command, so existing sites are not left dark
        // by the switch to serving inside the sandbox.
        const command = sandboxCommandFor(config);
        if (!command) {
            return failed(
                workspaceId,
                siteId,
                config,
                `Site "${config.name}" has no startup command. Set its \`command\` — the argv Genie runs to start it, e.g. ["npm","run","dev"] or ["php","artisan","serve","--host=0.0.0.0"].`,
            );
        }
        const internalPort = config.port;
        if (!internalPort || !Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535) {
            return failed(
                workspaceId,
                siteId,
                config,
                `Site "${config.name}" has no valid port — set the port its command listens on inside the sandbox, so Caddy can reach it.`,
            );
        }
        const cwd = repoCwd(mountTarget, config.repo);
        if (cwd === null) {
            return failed(workspaceId, siteId, config, `Invalid repo name ${JSON.stringify(config.repo)}.`);
        }

        try {
            // The site runs INSIDE the workspace sandbox, so the sandbox has to
            // exist. Idempotent; it is what publishes the one Caddy door.
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
                    sandbox.installHint ? `${sandbox.message} ${sandbox.installHint}` : sandbox.message,
                );
            }
            if (sandbox.caddyHostPort === undefined) {
                return failed(
                    workspaceId,
                    siteId,
                    config,
                    `The workspace sandbox for "${config.name}" published no proxy port, so the site cannot be reached. Reopen the workspace to recreate the sandbox.`,
                );
            }
            const containerId = sandbox.container.id;
            const caddyHostPort = sandbox.caddyHostPort;

            // Already running in this sandbox (a reconcile pass, a re-entrant
            // start, a second window): don't spawn a duplicate — re-point Caddy
            // (idempotent) and re-probe. A dead process falls through to respawn.
            if (live.has(siteId)) {
                if (await siteProcessAlive(runtime, containerId, siteId)) {
                    return await recordLive(runtime, workspaceId, siteId, config, containerId, caddyHostPort, internalPort);
                }
                live.delete(siteId);
            }

            beginPhase(workspaceId, siteId, config, 'starting');

            // The workspace's services, brought up and turned into env. A failure
            // here does NOT stop the site — hosting is often where a missing
            // database is diagnosed. The ORDER, weakest first:
            //   1. the allow-host plan (Genie's guess at making a framework accept
            //      the `.gen` Host);
            //   2. the site's OWN pinned env; then
            //   3. the workspace SERVICE env — injected LAST, and it WINS: it names
            //      the real engine the sandbox can reach.
            let serviceEnv: Record<string, string> = {};
            if (deps.serviceEnvFor) {
                try {
                    serviceEnv = await deps.serviceEnvFor(workspaceId);
                } catch {
                    serviceEnv = {};
                }
            }
            const env: Record<string, string> = {
                ...planHostAllowlist({
                    genName: config.genName,
                    ...(config.framework ? { framework: config.framework } : {}),
                    ...(config.stack ? { stack: config.stack } : {}),
                    ...(config.server ? { server: config.server } : {}),
                    command,
                    ...(config.upstreamHost ? { upstreamHost: config.upstreamHost } : {}),
                }).env,
                ...(config.env ?? {}),
                ...serviceEnv,
            };

            // Run the user's command detached in the sandbox, in the repo's LIVE
            // dir. No copy, no build — this is a development server over the source.
            const started = await startSiteProcess({
                runtime,
                containerId,
                siteId,
                command,
                cwd,
                ...(Object.keys(env).length ? { env } : {}),
            });
            if (!started.ok) {
                return failed(workspaceId, siteId, config, started.error);
            }

            return await recordLive(runtime, workspaceId, siteId, config, containerId, caddyHostPort, internalPort);
        } catch (e) {
            return failed(workspaceId, siteId, config, messageOf(e));
        }
    }

    /**
     * Record a running site, point the sandbox's Caddy at the full live set, and
     * probe the `.gen` through Caddy.
     */
    async function recordLive(
        runtime: ContainerRuntime,
        workspaceId: string,
        siteId: string,
        config: DevSiteConfig,
        containerId: string,
        caddyHostPort: number,
        internalPort: number,
        probeTimeoutMs: number = readyTimeoutMs,
    ): Promise<DevSiteStatus> {
        const routes: DevGenSite[] =
            config.kind === 'http'
                ? [
                      {
                          workspaceId,
                          genName: config.genName,
                          siteId,
                          // SNI = Host = the `.gen` name so Caddy routes by SNI;
                          // an upstream-Host override is applied AT Caddy, not here.
                          hostname: config.genName,
                          scheme: 'https',
                          port: caddyHostPort,
                          loopback: '127.0.0.1',
                      },
                  ]
                : [];

        live.set(siteId, {
            workspaceId,
            siteId,
            config,
            containerId,
            caddyHostPort,
            internalPort,
            ready: false,
            routes,
        });

        // Point Caddy at every live http site in this workspace, INCLUDING the one
        // just added. A failure means the site is up but unroutable — surfaced as
        // an error on the status, and the probe below will read not-ready.
        let caddyError: string | undefined;
        if (config.kind === 'http') {
            const applied = await reapplyCaddy(runtime, workspaceId, containerId);
            if (!applied.ok) caddyError = `The site started but its proxy could not be configured: ${applied.error}`;
        }

        const ready =
            config.kind === 'http'
                ? caddyError
                    ? false
                    : await probe({
                          port: caddyHostPort,
                          kind: 'http',
                          servername: config.genName,
                          hostHeader: config.upstreamHost ?? config.genName,
                          timeoutMs: probeTimeoutMs,
                      })
                : true;

        const entry = live.get(siteId);
        if (entry) entry.ready = ready;
        changed();
        return {
            ...statusOf(workspaceId, siteId, config, live.get(siteId)!),
            ...(caddyError ? { error: caddyError } : {}),
        };
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
            hostPort: entry.caddyHostPort,
            // The `.gen` origin exists only for an HTTP surface.
            ...(config.kind === 'http' ? { origin: `https://${config.genName}` } : {}),
        };
    }

    async function start(workspaceId: string, siteId: string): Promise<DevSiteStatus> {
        const pending = starting.get(siteId);
        if (pending) return pending;
        const promise = startOnce(workspaceId, siteId)
            .then((status) => {
                if (status.state === 'running') lastFailure.delete(siteId);
                else lastFailure.set(siteId, status);
                finishProgress(siteId, status);
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
            // Stop ONLY this site's process group — never the shared sandbox, which
            // holds the toolchain and the other sites. Then re-point Caddy at what
            // remains, dropping this site's vhost.
            await stopSiteProcess(runtime, entry.containerId, siteId);
            await reapplyCaddy(runtime, entry.workspaceId, entry.containerId);
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

        async reconfigure(workspaceId, siteId, opts) {
            const { previousSiteId, restart } = opts;

            // A restart-requiring edit on a running site: stop the old process
            // (under its OLD id, which a rename changes) and start the new one.
            if (restart) {
                await stop(previousSiteId);
                if (previousSiteId !== siteId) lastFailure.delete(previousSiteId);
                return start(workspaceId, siteId);
            }

            // No restart needed. If it is running, keep it — only refresh the live
            // config so a cosmetic field reads current.
            const found = findSite(workspaceId, siteId);
            const entry = live.get(previousSiteId);
            if (entry && found) {
                if (previousSiteId !== siteId) live.delete(previousSiteId);
                const next: Live = { ...entry, siteId, config: found.config };
                live.set(siteId, next);
                changed();
                return statusOf(workspaceId, siteId, found.config, next);
            }

            // Not running: the persisted edit is already stored; nothing to
            // reconcile on the process. Report the current state.
            if (previousSiteId !== siteId) lastFailure.delete(previousSiteId);
            changed();
            if (!found) {
                return failed(
                    workspaceId,
                    siteId,
                    null,
                    `Site ${siteId} is not configured in workspace ${workspaceId}.`,
                );
            }
            const failure = lastFailure.get(siteId);
            return (
                failure ?? {
                    siteId,
                    workspaceId,
                    name: found.config.name,
                    genName: found.config.genName,
                    state: 'stopped' as const,
                }
            );
        },

        async adopt() {
            const { runtime } = await deps.resolveRuntime();
            if (!runtime) return;
            for (const workspace of deps.listWorkspaces()) {
                // Find the workspace's RUNNING sandbox and its published Caddy port.
                let sandboxId: string | undefined;
                let caddyHostPort: number | undefined;
                try {
                    const name = devContainerNameFor(workspace.id);
                    const sandbox = (await runtime.ps(workspace.id)).find(
                        (c) => c.name === name && c.state === 'running',
                    );
                    if (!sandbox) continue;
                    sandboxId = sandbox.id;
                    const maps = await runtime.portMappings(sandbox.id);
                    caddyHostPort = maps.find((m) => m.container === CADDY_HTTPS_PORT)?.hostPort;
                } catch {
                    // One unreadable workspace must not abandon the others — this
                    // runs once at boot and gets no second chance.
                    continue;
                }
                if (!sandboxId || caddyHostPort === undefined) continue;

                for (const [siteId, config] of Object.entries(deps.devSitesFor(workspace.id))) {
                    if (live.has(siteId)) continue;
                    const internalPort = config.port;
                    if (!internalPort) continue;
                    let alive = false;
                    try {
                        alive = await siteProcessAlive(runtime, sandboxId, siteId);
                    } catch {
                        alive = false;
                    }
                    if (!alive) continue;
                    // A SHORT probe: the process is already up, so a healthy site
                    // answers at once; one that does not is reported not-ready.
                    await recordLive(
                        runtime,
                        workspace.id,
                        siteId,
                        config,
                        sandboxId,
                        caddyHostPort,
                        internalPort,
                        ADOPT_PROBE_MS,
                    );
                }
            }
        },

        list(workspaceId) {
            const rows: DevSiteRow[] = [];
            for (const workspace of deps.listWorkspaces()) {
                if (workspaceId && workspace.id !== workspaceId) continue;
                for (const [siteId, config] of Object.entries(deps.devSitesFor(workspace.id))) {
                    const entry = live.get(siteId);
                    const flight = inFlight.get(siteId);
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
                        // The stored intent always comes from CONFIG.
                        name: config.name,
                        genName: config.genName,
                        repo: config.repo,
                        runMode: config.runMode,
                        kind: config.kind,
                        enabled: config.enabled,
                        ...(config.stack ? { stack: config.stack } : {}),
                        ...(config.server ? { server: config.server } : {}),
                        ...(config.build?.length ? { build: config.build } : {}),
                        ...(config.command ? { command: config.command } : {}),
                        ...(config.serve ? { serve: config.serve } : {}),
                        ...(config.port ? { port: config.port } : {}),
                        ...(config.image ? { image: config.image } : {}),
                        ...(config.env && Object.keys(config.env).length ? { env: config.env } : {}),
                        ...(config.upstreamHost ? { upstreamHost: config.upstreamHost } : {}),
                        ...(flight
                            ? {
                                  phase: flight.phase,
                                  ...(flight.log ? { buildLog: flight.log } : {}),
                              }
                            : {}),
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
                    : 'This site is not running, so it has no log.';
            }
            const { runtime } = await deps.resolveRuntime();
            if (!runtime) return 'No container runtime is available, so the log cannot be read.';
            return readSiteProcessLog(runtime, entry.containerId, siteId, tail);
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
            for (const entry of live.values()) rows.push(...entry.routes);
            return rows;
        },

        async stopAll() {
            for (const siteId of [...live.keys()]) await stop(siteId);
        },
    };
}

// --- the process-wide instance ---------------------------------------------

let instance: DevSiteManager | null = null;

/**
 * Create the one dev-site manager for this process. Idempotent: a second call
 * returns the existing instance rather than orphaning the first one's processes.
 */
export function initDevSites(deps: DevSiteManagerDeps): DevSiteManager {
    instance ??= createDevSiteManager(deps);
    return instance;
}

/** The live manager, or null when the dev server was never initialised. */
export function devSiteManager(): DevSiteManager | null {
    return instance;
}

/**
 * RUNNING dev sites, for `sites/local-sites.ts`. Returns `[]` rather than
 * throwing when nothing was initialised, so the Testing-Browser wiring stays
 * purely additive.
 */
export function devServerGenSites(): DevGenSite[] {
    return instance?.genSites() ?? [];
}

/** Test-only: drop the process-wide instance. */
export function resetDevSitesForTests(): void {
    instance = null;
}
