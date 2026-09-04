/**
 * The host-owned HOSTING seam.
 *
 * Container hosting — dev SITES, dev SERVICES, and the LIFECYCLE that adopts and
 * warms them — is an agent ability: an agent runs `manageSite` to serve a repo.
 * So it belongs to the Host, not to any one shell. This module is the seam: one
 * `initHosting(ports)` that constructs the three managers from an injected port
 * set, so the desktop-embedded host and the headless genie-cloud host stand
 * hosting up identically, and every client (local or remote) drives it over the
 * one protocol.
 *
 * Before this, the three managers were built inline in the desktop boot
 * (`background.ts`) AFTER the `isHeadless()` bail — so hosting was desktop-only
 * and the headless host could not serve at all. The WIRING lives here now; a
 * shell supplies only the ports (desktop backs them with Electron + genie.db,
 * genie-cloud with its own runtime + store).
 *
 * `buildHostingDeps` is kept pure and separate from `initHosting` so the mapping
 * can be unit-tested without a container runtime or the process-wide singletons.
 */

import { initDevSites, devSiteManager } from '../dev-server/site-manager';
import type {
    DevSiteManager,
    DevSiteManagerDeps,
    DevSiteProgress,
    DevWorkspace,
    ResolvedRuntimeLike,
    SiteRunState,
} from '../dev-server/site-manager';
import { initDevServices, devServiceManager } from '../dev-server/services/service-manager';
import type {
    DevServiceManager,
    DevServiceManagerDeps,
    EngineAdminRequest,
    HostEnvReport,
} from '../dev-server/services/service-manager';
import { createServiceEnvSync } from '../dev-server/services/env-sync';
import { applyEnvBlock } from '../env-store';
import { createHostProcessRun } from '../dev-server/host-process-run';
import { createEngineMismatchNote } from '../dev-server/host-engine-probe';
import { createSiteEngineResolver } from '../dev-server/toolchain-manager';
import { initDevLifecycle } from '../dev-server/lifecycle';
import type { DevServerLifecycle, DevServerLifecycleDeps } from '../dev-server/lifecycle';
import { registerDevSiteTools } from '../mcp/dev-site-tools';
import type { DevSiteToolsDeps } from '../mcp/dev-site-tools';
import { isPortFree, waitForHttp, waitForPort } from '../dev-server/port-probe';
import type { DevSites } from '../dev-server/sites-config';
import type { DevServices } from '../dev-server/services/services-config';
import type { EngineAdmin } from '../dev-server/services/provision';
import type { ImagePullConsent } from '../dev-server/workspace-sandbox';
import type { HostIds } from '../dev-server/host-ids';
import { workspaceDnsName } from '../dev-server/services/catalog';

/** Add the trusted browser endpoint while leaving server-to-server traffic internal. */
export function browserWebSocketEnv(
    workspaceId: string,
    env: Record<string, string>,
): Record<string, string> {
    if (!env.REVERB_APP_KEY) return env;
    return {
        ...env,
        VITE_REVERB_APP_KEY: env.REVERB_APP_KEY,
        VITE_REVERB_HOST: `reverb.${workspaceDnsName(workspaceId)}.gen`,
        VITE_REVERB_PORT: '443',
        VITE_REVERB_SCHEME: 'https',
    };
}

/**
 * The shell-supplied inputs the hosting managers need. Everything that differs
 * between a desktop host and a headless cloud host is here: the container runtime
 * resolver, the workspace/site/service store reads, the image-pull gate, and how
 * change/progress events reach the viewer. Nothing Electron-shaped leaks past it.
 */
