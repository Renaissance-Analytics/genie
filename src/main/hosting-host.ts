import type { DeckItem } from '../core/deck.js';
import type { EngineStatusView, ReconcileReport } from '../core/engine-reconcile.js';
import { WAITING_FOR_A_WINDOW, elevationWaitingDeckItem } from '../core/elevation-waiting.js';
import { notAvailableHere } from '../core/host-runtime.js';
import type { GenRoute } from '../core/gen-router.js';
import type { ElevationOutcome, PrivilegedStep } from './elevate.js';
import type { EnvelopeSites } from './envelope-sites-host.js';
import type { FrontDoorStatus } from './hosting-compose.js';
import type { HostsSyncResult } from './hosts-file.js';
import type { TrustApi } from './hosting-trust.js';
import type { ServiceRegistry } from './service-registry.js';
import type { SiteManager } from './site-manager.js';

/**
 * GENIE'S HOSTING (the host split, P5a): the front door, the service engines and the site routes. genie-host builds it
 * (hosting-compose.ts) and keeps it in-process; a window reads the front door on frontdoor.watch and drives the sites and
 * services over the protocol (features.snapshot/act), and builds none of its own (2g-4d E2b, Tynn #955: the engine link's
 * hosting replica is gone).
 *
 * What its readers and writers may use of it is NARROW (`SitesApi`, `EnginesApi`, `EnvelopeSitesApi`): the members
 * hosting-actions.ts, mcp-tools-hosting.ts and the feature builders actually call. The real stack satisfies them by being
 * the classes; a test may hand compose.ts a stand-in of the same shape.
 */

/** The site manager as a window uses it. */
export type SitesApi = Pick<SiteManager, 'list' | 'get' | 'spec' | 'phpCgiFor' | 'restart' | 'serviceEnvChanged' | 'onChange'>;
/** The engine registry as a window uses it. */
export type EnginesApi = Pick<ServiceRegistry, 'list' | 'envFor' | 'choices' | 'add' | 'setActive' | 'use' | 'detach' | 'releaseSlice' | 'createDatabaseRefusal' | 'createDatabase' | 'logs' | 'onChange' | 'onStarted'>;
/** The workspaces' declared sites as a window uses them. */
export type EnvelopeSitesApi = Pick<EnvelopeSites, 'create' | 'update' | 'remove' | 'start' | 'stop' | 'restart' | 'workspaceName' | 'workspacePath' | 'declaredIn'>;

type BrowserTrust = { readonly caPem: string; readonly thumbprint: string } | { readonly caPem: null; readonly reason: string };

export interface HostingApi {
    readonly sites: SitesApi;
    /** The workspaces' declared sites over the manager: loaded at boot, started by v1's rule, created/removed into project.json. */
    readonly envelopeSites: EnvelopeSitesApi;
    /** Service engines per workspace (and the shared ones), on the Docker driver. */
    readonly engines: EnginesApi;
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
    /**
     * An engine's image update (P5a.2): `consent: false` previews it; with consent the image is pulled and the engine
     * replaced — refused, with nothing replaced, when its dependents at the moment it is stopped are not all among
     * `approvedDependents` (what the person reviewed). The check runs where the engine is stopped: in the host.
     */
    updateEngine(id: string, options: { consent: boolean; approvedDependents?: readonly string[] }): ReturnType<ServiceRegistry['update']>;
    /** What this hosting was started without, each with what goes without it (a host's launch inputs, P5a.2); none = []. */
    hostingProblems(): string[];
    /** `workspaceId` = who a delete-data acts for: refused while any OTHER workspace keeps data in it (core/service-tenancy.ts). */
    removeEngine(id: string, options: { deleteData: boolean; workspaceId?: string }): Promise<void>;
    readonly frontDoorPort: number;
    /**
     * S7: the root the Genie Browser's session trusts for `.gen` hosts (and nothing else) — Genie's CA, PEM — or why
     * there is none, in which case `.gen` sites do not open in the in-app browser and the reason is logged.
     */
    browserTrust(): BrowserTrust;
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
    /** The person's Not now on the Deck's hosts-file ask (Tynn #753): put away until the names change. */
    deferHosts(): void;
    /** `<name>.gen → 127.0.0.1:<port>` for every site that is up — what the front door reads. */
    routes(): GenRoute[];
    /**
     * The `.gen` names the hosts file carries: every site that is CONFIGURED (servable, not declared `enabled: false`),
     * running or not — plus any site up right now, so a name Caddy serves always resolves (genie#624's union).
     */
    configuredHosts(): string[];
    /** Genie's own Deck items about the front door: the one Trust ask and the site-reach (hosts file) asks. What waits for a window is WindowElevation's. */
    trustDeckItems(): DeckItem[];
    /** THE WORKSPACES' TRUST (genie#1519): owned where the hosting is — genie-host, which sets its own git read policy from it. */
    readonly trust: TrustApi;
    /** Stops what this hosting runs of its own (syncs, watches, the in-app door); supervised processes are the supervisor's. */
    shutdown(): Promise<void>;
}

