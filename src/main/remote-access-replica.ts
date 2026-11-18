import type { DriveMode } from '../core/connected-here.js';
import type { PairRequest } from '../core/pair-confirm.js';
import type { PinEnded } from '../core/remote.js';
import type { RemoteAccessEvent, RemoteAccessStatus } from './remote-access-host.js';
import type { Device } from './remote-devices.js';
import { isLocalEvent, type AgentEventOptions, type RemoteHost } from './remote-host.js';

/** Whether a status's connections want an agent's detail (Tynn #662): a status that does not say (an older host) wants all. */
function wantedIn(status: RemoteAccessStatus, agentId: string): boolean {
    const w = status.wants;
    return w === undefined || (w.remote && (w.all || w.agents.includes(agentId)));
}

/**
 * REMOTE ACCESS, READ AND DRIVEN FROM A WINDOW (Tynn #409, host split P5d.1): the client side of `genie.remote-access`.
 * The listener, the paired devices, the PIN, the pair prompts, the baton and the lock are genie-host's
 * (remote-access-host.ts); Settings → Workstation reads them here and drives them through `engine.remoteAccess`. The
 * window's own events reach remote connections through `forwardEvents`.
 */

/** What Settings → Workstation reads of remote access: genie-host's (this replica) or, on the emergency path, the window's own. */
export interface RemoteAccessView {
    readonly hostName: string;
    url(): string | null;
    unavailable(): string | null;
    locked(): boolean;
    activePin(): { code: string; expiresAt: number } | null;
    /** Why the last PIN went without pairing (Tynn #751). */
    pinEnded?(): PinEnded | null;
    devices(): Device[];
    connections(): ReturnType<RemoteHost['connections']>;
    issuePin(options?: { replaces?: string }): unknown;
    revokeDevice(id: string): boolean | Promise<boolean>;
    lock(): unknown;
    unlock(): unknown;
    /** Watch only, or full control, for one connected person (Tynn #732). */
    setMode(label: string, mode: DriveMode): unknown;
    onChange(listener: () => void): () => void;
}

/** "Pair this device?": what waits for Allow. */
export interface PairingView {
    requests(): PairRequest[];
    answer(id: string, allow: boolean): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
    onChange(listener: () => void): () => void;
}

type Call = (method: string, args: unknown[]) => Promise<unknown>;

export class RemoteAccessReplica implements RemoteAccessView {
    readonly hostName: string;
    readonly pairing: PairingView;
    readonly #call: Call;
    readonly #listeners = new Set<() => void>();
    /** The host API's listeners for agents that became wanted (forwardEvents, Tynn #862). */
    readonly #wantedListeners = new Set<(agentIds: readonly string[]) => void>();
    #status: RemoteAccessStatus;

    constructor(hostName: string, call: Call) {
        this.hostName = hostName;
        this.#call = call;
        this.#status = { host: hostName, url: null, unavailable: 'asking genie-host', locked: false, pin: null, devices: [], connections: [], pairRequests: [] };
        const self = this;
        this.pairing = {
            requests: () => [...self.#status.pairRequests],
            answer: async (id, allow) => (await self.#call('answerPair', [id, allow])) as { ok: true } | { ok: false; reason: string },
            onChange: (listener) => self.onChange(listener),
        };
    }

    /** Ask genie-host for the status now (at link-up). */
    async refresh(): Promise<void> {
        this.#rebase((await this.#call('status', [])) as RemoteAccessStatus);
    }

    url(): string | null { return this.#status.url; }
    unavailable(): string | null { return this.#status.unavailable; }
    locked(): boolean { return this.#status.locked; }
    activePin(): { code: string; expiresAt: number } | null { return this.#status.pin; }
    pinEnded(): PinEnded | null { return this.#status.pinEnded ?? null; }
    devices(): Device[] { return [...this.#status.devices]; }
    connections(): RemoteAccessStatus['connections'] { return [...this.#status.connections]; }

    issuePin(options: { replaces?: string } = {}): Promise<unknown> { return this.#call('issuePin', [options]); }
    async revokeDevice(id: string): Promise<boolean> { return (await this.#call('revokeDevice', [id])) === true; }
    lock(): Promise<unknown> { return this.#call('lock', []); }
    unlock(): Promise<unknown> { return this.#call('unlock', []); }
    setMode(label: string, mode: DriveMode): Promise<unknown> { return this.#call('setMode', [label, mode]); }
    /** The listener follows `remote_access` (genie-host applies it); Restart from Settings. */
    apply(): Promise<void> { return this.#call('apply', []).then(() => undefined); }
    restart(): Promise<void> { return this.#call('restart', []).then(() => undefined); }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** genie-host said the status changed. */
    deliver(event: RemoteAccessEvent): void {
        this.#rebase(event.status);
    }

    /**
     * The window's own events (the snapshot, features…) reach remote connections through genie-host — ONLY WHAT THEY WANT
     * (Tynn #662). Every agent change used to build the agent's whole detail (its ledger of thousands of rows) and send it
     * to genie-host every 50 ms, with nothing connected to receive it: on the memory soak, ~50 GB allocated in window main
     * every 5 minutes and lines of 10 M characters into the host 12 times a second. genie-host's status says what its
     * connections want (`RemoteHost.wanted`); an agent nobody wants is not even built (`wantsAgent`), and nothing is sent
     * while nobody listens. A status without it (an older host) is sent everything, as before.
     */
    forwardEvents(onEvent: (listener: (channel: string, payload: unknown) => void, options?: AgentEventOptions) => () => void): () => void {
        const wantsAgent = (agentId: string): boolean => wantedIn(this.#status, agentId);
        const wanted = (channel: string): boolean => {
            const w = this.#status.wants;
            if (w === undefined) return true;
            if (channel.startsWith('agent:')) return wantsAgent(channel.slice('agent:'.length));
            return isLocalEvent(channel) ? w.local : w.remote;
        };
        /*
         * AN AGENT THE WANTS GAINED IS SENT AS IT IS NOW (Tynn #862; the owner, 2026-11-18: a phone's chat showed nothing
         * "until I sent a message"). A phone's watch reads the agent's detail through this window first, and that read is
         * what starts the ledger's read; genie-host says the phone wants the agent only after. A ledger that landed in
         * between was not built (`wantsAgent`), and nothing sent it again until the agent next changed.
         */
        const onAgentsWanted = (listener: (agentIds: readonly string[]) => void): (() => void) => {
            this.#wantedListeners.add(listener);
            return () => { this.#wantedListeners.delete(listener); };
        };
        return onEvent((channel, payload) => { if (wanted(channel)) void this.#call('event', [channel, payload]).catch(() => {}); }, { wantsAgent, onAgentsWanted });
    }

    #rebase(status: RemoteAccessStatus): void {
        const was = this.#status;
        this.#status = status;
        // The agents a phone now watches that it did not before (Tynn #862). A desktop connection that comes to want every
        // agent reads each one's detail itself as it opens it, and so is not listed here.
        const gained = (status.wants?.agents ?? []).filter((agentId) => wantedIn(status, agentId) && !wantedIn(was, agentId));
        if (gained.length > 0) for (const l of [...this.#wantedListeners]) l(gained);
        for (const l of [...this.#listeners]) l();
    }
}
