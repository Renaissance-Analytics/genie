import path from 'node:path';
import {
    ROLE_LABEL,
    SITE_LABEL,
    SITE_ROLE,
    WORKSPACE_LABEL,
    siteBuildVolumeNameFor,
    siteContainerNameFor,
    workspaceSlugFor,
} from './argv';
import { GENIE_DEV_BASE_IMAGE, WORKSPACE_MOUNT_TARGET } from './images';
import { DEFAULT_READY_TIMEOUT_MS, waitForHttp, waitForPort } from './port-probe';
import { planHostAllowlist } from './host-allowlist';
import { planExposure } from './exposure';
import { FRANKENPHP_IMAGE, resolveHostedRun } from './serve-recipe';
import { BUILD_STEP_TIMEOUT_MS, runSiteBuild } from './site-build';
import { prepareIsolatedBuild } from './isolated-build';
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

/**
 * The transient stages a START passes through, surfaced so the card can show
 * something the instant the button is clicked instead of a dead disabled button
 * until the whole build+start finishes (Gap 2).
 *
 *   pulling  — resolving the runtime + ensuring the workspace sandbox (an image
 *              pull streams here on a cold machine)
 *   building — the production build is running (its log streams live)
 *   starting — the site container is being created and its port probed
 *   ready    — terminal: the container is up and the port answered (serving)
 *   failed   — terminal: it did not come up, and `error` says why
 *
 * `ready`/`failed` are the END of a start; the durable truth then lives in the
 * row's {@link DevSiteState} (`running` + `ready`, or `failed`). A phase is only
 * ever set WHILE a start is in flight.
 */
export type DevSitePhase = 'pulling' | 'building' | 'starting' | 'ready' | 'failed';

/** One live progress tick for a starting site, pushed to the renderer (and the
 *  remote bridge) so a card reflects a build as it happens rather than at the end. */
export interface DevSiteProgress {
    workspaceId: string;
    siteId: string;
    name: string;
    genName: string;
    phase: DevSitePhase;
    /** The accumulated build/pull log tail, when there is one to tail. */
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
    /** The stored env + upstream Host, so the Edit form can prefill them (they
     *  are not otherwise visible on a row). `exposed` is deliberately NOT here —
     *  the base status already uses it for the RESOLVED runtime routes. */
    env?: DevSiteConfig['env'];
    upstreamHost?: DevSiteConfig['upstreamHost'];
    /** Set ONLY while a start is in flight (Gap 2): the transient stage a card
     *  reflects live. Absent on a settled row — read `state`/`ready` then. */
    phase?: DevSitePhase;
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
    /**
     * A live START tick (Gap 2). Fired at each phase boundary and on every
     * build/pull log chunk, so the Site Manager card shows a site coming up —
     * `pulling → building → starting → ready|failed`, with the build log
     * streaming — instead of a disabled button until the whole thing finishes.
     *
     * Distinct from {@link onChanged}: that says "re-read the list", this carries
     * the in-flight detail without a round trip. A listener must never throw.
     */
    onProgress?: (progress: DevSiteProgress) => void;
}

export interface DevSiteManager {
    /** Start one configured site. Never throws — a failure is a failed status. */
    start(workspaceId: string, siteId: string): Promise<DevSiteStatus>;
    stop(siteId: string): Promise<void>;
    restart(workspaceId: string, siteId: string): Promise<DevSiteStatus>;
    /**
     * Apply an edited config to a site (Gap 1). Rebuild + restart it when the
     * change requires it (`restart: true` — a running site whose port / build /
     * serve / env / image / routing moved), otherwise leave the container exactly
     * as it is. `previousSiteId` differs from `siteId` only on a RENAME, where the
     * old container (under the old name) is torn down and a new one started.
     * Never throws — a failure is a failed status, like {@link start}.
     */
    reconfigure(
        workspaceId: string,
        siteId: string,
        opts: { previousSiteId: string; restart: boolean },
    ): Promise<DevSiteStatus>;
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
    // --- observable startup (Gap 2) -----------------------------------------
    //
    // A start streams through phases and a build log. The pull + build already
    // write chunks to `deps.onImagePullProgress`; we SHADOW that dep with a pump
    // that both preserves the original sink AND tags each chunk with the site it
    // belongs to, so the existing threading (sandbox / buildImage / runSiteBuild)
    // feeds the renderer with no change to any of those call sites. `inFlight`
    // holds the transient phase + accumulated log per starting site; it is the
    // ONLY place a phase ever lives (a settled row reads `state`/`ready`).
    const originalPull = deps.onImagePullProgress;
    const inFlight = new Map<
        string,
        { workspaceId: string; name: string; genName: string; phase: DevSitePhase; log: string }
    >();
    /** The site the next progress chunk belongs to (set at each phase boundary). */
    let chunkTarget: string | null = null;
    /** Enough of a live build/pull tail to read, without unbounded growth. */
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

