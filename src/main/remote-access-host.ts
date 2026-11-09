import { randomBytes } from 'node:crypto';
import { PairApprovals, type PairConfirm } from '../core/pair-confirm.js';
import { Baton, PairingPins } from '../core/remote.js';
import type { CallContext, RemoteMethod, ServerTransport } from '../core/remote-protocol.js';
import { DeviceStore, type Device } from './remote-devices.js';
import { RemoteHost, type HostApi } from './remote-host.js';
import { HOST_ALONE_METHODS } from './host-alone-api.js';

/**
 * REMOTE ACCESS'S HOST SIDE, IN GENIE-HOST (Tynn #409, host split P5d.1). A phone (over the tailnet) and a Pilot (over the
 * Tynn relay) reach THIS machine's genie-host, which runs whether a window is open or not. There is ONE of each thing that
 * says who drives: the paired devices (runtime/remote-devices.json, one writer), the PIN, the "Pair this device?" prompts,
 * the baton and the owner's lock. A window reads and drives them through its replica; its own protocol door (local
 * authentication) stays the window's.
 *
 * What genie-host answers itself is answered with every window closed. What it does not own yet is done by the newest
 * LOCAL window, through the engine link's reverse call; with none it is refused with what to do. Later P5d stories move
 * each family here (Tynn #551, #553).
 */

/** What genie-host answers itself, and the window for the rest. */
export interface HostRemoteApiPorts {
    readonly hostName: string;
    /** Methods genie-host performs itself, window or not. */
    readonly own: Partial<Record<RemoteMethod, (args: unknown[]) => Promise<unknown>>>;
    /** The newest local window, while one is connected: it performs what the host does not own yet. */
    readonly window: { connected(): boolean; invoke(method: RemoteMethod, args: unknown[], context?: CallContext): Promise<unknown> };
    /** Events for remote connections: the host's own, and those a connected window forwards. */
    readonly onEvent?: (listener: (channel: string, payload: unknown) => void) => () => void;
    /**
     * GENIE-HOST'S OWN ANSWERS TO A PHONE (Tynn #551, host-alone-api.ts): the phone's methods, used only while no window is
     * connected; its events reach remote connections only then (a connected window forwards its own). A getter: genie-host
     * builds it once its session host is up.
     */
    readonly alone?: HostApi | (() => HostApi | null);
    /** A Pilot's Take Over window closed: the TUI it started goes with it, whoever else is connected. */
    readonly takeOverEnded?: (terminalId: string) => void;
    /** The workspace an agent is in (a guest is held to its own), from the host's roster. */
    readonly workspaceOfAgent?: (agentId: string) => string | null;
}

export function hostRemoteApi(ports: HostRemoteApiPorts): HostApi {
    const alone = (): HostApi | null => (typeof ports.alone === 'function' ? ports.alone() : ports.alone ?? null);
    return {
        invoke: async (method, args, context) => {
            const own = ports.own[method];
            if (own) return own(args);
            if (ports.window.connected()) return ports.window.invoke(method, args, context);
            const answers = HOST_ALONE_METHODS.has(method) ? alone() : null;
            if (answers) return answers.invoke(method, args, context);
            throw new Error(`${ports.hostName} answers ${method} only while a Genie window is open there: open Genie on ${ports.hostName}`);
        },
        onEvent: (listener, options) => {
            const offWindow = ports.onEvent?.(listener) ?? (() => {});
            // genie-host's own events only while no window is connected: a connected window forwards its own.
            const offAlone = alone()?.onEvent((channel, payload) => { if (!ports.window.connected()) listener(channel, payload); }, options) ?? (() => {});
            return () => { offWindow(); offAlone(); };
        },
        workspaceOfAgent: (agentId) => ports.workspaceOfAgent?.(agentId) ?? null,
        ...(ports.takeOverEnded ? { takeOverEnded: ports.takeOverEnded } : {}),
    };
}

/** What Settings → Workstation shows of remote access, read from the host. */
export interface RemoteAccessStatus {
    readonly host: string;
    readonly url: string | null;
    readonly unavailable: string | null;
    readonly locked: boolean;
    readonly pin: { code: string; expiresAt: number } | null;
    readonly devices: Device[];
    readonly connections: ReturnType<RemoteHost['connections']>;
    readonly pairRequests: ReturnType<PairApprovals['requests']>;
}

export interface RemoteAccessHostOptions {
    /** Genie's root: the paired devices are `runtime/remote-devices.json` under it. */
    readonly home: string;
    readonly hostName: string;
    readonly api: HostApi;
    /** Where remote connections come from: the tailnet listener and the Tynn relay host. */
    readonly transport: ServerTransport;
    readonly now?: () => number;
    readonly confirm?: PairConfirm & Pick<PairApprovals, 'requests' | 'answer' | 'onChange'>;
    readonly build?: string;
}

export class RemoteAccessHost {
    readonly remote: RemoteHost;
    readonly pairing: PairConfirm & Pick<PairApprovals, 'requests' | 'answer' | 'onChange'>;
    readonly #devices: DeviceStore;

    private constructor(remote: RemoteHost, pairing: RemoteAccessHost['pairing'], devices: DeviceStore) {
        this.remote = remote;
        this.pairing = pairing;
        this.#devices = devices;
    }

