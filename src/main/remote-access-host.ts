import { randomBytes } from 'node:crypto';
import { PairApprovals, type PairConfirm } from '../core/pair-confirm.js';
import type { DriveMode } from '../core/connected-here.js';
import { Baton, PairingPins, type PinEnded } from '../core/remote.js';
import { LOCAL_EVENTS, type RemoteMethod, type ServerTransport } from '../core/remote-protocol.js';
import type { LocalUploads } from './local-uploads.js';
import { DeviceStore, type Device } from './remote-devices.js';
import { RemoteHost, type EventWants, type HostApi } from './remote-host.js';
import type { ProtocolOffer } from '../core/protocol-version.js';
import { HOST_WORKSPACE_READ_METHODS } from './host-alone-api.js';

/**
 * REMOTE ACCESS'S HOST SIDE, IN GENIE-HOST (Tynn #409, host split P5d.1). A phone (over the tailnet) and a Pilot (over the
 * Tynn relay) reach THIS machine's genie-host, which runs whether a window is open or not. There is ONE of each thing that
 * says who drives: the paired devices (runtime/remote-devices.json, one writer), the PIN, the "Pair this device?" prompts,
 * the baton and the owner's lock. A window reads and drives them through its replica; its own protocol door (local
 * authentication) stays the window's.
 *
 * genie-host answers every remote method itself, for every client, whether or not a window is connected (client/host
 * split step 2d, Tynn #898). Since step 2d-2b no remote method is sent to a window: the engine link's reverse call for it
 * (`client.remoteInvoke`) is gone.
 */

/** What genie-host answers for its remote connections. */
export interface HostRemoteApiPorts {
    readonly hostName: string;
    /** Methods genie-host performs itself, ahead of its built answers. */
    readonly own: Partial<Record<RemoteMethod, (args: unknown[]) => Promise<unknown>>>;
    /**
     * GENIE-HOST'S OWN ANSWERS (Tynn #551, #666, #898; host-alone-api.ts): every method, and every event, come from here
     * whether or not a window is connected. A getter: genie-host builds it once its session host is up; until then a call
     * is told to try again in a moment, and a connected window's events are passed on.
     */
    readonly alone?: HostApi | (() => HostApi | null);
    readonly onAloneReady?: (listener: () => void) => () => void;
    /** A Pilot's Take Over window closed: the TUI it started goes with it, whoever else is connected. */
    readonly takeOverEnded?: (terminalId: string) => void;
    /** The workspace an agent is in (a guest is held to its own), from the host's roster. */
    readonly workspaceOfAgent?: (agentId: string) => string | null;
    /** The workspace a terminal is in (Tynn #691): a guest reaches its own workspace's terminals and no other. Absent = none. */
    readonly workspaceOfTerminal?: (terminalId: string) => string | null;
    /** Each workspace's folder (Tynn #691): how far a guest may browse. Absent = a guest browses nothing. */
    readonly workspacePaths?: () => Readonly<Record<string, string>>;
}

export function hostRemoteApi(ports: HostRemoteApiPorts): HostApi {
    const alone = (): HostApi | null => (typeof ports.alone === 'function' ? ports.alone() : ports.alone ?? null);
    const featureEvent = (channel: string): boolean => channel === 'features' || channel === LOCAL_EVENTS.features;
    const api: HostApi = {
        get ownsFeatures() { return alone()?.ownsFeatures === true; },
        releaseCaller: context => alone()?.releaseCaller?.(context),
        // THE PORTS RemoteHost READS OFF THE API (Tynn #898 step 2d-3a): genie-host's own, once its answers are built.
        marketplace: () => alone()?.marketplace?.() ?? null,
        gapps: (context) => alone()?.gapps?.(context) ?? null,
        invoke: async (method, args, context) => {
            const own = ports.own[method];
            if (own) return own(args);
            const owned = alone();
            // These reads and writes share the host's store (Tynn #666); the rest are genie-host's too (Tynn #898).
            if (!owned) {
                if (HOST_WORKSPACE_READ_METHODS.has(method)) throw new Error(`${ports.hostName}'s workspace services are still starting; try again in a moment`);
                throw new Error(`${ports.hostName}'s services are still starting; try again in a moment`);
            }
            return owned.invoke(method, args, context);
        },
        // GENIE-HOST'S OWN EVENTS (Tynn #898): every event comes from its answers, once built; what a Pilot types among them
        // (Tynn #730), published to every client of this host, this machine's window included (it is one, since 2d-4b).
        onEvent: (listener, options) => {
            let offAlone: (() => void) | null = null;
            const bind = () => { if (!offAlone) offAlone = alone()?.onEvent(listener, options) ?? null; };
            const offReady = ports.onAloneReady?.(bind); bind();
            return () => { offReady?.(); offAlone?.(); };
        },
        workspaceOfAgent: (agentId) => ports.workspaceOfAgent?.(agentId) ?? null,
        ...(ports.workspaceOfTerminal ? { workspaceOfTerminal: ports.workspaceOfTerminal } : {}),
        ...(ports.workspacePaths ? { workspacePaths: ports.workspacePaths } : {}),
        ...(ports.takeOverEnded ? { takeOverEnded: ports.takeOverEnded } : {}),
    };
    // Read when RemoteHost asks, so a port genie-host builds after this API (at boot) is the one it gets; absent until then.
    for (const key of ['filesWatch', 'tynnWatch', 'localTerminals', 'localAgents'] as const) {
        Object.defineProperty(api, key, { get: () => alone()?.[key], enumerable: true });
    }
    return api;
}

