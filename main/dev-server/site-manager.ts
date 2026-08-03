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
import { planExposure } from './exposure';
import { FRANKENPHP_IMAGE, resolveHostedRun } from './serve-recipe';
import { runSiteBuild } from './site-build';
import { buildAuthEnv } from './build-auth';
import { ensureWorkspaceSandbox } from './workspace-sandbox';
import type { ContainerHealthcheck, ContainerRuntime, RuntimeDetection } from './container-runtime';
import type { ExposurePlan } from './exposure';
import type { HostIds } from './host-ids';
import type { DevSiteConfig, DevSites } from './sites-config';
import type { ImagePullConsent } from './workspace-sandbox';

/**
 * The HOSTED SITE MANAGER — "this workspace defines a site" becomes "it is
 * BUILT, a production server is serving the result, and the Genie Browser routes
 * there".
 *
 * ## Build, then serve — and they happen in different containers
 *
 * Starting a site is two stages, not one. First the production BUILD runs by
 * `exec`ing into the workspace's long-lived sandbox container, which is the one
 * with the toolchain (`site-build.ts`). Then the site's OWN container starts,
 * running the production server — very often from a different image entirely,
 * because FrankenPHP and nginx serve builds and cannot produce them. The two
 * share the workspace bind mount, which is what carries the artifact across.
 *
 * A required build step that fails means the site does NOT start. That rule is
 * the difference between a preview you can trust and one that silently serves
 * the last successful build while every health signal reads green.
 *
 * ## What is published is what the BROWSER needs
 *
 * `exposure.ts` decides, and nothing else may add a port. The app's HTTP surface
 * is published to loopback on an ephemeral port and routed at `<name>.gen`;
 * declared browser-facing surfaces get their own subdomain, and a raw one gets a
 * STABLE port so a client configured with a number keeps working. Backing
 * services are never here — they are reached on the workspace network through
 * the injected environment.
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
    /** The production build's log, when this start ran one. Kept on SUCCESS too:
     *  a green build that installed the wrong thing is worth reading. */
    buildLog?: string;
    /** Browser-facing surfaces beyond the app's HTTP, as they ended up. */
    exposed?: ExposedRoute[];
    error?: string;
}

/** One extra browser-facing surface, resolved to what a client can dial. */
export interface ExposedRoute {
    name: string;
    protocol: string;
    /** The `.gen` subdomain, for the HTTP-carried protocols. */
    genName: string;
    /** Set for a raw surface (gRPC/TCP): the stable loopback port to dial. */
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
    serve?: string[];
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
    /**
     * The managed GitHub token to authenticate the production BUILD with (genie
     * #119), or null when Genie holds none.
     *
     * Injected — REUSE of the same token resolution the clone path uses
     * (`github/storage.ts#getToken`), not a new store — so this module stays free
     * of the electron/safeStorage import and a test can supply a fake. Resolved
     * once per build and merged UNDER the site's own env as COMPOSER_AUTH +
     * GITHUB_TOKEN (see `build-auth.ts`); absent on a host with no GitHub
     * connected, where the build degrades to public access. Works on a headless
     * host — `getToken` reads the stored token, no interactive login.
     */
    githubToken?: () => string | null | undefined;
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
    /** The `.gen` rows this site contributes — its own, plus any HTTP-carried
     *  surface. Resolved to published ports at start, so `genSites()` stays
     *  synchronous for the browser's resolver map. */
    routes: DevGenSite[];
    /** The extra browser-facing surfaces, as a caller reads them. */
    exposed: ExposedRoute[];
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
        const run = resolveHostedRun(config, { devImage, workdir: mountTarget });
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
            // failure here does NOT stop the site: hosting is often exactly
            // where a missing database is diagnosed, and refusing to start
            // hides the error behind a second one.
            //
            // These are WORKSTATION-hosted shared engines, reached on the
            // workspace's own network at the engine's container name. Backend
            // traffic: nothing here is published, and nothing here gets a
            // browser-facing name. See `exposure.ts`.
            let serviceEnv: Record<string, string> = {};
            if (deps.serviceEnvFor) {
                try {
                    serviceEnv = await deps.serviceEnvFor(workspaceId);
                } catch {
                    serviceEnv = {};
                }
            }

