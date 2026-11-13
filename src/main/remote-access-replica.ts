import type { PairRequest } from '../core/pair-confirm.js';
import type { RemoteAccessEvent, RemoteAccessStatus } from './remote-access-host.js';
import type { Device } from './remote-devices.js';
import { isLocalEvent, type RemoteHost } from './remote-host.js';

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
    devices(): Device[];
    connections(): ReturnType<RemoteHost['connections']>;
    issuePin(options?: { replaces?: string }): unknown;
    revokeDevice(id: string): boolean | Promise<boolean>;
    lock(): unknown;
    unlock(): unknown;
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
    devices(): Device[] { return [...this.#status.devices]; }
    connections(): RemoteAccessStatus['connections'] { return [...this.#status.connections]; }

    issuePin(options: { replaces?: string } = {}): Promise<unknown> { return this.#call('issuePin', [options]); }
    async revokeDevice(id: string): Promise<boolean> { return (await this.#call('revokeDevice', [id])) === true; }
    lock(): Promise<unknown> { return this.#call('lock', []); }
    unlock(): Promise<unknown> { return this.#call('unlock', []); }
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
    forwardEvents(onEvent: (listener: (channel: string, payload: unknown) => void, options?: { wantsAgent?: (agentId: string) => boolean }) => () => void): () => void {
        const wantsAgent = (agentId: string): boolean => {
            const w = this.#status.wants;
            return w === undefined || (w.remote && (w.all || w.agents.includes(agentId)));
        };
        const wanted = (channel: string): boolean => {
            const w = this.#status.wants;
            if (w === undefined) return true;
            if (channel.startsWith('agent:')) return wantsAgent(channel.slice('agent:'.length));
            return isLocalEvent(channel) ? w.local : w.remote;
        };
        return onEvent((channel, payload) => { if (wanted(channel)) void this.#call('event', [channel, payload]).catch(() => {}); }, { wantsAgent });
    }

    #rebase(status: RemoteAccessStatus): void {
        this.#status = status;
        for (const l of [...this.#listeners]) l();
    }
}