    static async open(options: RemoteAccessHostOptions): Promise<RemoteAccessHost> {
        const now = options.now ?? Date.now;
        const devices = await DeviceStore.open(options.home, { now, random: () => randomBytes(24).toString('base64url') });
        // A correct PIN raises "Pair this device?" here; only Allow pairs (q_8c07b142). P5d.6 raises it through the tray.
        const pairing = options.confirm ?? new PairApprovals({ host: options.hostName, now });
        const remote = new RemoteHost({
            api: options.api,
            hostName: options.hostName,
            baton: new Baton(),
            pins: new PairingPins({ now }),
            devices,
            confirm: pairing,
            transport: options.transport,
            now,
            ...(options.build ? { build: options.build } : {}),
        });
        return new RemoteAccessHost(remote, pairing, devices);
    }

    status(): RemoteAccessStatus {
        const r = this.remote;
        return { host: r.hostName, url: r.url(), unavailable: r.unavailable(), locked: r.locked(), pin: r.activePin(), devices: r.devices(), connections: r.connections(), pairRequests: this.pairing.requests() };
    }

    issuePin(options: { replaces?: string } = {}): { code: string; expiresAt: number } {
        return this.remote.issuePin(options);
    }

    revokeDevice(id: string): boolean {
        return this.remote.revokeDevice(id);
    }

    lock(): void {
        this.remote.lock();
    }

    unlock(): void {
        this.remote.unlock();
    }

    answerPair(id: string, allow: boolean): { ok: true } | { ok: false; reason: string } {
        return this.pairing.answer(id, allow);
    }

    onChange(listener: () => void): () => void {
        const offRemote = this.remote.onChange(listener);
        const offPairing = this.pairing.onChange(listener);
        return () => { offRemote(); offPairing(); };
    }

    /** The store's writes are done. */
    async close(): Promise<void> {
        await this.#devices.flushed();
    }
}

/** What genie-host tells its local windows about remote access. */
export type RemoteAccessEvent = { readonly kind: 'status'; readonly status: RemoteAccessStatus };

export interface RemoteAccessServicePorts {
    /** The listener's switch (remote-access.ts): applied when `remote_access` changes, Restart from Settings. */
    readonly switch: { apply(): Promise<void>; restart(): Promise<void>; stop(): Promise<void> };
    /** The newest local window's connection: only its events reach remote connections (one window feeds them). */
    readonly newestWindow: () => string | null;
    /** An event the newest window forwarded, for remote connections. */
    readonly windowEvent: (channel: string, payload: unknown) => void;
    /** To one window (`owner`), or every local window (`null`). */
    readonly send: (owner: string | null, event: RemoteAccessEvent) => void;
}

/**
 * REMOTE ACCESS, AS THE WINDOW DRIVES IT (Tynn #409): the engine link's `engine.remoteAccess`, from a LOCAL window only
 * (session-engine-server.ts). Settings → Workstation's remote section reads the status and drives the PIN, the devices,
 * the lock and the pair answers; the newest window forwards its events.
 */
const CHANGES_STATUS = new Set(['issuePin', 'revokeDevice', 'lock', 'unlock', 'answerPair', 'apply', 'restart', 'start', 'stop']);

export class RemoteAccessService {
    readonly #access: RemoteAccessHost;
    readonly #ports: RemoteAccessServicePorts;

    constructor(access: RemoteAccessHost, ports: RemoteAccessServicePorts) {
        this.#access = access;
        this.#ports = ports;
        access.onChange(() => this.pushStatus());
    }

    pushStatus(): void {
        this.#ports.send(null, { kind: 'status', status: this.#access.status() });
    }

    async call(owner: string, method: string, args: unknown[]): Promise<unknown> {
        const value = await this.#perform(owner, method, args);
        // What the person changed is what every window shows next (RemoteHost does not say so for a PIN).
        if (CHANGES_STATUS.has(method)) this.pushStatus();
        return value;
    }

    async #perform(owner: string, method: string, args: unknown[]): Promise<unknown> {
        const a = this.#access;
        switch (method) {
            case 'status': return a.status();
            case 'issuePin': return a.issuePin(typeof (args[0] as { replaces?: unknown } | null)?.replaces === 'string' ? { replaces: (args[0] as { replaces: string }).replaces } : {});
            case 'revokeDevice': return a.revokeDevice(String(args[0]));
            case 'lock': a.lock(); return true;
            case 'unlock': a.unlock(); return true;
            case 'answerPair': return a.answerPair(String(args[0]), args[1] === true);
            case 'apply': await this.#ports.switch.apply(); return a.status();
            // The handlers genie.remote-access's catalog payload names (genie-catalog.ts): start follows the setting.
            case 'start': await this.#ports.switch.apply(); return a.status();
            case 'stop': await this.#ports.switch.stop(); return a.status();
            case 'health': { const s = a.status(); return { host: s.host, listening: s.url !== null, why: s.unavailable }; }
            case 'restart': await this.#ports.switch.restart(); return a.status();
            case 'event':
                // One window feeds remote connections: the newest local one, the same that does their calls.
                if (owner !== this.#ports.newestWindow()) return false;
                this.#ports.windowEvent(String(args[0]), args[1]);
                return true;
            default: throw new Error(`remote access has no ${method}`);
        }
    }
}
