import { deriveGenName } from '../mobile/hosts';
import { ensureBuilt as realEnsureBuilt } from './build';
import { createFrankenPhpRuntime } from './frankenphp';
import { ensureFrankenPhp as realEnsureFrankenPhp } from './frankenphp-fetch';
import { createStaticRuntime } from './static';
import { workspaceServiceEnv } from './services/manager';
import { hostedSiteIdFor, resolveHostedSite } from './sites-config';
import type { EnsureBuiltOptions } from './build';
import type { EnsureFrankenPhpOptions, FrankenPhpInstall } from './frankenphp-fetch';
import type { FrankenPhpRuntimeOptions } from './frankenphp';
import type { HostedSiteConfig, HostedSites } from './sites-config';
import type { HostedSite, HostedState, HostedStatus, HostingBackend, SiteRuntime } from './types';

/**
 * The hosting MANAGER (Tynn #232, P2) — the piece that turns "this workspace has
 * a site enabled" into a running server, and reports what is live.
 *
 * The adapters know how to serve ONE site; this knows the policy around them,
 * and the policy is where the owner's decisions live:
 *
 *   - A **PHP** site fetches the FrankenPHP runtime on FIRST USE (~277 MB,
 *     checksum-verified, once per machine per version).
 *   - A **STATIC** site never does. It builds instead, so previewing a frontend
 *     costs nothing but a `vite build`.
 *   - A site that is not RUNNING is not advertised. A hosted entry SHADOWS the
 *     hosts-file-discovered one for its hostname (see `sites/local-sites.ts`),
 *     so advertising a site that failed to start would replace a working Herd
 *     target with a dead port — strictly worse than not hosting at all.
 *
 * Failures are STATUSES, not exceptions: `reconcile()` starts every enabled site
 * on boot, and one workspace with a broken build must not take the others (or
 * the app) down with it.
 *
 * Every dependency is injected, so the whole policy is unit-tested without a
 * download, a build or a bound port. `initHosting` at the bottom is the one
 * process-wide instance the IPC layer and the Testing Browser read.
 */

// --- deps ------------------------------------------------------------------

export interface HostingWorkspace {
    id: string;
    /** The workspace root on disk — every docroot is relative to this. */
    path: string;
}

export interface HostingManagerDeps {
    /** Genie's userData dir: where the fetched runtime and Caddy's state live.
     *  Must persist across app updates. */
    baseDir: string;
    listWorkspaces(): HostingWorkspace[];
    hostedSitesFor(workspaceId: string): HostedSites;
    platform?: NodeJS.Platform | string;
    // Seams — the real implementations by default.
    ensureRuntime?: (opts: EnsureFrankenPhpOptions) => Promise<FrankenPhpInstall>;
    ensureBuilt?: (opts: EnsureBuiltOptions) => Promise<{ built: boolean }>;
    createFrankenPhp?: (opts: FrankenPhpRuntimeOptions) => SiteRuntime;
    createStatic?: () => SiteRuntime;
    /**
     * The managed-service environment for a workspace (#232 P3).
     *
     * A hosted Laravel app has to reach its database, and the cleanest way to
     * tell it where is the one every real deployment uses: real environment
     * variables on the server process. That path writes NOTHING to the user's
     * repository — `services/env.ts` explains why there is a second, file-based
     * path as well, and why it is the more dangerous of the two.
     *
     * Injected (rather than imported and called) so the site manager's tests
     * stay free of the service manager, and so a host with no services at all
     * simply supplies `{}`.
     */
    serviceEnvFor?: (workspaceId: string) => Record<string, string>;
}

/** One configured site plus whatever the runtime currently says about it. */
export interface HostedSiteRow extends HostedSiteConfig {
    workspaceId: string;
    siteId: string;
    /** The browser-facing `.gen` name, derived exactly as a discovered site's is. */
    genName: string;
    state: HostedState;
    backend: HostingBackend | null;
    origin: string | null;
    error?: string;
}

/** The Testing-Browser row shape (`EnabledGenSite` in `main/remote`), rebuilt
 *  here so this module does not depend on the remote stack. */
export interface HostedGenSite {
    workspaceId: string;
    genName: string;
    siteId: string;
    hostname: string;
    scheme: 'http' | 'https';
    port: number;
    loopback?: '127.0.0.1' | '::1';
}

export interface HostingManager {
    /** Start one configured site. Never throws — a failure is a failed status. */
    start(workspaceId: string, hostname: string): Promise<HostedStatus>;
    stop(siteId: string): Promise<void>;
    stopAll(): Promise<void>;
    /** Configured sites + live state. All workspaces, or one. */
    list(workspaceId?: string): HostedSiteRow[];
    /** Start every enabled site and stop everything that no longer is. */
    reconcile(): Promise<void>;
    /** RUNNING hosted sites as Testing-Browser rows. Synchronous — the Testing
     *  Browser reads this while building its resolver map. */
    genSites(): HostedGenSite[];
}

