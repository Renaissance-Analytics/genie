import type { Baton, PairingPins, ShareLinks, ShareLink } from '../core/remote.js';
import {
    AGENT_SCOPED_METHODS,
    WORKSPACE_SCOPED_METHODS,
    capabilityOf,
    filterSnapshotForWorkspace,
    parseMessage,
    type ControlMethod,
    type RemoteMethod,
    type ServerConnection,
    type ServerTransport,
    type WireMessage,
} from '../core/remote-protocol.js';
import type { Device, DeviceStore } from './remote-devices.js';

/**
 * THE REMOTE HOST (§6.8) — another machine (or a phone) drives THIS Genie over a transport.
 *
 * A connection says hello with a PIN read off this screen (pairs a device of the OWNER's and mints
 * a durable token), a token from an earlier pairing, or a share link (admits a GUEST to one
 * workspace). Then every call is gated by the one table in core/remote-protocol.ts: a read is never
 * gated, a write needs the baton, an upgrade needs ownership, a host-only method is refused with
 * where to do it. Events reach every connection; a guest's are filtered to its workspace. The
 * transport is a port — fancy-ws on a real socket, an in-memory pair in tests.
 */

export interface HostApi {
    /** Perform a bridge method on this host. Throws → the caller gets the message as a refusal. */
    invoke(method: RemoteMethod, args: unknown[]): Promise<unknown>;
    /** Everything the host pushes: `snapshot`, `agent:<id>`, `activity`, `features`, `updates`, `terminal-data`, `terminal-exit`. */
    onEvent(listener: (channel: string, payload: unknown) => void): () => void;
    workspaceOfAgent(agentId: string): string | null;
    /** Each workspace's folder on this host — how far a guest may browse (Tynn #835). Absent = a guest browses nothing. */
    workspacePaths?(): Readonly<Record<string, string>>;
}

/** What only the host's OWNER may do, whoever the guest is: it adds to the host itself (Tynn #835). */
const OWNER_ONLY: readonly string[] = ['workspaces.previewAdd', 'workspaces.confirmAdd', 'workspaces.previewAddFromGit', 'workspaces.confirmAddFromGit', 'workspaces.tynnProjects', 'workspaces.previewAddFromTynn', 'workspaces.confirmAddFromTynn'];

/** `/`-separated, `..` resolved — so `/w/tynn/../fancy` is judged as `/w/fancy`. */
function normalizedPath(p: string): string {
    const out: string[] = [];
    for (const seg of p.replace(/\\/g, '/').split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') out.pop();
        else out.push(seg);
    }
    const drive = /^[A-Za-z]:$/.test(out[0] ?? '');
    return drive ? `${out.join('/')}` : `/${out.join('/')}`;
}

/**
 * Is `path` the folder `root` or inside it (not a sibling that merely starts with its name)? Case is ignored only on a
 * Windows drive path: on Linux `/w/TYNN` is a different folder, and treating it as `/w/tynn` would let a guest out.
 */
function within(path: string, root: string): boolean {
    const windows = /^[A-Za-z]:/.test(normalizedPath(root));
    const fold = (s: string) => (windows ? s.toLowerCase() : s);
    const p = fold(normalizedPath(path));
    const r = fold(normalizedPath(root)).replace(/\/$/, '');
    return p === r || p.startsWith(`${r}/`);
}

interface Connection {
    readonly id: string;
    readonly socket: ServerConnection;
    auth: { label: string; isOwner: boolean; workspaceId: string | null; readonly: boolean } | null;
}

export class RemoteHost {
    readonly #api: HostApi;
    readonly #hostName: string;
    readonly #baton: Baton;
    readonly #pins: PairingPins;
    readonly #shares: ShareLinks;
    readonly #devices: DeviceStore;
    readonly #connections = new Map<string, Connection>();
    readonly #transport: ServerTransport;
    readonly #now: () => number;
    #pin: { code: string; expiresAt: number } | null = null;
    #next = 0;
    #locked = false;

