import { devContainerNameFor } from './argv';
import { CADDY_HTTPS_PORT, type CaddySite } from './caddyfile';
import { applyCaddyConfig } from './caddy-proxy';
import { GENIE_DEV_BASE_IMAGE, WORKSPACE_MOUNT_TARGET } from './images';
import { allocateFreePort as realAllocateFreePort, DEFAULT_READY_TIMEOUT_MS, waitForHttp, waitForHttpsSni, waitForPort } from './port-probe';
import { withPort } from './serve-recipe';
import { planHostAllowlist } from './host-allowlist';
import {
    readSiteProcessLog,
    siteProcessAlive,
    startSiteProcess,
    stopSiteProcess,
} from './site-process';
import { composeHostSiteEnv, describeEmptyHostServiceEnv } from './host-site-process';
import { serveCaddyfile, caddyServeArgv, phpFastcgiWorkerCommand } from './serve-config';
import type { HostEnvReport } from './services/service-manager';
import { hostBrowserRoutes as selectHostBrowserRoutes } from './host-browser-routes';
import type { HostSiteRoute } from './host-reconcile';
import { ensureWorkspaceSandbox, HOST_GATEWAY_HOSTNAME } from './workspace-sandbox';
import { effectiveCommand, hostNativeRoute, sandboxCommandFor, type HostNativeRoute } from './sites-config';
import type { ContainerRuntime, RuntimeDetection } from './container-runtime';
import type { HostIds } from './host-ids';
import type { DevSiteConfig, DevSites, HostServeConfig } from './sites-config';
import type { EngineResolution } from './engine-resolve';
import type { LanguageTool } from './toolchain-versions';
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
    /**
     * The origin that actually answers ON THIS MACHINE — and it is NOT the same
     * shape for the two kinds of site (genie#195):
     *
     *  - a CONTAINER site's `hostPort` is the sandbox's Caddy, which speaks TLS and
     *    routes by SNI, so the origin is `https://<genName>:<hostPort>`;
     *  - a HOST-NATIVE site holds the port itself and speaks plain http, so it is
     *    `http://127.0.0.1:<port>`.
     *
     * Printing one form for both is what made `curl http://127.0.0.1:<port>/` answer
     * "Client sent an HTTP request to an HTTPS server" and read like an app bug. The
     * https form still needs the SNI name pinned to loopback — see {@link localCurl}.
     */
    localOrigin?: string;
    /** The exact command that reaches {@link localOrigin} from this machine, SNI
     *  and all — so nobody has to reconstruct it from the port. */
    localCurl?: string;
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
    /** How Genie serves this host-native site (static/php), so the Edit form's
     *  serve-mode picker prefills. Absent ⇒ the repo's own dev server. */
    hostServe?: DevSiteConfig['hostServe'];
    /** Opt-in: `<name>.gen` exposed to real external browsers (story #238). */
    browserExposed?: DevSiteConfig['browserExposed'];
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

/** Runs a HOST-NATIVE site's dev server as a real HOST process (story #238),
 *  keyed by siteId. The site manager owns lifecycle + routing; this owns the
 *  actual process (detached spawn, pid, log). Never throws — a failure is an
 *  `ok:false` result / `false`. The real binding uses Node child_process +
 *  host-site-process.ts; tests inject a fake. */