// --- implementation --------------------------------------------------------

interface Live {
    workspaceId: string;
    site: HostedSite;
    runtime: SiteRuntime;
}

export function createHostingManager(deps: HostingManagerDeps): HostingManager {
    const ensureRuntime = deps.ensureRuntime ?? realEnsureFrankenPhp;
    const ensureBuiltFn = deps.ensureBuilt ?? realEnsureBuilt;
    const makeFrankenPhp = deps.createFrankenPhp ?? createFrankenPhpRuntime;
    const makeStatic = deps.createStatic ?? createStaticRuntime;
    const serviceEnvFor = deps.serviceEnvFor ?? workspaceServiceEnv;

    /** Sites we have started, so `genSites()` and `stop()` can find their
     *  runtime without re-deriving it from config that may have changed. */
    const live = new Map<string, Live>();
    /** In-flight `start()`s, keyed by siteId — two windows opening the Testing
     *  Browser at once must not run two downloads into one staging directory. */
    const starting = new Map<string, Promise<HostedStatus>>();
    /**
     * Why a site is NOT running, kept until it starts or is stopped.
     *
     * A failed site never enters `live`, so reading state only from the runtimes
     * would report it as a plain `stopped` — the user is shown a site that
     * simply "isn't on" when in fact its build is broken, and the compiler
     * output saying so is thrown away. The Site Manager needs the reason.
     */
    const lastFailure = new Map<string, HostedStatus>();

    let staticRuntime: SiteRuntime | null = null;
    let phpRuntime: SiteRuntime | null = null;
    let phpInstall: Promise<FrankenPhpInstall> | null = null;

    const failed = (siteId: string, error: string): HostedStatus => ({
        siteId,
        state: 'failed',
        backend: 'static',
        target: null,
        origin: null,
        error,
    });

    function staticBackend(): SiteRuntime {
        staticRuntime ??= makeStatic();
        return staticRuntime;
    }

    /** The FrankenPHP backend, fetching the runtime the first time it is asked
     *  for. The install promise is cached (not the result) so concurrent
     *  callers share ONE download. */
    async function phpBackend(): Promise<SiteRuntime> {
        if (phpRuntime) return phpRuntime;
        phpInstall ??= ensureRuntime({ baseDir: deps.baseDir, platform: deps.platform });
        try {
            const install = await phpInstall;
            phpRuntime ??= makeFrankenPhp({
                binaryPath: install.binaryPath,
                stateDir: `${deps.baseDir}/hosting/state`,
                extensionDir: install.extensionDir,
            });
            return phpRuntime;
        } catch (e) {
            // A failed fetch must not poison every later attempt — the network
            // may simply have been down.
            phpInstall = null;
            throw e;
        }
    }

    /** Find a configured site by hostname across (or within) workspaces. */
    function findConfig(
        workspaceId: string,
        hostname: string,
    ): { workspace: HostingWorkspace; config: HostedSiteConfig } | null {
        const workspace = deps.listWorkspaces().find((w) => w.id === workspaceId);
        if (!workspace) return null;
        const want = hostname.trim().toLowerCase();
        for (const config of Object.values(deps.hostedSitesFor(workspace.id))) {
            if (config?.hostname === want) return { workspace, config };
        }
        return null;
    }

    async function startOnce(workspaceId: string, hostname: string): Promise<HostedStatus> {
        const found = findConfig(workspaceId, hostname);
        if (!found) {
            return failed(hostedSiteIdFor(hostname), `${hostname} is not configured for hosting`);
        }
        const site = resolveHostedSite(found.workspace.path, found.config);
        if (!site) {
            return failed(
                hostedSiteIdFor(hostname),
                `${hostname} has an unusable document root (${found.config.docroot ?? ''})`,
            );
        }

        try {
            let runtime: SiteRuntime;
            if (site.kind === 'php') {
                runtime = await phpBackend();
                // Managed services, as environment. Merged UNDER anything the
                // stored site config already set, so a hand-configured
                // `DB_HOST` on the site still wins over the one we would
                // derive — same "never clobber what the user chose" rule the
                // `.env` writer follows.
                const serviceEnv = serviceEnvFor(workspaceId);
                if (Object.keys(serviceEnv).length) {
                    site.env = { ...serviceEnv, ...(site.env ?? {}) };
                }
            } else {
                // A built app or nothing to serve — produce it before binding a
                // port, so "running" always means "there is something there".
                await ensureBuiltFn({
                    repoDir: found.workspace.path,
                    docroot: site.root,
                    platform: deps.platform,
                });
                runtime = staticBackend();
            }
            const status = await runtime.start(site);
            if (status.state === 'running') {
                live.set(site.id, { workspaceId, site, runtime });
            }
            return status;
        } catch (e) {
            return failed(site.id, e instanceof Error ? e.message : String(e));
        }
    }

    async function start(workspaceId: string, hostname: string): Promise<HostedStatus> {
        const siteId = hostedSiteIdFor(hostname);
        const inFlight = starting.get(siteId);
        if (inFlight) return inFlight;
        const promise = startOnce(workspaceId, hostname)
            .then((status) => {
                if (status.state === 'running') lastFailure.delete(status.siteId);
                else lastFailure.set(status.siteId, status);
                return status;
            })
            .finally(() => starting.delete(siteId));
        starting.set(siteId, promise);
        return promise;
    }

    async function stop(siteId: string): Promise<void> {
        // A stop clears the remembered failure too: the site is now off because
        // it was asked to be, which is not the same as being broken.
        lastFailure.delete(siteId);
        const entry = live.get(siteId);
        if (!entry) return;
        live.delete(siteId);
        await entry.runtime.stop(siteId);
    }

    function statusOf(siteId: string): HostedStatus | null {
        const entry = live.get(siteId);
        return entry ? entry.runtime.status(siteId) : lastFailure.get(siteId) ?? null;
    }

    return {
        start,
        stop,

        async stopAll() {
            live.clear();
            await Promise.all(
                [staticRuntime, phpRuntime]
                    .filter((r): r is SiteRuntime => !!r)
                    .map((r) => r.stopAll()),
            );
        },

        list(workspaceId) {
            const rows: HostedSiteRow[] = [];
            for (const workspace of deps.listWorkspaces()) {
                if (workspaceId && workspace.id !== workspaceId) continue;
                for (const config of Object.values(deps.hostedSitesFor(workspace.id))) {
                    if (!config?.hostname) continue;
                    const siteId = hostedSiteIdFor(config.hostname);
                    const status = statusOf(siteId);
                    rows.push({
                        ...config,
                        workspaceId: workspace.id,
                        siteId,
                        genName: deriveGenName(config.hostname),
                        state: status?.state ?? 'stopped',
                        backend: status?.backend ?? null,
                        origin: status?.origin ?? null,
                        ...(status?.error ? { error: status.error } : {}),
                    });
                }
            }
            return rows;
        },

        async reconcile() {
            const wanted = new Set<string>();
            for (const workspace of deps.listWorkspaces()) {
                for (const config of Object.values(deps.hostedSitesFor(workspace.id))) {
                    if (!config?.enabled || !config.hostname) continue;
                    wanted.add(hostedSiteIdFor(config.hostname));
                    await start(workspace.id, config.hostname);
                }
            }
            // Anything live that is no longer wanted was disabled or removed.
            for (const siteId of [...live.keys()]) {
                if (!wanted.has(siteId)) await stop(siteId);
            }
        },

        genSites() {
            const rows: HostedGenSite[] = [];
            for (const [siteId, entry] of live) {
                const status = entry.runtime.status(siteId);
                // ONLY running sites — see the file header.
                if (status.state !== 'running' || !status.target) continue;
                rows.push({
                    workspaceId: entry.workspaceId,
                    genName: deriveGenName(entry.site.hostname),
                    siteId,
                    hostname: entry.site.hostname,
                    scheme: status.target.scheme,
                    port: status.target.port,
                    loopback: status.target.loopback ?? '127.0.0.1',
                });
            }
            return rows;
        },
    };
}

// --- the process-wide instance ---------------------------------------------

let instance: HostingManager | null = null;

/**
 * Create the one hosting manager for this process.
 *
 * Called from `background.ts` once the database is open — the manager reads
 * workspaces and their hosted-site configs from it. Idempotent: a second call
 * returns the existing instance rather than orphaning the first one's servers.
 */
export function initHosting(deps: HostingManagerDeps): HostingManager {
    instance ??= createHostingManager(deps);
    return instance;
}

/** The live manager, or null when hosting has not been initialised (headless
 *  host-core, tests, an early boot path). Callers must tolerate null. */
export function hostingManager(): HostingManager | null {
    return instance;
}

/**
 * RUNNING hosted sites, for `sites/local-sites.ts`.
 *
 * Returns `[]` rather than throwing when hosting was never initialised, so the
 * existing hosts-file discovery path keeps working untouched — that is what
 * makes the Testing Browser wiring purely additive.
 */
export function hostedGenSites(): HostedGenSite[] {
    return instance?.genSites() ?? [];
}

/** Test-only: drop the process-wide instance. */
export function resetHostingForTests(): void {
    instance = null;
}