    constructor(deps: { api: HostApi; hostName: string; baton: Baton; pins: PairingPins; shares: ShareLinks; devices: DeviceStore; transport: ServerTransport; now?: () => number }) {
        this.#api = deps.api;
        this.#hostName = deps.hostName;
        this.#baton = deps.baton;
        this.#pins = deps.pins;
        this.#shares = deps.shares;
        this.#devices = deps.devices;
        this.#transport = deps.transport;
        this.#now = deps.now ?? Date.now;
        deps.transport.onConnection((socket) => this.#accept(socket));
        deps.api.onEvent((channel, payload) => this.#broadcast(channel, payload));
    }

    /** The six digits shown on THIS screen for a device to type. */
    issuePin(): { code: string; expiresAt: number } {
        this.#pin = this.#pins.issue();
        return this.#pin;
    }

    get hostName(): string {
        return this.#hostName;
    }

    /** The PIN on this screen, while it is still good. */
    activePin(): { code: string; expiresAt: number } | null {
        if (this.#pin && this.#now() > this.#pin.expiresAt) this.#pin = null;
        return this.#pin;
    }

    /** Where a device connects; `null` until a transport actually listens. */
    url(): string | null {
        return this.#transport.address?.() ?? null;
    }

    /** Why devices cannot connect, in the transport's own words; `null` while the socket listens. */
    unavailable(): string | null {
        if (this.url() !== null) return null;
        return this.#transport.unavailable?.() ?? `nothing is listening on ${this.#hostName}`;
    }

    locked(): boolean {
        return this.#locked;
    }

    devices(): Device[] {
        return this.#devices.list();
    }

    revokeDevice(id: string): boolean {
        return this.#devices.revoke(id);
    }

    shares(): ShareLink[] {
        return this.#shares.roster();
    }

    /** Mint AND serve in one step: the URL leaves here exactly once. */
    mintShare(input: { workspaceId: string; grantedTo: string; expiresInMs: number }): { link: ShareLink; url: string } {
        const link = this.#shares.mint(input);
        const served = this.#shares.serve(link.id);
        if (!served.ok) throw new Error(served.reason);
        return { link: this.#shares.roster().find((l) => l.id === link.id) ?? link, url: served.url };
    }

    revokeShare(id: string): boolean {
        return this.#shares.revoke(id);
    }

    connections(): Array<{ id: string; label: string; isOwner: boolean; workspaceId: string | null; driving: boolean }> {
        const driver = this.#baton.holder()?.connectionId ?? null;
        return [...this.#connections.values()]
            .filter((c) => c.auth !== null)
            .map((c) => ({ id: c.id, label: c.auth!.label, isOwner: c.auth!.isOwner, workspaceId: c.auth!.workspaceId, driving: c.id === driver }));
    }

    /** The owner's kill-switch: every write refused for everyone until unlocked; reads still answer. */
    lock(): void {
        this.#locked = true;
        this.#baton.lock();
    }

    unlock(): void {
        this.#locked = false;
        this.#baton.unlock();
    }

    #accept(socket: ServerConnection): void {
        const connection: Connection = { id: `conn_${++this.#next}`, socket, auth: null };
        this.#connections.set(connection.id, connection);
        socket.onMessage((text) => { void this.#onFrame(connection, text); });
        socket.onClose(() => {
            this.#baton.connectionLost(connection.id);
            this.#connections.delete(connection.id);
        });
    }

    #send(connection: Connection, message: WireMessage): void {
        connection.socket.send(JSON.stringify(message));
    }

    #refuse(connection: Connection, reason: string, close: boolean): void {
        this.#send(connection, { kind: 'refused', reason });
        if (close) {
            this.#connections.delete(connection.id);
            connection.socket.close();
        }
    }

    async #onFrame(connection: Connection, text: string): Promise<void> {
        const parsed = parseMessage(text);
        if (!parsed.ok) {
            this.#refuse(connection, parsed.reason, connection.auth === null);
            return;
        }
        const message = parsed.message;
        if (connection.auth === null) {
            if (message.kind !== 'hello') {
                this.#refuse(connection, 'say hello first', false);
                return;
            }
            this.#hello(connection, message);
            return;
        }
        if (message.kind !== 'call') return; // A client sends calls; anything else is noise, not an error worth a frame.
        this.#send(connection, await this.#call(connection, message.id, message.method, message.args));
    }

    #hello(connection: Connection, message: Extract<WireMessage, { kind: 'hello' }>): void {
        const auth = message.auth;
        const label = auth.label ?? message.label ?? 'a device';
        let token: string | undefined;
        if (auth.kind === 'pin') {
            const r = this.#pins.redeem(auth.code);
            if (!r.ok) return this.#refuse(connection, r.reason, true);
            token = this.#devices.pair(label).token;
            connection.auth = { label, isOwner: true, workspaceId: null, readonly: false };
        } else if (auth.kind === 'token') {
            const device = this.#devices.byToken(auth.token);
            if (!device) return this.#refuse(connection, `this device is not paired with ${this.#hostName}`, true);
            connection.auth = { label: auth.label ?? message.label ?? device.label, isOwner: true, workspaceId: null, readonly: false };
        } else if (auth.kind === 'relay') {
            // The transport proved who this is (a Tynn grant and its key); without that proof there is nothing to take.
            const pre = connection.socket.preAuth;
            if (!pre) return this.#refuse(connection, 'this connection did not come through the Tynn relay', true);
            connection.auth = { label: pre.label, isOwner: pre.isOwner, workspaceId: pre.workspaceId, readonly: pre.readonly };
        } else {
            const r = this.#shares.redeem(auth.id, auth.secret);
            if (!r.ok) return this.#refuse(connection, r.reason, true);
            connection.auth = { label: auth.label ?? message.label ?? r.grantedTo, isOwner: false, workspaceId: r.workspaceId, readonly: false };
        }
        this.#send(connection, {
            kind: 'welcome',
            connectionId: connection.id,
            host: this.#hostName,
            isOwner: connection.auth.isOwner,
            workspaceId: connection.auth.workspaceId,
            ...(token ? { token } : {}),
        });
    }