            // The environment BOTH stages get, and this SITE container's own env
            // (per-repo scope — `serviceEnvFor` is resolved at workspace scope,
            // but injected here, into each site's container). The ORDER is the
            // contract, weakest first:
            //   1. the allow-host plan (Genie's guess at making a framework
            //      accept the `.gen` Host);
            //   2. the site's OWN pinned env (`config.env`);
            //   3. the workspace's SERVICE connection env — injected LAST, and it
            //      WINS OUTRIGHT. DB_HOST / DATABASE_URL / PG* / REDIS_* name the
            //      real engine the container can actually reach (e.g.
            //      `genie-svc-postgres-17` on the workspace network). A repo whose
            //      committed `.env` still says `127.0.0.1` (carried into
            //      `config.env`, or read from the file by a framework that honours
            //      real env vars) must NOT beat that, or the app dials nothing.
            const env: Record<string, string> = {
                ...planHostAllowlist({
                    genName: config.genName,
                    ...(config.framework ? { framework: config.framework } : {}),
                    // The recipe STACK/SERVER, so a PRODUCTION serve is host/scheme
                    // fixed even when the argv cannot say what it runs — a
                    // FrankenPHP `php-server` has no `artisan` token, yet a Laravel
                    // app still needs APP_URL on the https `.gen` origin or its
                    // assets load over http and the browser blocks them (#119).
                    ...(config.stack ? { stack: config.stack } : {}),
                    ...(config.server ? { server: config.server } : {}),
                    ...(config.serve ? { command: config.serve } : {}),
                    ...(config.upstreamHost ? { upstreamHost: config.upstreamHost } : {}),
                }).env,
                ...(config.env ?? {}),
                ...serviceEnv,
            };

            // --- BUILD, then serve ------------------------------------------
            //
            // In the SANDBOX container, because that is the one with the
            // toolchain: the site's own image may be FrankenPHP or nginx, which
            // serve a build and cannot make one. A required step that fails
            // stops the site — starting anyway would serve the previous build
            // while every health signal read green.
            let buildLog: string | undefined;
            if (run.build.length) {
                // The build gets the serve env PLUS the auth/git-safety DEFAULTS
                // (genie #119): a git `safe.directory` so composer does not die on
                // dubious ownership, and — when Genie holds one — the managed
                // GitHub token as COMPOSER_AUTH + GITHUB_TOKEN so github.com dist
                // fetches authenticate instead of hitting the anonymous rate
                // limit. The defaults sit UNDER `env`, so a value the user pinned
                // still wins; the token rides ONLY the build (never the serving
                // container) and is scrubbed from the surfaced build log.
                const auth = buildAuthEnv(deps.githubToken?.());
                const buildEnv = { ...auth.env, ...env };
                const built = await runSiteBuild(run.build, {
                    exec: (id, argv, execOpts) => runtime.exec(id, argv, execOpts),
                    containerId: sandbox.container.id,
                    workdir: run.workdir,
                    env: buildEnv,
                    ...(auth.secrets.length ? { secrets: auth.secrets } : {}),
                    ...(deps.onImagePullProgress
                        ? { onProgress: deps.onImagePullProgress }
                        : {}),
                });
                buildLog = built.log;
                if (!built.ok) {
                    return {
                        ...failed(workspaceId, siteId, config, built.error ?? 'The build failed.'),
                        buildLog,
                    };
                }
            }

            const exposure = planExposure({
                siteId,
                genName: config.genName,
                port: run.port,
                kind: config.kind,
                ...(config.exposed ? { exposed: config.exposed } : {}),
            });

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

            const healthcheck = siteHealthcheck(image, run.port);
            const container = await runtime.runContainer({
                workspaceId,
                name,
                image,
                ...(run.serve ? { command: run.serve } : {}),
                network: sandbox.network,
                labels: {
                    [WORKSPACE_LABEL]: workspaceId,
                    [ROLE_LABEL]: SITE_ROLE,
                    [SITE_LABEL]: siteId,
                },
                mounts: [{ source: workspace.path, target: mountTarget }],
                workdir: run.workdir,
                // EXACTLY what the browser needs, and nothing else. The plan is
                // the only thing that may open a port on this container — see
                // `exposure.ts`.
                ports: exposure.publish,
                ...(Object.keys(env).length ? { env } : {}),
                // A production server still spawns workers (gunicorn, php-fpm,
                // nginx); without a reaper their orphans accumulate as zombies.
                init: true,
                // Replace FrankenPHP's broken :2019 admin-endpoint healthcheck
                // (genie #119, Blocker 5). Null for every other image — none of
                // them bake in a broken one.
                ...(healthcheck ? { healthcheck } : {}),
            });