export interface HostingPorts {
    /** Which container runtime, and is it usable — resolved per action so
     *  installing Docker mid-session needs no restart. */
    resolveRuntime: () => Promise<ResolvedRuntimeLike>;
    listWorkspaces: () => DevWorkspace[];
    workspaceFor: (workspaceId: string) => DevWorkspace | null;
    devSitesFor: (workspaceId: string) => DevSites;
    devServicesFor: (workspaceId: string) => DevServices;
    /** The engine superuser credential, minted once per engine container. */
    engineAdmin: (req: EngineAdminRequest) => EngineAdmin;
    /** Bundled Host-native Pusher service (Sockudo on desktop/host). */
    hostWebSockets?: DevServiceManagerDeps['hostWebSockets'];
    /** This workspace's provisioned services, as environment. */
    devServiceEnvFor: (workspaceId: string) => Record<string, string>;
    /** This workspace's provisioned services in HOST form (127.0.0.1:<published
     *  port>), for a HOST-NATIVE site's dev server (story #238 / beta.237). */
    devServiceHostEnvFor: (workspaceId: string) => Record<string, string>;
    /** {@link devServiceHostEnvFor} plus the enabled/live/host-published counts
     *  that explain an EMPTY result, so a host-native start can log WHY it got no
     *  service env instead of serving DB-less in silence (moic's beta.245 report).
     *  Optional so a host that has not adopted it yet still compiles — absent ⇒ the
     *  env still flows (via {@link devServiceHostEnvFor}), only the diagnostic is
     *  skipped. */
    devServiceHostEnvReportFor?: (workspaceId: string) => HostEnvReport;
    /** Where a HOST-NATIVE site's dev-server output is logged (a Genie data dir).
     *  Absent ⇒ host-native hosting (runMode 'host') is off and fails with a clear
     *  message rather than silently containerising. */
    hostSiteLogDir?: string;
    /** Absolute path to Genie's bundled Caddy binary, for serving a `hostServe`
     *  (static / php) site with Genie's own web server. Absent ⇒ those serve modes
     *  fail with a clear "not available" status. */
    caddyBin?: string;
    /** Write a per-site generated web-server config and return its path — the fs
     *  seam the shell owns (desktop writes under its data dir). Absent ⇒ generated
     *  serve modes are unavailable. */
    writeServeConfig?: (siteId: string, content: string) => string;
    /** The persisted `toolchain_defaults` blob — which version of each language is
     *  this machine's DEFAULT, the choice a site follows unless it pins one
     *  (genie#207). Read through a port because the store is the shell's (desktop:
     *  genie.db settings). Absent ⇒ no explicit default, so a site follows the
     *  newest Genie-managed install, which is what `defaultVersionFor` already
     *  means by "default". */
    readToolchainDefaults?: () => string | undefined;
    /** Consent for fetching a missing image. Absent ⇒ no pull. */
    confirmImagePull?: (req: ImagePullConsent) => Promise<boolean> | boolean;
    /** The `.gen` change event — desktop broadcasts to the renderer, the cloud
     *  host over the relay. Fires for both managers. */
    onChanged: () => void;
    /** A repo `.env` Genie could not keep current, or kept current somewhere it
     *  should not stay (a git-tracked file). Absent ⇒ the reason is dropped, which
     *  is the silence this exists to end — wire it. */
    onServiceEnvProblem?: (message: string) => void;
    /** Where an engine's published host ports are REMEMBERED, so they stop moving
     *  (desktop: `dev_service_ports` in genie.db). Absent ⇒ the old ephemeral
     *  publication, which still works and still moves. */
    servicePorts?: DevServiceManagerDeps['servicePorts'];
    /** Live site START progress (pulling → building → starting → ready). */
    onSiteProgress: (progress: DevSiteProgress) => void;
    /**
     * The user's last explicit run decision per site (genie#407) — the MACHINE-
     * LOCAL half that `enabled` could not carry, because `enabled` lives in the
     * git-tracked envelope and a stop is not something a teammate should inherit
     * or a `git pull` should undo. Desktop backs it with `site_run_state` in
     * genie.db.
     *
     * Optional so a host that has not adopted it yet still compiles — absent ⇒
     * nothing is remembered across a launch and boot resumes every enabled site,
     * which is what every build did before this. Wire it: it is the difference
     * between a stop and a pause until the next restart.
     */
    siteRunState?: SiteRunState;
    /** Open a `.gen` site in the viewer. Desktop wires the Testing Browser;
     *  headless omits it and `manageSite open` says so rather than pretending. */
    openInBrowser?: DevSiteToolsDeps['openInBrowser'];
    platform?: NodeJS.Platform | string;
    image?: string;
    mountTarget?: string;
    hostIds?: HostIds | null;
}

/** The three managers' dep objects, derived from one port set. */
export interface HostingDeps {
    services: DevServiceManagerDeps;
    sites: DevSiteManagerDeps;
    lifecycle: DevServerLifecycleDeps;
    siteTools: DevSiteToolsDeps;
}