/**
 * GENIE-HOST NEVER RAISES AN OS PROMPT ON ITS OWN (P5a ruling). Every elevation its hosting needs (the hosts file, the
 * trust store) is asked of a CONNECTED window, which runs it exactly as a window always has. With no window connected
 * nothing is elevated: the request is held, answered "waiting for a window", and said on genie-host's own Deck (its
 * `deckItems()`, which deck.watch and every client's estate carry; Approve there runs the hosts sync) — connecting is not
 * an approval, so nothing runs until the person approves with a window open.
 *
 * A host that can never elevate (plain Node, P10.1d: no Genie window can connect) asks nothing and holds nothing: it says
 * the elevation is not available on this host, in the one wording.
 */
export interface WindowElevationPorts {
    connected(): boolean;
    ask(steps: readonly PrivilegedStep[]): Promise<ElevationOutcome>;
    now?: () => number;
    /** false: this host can never elevate (hostCapabilities). Absent = it can. */
    elevation?: boolean;
}

export class WindowElevation {
    readonly #ports: WindowElevationPorts;
    readonly #listeners = new Set<() => void>();
    #waiting: { labels: string[]; at: number } | null = null;

    constructor(ports: WindowElevationPorts) {
        this.#ports = ports;
    }

    async run(steps: readonly PrivilegedStep[]): Promise<ElevationOutcome> {
        if (this.#ports.elevation === false) return { ok: false, failed: null, error: notAvailableHere(`elevation to ${[...new Set(steps.map((s) => s.label))].join(' and ')}`, 'a Genie window to ask in') };
        if (!this.#ports.connected()) return this.#hold(steps, 'no Genie window is open to ask');
        let outcome: ElevationOutcome;
        try {
            outcome = await this.#ports.ask(steps);
        } catch (error) {
            // The window closed before it answered: nothing ran there that we know of, so it waits like any other.
            return this.#hold(steps, error instanceof Error ? error.message : String(error));
        }
        // The person was asked (whatever they answered): nothing waits any more.
        if (this.#waiting !== null) { this.#waiting = null; this.#notify(); }
        return outcome;
    }

    /** What waits for a window, as the person reads it. */
    waiting(): string[] {
        return this.#waiting ? [...this.#waiting.labels] : [];
    }

    /** What waits, as genie-host's Deck says it (core/elevation-waiting.ts): one item, or none. */
    deckItems(): DeckItem[] {
        const item = this.#waiting ? elevationWaitingDeckItem(this.#waiting.labels, this.#waiting.at) : null;
        return item ? [item] : [];
    }

    /** Something started or stopped waiting: genie-host's Deck is said again. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #hold(steps: readonly PrivilegedStep[], why: string): ElevationOutcome {
        const labels = [...new Set([...(this.#waiting?.labels ?? []), ...steps.map((s) => s.label)])];
        this.#waiting = { labels, at: this.#waiting?.at ?? (this.#ports.now ?? Date.now)() };
        this.#notify();
        return { ok: false, failed: null, error: `${WAITING_FOR_A_WINDOW}: Genie needs your approval to ${labels.join(' and ')}, and ${why}; it asks when a Genie window opens` };
    }

    #notify(): void {
        for (const l of [...this.#listeners]) { try { l(); } catch { /* one listener never costs another */ } }
    }
}