export interface HostProcessRun {
    start(input: {
        siteId: string;
        workspaceId: string;
        command: string[];
        /** The repo dir ON THE HOST (not a container mount). */
        cwd: string;
        env: Record<string, string>;
        /** A one-line `[genie]` note prepended to the site's log before the dev
         *  server's own output — used to record a start-time diagnostic (e.g. the
         *  workspace's services resolved to no host env) where `manageSite logs`
         *  and the progress tail will show it. */
        note?: string;
        /** The loopback port this run serves on. Recorded with the run so a Genie
         *  that restarts can re-ROUTE `.gen` to a dev server still serving on it,
         *  instead of leaving it orphaned (genie#190). */
        port?: number;
    }): Promise<{ ok: true; pid: number } | { ok: false; error: string }>;
    stop(siteId: string): Promise<void>;
    alive(siteId: string): Promise<boolean>;
    readLog(siteId: string, tail?: number): Promise<string>;
    /**
     * The runs this binding can still account for — pid ALIVE, port known — after
     * a Genie restart. `adopt()` re-attaches exactly these (genie#190).
     *
     * Optional because a leaner binding may keep no cross-restart registry at all;
     * absent simply means "nothing to re-attach", which is what every build did
     * before the registry was persisted.
     */
    running?(): Promise<Array<{ siteId: string; port: number }>>;
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
    /**
     * HOST-FORM service env (127.0.0.1:<published port>) for a HOST-NATIVE site's
     * dev server — the same host-form env terminals + manageProcess already get
     * (beta.237), so the dev server reaches the managed DB/redis on the host.
     * Merged UNDER the site's own env.
     */
    serviceHostEnvFor?: (workspaceId: string) => Promise<Record<string, string>>;
    /**
     * HOST-FORM service env WITH the diagnostic that explains an EMPTY result
     * (enabled vs live vs host-published counts). Preferred over
     * {@link serviceHostEnvFor} when present: its `env` is used the same way, and
     * when a host-native site's workspace has services enabled but the env is
     * empty, the start records an actionable line to the site log instead of
     * silently serving DB-less (moic's beta.245 report). Absent ⇒ fall back to
     * {@link serviceHostEnvFor} (no diagnostic).
     */
    serviceHostEnvReportFor?: (workspaceId: string) => Promise<HostEnvReport>;
    /**
     * A one-line warning when the repo at `cwd` declares a runtime version (php/
     * node/go/python, from its stack) the HOST doesn't match — surfaced in the site
     * log at start (goal item 4, interim: detect + validate + warn). Absent ⇒ no
     * engine-version validation. Composed in the host layer from the repo's declared
     * version + a host `<engine> --version` probe.
     */
    engineMismatchNote?: (cwd: string, stack?: string) => Promise<string | null>;
    /**
     * WHICH runtime a Genie-served site spawns (genie#207) — the site's pinned
     * version, else the machine default, resolved to the ABSOLUTE executable
     * inside the toolchain install Genie owns (`engine-resolve.ts`, wired to the
     * real scan in the host layer).
     *
     * Absent ⇒ a `hostServe` mode that needs an engine FAILS. It deliberately does
     * not degrade to a bare `php-cgi`: that PATH lookup is genie#206 — on a Herd
     * machine PATH holds a `php.bat` shim, the win32 spawn goes through a shell,
     * and the missing binary still returns a pid, so the site reports "Serving."
     * while every request 502s.
     */
    resolveEngine?: (req: {
        tool: LanguageTool;
        /** The binary inside the install to spawn — `php-cgi` for the worker. */
        bin: string;
        /** The site's pin. Omitted ⇒ the machine default. */
        version?: string;
    }) => Promise<EngineResolution>;
    /**
     * Run a HOST-NATIVE site's dev server as a real HOST process (story #238).
     * Absent ⇒ a `runMode: 'host'` site fails with a clear "not available" status
     * rather than silently falling back to a container.
     */
    hostSpawn?: HostProcessRun;
    /**
     * Allocate a guaranteed-free host port for a managed host-native site, never
     * one already held by a live site (passed in `exclude`). The HOST owns ports —
     * agents never pick one — so two sites can never collide. Injectable for tests;
     * defaults to the real loopback allocator.
     */
    allocateFreePort?: (exclude: Set<number>) => Promise<number>;
    /**
     * Absolute path to Genie's bundled Caddy binary — the web server Genie runs to
     * serve a host-native site that is NOT its own dev server (a `hostServe` static
     * or php site). Absent ⇒ those serve modes fail with a clear "not available"
     * status. The reverse-proxy (repo-dev-server) path never needs it.
     */
    caddyBin?: string;
    /**
     * Write a per-site generated web-server config (a Caddyfile) and return its
     * absolute path — so `startHostNativeManaged` can point Genie's Caddy at it.
     * Injectable so the serve orchestration is unit-tested without touching disk.
     */
    writeServeConfig?: (siteId: string, content: string) => string;
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
    /**
     * Bring back the ENABLED sites that are not running (genie#190, genie#216).
     * Boot only, and strictly after {@link adopt} — what survived is adopted, what
     * did not is started. A site nobody enabled is never started. Never throws.
     */
    resumeEnabledSites(): Promise<void>;
    /** RUNNING http sites as Testing-Browser rows. Synchronous. */
    genSites(): DevGenSite[];
    /** The browser-exposed HOST-NATIVE routes across all workspaces — the input to
     *  the external-browser host reconcile (story #238). Synchronous. */
    hostBrowserRoutes(): HostSiteRoute[];
    stopAll(): Promise<void>;
}

// --- implementation ---------------------------------------------------------

