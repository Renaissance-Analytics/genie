import type { DeckItem } from '../core/deck.js';
import type { EngineStatusView, ReconcileReport } from '../core/engine-reconcile.js';
import { WAITING_FOR_A_WINDOW, elevationWaitingDeckItem } from '../core/elevation-waiting.js';
import { notAvailableHere } from '../core/host-runtime.js';
import type { GenRoute } from '../core/gen-router.js';
import type { ElevationOutcome, PrivilegedStep } from './elevate.js';
import type { EnvelopeSites, SiteActor } from './envelope-sites-host.js';
import type { FrontDoorStatus } from './hosting-compose.js';
import type { HostsSyncResult } from './hosts-file.js';
import { trustedPathIn, type TrustApi, type TrustEntry } from './hosting-trust.js';
import type { TrustView } from './workspace-trust-host.js';
import type { ServiceRegistry } from './service-registry.js';
import type { CreateSiteInput, PhpCgiResolution, SiteManager } from './site-manager.js';

/**
 * GENIE'S HOSTING (the host split, P5a): the front door, the service engines and the site routes. genie-host builds it
 * (hosting-compose.ts) and serves it (`HostingService`); a window is handed it — the host's, through `HostingReplica` — and
 * builds none of its own. On the emergency path (no host) the window builds it itself, the same way.
 *
 * What a window may use of it is NARROW (`SitesApi`, `EnginesApi`, `EnvelopeSitesApi`): the members the window's readers
 * and writers actually call (hosting-actions.ts, mcp-tools-hosting.ts, feature-ipc.ts, main.ts). The real stack satisfies
 * them by being the classes; the replica by reading its dump and forwarding every write as an `engine.hosting` call.
 */

/** The site manager as a window uses it. */
export type SitesApi = Pick<SiteManager, 'list' | 'get' | 'spec' | 'phpCgiFor' | 'restart' | 'serviceEnvChanged' | 'onChange'>;
/** The engine registry as a window uses it. */
export type EnginesApi = Pick<ServiceRegistry, 'list' | 'envFor' | 'choices' | 'add' | 'setActive' | 'use' | 'detach' | 'releaseSlice' | 'createDatabaseRefusal' | 'createDatabase' | 'logs' | 'onChange' | 'onStarted'>;
/** The workspaces' declared sites as a window uses them. */
export type EnvelopeSitesApi = Pick<EnvelopeSites, 'create' | 'update' | 'remove' | 'start' | 'stop' | 'restart' | 'workspaceName' | 'workspacePath' | 'declaredIn'>;

type SiteInfo = ReturnType<SiteManager['list']>[number];
type ServiceInstance = ReturnType<ServiceRegistry['list']>[number];
type EngineChoice = ReturnType<ServiceRegistry['choices']>[number];
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
    /** `<name>.gen → 127.0.0.1:<port>` for every site that is up — what the front door reads. */
    routes(): GenRoute[];
    /**
     * The `.gen` names the hosts file carries: every site that is CONFIGURED (servable, not declared `enabled: false`),
     * running or not — plus any site up right now, so a name Caddy serves always resolves (genie#624's union).
     */
    configuredHosts(): string[];
    /** Genie's own Deck items about the front door: the one Trust ask (and, from genie-host, an elevation waiting for a window). */
    trustDeckItems(): DeckItem[];
    /**
     * THE WORKSPACES' TRUST (genie#1519): owned where the hosting is — genie-host, or the window on the emergency path. A
     * window's replica reads the verdicts from the dump and FAILS CLOSED before its first dump and after its link drops.
     */
    readonly trust: TrustApi;
    /** Stops what this hosting runs of its own (syncs, watches, the in-app door); supervised processes are the supervisor's. */
    shutdown(): Promise<void>;
}