/** The live hosting managers a shell gets back from {@link initHosting}. */
export interface HostingHandles {
    services: DevServiceManager;
    sites: DevSiteManager;
    lifecycle: DevServerLifecycle;
}

/**
 * Map ONE port set into the three managers' deps. Pure: no singletons touched,
 * no runtime resolved — so the wiring is unit-testable. The only shared logic it
 * bakes in is the stuff that is the same on every host: the readiness probes and
 * the "ensure services up, then hand the site their env" thread.
 */
export function buildHostingDeps(ports: HostingPorts): HostingDeps {
    const envSpecific = {
        ...(ports.platform ? { platform: ports.platform } : {}),
        ...(ports.image ? { image: ports.image } : {}),
        ...(ports.mountTarget ? { mountTarget: ports.mountTarget } : {}),
        ...(ports.hostIds !== undefined ? { hostIds: ports.hostIds } : {}),
    };

    const services: DevServiceManagerDeps = {
        resolveRuntime: ports.resolveRuntime,
        listWorkspaces: ports.listWorkspaces,
        devServicesFor: ports.devServicesFor,
        engineAdmin: ports.engineAdmin,
        ...(ports.hostWebSockets ? { hostWebSockets: ports.hostWebSockets } : {}),
        ...(ports.confirmImagePull ? { confirmImagePull: ports.confirmImagePull } : {}),
        // REQUIRED for engines with no in-container check (Mailpit/Meilisearch/
        // MinIO): without a host-side probe `waitReady` answers "not ready"
        // immediately and every acquire of those fails.
        probeReady: ({ port, kind, timeoutMs }) =>
            kind === 'http' ? waitForHttp(port, timeoutMs) : waitForPort(port, timeoutMs),
        // "Can I have this exact port?" — a BIND, not a connect, because Docker
        // Desktop's forwarder answers a connect for ports nothing serves. Always
        // available: it is a plain loopback probe with no host-shaped dependency.
        isPortFree,
        ...(ports.servicePorts ? { servicePorts: ports.servicePorts } : {}),
        // A move is the one moment an address genuinely changes. The `.env` is
        // rewritten either way; this is for the processes that already captured the
        // old one and cannot be reached.
        ...(ports.onServiceEnvProblem ? { onPortMoved: ports.onServiceEnvProblem } : {}),
        onChanged: ports.onChanged,
        // The `.env` WRITE (genie#242). This seam is where the two halves meet:
        // the service manager knows a workspace's published connection has moved,
        // the site config knows which repos that workspace's apps live in, and
        // neither knows the other.
        //
        // It is the whole fix. Before it, a service's connection existed only in
        // the environment of terminals spawned since it last changed — invisible
        // to a hosted site, a `manageProcess` worker or a shell the user opened,
        // and (dotenv being immutable in Laravel) able to OVERRIDE the `.env`
        // somebody had just corrected. The app reads `.env`; `.env` is now what
        // Genie keeps true.
        onServiceEnvChanged: createServiceEnvSync({
            workspaceFor: ports.workspaceFor,
            devSitesFor: ports.devSitesFor,
            hostEnvFor: ports.devServiceHostEnvFor,
            write: applyEnvBlock,
            ...(ports.onServiceEnvProblem ? { onProblem: ports.onServiceEnvProblem } : {}),
        }),
    };

    const sites: DevSiteManagerDeps = {
        resolveRuntime: ports.resolveRuntime,
        listWorkspaces: ports.listWorkspaces,
        devSitesFor: ports.devSitesFor,
        ...envSpecific,
        ...(ports.confirmImagePull ? { confirmImagePull: ports.confirmImagePull } : {}),
        // A site gets its workspace's services as env — asking for them ENSURES
        // they are up first, so a dev server never comes up pointed at an engine
        // that is not there. No probeReady: the site manager defaults to probing
        // THROUGH Caddy (waitForHttpsSni), which is the exact browser path.
        serviceEnvFor: async (workspaceId) => {
            const svc = devServiceManager();
            if (!svc) return {};
            for (const row of svc.list(workspaceId)) {
                if (row.enabled) await svc.acquire(workspaceId, row.serviceId);
            }
            return browserWebSocketEnv(workspaceId, ports.devServiceEnvFor(workspaceId));
        },
        // The HOST-FORM service env (127.0.0.1:<published port>) a host-native dev
        // server uses — same ensure-services-up-first as serviceEnvFor (story #238),
        // but returned WITH its diagnostic: a per-service acquire failure no longer
        // strips the healthy services' env (each is tolerated), and the report's
        // counts let the site log say WHY the env is empty rather than serve DB-less
        // in silence (moic's beta.245 report).
        serviceHostEnvReportFor: async (workspaceId) => {
            const svc = devServiceManager();
            if (!svc) return { env: {}, enabled: 0, live: 0, withHostPort: 0, gaps: [] };
            for (const row of svc.list(workspaceId)) {
                // Tolerate a single service failing: acquire never throws (it returns
                // a failed status), but guard anyway so one engine can never abort the
                // batch and wipe the DB env the rest would have provided.
                if (row.enabled) await svc.acquire(workspaceId, row.serviceId).catch(() => {});
            }
            // A host that supplies the report port gets the full diagnostic; one that
            // only supplies the env port still gets the env (no counts ⇒ no warning).
            const report = ports.devServiceHostEnvReportFor
                ? ports.devServiceHostEnvReportFor(workspaceId)
                : {
                      env: ports.devServiceHostEnvFor(workspaceId),
                      enabled: 0,
                      live: 0,
                      withHostPort: 0,
                      gaps: [],
                  };
            return { ...report, env: browserWebSocketEnv(workspaceId, report.env) };
        },
        // Genie runs a host-native site's dev server as a real HOST process (no
        // container). Only when a log dir is provided — otherwise host-native is off.
        ...(ports.hostSiteLogDir
            ? { hostSpawn: createHostProcessRun({ logDir: ports.hostSiteLogDir }) }
            : {}),
        // Genie's bundled Caddy + a config writer: together they let a `hostServe`
        // (static / php) site be served by Genie's own web server, so an agent never
        // hand-rolls an nginx/Caddy config. Both required — either absent leaves the
        // serve mode off with a clear status.
        ...(ports.caddyBin ? { caddyBin: ports.caddyBin } : {}),
        ...(ports.writeServeConfig ? { writeServeConfig: ports.writeServeConfig } : {}),
        // WHICH runtime a Genie-served site spawns (genie#207): the site's pin, else
        // the machine default, resolved to the absolute executable inside the
        // toolchain install Genie owns. Always wired — the alternative is the bare
        // PATH lookup that produced genie#206 — and a host with no stored default
        // still resolves, to the newest managed install.
        resolveEngine: createSiteEngineResolver(ports.readToolchainDefaults ?? (() => undefined)),
        // Engine-version validation (goal item 4, interim): warn at a host-native
        // start when the repo declares a php/node/go/python version the host runtime
        // doesn't match. Composed from the repo's declared version + a host probe.
        engineMismatchNote: createEngineMismatchNote(),
        onChanged: ports.onChanged,
        onProgress: ports.onSiteProgress,
        // A stop the USER asked for, remembered across the launch (genie#407).
        ...(ports.siteRunState ? { runState: ports.siteRunState } : {}),
    };

    const lifecycle: DevServerLifecycleDeps = {
        resolveRuntime: ports.resolveRuntime,
        workspaceFor: ports.workspaceFor,
        devSitesFor: ports.devSitesFor,
        devServicesFor: ports.devServicesFor,
        // Read lazily — the managers are created just below, and the lifecycle
        // only orchestrates whatever is live.
        sites: () => devSiteManager(),
        services: () => devServiceManager(),
        ...envSpecific,
    };

    const siteTools: DevSiteToolsDeps = ports.openInBrowser
        ? { openInBrowser: ports.openInBrowser }
        : {};

    return { services, sites, lifecycle, siteTools };
}

/**
 * Stand hosting up from a port set. Services BEFORE sites (a site reads its
 * workspace's service env when it starts), lifecycle last (it only orchestrates
 * the other two and adopts on boot). Idempotent, because each `init*` is.
 */
export function initHosting(ports: HostingPorts): HostingHandles {
    const deps = buildHostingDeps(ports);
    const services = initDevServices(deps.services);
    const sites = initDevSites(deps.sites);
    const lifecycle = initDevLifecycle(deps.lifecycle);
    registerDevSiteTools(deps.siteTools);
    return { services, sites, lifecycle };
}