/** What Settings → Workstation shows of remote access, read from the host. */
export interface RemoteAccessStatus {
    readonly host: string;
    readonly url: string | null;
    readonly unavailable: string | null;
    readonly locked: boolean;
    readonly pin: { code: string; expiresAt: number } | null;
    /** Why the last PIN went without pairing (Tynn #751); absent from an older host = not said. */
    readonly pinEnded?: PinEnded | null;
    readonly devices: Device[];
    readonly connections: ReturnType<RemoteHost['connections']>;
    readonly pairRequests: ReturnType<PairApprovals['requests']>;
    /** What the connections want of the window's events (Tynn #662); absent from an older host = everything. */
    readonly wants?: EventWants;
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
    /** This host's protocol offer, read at each hello (Tynn #894); absent = this build's, with no catalog elements. */
    readonly protocol?: () => ProtocolOffer;
    /**
     * Where a local connection stages what it uploads (a draft's file, a file to write; Tynn #898 step 2d-3b): one
     * registry per connection, over this host's staging area. Absent = "local staging is not configured on this host".
     */
    readonly createLocalUploads?: () => LocalUploads | Promise<LocalUploads>;
    /** What one of this machine's windows adds to its own snapshot (its renderer notice); null = nothing. Never a remote connection's. */
    readonly localSnapshot?: (connectionId: string) => Readonly<Record<string, unknown>> | null;
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
            ...(options.protocol ? { protocol: options.protocol } : {}),
            ...(options.createLocalUploads ? { createLocalUploads: options.createLocalUploads } : {}),
            ...(options.localSnapshot ? { localSnapshot: options.localSnapshot } : {}),
        });
        return new RemoteAccessHost(remote, pairing, devices);
    }

    status(): RemoteAccessStatus {
        const r = this.remote;
        return { host: r.hostName, url: r.url(), unavailable: r.unavailable(), locked: r.locked(), pin: r.activePin(), pinEnded: r.pinEnded(), devices: r.devices(), connections: r.connections(), pairRequests: this.pairing.requests(), wants: r.wanted() };
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

    /** Watch only, or full control, for one connected person (Tynn #732). */
    setMode(label: string, mode: DriveMode): void {
        this.remote.setMode(label, mode);
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
    /** To one window (`owner`), or every local window (`null`). */
    readonly send: (owner: string | null, event: RemoteAccessEvent) => void;
}

/**
 * REMOTE ACCESS, AS THE WINDOW DRIVES IT (Tynn #409): the engine link's `engine.remoteAccess`, from a LOCAL window only
 * (session-engine-server.ts). Settings → Workstation's remote section reads the status and drives the PIN, the devices,
 * the lock and the pair answers.
 */
const CHANGES_STATUS = new Set(['issuePin', 'revokeDevice', 'lock', 'unlock', 'setMode', 'answerPair', 'apply', 'restart', 'start', 'stop']);

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
            case 'setMode': {
                const [label, mode] = args;
                if (typeof label !== 'string' || (mode !== 'view' && mode !== 'control')) throw new Error('setMode names a person and view or control');
                a.setMode(label, mode);
                return true;
            }
            case 'answerPair': return a.answerPair(String(args[0]), args[1] === true);
            case 'apply': await this.#ports.switch.apply(); return a.status();
            // The handlers genie.remote-access's catalog payload names (genie-catalog.ts): start follows the setting.
            case 'start': await this.#ports.switch.apply(); return a.status();
            case 'stop': await this.#ports.switch.stop(); return a.status();
            case 'health': { const s = a.status(); return { host: s.host, listening: s.url !== null, why: s.unavailable }; }
            case 'restart': await this.#ports.switch.restart(); return a.status();
            default: throw new Error(`remote access has no ${method}`);
        }
    }
}