    async #call(connection: Connection, id: number, method: RemoteMethod | ControlMethod, args: unknown[]): Promise<WireMessage> {
        const auth = connection.auth!;
        const ok = (value: unknown): WireMessage => ({ kind: 'result', id, ok: true, value });
        const refuse = (reason: string): WireMessage => ({ kind: 'result', id, ok: false, reason });

        switch (method) {
            case 'baton.take': {
                // Holding the baton would keep everyone who CAN change things from doing so.
                if (auth.readonly) return refuse(`${auth.label} has read-only access to ${this.#hostName}`);
                const r = this.#baton.take(connection.id, auth.label);
                return r.ok ? ok({ driver: auth.label, mine: true }) : refuse(`${r.driverLabel} is driving ${this.#hostName}`);
            }
            case 'baton.release':
                return ok({ released: this.#baton.release(connection.id) });
            case 'baton.status': {
                const holder = this.#baton.holder();
                return ok({ driver: holder?.label ?? null, mine: holder?.connectionId === connection.id, locked: this.#locked });
            }
            case 'host.lock':
                if (!auth.isOwner) return refuse(`only the host owner may lock ${this.#hostName}`);
                this.lock();
                return ok({ locked: true });
            case 'host.unlock':
                if (!auth.isOwner) return refuse(`only the host owner may unlock ${this.#hostName}`);
                this.unlock();
                return ok({ locked: false });
        }

        const capability = capabilityOf(method);
        // A read-only grant (Tynn #838): reads, nothing else.
        if (auth.readonly && capability !== 'read') return refuse(`${auth.label} has read-only access to ${this.#hostName}`);
        // Only the owner changes the host itself — a guest of the whole host included.
        if (!auth.isOwner && auth.workspaceId === null && (method === 'features.act' || method.startsWith('updates.'))) return refuse(`${method} changes ${this.#hostName} itself; only its owner can`);
        if (!auth.isOwner && OWNER_ONLY.includes(method)) return refuse(`${method} changes ${this.#hostName} itself; only its owner can`);
        // A guest browses inside what it was given; the owner, the whole disk (Genie 1's approved scope, Tynn #835).
        if (!auth.isOwner && method === 'host.listDir') {
            const paths = this.#api.workspacePaths?.() ?? {};
            const roots = auth.workspaceId !== null ? [paths[auth.workspaceId]].filter((p): p is string => typeof p === 'string') : Object.values(paths);
            const target = String(args[0] ?? '');
            if (!roots.some((r) => within(target, r))) return refuse(`${target} is outside what this link shares`);
        }
        if (capability === 'host-only') {
            if (method === 'addWorkspace') return refuse(`${method} opens a folder picker on ${this.#hostName}; do it there`);
            if (method === 'takeOver') return refuse(`takeOver opens a window on ${this.#hostName}; do it there`);
            return refuse(`${method} places a view on ${this.#hostName}'s own window; there is nothing to do remotely`);
        }
        if (capability !== 'read') {
            const may = this.#baton.may(connection.id, capability, { isOwner: auth.isOwner });
            if (!may.ok) return refuse(may.reason);
            if (capability === 'write' && this.#baton.holder() === null) return refuse(`nobody is driving ${this.#hostName}; take the baton to make changes`);
        }
        if (auth.workspaceId !== null) {
            const scoped = this.#guestScope(auth.workspaceId, method, args);
            if (scoped) return refuse(scoped);
        }

        try {
            const value = await this.#api.invoke(method, args);
            return ok(method === 'snapshot' && auth.workspaceId !== null ? filterSnapshotForWorkspace(value as Parameters<typeof filterSnapshotForWorkspace>[0], auth.workspaceId) : value);
        } catch (error) {
            return refuse(error instanceof Error ? error.message : String(error));
        }
    }

    /** A guest holds a link to ONE workspace; anything outside it is refused by name. */
    #guestScope(workspaceId: string, method: RemoteMethod, args: unknown[]): string | null {
        if (AGENT_SCOPED_METHODS.includes(method)) {
            const agentId = String(args[0] ?? '');
            if (this.#api.workspaceOfAgent(agentId) !== workspaceId) return `${agentId} is not in the workspace this link shares`;
        }
        if (WORKSPACE_SCOPED_METHODS.includes(method) && String(args[0] ?? '') !== workspaceId) return `${String(args[0])} is not the workspace this link shares`;
        if (method === 'features.act' || method.startsWith('updates.')) return `${method} changes ${this.#hostName} itself; a shared workspace cannot`;
        return null;
    }

    #broadcast(channel: string, payload: unknown): void {
        for (const c of this.#connections.values()) {
            if (c.auth === null) continue;
            // An agent's activity feed reaches a guest only for an agent of the workspace its link shares.
            if (channel === 'activity' && c.auth.workspaceId !== null && this.#api.workspaceOfAgent(String((payload as { agentId?: unknown } | null)?.agentId ?? '')) !== c.auth.workspaceId) continue;
            const scoped = channel === 'snapshot' && c.auth.workspaceId !== null ? filterSnapshotForWorkspace(payload as Parameters<typeof filterSnapshotForWorkspace>[0], c.auth.workspaceId) : payload;
            this.#send(c, { kind: 'event', channel, payload: scoped });
        }
    }
}