            const status = await recordLive(
                runtime,
                workspaceId,
                siteId,
                config,
                container.id,
                readyTimeoutMs,
                exposure,
            );
            return {
                ...status,
                ...(buildLog ? { buildLog } : {}),
                // Refusals are reported, not silently dropped: a caller that
                // asked to expose a database needs to be told why it did not
                // happen, on the call where they asked.
                ...(exposure.rejected.length
                    ? {
                          error: exposure.rejected
                              .map((r) => r.error)
                              .concat(status.error ? [status.error] : [])
                              .join(' '),
                      }
                    : {}),
            };
        } catch (e) {
            return failed(workspaceId, siteId, config, messageOf(e));
        }
    }

    /** Read the published ports back, probe the app's, and remember it as live. */
    async function recordLive(
        runtime: ContainerRuntime,
        workspaceId: string,
        siteId: string,
        config: DevSiteConfig,
        containerId: string,
        probeTimeoutMs: number = readyTimeoutMs,
        exposure: ExposurePlan = planExposure({
            siteId,
            genName: config.genName,
            port: config.port ?? 0,
            kind: config.kind,
            ...(config.exposed ? { exposed: config.exposed } : {}),
        }),
    ): Promise<DevSiteStatus> {
        const mappings = await runtime.portMappings(containerId);
        const hostPortFor = (containerPort: number): number | undefined =>
            mappings.find((m) => m.container === containerPort && m.protocol === 'tcp')?.hostPort;

        const hostPort = hostPortFor(config.port ?? 0) ?? mappings.find((m) => m.protocol === 'tcp')?.hostPort;
        if (!hostPort) {
            return failed(
                workspaceId,
                siteId,
                config,
                `The container for "${config.name}" started but published no port, so nothing can reach it.`,
            );
        }

        // The plan named container ports; the runtime just told us what it
        // published them as. A route whose port did not come back is DROPPED
        // rather than advertised — a `.gen` name resolving to a closed port is
        // worse than one that resolves nowhere.
        const routes: DevGenSite[] = [];
        const exposed: ExposedRoute[] = [];
        for (const route of exposure.routes) {
            const port = hostPortFor(route.containerPort) ?? hostPort;
            routes.push({
                workspaceId,
                genName: route.genName,
                // Sub-surfaces get their own resolver key, or the second one
                // would displace the first in the carrier's first-wins merge.
                siteId: route.genName === config.genName ? siteId : `${siteId}:${route.genName}`,
                hostname: route.genName === config.genName
                    ? config.upstreamHost ?? config.genName
                    : route.genName,
                scheme: 'http',
                port,
                loopback: '127.0.0.1',
            });
            if (route.genName !== config.genName) {
                exposed.push({
                    name: route.genName.split('.')[0] ?? route.genName,
                    protocol: route.protocol,
                    genName: route.genName,
                });
            }
        }
        for (const forward of exposure.forwards) {
            exposed.push({
                name: forward.genName.split('.')[0] ?? forward.genName,
                protocol: forward.protocol,
                genName: forward.genName,
                hostPort: hostPortFor(forward.containerPort) ?? forward.hostPort,
            });
        }

        const ready = await probe({
            port: hostPort,
            kind: config.kind,
            hostHeader: config.upstreamHost ?? config.genName,
            timeoutMs: probeTimeoutMs,
        });
        live.set(siteId, {
            workspaceId,
            siteId,
            config,
            containerId,
            hostPort,
            ready,
            routes,
            exposed,
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
            ...(entry.exposed.length ? { exposed: entry.exposed } : {}),
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
                        ...(config.stack ? { stack: config.stack } : {}),
                        ...(config.server ? { server: config.server } : {}),
                        ...(config.build?.length ? { build: config.build } : {}),
                        ...(config.serve ? { serve: config.serve } : {}),
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
                // Only RUNNING sites: a hosted row DISPLACES a discovered one in
                // the overlay, so advertising a dead target would replace a
                // working site with a closed port. A `tcp` site contributes no
                // routes at all, which `exposure.ts` has already decided.
                rows.push(...entry.routes);
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

/**
 * The site container's HEALTHCHECK, or null to inherit the image's own.
 *
 * Only the FrankenPHP production image needs one. It bakes in a check that curls
 * its Caddy admin endpoint on :2019 — which `php-server` mode disables — so the
 * container is reported `(unhealthy)` forever even while it serves correctly
 * (genie #119, Blocker 5). We replace it with a check aimed at the REAL serve
 * port on `/`: ANY HTTP response counts as healthy, exactly the bar
 * `port-probe.ts` uses for `ready`, so an app that boots but returns a 500 is
 * still a server that has BOUND. `curl` is present in the FrankenPHP image — it
 * is what the broken baked check uses. `port` is the container-internal serve
 * port (what FrankenPHP binds `0.0.0.0:<port>` on), not the published host port.
 *
 * Gated on the IMAGE, not the server name: the image is what carries the broken
 * HEALTHCHECK, and no other image Genie serves from (the dev-base image, nginx,
 * a repo's own Dockerfile) bakes one in — so they are left to inherit, and Genie
 * never invents a `curl`/`nc` check for an image that may not have the tool.
 */
function siteHealthcheck(image: string, port: number): ContainerHealthcheck | null {
    if (image !== FRANKENPHP_IMAGE) return null;
    return {
        // -sS (not -f): a 4xx/5xx still means the server BOUND and answered,
        // which is the same bar port-probe.ts uses for readiness. --max-time
        // keeps one hung request from outlasting the health-timeout.
        cmd: `curl -sS -o /dev/null --max-time 5 http://127.0.0.1:${port}/`,
        intervalSec: 10,
        timeoutSec: 5,
        retries: 3,
        // A grace window while FrankenPHP boots — failures here are not counted
        // against the retry budget, so a normal cold start never flaps.
        startPeriodSec: 10,
    };
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
