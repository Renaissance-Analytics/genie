import { randomBytes, randomUUID } from 'node:crypto';
import { PairApprovals, type PairConfirm } from '../core/pair-confirm.js';
import { Baton, PairingPins } from '../core/remote.js';
import type { PreAuth, RemoteMethod, ServerConnection, ServerTransport } from '../core/remote-protocol.js';
import { DeviceStore, type Device } from './remote-devices.js';
import { RemoteHost, type HostApi } from './remote-host.js';

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
    readonly window: { connected(): boolean; invoke(method: RemoteMethod, args: unknown[]): Promise<unknown> };
    /** Events for remote connections: the host's own, and those a connected window forwards. */
    readonly onEvent?: (listener: (channel: string, payload: unknown) => void) => () => void;
    /** The workspace an agent is in (a guest is held to its own), from the host's roster. */
    readonly workspaceOfAgent?: (agentId: string) => string | null;
}

export function hostRemoteApi(ports: HostRemoteApiPorts): HostApi {
    return {
        invoke: async (method, args) => {
            const own = ports.own[method];
            if (own) return own(args);
            if (ports.window.connected()) return ports.window.invoke(method, args);
            throw new Error(`${ports.hostName} answers ${method} only while a Genie window is open there: open Genie on ${ports.hostName}`);
        },
        onEvent: (listener) => ports.onEvent?.(listener) ?? (() => {}),
        workspaceOfAgent: (agentId) => ports.workspaceOfAgent?.(agentId) ?? null,
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
    /** Where remote connections come from: the tailnet listener, and the relay connections the window's relay host bridges. */
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

/**
 * THE RELAY BRIDGE, HOST SIDE (Tynn #409; the coordinator's option 1). Until the relay host itself moves here (P5d.3,
 * #410), a window's relay host admits a Pilot or a guest by its Tynn grant and hands the connection to genie-host, so
 * every remote connection meets the ONE baton, lock and device list here.
 *
 * SECURITY. A bridged connection is exactly what the relay admitted, never more:
 * - only a relay proof crosses: a pre-auth that says `local`, or none at all, is refused (a bridged connection must never
 *   become this machine's own window, nor say a tailnet hello: remote-host.ts's #348 binding then holds as for any relay
 *   connection);
 * - the pre-auth is checked field by field and copied, so nothing else rides along;
 * - each connection's id is minted HERE, random, and belongs to the window that opened it: a frame for an id that is not
 *   that window's, or that has closed, is refused (no replay onto a closed or someone else's connection);
 * - the window that opened it leaving closes it.
 */
export type BridgeEvent = { readonly id: string; readonly frame: string } | { readonly id: string; readonly closed: true };

interface Bridged {
    readonly owner: string;
    readonly messages: Set<(text: string) => void>;
    readonly closes: Set<() => void>;
    closed: boolean;
}

const LABEL_MAX = 200;

/** A relay pre-auth, checked and copied; `null` when it is not one. */
export function relayPreAuth(value: unknown): PreAuth | null {
    if (value === null || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    const allowed = new Set(['kind', 'label', 'isOwner', 'workspaceId', 'readonly']);
    if (Object.keys(v).some((k) => !allowed.has(k))) return null;
    if (v.kind !== undefined && v.kind !== 'relay') return null;
    if (typeof v.label !== 'string' || v.label.trim() === '' || v.label.length > LABEL_MAX) return null;
    if (typeof v.isOwner !== 'boolean' || typeof v.readonly !== 'boolean') return null;
    // `null`: the whole host (the owner, or a `host:all` guest, relay-grant.ts principalOf); else the one workspace.
    if (v.workspaceId !== null && (typeof v.workspaceId !== 'string' || v.workspaceId === '')) return null;
    return { kind: 'relay', label: v.label, isOwner: v.isOwner, workspaceId: v.workspaceId as string | null, readonly: v.readonly };
}

export class RelayBridgeHost implements ServerTransport {
    readonly #listeners = new Set<(connection: ServerConnection) => void>();
    readonly #open = new Map<string, Bridged>();
    readonly #send: (owner: string, event: BridgeEvent) => void;

    /** `send`: a frame (or the close) for the window that owns the connection. */
    constructor(send: (owner: string, event: BridgeEvent) => void) {
        this.#send = send;
    }

    onConnection(listener: (connection: ServerConnection) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** A relay connection the window's relay host admitted. */
    open(owner: string, preAuth: unknown): { ok: true; id: string } | { ok: false; reason: string } {
        const pre = relayPreAuth(preAuth);
        if (!pre) return { ok: false, reason: 'only a connection the Tynn relay admitted is bridged, with its relay proof' };
        const id = randomUUID();
        const b: Bridged = { owner, messages: new Set(), closes: new Set(), closed: false };
        this.#open.set(id, b);
        const connection: ServerConnection = {
            remoteAddress: `relay:${pre.label}`,
            preAuth: pre,
            send: (text) => { if (!b.closed) this.#send(owner, { id, frame: text }); },
            onMessage: (l) => { b.messages.add(l); return () => { b.messages.delete(l); }; },
            onClose: (l) => { b.closes.add(l); return () => { b.closes.delete(l); }; },
            close: () => { if (this.#end(id)) this.#send(owner, { id, closed: true }); },
        };
        for (const l of this.#listeners) l(connection);
        return { ok: true, id };
    }

    /** A frame from the Pilot, through the window that owns the connection. */
    frame(owner: string, id: string, text: string): { ok: true } | { ok: false; reason: string } {
        const b = this.#open.get(id);
        if (!b || b.closed || b.owner !== owner) return { ok: false, reason: 'no such bridged connection' };
        for (const l of [...b.messages]) l(text);
        return { ok: true };
    }

    /** The Pilot left (the window says so). */
    closed(owner: string, id: string): void {
        const b = this.#open.get(id);
        if (b && b.owner === owner) this.#end(id);
    }

    /** The window that opened them left: its connections end. */
    dropOwner(owner: string): void {
        for (const [id, b] of [...this.#open]) if (b.owner === owner) this.#end(id);
    }

    #end(id: string): boolean {
        const b = this.#open.get(id);
        if (!b || b.closed) return false;
        b.closed = true;
        this.#open.delete(id);
        for (const l of [...b.closes]) l();
        return true;
    }
}

/** What genie-host tells its local windows about remote access. */
export type RemoteAccessEvent = { readonly kind: 'status'; readonly status: RemoteAccessStatus } | { readonly kind: 'bridge'; readonly event: BridgeEvent };

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
 * the lock and the pair answers; the window's relay host bridges its connections; the newest window forwards its events.
 */
const CHANGES_STATUS = new Set(['issuePin', 'revokeDevice', 'lock', 'unlock', 'answerPair', 'apply', 'restart', 'start', 'stop']);

export class RemoteAccessService {
    readonly #access: RemoteAccessHost;
    readonly #bridge: RelayBridgeHost;
    readonly #ports: RemoteAccessServicePorts;

    constructor(access: RemoteAccessHost, bridge: RelayBridgeHost, ports: RemoteAccessServicePorts) {
        this.#access = access;
        this.#bridge = bridge;
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
            case 'bridge.open': return this.#bridge.open(owner, args[0]);
            case 'bridge.frame': return this.#bridge.frame(owner, String(args[0]), String(args[1]));
            case 'bridge.close': this.#bridge.closed(owner, String(args[0])); return true;
            case 'event':
                // One window feeds remote connections: the newest local one, the same that does their calls.
                if (owner !== this.#ports.newestWindow()) return false;
                this.#ports.windowEvent(String(args[0]), args[1]);
                return true;
            default: throw new Error(`remote access has no ${method}`);
        }
    }

    dropOwner(owner: string): void {
        this.#bridge.dropOwner(owner);
    }
}