/**
 * GENIE-HOST NEVER RAISES AN OS PROMPT ON ITS OWN (P5a ruling). Every elevation its hosting needs (the hosts file, the
 * trust store) is asked of a CONNECTED window, which runs it exactly as a window always has. With no window connected
 * nothing is elevated: the request is held, answered "waiting for a window", and the next window is told (a Deck item)
 * — connecting is not an approval, so nothing runs until the person approves there.
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

    deckItems(): DeckItem[] {
        const item = this.#waiting ? elevationWaitingDeckItem(this.#waiting.labels, this.#waiting.at) : null;
        return item ? [item] : [];
    }

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

/** Everything a window reads of the host's hosting, sent before `engine.ready` and again on every change. */
export interface HostingDump {
    readonly frontDoorPort: number;
    readonly browserTrust: BrowserTrust;
    readonly externalFrontDoor: FrontDoorStatus;
    readonly routes: GenRoute[];
    readonly configuredHosts: string[];
    readonly deckItems: DeckItem[];
    readonly sites: SiteInfo[];
    readonly specs: Readonly<Record<string, CreateSiteInput | null>>;
    readonly declared: Readonly<Record<string, { workspaceId: string; workspacePath: string } | null>>;
    readonly engines: ServiceInstance[];
    readonly workspaces: Readonly<Record<string, { env: Record<string, string>; choices: EngineChoice[]; toRelease: string[]; toResume: string[]; path: string | null }>>;
    /** Per engine; `null` = the host could not say (the read threw). */
    readonly dependents: Readonly<Record<string, readonly string[] | null>>;
    readonly reconcile: ReconcileReport | null;
    readonly problems: readonly string[];
    /** Every workspace's trust verdict as the host last read it (genie#1519). Local window links only, as the whole dump. */
    readonly trust?: readonly TrustEntry[];
    /** Private ownership metadata, including hidden folders: absence from the public workspace view never grants writes. */
    readonly registeredFolders?: readonly string[];
}

export type HostingEvent =
    | { readonly kind: 'dump'; readonly dump: HostingDump }
    | { readonly kind: 'engineStarted'; readonly id: string };

const str = (v: unknown): string => String(v);
const optionalStr = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));
const attempt = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

/**
 * THE HOST'S HOSTING, SERVED (P5a). Its whole readable state is one dump, sent on connect and again (coalesced) whenever
 * the sites, the engines, the front door or a held elevation change; a window's write is answered only after a fresh
 * dump is sent, so the window reads what it did as soon as its call returns.
 */
export class HostingService {
    readonly #stack: HostingApi;
    readonly #workspaces: () => readonly string[];
    readonly #registeredFolders: (() => readonly string[]) | undefined;
    readonly #elevation: WindowElevation | null;
    readonly #listeners = new Set<(event: HostingEvent) => void>();
    readonly #schedule: (fn: () => void, ms: number) => () => void;
    #reconcile: ReconcileReport | null = null;
    #last = '';
    #cancel: (() => void) | null = null;

