import type { DeckItem } from '../core/deck.js';
import type { EngineStatusView, ReconcileReport } from '../core/engine-reconcile.js';
import type { GenRoute } from '../core/gen-router.js';
import type { DotEnvSync } from './dotenv-sync.js';
import type { EnvelopeSites } from './envelope-sites-host.js';
import type { GenRouterServer } from './gen-router-server.js';
import type { FrontDoorStatus } from './hosting-compose.js';
import type { HostsSyncResult } from './hosts-file.js';
import type { ServiceRegistry } from './service-registry.js';
import type { SiteManager } from './site-manager.js';

/**
 * GENIE'S HOSTING (the host split, P5a): the front door, the service engines and the site routes. genie-host builds it
 * (hosting-compose.ts) and serves it; a window is handed it — the host's, through its replica — and builds none of its own.
 * On the emergency path (no host) the window builds it itself, the same way.
 */
export interface HostingApi {
    readonly sites: SiteManager;
    /** The workspaces' declared sites over the manager: loaded at boot, started by v1's rule, created/removed into project.json. */
    readonly envelopeSites: EnvelopeSites;
    /** Service engines per workspace (and the shared ones), on the Docker driver. */
    readonly engines: ServiceRegistry;
    /**
     * Genie start's pass over the registered engines (core/engine-reconcile.ts): the ones not running and not stopped by
     * the person are started and waited for; with Docker down, each says so. Boot does not wait for it. Never rejects.
     */
    readonly engineReconcile: Promise<ReconcileReport>;
    /** Every engine with its status for the Services tab — `docker-not-running`, with Docker's reason, when Docker is not there to ask. */
    engineStatuses(): Promise<EngineStatusView[]>;
    /** The PERSON's start / stop / remove of an engine: recorded (machine-local), so a restart keeps a stopped engine stopped. */
    startEngine(id: string): Promise<void>;
    stopEngine(id: string): Promise<void>;
    /**
     * A hibernating or waking workspace's engines (parity audit #12, core/hibernate-engines.ts): which to release and
     * which to resume, and the registry's own stop and start — NOT the person's Stop, which a wake must respect.
     */
    hibernationEngines: { toRelease(workspaceId: string): string[]; toResume(workspaceId: string): string[]; stop(id: string): Promise<void>; start(id: string): Promise<void> };
    /** Workspaces currently receiving this engine's env, plus their running sites and processes. */
    engineDependents(id: string): readonly string[];
    /** `workspaceId` = who a delete-data acts for: refused while any OTHER workspace keeps data in it (core/service-tenancy.ts). */
    removeEngine(id: string, options: { deleteData: boolean; workspaceId?: string }): Promise<void>;
    /** The workspace's service connection kept current in each site repo's `.env` — refused where git would commit it. */
    readonly envFiles: DotEnvSync;
    readonly frontDoor: GenRouterServer;
    readonly frontDoorPort: number;
    /**
     * S7: the root the Genie Browser's session trusts for `.gen` hosts (and nothing else) — Genie's CA, PEM — or why
     * there is none, in which case `.gen` sites do not open in the in-app browser and the reason is logged.
     */
    browserTrust(): { readonly caPem: string; readonly thumbprint: string } | { readonly caPem: null; readonly reason: string };
    /** Genie's own Caddy on 443 for EXTERNAL browsers (https://<name>.gen), or why it is off. */
    readonly externalFrontDoor: FrontDoorStatus;
    /** Fires when the front door state changes (a hosts sync landed, the root got trusted). */
    onFrontDoorChange(listener: () => void): () => void;
    /** Observe current controller and hosts work without requesting changes; does not acknowledge Caddy's --watch reload. */
    frontDoorSettled(): Promise<void>;
    /** Sync the hosts block now — the person's "try again" after a declined prompt. */
    syncHosts(): Promise<HostsSyncResult>;
    /** The person's Try again on a front door whose port was held: asked again, and Caddy started when it is free. */
    retryFrontDoor(): Promise<FrontDoorStatus>;
    /**
     * Install Genie's CA into the OS trust store through ONE elevation. Trusted only when the store, read again
     * afterwards, holds the CA's thumbprint; a declined prompt or a failed install answers its reason and marks nothing.
     */
    trustCertificate(): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** The person's Not now on the Deck's Trust item: not asked again for this CA (Hosting's line stays). */
    deferTrustCertificate(): void;
    /** `<name>.gen → 127.0.0.1:<port>` for every site that is up — what the front door reads. */
    routes(): GenRoute[];
    /**
     * The `.gen` names the hosts file carries: every site that is CONFIGURED (servable, not declared `enabled: false`),
     * running or not — plus any site up right now, so a name Caddy serves always resolves (genie#624's union).
     */
    configuredHosts(): string[];
    /** Genie's own Deck items about the front door: the one Trust ask. */
    trustDeckItems(): DeckItem[];
    /** Stops what this hosting runs of its own (syncs, watches, the in-app door); supervised processes are the supervisor's. */
    shutdown(): Promise<void>;
}