    /** Enter a phase for a starting site (and route its log chunks here). */
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

    /** The shadowed progress sink: keep the original behaviour, and tag the
     *  chunk with the current in-flight site so a card can tail it. */
    const pump = (chunk: string): void => {
        originalPull?.(chunk);
        const siteId = chunkTarget;
        if (!siteId) return;
        const f = inFlight.get(siteId);
        if (!f) return;
        f.log = (f.log + chunk).slice(-MAX_PROGRESS_LOG);
        emitProgress(siteId, { log: f.log });
    };

    /** Terminal tick: announce ready|failed, then forget the transient phase so
     *  `list()` reads the real state from here on. */
    const finishProgress = (siteId: string, status: DevSiteStatus): void => {
        const f = inFlight.get(siteId);
        if (!f) return;
        const phase: DevSitePhase = status.state === 'running' ? 'ready' : 'failed';
        const log = status.buildLog ?? (f.log || undefined);
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

        // The instant a start begins — so the card leaves "off" the moment the
        // button is clicked, not when the whole build finishes (Gap 2). Covers
        // runtime resolution + the sandbox ensure, where a cold image pull
        // streams its progress.
        beginPhase(workspaceId, siteId, config, 'pulling');

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

            // Already up (a second window, a re-entrant start, a reconcile
            // pass): ADOPT it and rebuild nothing. A running site does not need
            // to be produced again, and — critically — the build volume it is
            // serving from must not be torn out from under it to make a fresh
            // one. Moved AHEAD of the build so an adopt costs no rebuild.
            const name = siteContainerNameFor(workspaceId, config.name);
            const existing = (await runtime.ps(workspaceId)).find((c) => c.name === name);
            if (existing?.state === 'running') {
                return await recordLive(runtime, workspaceId, siteId, config, existing.id);
            }
            // A stopped leftover under the same name: the published port is fixed
            // at create time and the artifact lives in a freshly built copy, so
            // replace it rather than restart it.
            if (existing) await runtime.remove(existing.id);

            // The build stage (Gap 2): a Dockerfile image build and/or the
            // production build steps below. Their logs stream through the pump.
            if (run.needsBuild || run.build.length) {
                beginPhase(workspaceId, siteId, config, 'building');
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

            // --- BUILD in an ISOLATED copy, then serve ----------------------
            //
            // NEVER the developer's working tree (genie #119, Blocker 4). The
            // build used to `exec` into the workspace dev container over the
            // bind-mounted checkout, so `composer install --no-dev`,
            // `rm -rf vendor node_modules` and `npm run build` all MUTATED the
            // user's live directory — and, as a foreign uid over host-owned
            // files, could not own its own repo (git dubious-ownership) or
            // overwrite a committed file (EPERM). Instead we copy the repo into a
            // container-owned volume and build THERE: the host tree is only ever
            // READ (a read-only bind), production parity is a build from a fresh
            // checkout, and the serve container mounts that same volume.
            //
            // A required step that fails stops the site — starting anyway would
            // serve the previous build while every health signal read green.
            const useIsolatedCopy = run.build.length > 0;
            const buildVolumeName = siteBuildVolumeNameFor(workspaceId, config.name);
            let buildLog: string | undefined;
            if (run.build.length) {
                const prep = await prepareIsolatedBuild({
                    runtime,
                    workspaceId,
                    siteId,
                    siteName: config.name,
                    // Copy the specific repo subdir being served (or the whole
                    // workspace when the site IS the workspace root).
                    hostSource: config.repo
                        ? path.join(workspace.path, 'repos', config.repo)
                        : workspace.path,
                    network: sandbox.network,
                    image: devImage,
                    mountTarget,
                    workdir: run.workdir,
                    platform,
                    ...(deps.hostIds === undefined ? {} : { hostIds: deps.hostIds }),
                    copyTimeoutMs: BUILD_STEP_TIMEOUT_MS,
                    ...(deps.onImagePullProgress
                        ? { onProgress: deps.onImagePullProgress }
                        : {}),
                });
                if (!prep.ok) return failed(workspaceId, siteId, config, prep.error);

                // The build gets the serve env PLUS the auth/git-safety DEFAULTS
                // (genie #119): a git `safe.directory` — no longer load-bearing
                // now that the copy is build-owned, kept as harmless belt-and-
                // suspenders — and, when Genie holds one, the managed GitHub token
                // as COMPOSER_AUTH + GITHUB_TOKEN so github.com dist fetches
                // authenticate instead of hitting the anonymous rate limit. The
                // defaults sit UNDER `env`, so a value the user pinned still wins;
                // the token rides ONLY the build (never the serving container) and
                // is scrubbed from the surfaced build log.
                const auth = buildAuthEnv(deps.githubToken?.());
                const buildEnv = { ...auth.env, ...env };
                const built = await runSiteBuild(run.build, {
                    exec: (id, argv, execOpts) => runtime.exec(id, argv, execOpts),
                    // The ISOLATED build container, not the sandbox — its copy of
                    // the repo, in the container-owned volume, is what gets built.
                    containerId: prep.env.container.id,
                    workdir: run.workdir,
                    env: buildEnv,
                    ...(auth.secrets.length ? { secrets: auth.secrets } : {}),
                    ...(deps.onImagePullProgress
                        ? { onProgress: deps.onImagePullProgress }
                        : {}),
                });
                buildLog = built.log;
                // The build container has served its only purpose — producing the
                // artifact into the volume. Remove it whether the build passed or
                // failed, so a failed build leaves no stopped container behind.
                await runtime.remove(prep.env.container.id).catch(() => {});
                if (!built.ok) {
                    // The copy is worthless without a green build; drop it so the
                    // next attempt starts clean and nothing leaks.
                    await runtime.volumeRemove(buildVolumeName).catch(() => {});
                    return {
                        ...failed(workspaceId, siteId, config, built.error ?? 'The build failed.'),
                        buildLog,
                    };
                }
            }

            // The build (if any) is done; the container is about to be created
            // and its port probed (Gap 2).
            beginPhase(workspaceId, siteId, config, 'starting');

            const exposure = planExposure({
                siteId,
                genName: config.genName,
                port: run.port,
                kind: config.kind,
                ...(config.exposed ? { exposed: config.exposed } : {}),
            });

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
                // Serve from the container-owned build COPY, not the host working
                // tree (genie #119). A site with no build steps has no copy to
                // serve, so it mounts the workspace as before.
                ...(useIsolatedCopy
                    ? { volumes: [{ name: buildVolumeName, target: mountTarget }] }
                    : { mounts: [{ source: workspace.path, target: mountTarget }] }),
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
        const pending = starting.get(siteId);
        if (pending) return pending;
        const promise = startOnce(workspaceId, siteId)
            .then((status) => {
                if (status.state === 'running') lastFailure.delete(siteId);
                else lastFailure.set(siteId, status);
                // Terminal progress tick (Gap 2): announce ready|failed and drop
                // the transient phase so the row settles to its real state.
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
            try {
                await runtime.stop(entry.containerId);
                // Removed, not just stopped: an exited container still holds the
                // published port reservation and the container name.
                await runtime.remove(entry.containerId);
            } catch {
                /* tolerant — the adapter already treats "already gone" as success */
            }
            // Drop the isolated build copy (genie #119). It exists only to serve
            // THIS site; the next start makes a fresh one (production parity). A
            // site that never built has none — volumeRemove is tolerant of that.
            // This is also what cleans it up on workspace removal, whose teardown
            // sweeps containers by label but not volumes.
            try {
                await runtime.volumeRemove(
                    siteBuildVolumeNameFor(entry.workspaceId, entry.config.name),
                );
            } catch {
                /* already gone is success */
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

        async reconfigure(workspaceId, siteId, opts) {
            const { previousSiteId, restart } = opts;

            // A restart-requiring edit on a running site: tear the old container
            // down (under its OLD id/name, which a rename changes) and bring a
            // fresh one up on the new definition. This is also the rename path.
            if (restart) {
                await stop(previousSiteId);
                if (previousSiteId !== siteId) lastFailure.delete(previousSiteId);
                return start(workspaceId, siteId);
            }

            // No restart needed. If it is running, keep it exactly as it is —
            // only refresh the live config so a cosmetic field reads current
            // (and carry the entry across an id change, though a no-restart edit
            // never renames).
            const found = findSite(workspaceId, siteId);
            const entry = live.get(previousSiteId);
            if (entry && found) {
                if (previousSiteId !== siteId) live.delete(previousSiteId);
                const next: Live = { ...entry, siteId, config: found.config };
                live.set(siteId, next);
                changed();
                return statusOf(workspaceId, siteId, found.config, next);
            }

            // Not running: the persisted edit is already stored; there is nothing
            // to reconcile on the container. Report the current state.
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
                    // A start in flight (Gap 2): overlay its transient phase +
                    // live log so a card that mounts mid-build reads the current
                    // stage from a plain `list`, not only from the push stream.
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
                        // Stored env + upstream Host, so the Edit form can prefill
                        // fields a running row does not otherwise carry.
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