interface Live {
    workspaceId: string;
    siteId: string;
    config: DevSiteConfig;
    /** The SANDBOX container the process runs in (shared by every site in the
     *  workspace). Absent for a HOST-NATIVE site (story #238): it runs no container. */
    containerId?: string;
    /** The port `.gen` is reached through — the sandbox's published Caddy port for a
     *  container site, or the host loopback dev-server port for a host-native one. */
    caddyHostPort: number;
    /** The app's own loopback port INSIDE the sandbox — what Caddy proxies to.
     *  Absent for a host-native site (there is no sandbox hop). */
    internalPort?: number;
    ready: boolean;
    /** The `.gen` rows this site contributes (its own). Resolved at start so
     *  `genSites()` stays synchronous. */
    routes: DevGenSite[];
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * PURE. How a running site is reached FROM THIS MACHINE — the honest answer to
 * "what do I curl?" (genie#195).
 *
 * The two shapes are genuinely different protocols on the loopback port, and the
 * bug this exists to end was labelling both as `http://127.0.0.1:<port>`:
 *
 *  - `sniTls` (a CONTAINER site) — the port belongs to the sandbox's Caddy, which
 *    TLS-terminates every `.gen` and picks the vhost by SNI. A plain-http request
 *    gets "Client sent an HTTP request to an HTTPS server", and even the https URL
 *    needs `--resolve`, because `<genName>` resolves nowhere on this machine.
 *  - otherwise (a HOST-NATIVE site) — the dev server holds the port itself and
 *    speaks plain http, which is exactly why `.gen` for it is terminated elsewhere.
 */
export function siteLocalReach(site: {
    genName: string;
    /** The loopback port that is actually published/held. */
    port: number;
    /** True when that port is the sandbox's Caddy (TLS, routed by SNI). */
    sniTls: boolean;
}): { localOrigin: string; localCurl: string } {
    if (!site.sniTls) {
        const origin = `http://127.0.0.1:${site.port}`;
        return { localOrigin: origin, localCurl: `curl -s ${origin}/` };
    }
    const origin = `https://${site.genName}:${site.port}`;
    return {
        localOrigin: origin,
        // `-k` because Caddy's loopback leaf is signed by its internal CA, and
        // `--resolve` because the SNI name has to be the `.gen` one for Caddy to
        // route to this vhost at all.
        localCurl: `curl -sk --resolve ${site.genName}:${site.port}:127.0.0.1 ${origin}/`,
    };
}

/** A repo name safe to append to the container-side mount point. */
const SAFE_REPO = /^[A-Za-z0-9._-]+$/;

/** The repo's live-mounted dir inside the sandbox, or null when the repo name is
 *  unsafe (it becomes a path segment under the mount). */
function repoCwd(mountTarget: string, repo: string): string | null {
    if (!repo) return mountTarget;
    if (!SAFE_REPO.test(repo) || repo === '.' || repo === '..') return null;
    return `${mountTarget}/repos/${repo}`;
}

/** The repo's dir ON THE HOST (workspace root, or `repos/<repo>`), or null when the
 *  repo name is unsafe. A HOST-NATIVE site (story #238) runs its dev server here —
 *  the real on-disk repo — not in a container mount. */
function repoCwdOnHost(workspacePath: string, repo: string): string | null {
    if (!repo) return workspacePath;
    if (!SAFE_REPO.test(repo) || repo === '.' || repo === '..') return null;
    return `${workspacePath}/repos/${repo}`;
}

/** The absolute docroot Genie's Caddy serves for a host-serve site: the repo dir
 *  plus the (already sanitized, repo-relative) serve root. Guarded against a `..`
 *  even so — it becomes a served directory, so it must not climb out of the repo. */
function resolveServeRoot(cwd: string, rel: string): string | null {
    if (rel.split(/[\\/]/).some((seg) => seg === '..')) return null;
    return `${cwd}/${rel}`.replace(/\/+$/, '');
}

/** The companion process key for a PHP site's FastCGI worker. A PHP site runs TWO
 *  host processes — Genie's Caddy (keyed by the site id) and a `php-cgi` worker
 *  (this key) — so a distinct hostSpawn key lets the one-process-per-key registry
 *  manage the worker beside the Caddy with no registry changes. Matches SITE_ID_RE
 *  (`[A-Za-z0-9_-]+`) because a site id is an alnum hash. */
/** How long a companion worker gets to fall over before we believe it started.
 *  A shell that could not find its command exits in tens of milliseconds; a real
 *  `php-cgi` is still there. Short enough not to be felt on a good start. */
const WORKER_SETTLE_MS = 400;

function fcgiSiteId(siteId: string): string {
    return `${siteId}-fcgi`;
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
    const allocateFreePort = deps.allocateFreePort ?? realAllocateFreePort;

    /** Sites that are up, keyed by siteId. */
    const live = new Map<string, Live>();
    const lastFailure = new Map<string, DevSiteStatus>();
    const starting = new Map<string, Promise<DevSiteStatus>>();

    /** Ports currently held by live sites — passed to the allocator so a new site
     *  can never be handed a port another live site already holds. */
    const livePortSet = () => new Set([...live.values()].map((e) => e.caddyHostPort));

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
            // A HOST-NATIVE site (story #238) is served straight off its host port,
            // not through the sandbox Caddy, and has no internal container port — so
            // it contributes no vhost here.
            if (e.internalPort === undefined) continue;
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

        // HOST-NATIVE (story #238): the site points `.gen` at a dev server already
        // running as a HOST process (e.g. started via manageProcess) on
        // 127.0.0.1:<hostPort>. Register its route and probe it — spawn NOTHING, and
        // need NO container runtime. This is the owner's model: "just serve the repo
        // the site points to; don't use containers." Guarded, so the container path
        // below is untouched for ordinary sites.
        const hostRoute = hostNativeRoute(config);
        if (hostRoute) {
            beginPhase(workspaceId, siteId, config, 'starting');
            return await recordHostNativeLive(workspaceId, siteId, config, hostRoute);
        }

        // MANAGED HOST-NATIVE (story #238): Genie runs the repo's dev server as a
        // HOST process (no container) and routes `.gen` to it — "just serve the repo
        // the site points to", the way Herd did (Docker only for services).
        if (config.runMode === 'host') {
            return await startHostNativeManaged(workspaceId, siteId, config, workspace.path);
        }

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
                // Weakest, so a user can override: how to reach a HOST
                // `manageProcess` service from inside the sandbox. A site's
                // `localhost` is the SANDBOX, not the host, so a host-bound manager
                // is unreachable via 127.0.0.1 — apps use GENIE_HOST_GATEWAY
                // instead (backed by the sandbox's host-gateway add-host, #130).
                GENIE_HOST_GATEWAY: HOST_GATEWAY_HOSTNAME,
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

    /**
     * Record a HOST-NATIVE site (story #238): one whose `.gen` points straight at a
     * dev server already running as a HOST process on `127.0.0.1:<hostPort>`. No
     * container, no Caddy — just the route + a plain-http readiness probe on the
     * host port. The Testing Browser's session-CA shim terminates TLS at `.gen`, so
     * the plain-http dev server is reachable as `https://<name>.gen` with nothing
     * else. This is what makes "run a dev server and point a site at it" work.
     */
    async function recordHostNativeLive(
        workspaceId: string,
        siteId: string,
        config: DevSiteConfig,
        route: HostNativeRoute,
        probeTimeoutMs: number = readyTimeoutMs,
    ): Promise<DevSiteStatus> {
        const routes: DevGenSite[] = [
            {
                workspaceId,
                genName: config.genName,
                siteId,
                hostname: config.genName,
                // Plain http on the host port; the Testing Browser's shim adds TLS.
                scheme: route.scheme,
                port: route.port,
                loopback: route.loopback,
            },
        ];
        live.set(siteId, { workspaceId, siteId, config, caddyHostPort: route.port, ready: false, routes });

        const ready = await probe({
            port: route.port,
            kind: 'http',
            // NO servername: a host-native dev server speaks PLAIN HTTP on the host
            // port, so the probe must use waitForHttp — a servername would route it
            // to the HTTPS-SNI path, whose TLS handshake fails against the plain-http
            // port and reports ready:false for a site that is actually up (genie#160).
            hostHeader: config.upstreamHost ?? config.genName,
            timeoutMs: probeTimeoutMs,
        });
        const entry = live.get(siteId);
        if (entry) entry.ready = ready;
        changed();
        return statusOf(workspaceId, siteId, config, live.get(siteId)!);
    }

    /**
     * Re-attach every HOST-NATIVE dev server that outlived the last Genie (#190).
     *
     * The spawn is deliberately detached, so a restart — and above all an UPDATE,
     * which is a quit — leaves the dev servers running. Which pids those were is
     * the one thing this process cannot re-derive, so the spawn binding persists
     * its registry and reports back the runs still alive (`running()`); everything
     * here does is turn each of those into the live entry + `.gen` route the rest
     * of Genie reads. A run whose process is gone is simply absent from that list,
     * so it stays reported as stopped and nothing is invented.
     *
     * Never throws: adoption runs once at boot and gets no second chance, so one
     * unreadable site must not abandon the others.
     */
    async function adoptHostNative(): Promise<void> {
        const hostSpawn = deps.hostSpawn;
        if (!hostSpawn?.running) return;
        let recovered: Array<{ siteId: string; port: number }> = [];
        try {
            recovered = await hostSpawn.running();
        } catch {
            return;
        }
        if (recovered.length === 0) return;
        const ports = new Map(recovered.map((r) => [r.siteId, r.port]));
        for (const workspace of deps.listWorkspaces()) {
            for (const [siteId, config] of Object.entries(deps.devSitesFor(workspace.id))) {
                if (config.runMode !== 'host' || live.has(siteId)) continue;
                const port = ports.get(siteId);
                if (port === undefined) continue;
                try {
                    // A SHORT probe, like the container pass: the dev server is
                    // already up, so a healthy one answers at once.
                    await recordHostNativeLive(
                        workspace.id,
                        siteId,
                        config,
                        {
                            genName: config.genName,
                            scheme: 'http',
                            loopback: '127.0.0.1',
                            port,
                            ...(config.upstreamHost ? { upstreamHost: config.upstreamHost } : {}),
                        },
                        ADOPT_PROBE_MS,
                    );
                } catch {
                    /* one unreadable site must not abandon the rest */
                }
            }
        }
    }

    /**
     * Start a MANAGED HOST-NATIVE site (story #238): run the repo's dev server as a
     * real HOST process (no container) and route `.gen` to it. Genie owns the
     * process (via {@link DevSiteManagerDeps.hostSpawn}); the dev server runs in the
     * repo's real on-disk dir with the workspace's HOST-FORM service env (beta.237),
     * so it reaches the managed DB/redis. Nothing is containerised.
     */
    /**
     * How Genie serves a `hostServe` site with its bundled Caddy — the agent wrote
     * no server config. `static` serves a built directory (optional SPA fallback) in
     * ONE process (`command` = Caddy). `php` is the nginx model in TWO: `command` is
     * still Caddy (`php_fastcgi` over `public/`), and `worker` is a `php-cgi` FastCGI
     * server on a SECOND allocated port that the Caddyfile points at — the caller
     * starts the worker as a companion process. Returns a clear failure rather than
     * spawning nothing.
     */
    async function planHostServe(
        hostServe: HostServeConfig,
        cwd: string,
        sitePort: number,
        siteId: string,
    ): Promise<
        | { ok: true; command: string[]; worker?: string[]; workerRuns?: string }
        | { ok: false; error: string }
    > {
        if (!deps.caddyBin || !deps.writeServeConfig) {
            const which = hostServe.mode === 'php' ? 'PHP' : 'Static';
            return {
                ok: false,
                error: `${which} serving is not available in this build (Genie has no bundled Caddy here).`,
            };
        }
        const root = resolveServeRoot(cwd, hostServe.root);
        if (!root) {
            return { ok: false, error: `Invalid serve root ${JSON.stringify(hostServe.root)}.` };
        }
        if (hostServe.mode === 'php') {
            // WHICH php (genie#207): the site's pin, else the machine default,
            // resolved to the real `php-cgi` inside a Genie-owned install. Resolved
            // FIRST — before a port is taken or a config written — so a site that
            // cannot name its runtime fails having changed nothing.
            if (!deps.resolveEngine) {
                return {
                    ok: false,
                    error: 'PHP serving is not available in this build (Genie cannot resolve a managed PHP here).',
                };
            }
            const engine = await deps.resolveEngine({
                tool: 'php',
                bin: 'php-cgi',
                ...(hostServe.version ? { version: hostServe.version } : {}),
            });
            if (!engine.ok) return { ok: false, error: engine.error };
            // A SECOND guaranteed-free port for the FastCGI worker — never the site
            // port or one a live site holds.
            const fcgiPort = await allocateFreePort(new Set([...livePortSet(), sitePort]));
            const caddyfile = serveCaddyfile({ sitePort, serve: { kind: 'php', root, fcgiPort } });
            const configPath = deps.writeServeConfig(siteId, caddyfile);
            return {
                ok: true,
                command: caddyServeArgv(deps.caddyBin, configPath),
                worker: phpFastcgiWorkerCommand(engine.exe, fcgiPort),
                workerRuns: `PHP ${engine.version} (${engine.exe})`,
            };
        }
        const caddyfile = serveCaddyfile({
            sitePort,
            serve: { kind: 'static', root, spa: hostServe.spa ?? false },
        });
        const configPath = deps.writeServeConfig(siteId, caddyfile);
        return { ok: true, command: caddyServeArgv(deps.caddyBin, configPath) };
    }

    async function startHostNativeManaged(
        workspaceId: string,
        siteId: string,
        config: DevSiteConfig,
        workspacePath: string,
    ): Promise<DevSiteStatus> {
        const cwd = repoCwdOnHost(workspacePath, config.repo);
        if (cwd === null) {
            return failed(workspaceId, siteId, config, `Invalid repo name ${JSON.stringify(config.repo)}.`);
        }
        if (!deps.hostSpawn) {
            return failed(
                workspaceId,
                siteId,
                config,
                'Host-native hosting is not available in this build, so this site cannot run without a container.',
            );
        }
        const hostSpawn = deps.hostSpawn;

        const buildRoute = (port: number): HostNativeRoute => ({
            genName: config.genName,
            scheme: 'http',
            loopback: '127.0.0.1',
            port,
            ...(config.upstreamHost ? { upstreamHost: config.upstreamHost } : {}),
        });

        beginPhase(workspaceId, siteId, config, 'starting');

        // Already running (a reconcile, a re-entrant start): re-record on its LIVE
        // port — don't allocate a fresh one and don't respawn.
        const existing = live.get(siteId);
        if (existing && (await hostSpawn.alive(siteId))) {
            return await recordHostNativeLive(workspaceId, siteId, config, buildRoute(existing.caddyHostPort));
        }
        live.delete(siteId);

        // The HOST owns the port: allocate a guaranteed-free one (never a port a live
        // site already holds) and rewrite the command to bind exactly that — so two
        // sites can never collide and `.gen` always routes to the right app. The
        // stored `config.port` is ignored on this path precisely because a fixed
        // stored port is the collision vector.
        const port = await allocateFreePort(livePortSet());

        // How the site is served on `port`:
        //   - `hostServe` → GENIE serves it with its bundled Caddy (a built dir, or
        //     public/ via FastCGI) — the agent wrote no server config;
        //   - otherwise → the repo's OWN dev server, reverse-proxied (Phase 1).
        let command: string[];
        let worker: string[] | undefined;
        /** WHICH runtime the worker is, for the failure text — a message blaming
         *  PATH would send someone to fix the wrong thing now that the version is
         *  resolved through the toolchain (genie#207). */
        let workerRuns: string | undefined;
        let portEnv: Record<string, string> = {};
        if (config.hostServe) {
            const planned = await planHostServe(config.hostServe, cwd, port, siteId);
            if (!planned.ok) return failed(workspaceId, siteId, config, planned.error);
            command = planned.command;
            worker = planned.worker;
            workerRuns = planned.workerRuns;
        } else {
            const baseCommand = effectiveCommand(config);
            if (!baseCommand) {
                return failed(
                    workspaceId,
                    siteId,
                    config,
                    `Host-native site "${config.name}" has no command — set its \`command\`, e.g. ["php","artisan","serve"].`,
                );
            }
            const withP = withPort(baseCommand, port, {
                ...(config.stack ? { stack: config.stack } : {}),
                ...(config.framework ? { framework: config.framework } : {}),
            });
            command = withP.command;
            portEnv = withP.env;
        }

        // Same env precedence as a container site, but HOST-FORM services (beta.237).
        // `portEnv` (the allocated PORT, for stacks that read it) is stamped LAST so
        // the host-owned port always wins. Prefer the REPORT form: it carries the
        // enabled/live/host-published counts, so when a workspace has services but
        // the env comes back empty we can say WHY in the log rather than start the
        // site pointed at nothing and let it 500 in silence (moic's beta.245 report).
        const notes: string[] = [];
        let serviceHostEnv: Record<string, string> = {};
        if (deps.serviceHostEnvReportFor) {
            const report = await deps.serviceHostEnvReportFor(workspaceId).catch(() => null);
            serviceHostEnv = report?.env ?? {};
            const n = report ? describeEmptyHostServiceEnv(report) : null;
            if (n) notes.push(n);
        } else if (deps.serviceHostEnvFor) {
            serviceHostEnv = await deps.serviceHostEnvFor(workspaceId).catch(() => ({}));
        }
        // Engine-version validation (goal item 4, interim): a host-native site runs
        // on the HOST's runtime, so warn — don't fail — when the repo declares a
        // php/node/go/python version the host doesn't match.
        if (deps.engineMismatchNote) {
            const n = await deps.engineMismatchNote(cwd, config.stack).catch(() => null);
            if (n) notes.push(n);
        }
        const note = notes.length ? notes.join('\n') : undefined;
        const env = { ...composeHostSiteEnv(config, command, serviceHostEnv), ...portEnv };

        // PHP (nginx model): bring up the FastCGI worker — a companion process keyed
        // `<siteId>-fcgi` — BEFORE the Caddy that proxies to it, in the repo cwd with
        // the SAME env (so PHP reaches the managed DB). If the worker will not start,
        // the site cannot serve, so fail before spawning a Caddy pointed at nothing.
        if (worker) {
            const workerId = fcgiSiteId(siteId);
            const workerStarted = await hostSpawn.start({
                siteId: workerId,
                workspaceId,
                command: worker,
                cwd,
                env,
            });
            if (!workerStarted.ok) {
                return failed(
                    workspaceId,
                    siteId,
                    config,
                    `The PHP FastCGI worker did not start: ${workerStarted.error}`,
                );
            }
            // A PID IS NOT PROOF IT RAN (genie#206). On Windows the command goes
            // through a SHELL — it has to, since php/npm are `.cmd` shims — so a
            // MISSING `php-cgi` starts cmd.exe successfully, prints "'php-cgi' is
            // not recognized", and exits. The start reports ok, the worker is dead,
            // and Caddy then comes up in front of a backend that never answers:
            // the site says "Serving." while every request 502s.
            //
            // So confirm it is still there a moment later, and when it is not, fail
            // with the WORKER'S OWN OUTPUT — that log line is the entire diagnosis
            // and it otherwise sits in a file nothing reads.
            await new Promise((r) => setTimeout(r, WORKER_SETTLE_MS));
            if (!(await hostSpawn.alive(workerId).catch(() => false))) {
                const why = (await hostSpawn.readLog(workerId, 20).catch(() => '')).trim();
                await hostSpawn.stop(workerId).catch(() => {});
                return failed(
                    workspaceId,
                    siteId,
                    config,
                    `The PHP FastCGI worker exited immediately, so this site cannot serve PHP.${
                        why ? `\n\n${why}` : ''
                    }${
                        workerRuns ? `\n\nGenie ran ${workerRuns}.` : ''
                    }\n\nCheck that install in Settings → Toolchain → Languages, or point the site at another version.`,
                );
            }
        }

        const started = await hostSpawn.start({
            siteId,
            workspaceId,
            command,
            cwd,
            env,
            ...(note ? { note } : {}),
            // The ALLOCATED port travels with the run so the next Genie can route
            // `.gen` back to this dev server instead of orphaning it (genie#190) —
            // `config.port` is deliberately not it, the host owns the port here.
            port,
        });
        if (!started.ok) {
            // Don't orphan the worker if the Caddy failed to come up.
            if (worker) await hostSpawn.stop(fcgiSiteId(siteId)).catch(() => {});
            return failed(workspaceId, siteId, config, `The dev server did not start: ${started.error}`);
        }
        return await recordHostNativeLive(workspaceId, siteId, config, buildRoute(port));
    }

    function statusOf(
        workspaceId: string,
        siteId: string,
        config: DevSiteConfig,
        entry: Live,
    ): DevSiteStatus {
        // What answers on THIS machine, in the protocol the port really speaks: a
        // container site's port is the sandbox Caddy (TLS + SNI), a host-native
        // site's is the dev server itself (plain http). See `siteLocalReach`.
        const local =
            config.kind === 'http'
                ? siteLocalReach({
                      genName: config.genName,
                      port: entry.caddyHostPort,
                      sniTls: entry.internalPort !== undefined,
                  })
                : null;
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
            ...(local ? { localOrigin: local.localOrigin, localCurl: local.localCurl } : {}),
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
        if (!entry) {
            // Not live (already stopped, or never started) — but a browser-exposed
            // site may still have a `.gen` hosts line / host-Caddy vhost from a prior
            // run, so fire changed() to let the host-browser reconcile DRAIN it. A
            // redundant schedule is harmless (the reconcile no-ops when in sync).
            changed();
            return;
        }
        live.delete(siteId);
        // MANAGED HOST-NATIVE (story #238): Genie owns the dev server process — stop
        // it. No container runtime involved.
        if (entry.config.runMode === 'host') {
            if (deps.hostSpawn) {
                await deps.hostSpawn.stop(siteId).catch(() => {});
                // Stop the PHP FastCGI worker companion too — a no-op for a static or
                // proxy site, which has no such process tracked.
                await deps.hostSpawn.stop(fcgiSiteId(siteId)).catch(() => {});
            }
            changed();
            return;
        }
        const { runtime } = await deps.resolveRuntime();
        // An EXTERNAL host-native site (hostPort, no container) runs no process Genie
        // owns — dropping its route above IS the stop; the dev server it points at is
        // the user's own host process (via manageProcess), left running.
        if (runtime && entry.containerId) {
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
            // HOST-NATIVE first, and OUTSIDE the runtime gate (genie#190). A
            // host-native site's whole point is that there is no container, so
            // returning early on "no Docker" left exactly the sites that need this
            // most unadopted: the dev server is spawned to outlive the call that
            // started it, so it outlives Genie too, and an unadopted one keeps
            // serving on its port while `genSites()` does not know it exists — the
            // same orphan the container pass below exists to prevent.
            await adoptHostNative();

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
                        ...(config.hostServe ? { hostServe: config.hostServe } : {}),
                        ...(config.browserExposed ? { browserExposed: config.browserExposed } : {}),
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
            // MANAGED HOST-NATIVE (story #238): Genie owns the dev server process, so
            // its captured output IS available.
            if (entry.config.runMode === 'host') {
                if (!deps.hostSpawn) {
                    return 'Host-native hosting is not available, so the log cannot be read.';
                }
                const main = await deps.hostSpawn.readLog(siteId, tail);
                // A PHP site is TWO processes, and the interesting failures happen in
                // the one nobody was showing (genie#206): the front Caddy logs a
                // tidy 502 while the FastCGI worker's log holds the actual reason
                // ("'php-cgi' is not recognized"). Show both, labelled.
                if (entry.config.hostServe?.mode !== 'php') return main;
                const workerLog = (await deps.hostSpawn
                    .readLog(fcgiSiteId(siteId), tail)
                    .catch(() => '')).trim();
                return workerLog
                    ? `${main}\n\n--- PHP FastCGI worker ---\n${workerLog}`
                    : main;
            }
            // An EXTERNAL host-native site (hostPort) has no container and no process
            // Genie owns: its output is the user's own dev server log.
            if (!entry.containerId) {
                return `This site points at a host dev server on 127.0.0.1:${entry.caddyHostPort}. Its output is that dev server's own log, not a container log.`;
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

        async resumeEnabledSites() {
            // Resolved ONCE, and only to answer "is a container runtime up yet".
            // Docker Desktop routinely finishes starting after Genie does, and
            // trying anyway would stamp every container site with a "no container
            // runtime" failure on every launch — a worse lie than "stopped", and
            // one the user then has to clear by hand.
            let hasRuntime = false;
            try {
                hasRuntime = !!(await deps.resolveRuntime()).runtime;
            } catch {
                hasRuntime = false;
            }
            for (const workspace of deps.listWorkspaces()) {
                for (const [siteId, config] of Object.entries(deps.devSitesFor(workspace.id))) {
                    // `enabled` IS the ask. A site nobody enabled still starts
                    // nothing, which is the policy `adopt()` states and this keeps.
                    if (!config.enabled) continue;
                    // Adopted a moment ago (it survived), or started by a concurrent
                    // caller — either way it is already serving.
                    if (live.has(siteId)) continue;
                    // A host-native site needs no runtime — that is the whole point
                    // of it — so it is never held back by Docker's absence.
                    if (config.runMode !== 'host' && !hasRuntime) continue;
                    try {
                        await start(workspace.id, siteId);
                    } catch {
                        // A site that will not come back must not stop the others —
                        // this runs once at boot and gets no second chance. `start`
                        // already records the failure for `list`/`logs` to show.
                    }
                }
            }
        },

        genSites() {
            const rows: DevGenSite[] = [];
            for (const entry of live.values()) rows.push(...entry.routes);
            return rows;
        },

        hostBrowserRoutes() {
            return selectHostBrowserRoutes(
                [...live.values()].map((e) => ({ config: e.config, port: e.caddyHostPort })),
            );
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

/** The browser-exposed host-native routes for the external-browser reconcile
 *  (story #238). `[]` when the dev server was never initialised. */
export function devServerHostBrowserRoutes(): HostSiteRoute[] {
    return instance?.hostBrowserRoutes() ?? [];
}

/** Test-only: drop the process-wide instance. */
export function resetDevSitesForTests(): void {
    instance = null;
}