    constructor(stack: HostingApi, options: {
        /** The registered workspaces' ids: each one's env, engine choices and hibernation engines are in the dump. */
        workspaces: () => readonly string[];
        registeredFolders?: () => readonly string[];
        elevation?: WindowElevation;
        /** Anything else the dump reads changed (a supervised process — an engine's dependents —, a workspace). */
        onChange?: (listener: () => void) => () => void;
        schedule?: (fn: () => void, ms: number) => () => void;
    }) {
        this.#stack = stack;
        this.#workspaces = options.workspaces;
        this.#registeredFolders = options.registeredFolders;
        this.#elevation = options.elevation ?? null;
        this.#schedule = options.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
        const changed = () => this.#changed();
        stack.sites.onChange(changed);
        stack.engines.onChange(changed);
        stack.onFrontDoorChange(changed);
        this.#elevation?.onChange(changed);
        options.onChange?.(changed);
        stack.engines.onStarted((id) => this.#emit({ kind: 'engineStarted', id }));
        // A verdict that moved goes out AT ONCE, uncoalesced (genie#1519): the host recorded it first, and a revocation must
        // reach the window before anything else it runs.
        stack.trust.onVerdict(() => this.#sendNow());
        void stack.engineReconcile.then((report) => { this.#reconcile = report; this.#changed(); });
    }

    dump(): HostingDump {
        const s = this.#stack;
        const sites = s.sites.list();
        const engines = s.engines.list();
        const workspaceIds = [...new Set([...this.#workspaces(), ...sites.map((x) => x.workspaceId)])];
        return {
            frontDoorPort: s.frontDoorPort,
            browserTrust: s.browserTrust(),
            externalFrontDoor: s.externalFrontDoor,
            routes: s.routes(),
            configuredHosts: s.configuredHosts(),
            deckItems: [...s.trustDeckItems(), ...(this.#elevation?.deckItems() ?? [])],
            sites,
            specs: Object.fromEntries(sites.map((x) => [x.id, s.sites.spec(x.id)])),
            declared: Object.fromEntries(sites.map((x) => [x.id, s.envelopeSites.declaredIn(x.id)])),
            engines,
            workspaces: Object.fromEntries(workspaceIds.map((id) => [id, {
                env: s.engines.envFor(id),
                choices: s.engines.choices(id),
                toRelease: attempt(() => s.hibernationEngines.toRelease(id), []),
                toResume: attempt(() => s.hibernationEngines.toResume(id), []),
                path: s.envelopeSites.workspacePath(id),
            }])),
            dependents: Object.fromEntries(engines.map((e) => [e.id, attempt<readonly string[] | null>(() => s.engineDependents(e.id), null)])),
            reconcile: this.#reconcile,
            problems: s.hostingProblems(),
            trust: s.trust.entries(),
            ...(this.#registeredFolders ? { registeredFolders: this.#registeredFolders() } : {}),
        };
    }

    onEvent(listener: (event: HostingEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** A window's write (or an async read), by name. Answered after a fresh dump is out. */
    async call(method: string, args: readonly unknown[]): Promise<unknown> {
        const value = await this.#run(method, args);
        this.#sendNow();
        return value;
    }

    async #run(method: string, a: readonly unknown[]): Promise<unknown> {
        const s = this.#stack;
        switch (method) {
            case 'sites.restart': return s.sites.restart(str(a[0]), (a[1] ?? {}) as { join?: boolean });
            case 'sites.serviceEnvChanged': return s.sites.serviceEnvChanged(optionalStr(a[0]));
            case 'engines.add': return s.engines.add(a[0] as Parameters<EnginesApi['add']>[0]);
            case 'updateEngine': {
                const o = (a[1] ?? {}) as { consent?: unknown; approvedDependents?: unknown };
                return s.updateEngine(str(a[0]), { consent: o.consent === true, ...(Array.isArray(o.approvedDependents) ? { approvedDependents: o.approvedDependents.map(String) } : {}) });
            }
            case 'engines.setActive': return s.engines.setActive(str(a[0]), str(a[1]), str(a[2]));
            case 'engines.use': return s.engines.use(str(a[0]), str(a[1]));
            case 'engines.detach': return s.engines.detach(str(a[0]), str(a[1]));
            case 'engines.releaseSlice': return s.engines.releaseSlice(str(a[0]), str(a[1]));
            case 'engines.createDatabaseRefusal': return s.engines.createDatabaseRefusal(str(a[0]), str(a[1]), str(a[2]));
            case 'engines.createDatabase': return s.engines.createDatabase(str(a[0]), str(a[1]), str(a[2]));
            case 'engines.logs': return s.engines.logs(str(a[0]), typeof a[1] === 'number' ? a[1] : undefined);
            case 'envelopeSites.create': return s.envelopeSites.create(a[0] as CreateSiteInput);
            case 'envelopeSites.update': return s.envelopeSites.update(str(a[0]), a[1] as CreateSiteInput, (a[2] ?? {}) as SiteActor);
            case 'envelopeSites.remove': return s.envelopeSites.remove(str(a[0]));
            case 'envelopeSites.start': return s.envelopeSites.start(str(a[0]), (a[1] ?? {}) as SiteActor);
            case 'envelopeSites.stop': return s.envelopeSites.stop(str(a[0]));
            case 'envelopeSites.restart': return s.envelopeSites.restart(str(a[0]), (a[1] ?? {}) as SiteActor);
            case 'envelopeSites.workspaceName': return s.envelopeSites.workspaceName(str(a[0]));
            case 'engineStatuses': return s.engineStatuses();
            case 'startEngine': return s.startEngine(str(a[0]));
            case 'stopEngine': return s.stopEngine(str(a[0]));
            case 'removeEngine': return s.removeEngine(str(a[0]), a[1] as { deleteData: boolean; workspaceId?: string });
            case 'hibernation.stop': return s.hibernationEngines.stop(str(a[0]));
            case 'hibernation.start': return s.hibernationEngines.start(str(a[0]));
            case 'frontDoorSettled': return s.frontDoorSettled();
            case 'syncHosts': return s.syncHosts();
            case 'retryFrontDoor': return s.retryFrontDoor();
            case 'trustCertificate': return s.trustCertificate();
            case 'deferTrustCertificate': return s.deferTrustCertificate();
            // The person's yes to a workspace (genie#1519). `engine.hosting` is a local window's only (session-engine-server.ts).
            case 'trust.trust': return s.trust.trust(str(a[0]));
            case 'trust.untrust': return s.trust.untrust(str(a[0]));
            case 'trust.refresh': return a[1] === 'redock' ? s.trust.refresh(str(a[0]), 'redock') : s.trust.refresh(str(a[0]));
            default: throw new Error(`a window cannot call hosting.${method}`);
        }
    }

    #changed(): void {
        if (this.#cancel !== null) return;
        this.#cancel = this.#schedule(() => { this.#cancel = null; this.#sendNow(); }, 16);
    }

    #sendNow(): void {
        if (this.#cancel !== null) { this.#cancel(); this.#cancel = null; }
        const dump = this.dump();
        const text = JSON.stringify(dump);
        if (text === this.#last) return;
        this.#last = text;
        this.#emit({ kind: 'dump', dump });
    }

    #emit(event: HostingEvent): void {
        for (const l of [...this.#listeners]) {
            try { l(event); } catch { /* one window's listener never costs another's */ }
        }
    }
}

const NOT_YET = 'genie-host has not sent its hosting yet';

/**
 * THE HOST'S HOSTING, AS A WINDOW READS AND DRIVES IT (P5a). Reads are synchronous, from the last dump (connect awaits
 * the first one, so a composed window never reads "not yet"); every write is forwarded as an `engine.hosting` call and
 * answers in the host's words. The few writes the window uses SYNCHRONOUSLY (`sites.restart`, `sites.serviceEnvChanged`,
 * `deferTrustCertificate`) are forwarded and answered OPTIMISTICALLY from the dump, the way SupervisorReplica answers a
 * start: the host decides, and its answer arrives as the next dump.
 */
export class HostingReplica implements HostingApi {
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;
    readonly #phpCgiFor: (pin: string | undefined) => PhpCgiResolution;
    readonly #siteListeners = new Set<() => void>();
    readonly #engineListeners = new Set<() => void>();
    readonly #startedListeners = new Set<(id: string) => void>();
    readonly #frontDoorListeners = new Set<() => void>();
    #dump: HostingDump | null = null;
    /** The link is up and its dump is in: until then, and after it drops, no verdict is believed (fail closed, genie#1519). */
    #linked = false;
    #keys = { sites: '', engines: '', frontDoor: '', trust: '' };
    readonly #verdictListeners = new Set<(workspaceId: string) => void>();
    #reconciled: ((report: ReconcileReport) => void) | null = null;
    readonly engineReconcile: Promise<ReconcileReport>;

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>, options: {
        /** Which php-cgi a pin runs, asked where the window is (the same machine, the same toolchain): a sync read the dump cannot carry for every pin. */
        phpCgiFor?: (pin: string | undefined) => PhpCgiResolution;
    } = {}) {
        this.#call = call;
        this.#phpCgiFor = options.phpCgiFor ?? ((pin) => (pin === undefined || pin === '' ? { ok: true, command: 'php-cgi' } : { ok: false, reason: `this site is pinned to PHP ${pin}, and this window cannot tell which php-cgi runs it` }));
        this.engineReconcile = new Promise((resolve) => { this.#reconciled = resolve; });
    }

    rebase(dump: HostingDump): void {
        const trustBefore = this.#trustEntries();
        this.#dump = dump;
        this.#linked = true;
        const keys = {
            sites: JSON.stringify([dump.sites, dump.specs, dump.declared]),
            engines: JSON.stringify([dump.engines, dump.workspaces, dump.dependents]),
            // The port and the CA are part of it (P5a.2): a host that comes back on a new port, or with a new CA, is a change.
            frontDoor: JSON.stringify([dump.frontDoorPort, dump.browserTrust, dump.externalFrontDoor, dump.routes, dump.configuredHosts, dump.deckItems, dump.problems ?? []]),
            trust: JSON.stringify(dump.trust ?? []),
        };
        const was = this.#keys;
        this.#keys = keys;
        if (dump.reconcile !== null && this.#reconciled) { this.#reconciled(dump.reconcile); this.#reconciled = null; }
        if (keys.sites !== was.sites) this.#fire(this.#siteListeners);
        if (keys.engines !== was.engines) this.#fire(this.#engineListeners);
        if (keys.frontDoor !== was.frontDoor) this.#fire(this.#frontDoorListeners);
        this.#verdictsMoved(trustBefore);
    }

    #trustEntries(): readonly TrustEntry[] {
        return this.#linked ? (this.#dump?.trust ?? []) : [];
    }

    /** The link to the host dropped: the verdicts it last sent are not believed, so every workspace reads untrusted until the next dump. */
    linkDown(): void {
        const trustBefore = this.#trustEntries();
        this.#linked = false;
        this.#verdictsMoved(trustBefore);
    }

    #verdictsMoved(before: readonly TrustEntry[]): void {
        const now = this.#trustEntries();
        const ids = new Set([...before, ...now].map((e) => e.workspaceId));
        for (const id of ids) {
            if (before.find((e) => e.workspaceId === id)?.trusted === now.find((e) => e.workspaceId === id)?.trusted) continue;
            for (const l of [...this.#verdictListeners]) { try { l(id); } catch { /* one listener never costs another */ } }
        }
    }

    readonly trust: TrustApi = {
        isTrustedPath: (path: string) => trustedPathIn(this.#trustEntries(), path),
        view: (workspaceId: string): TrustView | null => {
            const entry = this.#trustEntries().find((e) => e.workspaceId === workspaceId);
            return entry ? { trusted: entry.trusted, changed: entry.changed, list: entry.list } : null;
        },
        entries: () => [...this.#trustEntries()],
        refresh: (workspaceId: string, purpose?: 'redock') => purpose === undefined ? this.#ask<TrustView | null>('trust.refresh', workspaceId) : this.#ask<TrustView | null>('trust.refresh', workspaceId, purpose),
        trust: (workspaceId: string) => this.#ask<TrustView | null>('trust.trust', workspaceId),
        untrust: (workspaceId: string) => this.#ask<TrustView | null>('trust.untrust', workspaceId),
        mayWriteInto: async (folder: string) => {
            const dump = this.#dump;
            // Fail closed: no dump yet, or the link is down, and nothing is known to be trusted.
            if (dump === null || !this.#linked) return false;
            const entry = (dump.trust ?? []).find((e) => e.path === folder);
            if (entry) return entry.trusted;
            // A registered workspace not read yet is not trusted; a folder that is no workspace is not this rule's.
            return !(dump.registeredFolders ?? Object.values(dump.workspaces).flatMap((w) => w.path === null ? [] : [w.path])).includes(folder);
        },
        onVerdict: (listener: (workspaceId: string) => void) => { this.#verdictListeners.add(listener); return () => { this.#verdictListeners.delete(listener); }; },
    };

    apply(event: HostingEvent): void {
        if (event.kind === 'dump') { this.rebase(event.dump); return; }
        for (const l of [...this.#startedListeners]) { try { l(event.id); } catch { /* one listener never costs another */ } }
    }

    async #ask<T>(method: string, ...args: unknown[]): Promise<T> {
        return (await this.#call(method, args)) as T;
    }

    #site(id: string): SiteInfo | null {
        return this.#dump?.sites.find((s) => s.id === id) ?? null;
    }

    #workspace(id: string) {
        return this.#dump?.workspaces[id] ?? null;
    }

    readonly sites: SitesApi = {
        list: (workspaceId?: string) => (this.#dump?.sites ?? []).filter((s) => workspaceId === undefined || s.workspaceId === workspaceId),
        get: (id: string) => this.#site(id),
        spec: (id: string) => this.#dump?.specs[id] ?? null,
        phpCgiFor: (pin: string | undefined) => this.#phpCgiFor(pin),
        // Optimistic (see the class): the host restarts it, or says why not as the site's state in the next dump.
        restart: (id: string, options: { join?: boolean } = {}) => {
            const known = this.#site(id);
            if (!known) throw new Error(`no site ${id}`);
            void this.#call('sites.restart', [id, options]).catch(() => {});
            return known;
        },
        // Optimistic: the running sites of that workspace are the ones the host restarts when their env moved.
        serviceEnvChanged: (workspaceId?: string) => {
            void this.#call('sites.serviceEnvChanged', [workspaceId ?? null]).catch(() => {});
            return (this.#dump?.sites ?? []).filter((s) => (workspaceId === undefined || s.workspaceId === workspaceId) && s.state === 'running').map((s) => s.id);
        },
        onChange: (listener: () => void) => { this.#siteListeners.add(listener); return () => { this.#siteListeners.delete(listener); }; },
    };

    readonly engines: EnginesApi = {
        list: (workspaceId?: string) => (this.#dump?.engines ?? []).filter((i) => workspaceId === undefined || (i.scope.kind === 'dedicated' && i.scope.workspaceId === workspaceId)),
        envFor: (workspaceId: string) => ({ ...(this.#workspace(workspaceId)?.env ?? {}) }),
        choices: (workspaceId: string) => [...(this.#workspace(workspaceId)?.choices ?? [])],
        add: (input) => this.#ask('engines.add', input),
        setActive: (workspaceId, engine, version) => this.#ask('engines.setActive', workspaceId, engine, version),
        use: (workspaceId, id) => this.#ask('engines.use', workspaceId, id),
        detach: (workspaceId, id) => this.#ask('engines.detach', workspaceId, id),
        releaseSlice: (id, workspaceId) => this.#ask('engines.releaseSlice', id, workspaceId),
        createDatabaseRefusal: (id, workspaceId, database) => this.#ask('engines.createDatabaseRefusal', id, workspaceId, database),
        createDatabase: (id, workspaceId, database) => this.#ask('engines.createDatabase', id, workspaceId, database),
        logs: (id, tail) => this.#ask('engines.logs', id, tail ?? null),
        onChange: (listener: () => void) => { this.#engineListeners.add(listener); return () => { this.#engineListeners.delete(listener); }; },
        onStarted: (listener: (id: string) => void) => { this.#startedListeners.add(listener); return () => { this.#startedListeners.delete(listener); }; },
    };

    readonly envelopeSites: EnvelopeSitesApi = {
        create: (input) => this.#ask('envelopeSites.create', input),
        update: (siteId, input, by = {}) => this.#ask('envelopeSites.update', siteId, input, by),
        remove: (siteId) => this.#ask('envelopeSites.remove', siteId),
        start: (siteId, by = {}) => this.#ask('envelopeSites.start', siteId, by),
        stop: (siteId) => this.#ask('envelopeSites.stop', siteId),
        restart: (siteId, by = {}) => this.#ask('envelopeSites.restart', siteId, by),
        workspaceName: (workspaceId) => this.#ask('envelopeSites.workspaceName', workspaceId),
        workspacePath: (workspaceId: string) => this.#workspace(workspaceId)?.path ?? null,
        declaredIn: (siteId: string) => this.#dump?.declared[siteId] ?? null,
    };

    readonly hibernationEngines = {
        toRelease: (workspaceId: string) => [...(this.#workspace(workspaceId)?.toRelease ?? [])],
        toResume: (workspaceId: string) => [...(this.#workspace(workspaceId)?.toResume ?? [])],
        stop: (id: string) => this.#ask<void>('hibernation.stop', id),
        start: (id: string) => this.#ask<void>('hibernation.start', id),
    };

    engineStatuses(): Promise<EngineStatusView[]> { return this.#ask('engineStatuses'); }
    startEngine(id: string): Promise<void> { return this.#ask('startEngine', id); }
    stopEngine(id: string): Promise<void> { return this.#ask('stopEngine', id); }
    removeEngine(id: string, options: { deleteData: boolean; workspaceId?: string }): Promise<void> { return this.#ask('removeEngine', id, options); }
    /** The host checks the dependents when it stops the engine; the window only says which it approved. */
    updateEngine(id: string, options: { consent: boolean; approvedDependents?: readonly string[] }): ReturnType<ServiceRegistry['update']> { return this.#ask('updateEngine', id, options); }
    hostingProblems(): string[] { return [...(this.#dump?.problems ?? [])]; }

    engineDependents(id: string): readonly string[] {
        const known = this.#dump?.dependents[id];
        if (known === undefined || known === null) throw new Error(`no service ${id}`);
        return known;
    }

    get frontDoorPort(): number { return this.#dump?.frontDoorPort ?? 0; }
    browserTrust(): BrowserTrust { return this.#dump?.browserTrust ?? { caPem: null, reason: NOT_YET }; }
    get externalFrontDoor(): FrontDoorStatus { return this.#dump?.externalFrontDoor ?? { running: false, reason: NOT_YET }; }
    onFrontDoorChange(listener: () => void): () => void {
        this.#frontDoorListeners.add(listener);
        return () => { this.#frontDoorListeners.delete(listener); };
    }
    frontDoorSettled(): Promise<void> { return this.#ask('frontDoorSettled'); }
    syncHosts(): Promise<HostsSyncResult> { return this.#ask('syncHosts'); }
    retryFrontDoor(): Promise<FrontDoorStatus> { return this.#ask('retryFrontDoor'); }
    trustCertificate(): Promise<{ ok: true } | { ok: false; reason: string }> { return this.#ask('trustCertificate'); }
    /** Optimistic: the Trust item goes when the host's next dump says so. */
    deferTrustCertificate(): void { void this.#call('deferTrustCertificate', []).catch(() => {}); }
    routes(): GenRoute[] { return [...(this.#dump?.routes ?? [])]; }
    configuredHosts(): string[] { return [...(this.#dump?.configuredHosts ?? [])]; }
    trustDeckItems(): DeckItem[] { return [...(this.#dump?.deckItems ?? [])]; }
    /** The hosting is the host's: a window closing stops none of it. */
    async shutdown(): Promise<void> {}

    #fire(listeners: Set<() => void>): void {
        for (const l of [...listeners]) { try { l(); } catch { /* one listener never costs another */ } }
    }
}
