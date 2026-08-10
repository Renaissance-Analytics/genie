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
} from '../dev-server/site-manager';
import { initDevServices, devServiceManager } from '../dev-server/services/service-manager';
import type {
    DevServiceManager,
    DevServiceManagerDeps,
    EngineAdminRequest,
    HostEnvReport,
} from '../dev-server/services/service-manager';
import { createHostProcessRun } from '../dev-server/host-process-run';
import { createEngineMismatchNote } from '../dev-server/host-engine-probe';
import { initDevLifecycle } from '../dev-server/lifecycle';
import type { DevServerLifecycle, DevServerLifecycleDeps } from '../dev-server/lifecycle';
import { registerDevSiteTools } from '../mcp/dev-site-tools';
import type { DevSiteToolsDeps } from '../mcp/dev-site-tools';
import { waitForHttp, waitForPort } from '../dev-server/port-probe';
import type { DevSites } from '../dev-server/sites-config';
import type { DevServices } from '../dev-server/services/services-config';
import type { EngineAdmin } from '../dev-server/services/provision';
import type { ImagePullConsent } from '../dev-server/workspace-sandbox';
import type { HostIds } from '../dev-server/host-ids';

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
    /** Consent for fetching a missing image. Absent ⇒ no pull. */
    confirmImagePull?: (req: ImagePullConsent) => Promise<boolean> | boolean;
    /** The `.gen` change event — desktop broadcasts to the renderer, the cloud
     *  host over the relay. Fires for both managers. */
    onChanged: () => void;
    /** Live site START progress (pulling → building → starting → ready). */
    onSiteProgress: (progress: DevSiteProgress) => void;
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
        ...(ports.confirmImagePull ? { confirmImagePull: ports.confirmImagePull } : {}),
        // REQUIRED for engines with no in-container check (Mailpit/Meilisearch/
        // MinIO): without a host-side probe `waitReady` answers "not ready"
        // immediately and every acquire of those fails.
        probeReady: ({ port, kind, timeoutMs }) =>
            kind === 'http' ? waitForHttp(port, timeoutMs) : waitForPort(port, timeoutMs),
        onChanged: ports.onChanged,
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
            return ports.devServiceEnvFor(workspaceId);
        },
        // The HOST-FORM service env (127.0.0.1:<published port>) a host-native dev
        // server uses — same ensure-services-up-first as serviceEnvFor (story #238),
        // but returned WITH its diagnostic: a per-service acquire failure no longer
        // strips the healthy services' env (each is tolerated), and the report's
        // counts let the site log say WHY the env is empty rather than serve DB-less
        // in silence (moic's beta.245 report).
        serviceHostEnvReportFor: async (workspaceId) => {
            const svc = devServiceManager();
            if (!svc) return { env: {}, enabled: 0, live: 0, withHostPort: 0, missingHostPort: [] };
            for (const row of svc.list(workspaceId)) {
                // Tolerate a single service failing: acquire never throws (it returns
                // a failed status), but guard anyway so one engine can never abort the
                // batch and wipe the DB env the rest would have provided.
                if (row.enabled) await svc.acquire(workspaceId, row.serviceId).catch(() => {});
            }
            // A host that supplies the report port gets the full diagnostic; one that
            // only supplies the env port still gets the env (no counts ⇒ no warning).
            return ports.devServiceHostEnvReportFor
                ? ports.devServiceHostEnvReportFor(workspaceId)
                : {
                      env: ports.devServiceHostEnvFor(workspaceId),
                      enabled: 0,
                      live: 0,
                      withHostPort: 0,
                      missingHostPort: [],
                  };
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
        // Engine-version validation (goal item 4, interim): warn at a host-native
        // start when the repo declares a php/node/go/python version the host runtime
        // doesn't match. Composed from the repo's declared version + a host probe.
        engineMismatchNote: createEngineMismatchNote(),
        onChanged: ports.onChanged,
        onProgress: ports.onSiteProgress,
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
