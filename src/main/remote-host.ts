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
import { pairRefusal, type PairConfirm } from '../core/pair-confirm.js';
import { DEVICE_EXPIRY_DAYS } from '../core/device-expiry.js';
import { UploadStaging, nextWindow, openWindow, type WatchOptions, type WindowState, type WireRow } from '../core/mobile-wire.js';

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
    /**
     * Everything the host pushes: `snapshot`, `agent:<id>`, `features`, `updates`, `terminal-data`, `terminal-exit`.
     * `wantsAgent`: whether anyone listening wants an agent's detail now — one nobody wants is not built (genie#1346).
     */
    onEvent(listener: (channel: string, payload: unknown) => void, options?: { wantsAgent?: (agentId: string) => boolean }): () => void;
    workspaceOfAgent(agentId: string): string | null;
    /** The workspace a terminal is in — what decides whether a guest receives its output. Absent = a guest receives none. */
    workspaceOfTerminal?(terminalId: string): string | null;
    /** Each workspace's folder on this host — how far a guest may browse (Tynn #835). Absent = a guest browses nothing. */
    workspacePaths?(): Readonly<Record<string, string>>;
}

// 'workspaces.create' too: New can create a repository under the host owner's GitHub and declare it on their Tynn (Add workspace parity 11).
/** What only the host's OWNER may do, whoever the guest is: it adds to the host itself (Tynn #835). */
const OWNER_ONLY: readonly string[] = ['workspaces.previewAdd', 'workspaces.confirmAdd', 'workspaces.create', 'workspaces.previewAddFromGit', 'workspaces.confirmAddFromGit', 'workspaces.readSource', 'workspaces.stageFromGit', 'workspaces.registerExisting', 'workspaces.buildEnvelope', 'workspaces.discardStaged', 'workspaces.githubRepos', 'workspaces.tynnProjects', 'workspaces.tynnOwnerOptions', 'workspaces.createTynnProject', 'workspaces.importedAgents', 'workspaces.adoptAgent', 'workspaces.previewAddFromTynn', 'workspaces.confirmAddFromTynn', 'workspaces.tynnBoard', 'workspaces.tynnBoardAction', 'workspaces.tynnIssues', 'workspaces.tynnIssueAction', 'workspaces.tynnPage', 'host.mkdir'];

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
    /** The paired device this connection is (PIN or token) — what removing it in Settings closes. */
    deviceId: string | null;
    /** The "Pair this device?" prompt this connection is waiting on (q_8c07b142); withdrawn if it hangs up. */
    pendingPair: string | null;
    /** `mobile`: a phone (genie#1346) — the snapshot and its watched agents only, no terminals. */
    profile: 'mobile' | null;
    /** A phone's windows on the agents it watches (core/mobile-wire.ts). */
    readonly watching: Map<string, WindowState<WireRow>>;
}

/** What a phone may never call: it has no terminals (the owner, 2026-10-11; Genie 1 streamed them to the phone). */
const PHONE_REFUSES = (method: string): boolean => method.startsWith('terminals.');

/** A push a connection does not receive. */
const NOT_SENT = Symbol('not sent');

/** A feature snapshot for a non-owner: the remote section's secrets emptied, its shape kept (the window still renders). */
function withoutRemoteSecrets(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || !('remote' in value)) return value;
    const remote = (value as { remote: unknown }).remote;
    if (typeof remote !== 'object' || remote === null) return value;
    return { ...value, remote: { ...remote, pin: null, devices: [], shares: [], connections: [], servedLink: null, pairRequests: [] } };
}

/**
 * A feature snapshot for ANY remote connection: no "Pair this device?" requests. Allow is given on this machine's own
 * screen only (q_8c07b142) — a device already paired does not get to let another one in.
 */
function withoutPairRequests(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || !('remote' in value)) return value;
    const remote = (value as { remote: unknown }).remote;
    if (typeof remote !== 'object' || remote === null) return value;
    return { ...value, remote: { ...remote, pairRequests: [] } };
}

const isAnswerPair = (args: unknown[]): boolean => typeof args[0] === 'object' && args[0] !== null && (args[0] as { kind?: unknown }).kind === 'remote.answerPair';

export class RemoteHost {
    readonly #api: HostApi;
    readonly #hostName: string;
    readonly #baton: Baton;
    readonly #pins: PairingPins;
    readonly #shares: ShareLinks;
    readonly #devices: DeviceStore;
    readonly #confirm: PairConfirm;
    readonly #changeListeners = new Set<() => void>();
    /** Re-pair: the device the PIN on screen was issued to replace, if any. */
    #pinReplaces: string | null = null;
    readonly #connections = new Map<string, Connection>();
    readonly #transport: ServerTransport;
    readonly #now: () => number;
    /** Bytes a connection sent ahead of the call that uses them (genie#1346). */
    readonly #staging: UploadStaging;
    #pin: { code: string; expiresAt: number } | null = null;
    #next = 0;
    #locked = false;
    /**
     * The host API's events, listened to ONLY while an authenticated connection exists (genie#1200). Listening builds an
     * agent's whole detail on every update of every agent (host-api.ts), and with no one connected #broadcast sent it to
     * no one — main at 78–98 % of a core for seconds on the owner's machine with many agents.
     */
    #stopListening: (() => void) | null = null;

    /**
     * `confirm`: the desktop's "Pair this device?" (core/pair-confirm.ts). Required — a correct PIN pairs nothing until the
     * person presses Allow on this machine (q_8c07b142; Genie 1's confirmPair).
     */
    constructor(deps: { api: HostApi; hostName: string; baton: Baton; pins: PairingPins; shares: ShareLinks; devices: DeviceStore; confirm: PairConfirm; transport: ServerTransport; now?: () => number }) {
        this.#api = deps.api;
        this.#hostName = deps.hostName;
        this.#baton = deps.baton;
        this.#pins = deps.pins;
        this.#shares = deps.shares;
        this.#devices = deps.devices;
        this.#confirm = deps.confirm;
        this.#transport = deps.transport;
        this.#now = deps.now ?? Date.now;
        this.#staging = new UploadStaging({ now: this.#now });
        deps.transport.onConnection((socket) => this.#accept(socket));
    }

    /** Someone is connected and known: hear the host API (once, however many connect). */
    #listen(): void {
        this.#stopListening ??= this.#api.onEvent((channel, payload) => this.#broadcast(channel, payload), { wantsAgent: (agentId) => this.#wantsAgent(agentId) });
    }

    /** Someone wants this agent's detail: a window that is not a phone (it hears every agent), or a phone watching it. */
    #wantsAgent(agentId: string): boolean {
        for (const c of this.#connections.values()) {
            if (c.auth === null) continue;
            if (c.profile !== 'mobile' || c.watching.has(agentId)) return true;
        }
        return false;
    }

    /** A connection left: with no authenticated connection remaining, stop hearing the host API. */
    #drop(connection: Connection): void {
        if (connection.pendingPair !== null) {
            this.#confirm.cancel(connection.pendingPair);
            connection.pendingPair = null;
        }
        const was = this.#connections.delete(connection.id);
        if (was && connection.auth !== null) this.#changed();
        if ([...this.#connections.values()].some((c) => c.auth !== null)) return;
        this.#stopListening?.();
        this.#stopListening = null;
    }

    /**
     * The six digits shown on THIS screen for a device to type. `replaces`: a Re-pair — the device that pairs with this PIN
     * (and is allowed) takes the place of that one.
     */
    issuePin(options: { replaces?: string } = {}): { code: string; expiresAt: number } {
        this.#pin = this.#pins.issue();
        this.#pinReplaces = options.replaces ?? null;
        return this.#pin;
    }

    /** Connections, devices or a pairing changed: Settings and the prompt redraw. */
    onChange(listener: () => void): () => void {
        this.#changeListeners.add(listener);
        return () => { this.#changeListeners.delete(listener); };
    }

    #changed(): void {
        for (const l of this.#changeListeners) l();
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

    /** Remove a paired device — and end its live connections NOW, not at its next reconnect (genie#1346). */
    revokeDevice(id: string): boolean {
        if (!this.#devices.revoke(id)) return false;
        for (const c of [...this.#connections.values()]) {
            if (c.deviceId !== id) continue;
            this.#baton.connectionLost(c.id);
            this.#refuse(c, `this device is not paired with ${this.#hostName} any more`, true);
        }
        this.#changed();
        return true;
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
        const connection: Connection = { id: `conn_${++this.#next}`, socket, auth: null, deviceId: null, pendingPair: null, profile: null, watching: new Map() };
        this.#connections.set(connection.id, connection);
        socket.onMessage((text) => { void this.#onFrame(connection, text); });
        socket.onClose(() => {
            this.#baton.connectionLost(connection.id);
            this.#staging.dropOwner(connection.id);
            this.#drop(connection);
        });
    }

    #send(connection: Connection, message: WireMessage): void {
        connection.socket.send(JSON.stringify(message));
    }

    #refuse(connection: Connection, reason: string, close: boolean): void {
        this.#send(connection, { kind: 'refused', reason });
        if (close) {
            this.#drop(connection);
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
            await this.#hello(connection, message);
            return;
        }
        if (message.kind !== 'call') return; // A client sends calls; anything else is noise, not an error worth a frame.
        this.#send(connection, await this.#call(connection, message.id, message.method, message.args));
    }

    async #hello(connection: Connection, message: Extract<WireMessage, { kind: 'hello' }>): Promise<void> {
        const auth = message.auth;
        const label = auth.label ?? message.label ?? 'a device';
        let token: string | undefined;
        if (connection.pendingPair !== null) return this.#refuse(connection, `this device is already waiting for Allow on ${this.#hostName}`, false);
        if (auth.kind === 'pin') {
            const r = this.#pins.redeem(auth.code);
            if (!r.ok) return this.#refuse(connection, r.reason, true);
            // THE CONFIRM (q_8c07b142; Genie 1's confirmPair): the right PIN only raises "Pair this device?" on this screen.
            const replacing = this.#pinReplaces === null ? undefined : this.#devices.list().find((d) => d.id === this.#pinReplaces);
            this.#pinReplaces = null;
            const asked = this.#confirm.ask({ label, from: connection.socket.remoteAddress, replaces: replacing ? { id: replacing.id, label: replacing.label } : null });
            connection.pendingPair = asked.id;
            this.#send(connection, { kind: 'pairing', host: this.#hostName, expiresAt: asked.expiresAt });
            const answer = await asked.answer.catch(() => 'deny' as const);
            connection.pendingPair = null;
            if (answer === 'gone' || !this.#connections.has(connection.id)) return;
            if (answer !== 'allow') return this.#refuse(connection, pairRefusal(answer, this.#hostName), true);
            const paired = this.#devices.pair(label);
            token = paired.token;
            connection.deviceId = paired.device.id;
            connection.auth = { label, isOwner: true, workspaceId: null, readonly: false };
            // A Re-pair: the old pairing goes, and any socket still using it is closed.
            if (replacing) this.revokeDevice(replacing.id);
        } else if (auth.kind === 'token') {
            const checked = this.#devices.check(auth.token);
            if (!checked.ok) {
                return this.#refuse(connection, checked.expired
                    ? `this device is not paired with ${this.#hostName} any more: it had not connected for ${DEVICE_EXPIRY_DAYS} days. Pair it again.`
                    : `this device is not paired with ${this.#hostName}`, true);
            }
            const device = checked.device;
            connection.deviceId = device.id;
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
        if (message.profile === 'mobile') connection.profile = 'mobile';
        this.#send(connection, {
            kind: 'welcome',
            connectionId: connection.id,
            host: this.#hostName,
            isOwner: connection.auth.isOwner,
            workspaceId: connection.auth.workspaceId,
            ...(token ? { token } : {}),
        });
        this.#listen();
        this.#changed();
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
            case 'agent.watch':
                return this.#watch(connection, String(args[0] ?? ''), (args[1] ?? {}) as WatchOptions).then(ok, (error: unknown) => refuse(error instanceof Error ? error.message : String(error)));
            case 'agent.unwatch':
                return ok({ unwatched: connection.watching.delete(String(args[0] ?? '')) });
            case 'upload.begin': {
                if (auth.readonly) return refuse(`${auth.label} has read-only access to ${this.#hostName}`);
                const input = (args[0] ?? {}) as { name?: unknown; size?: unknown };
                const r = this.#staging.begin(connection.id, { name: input.name, size: input.size });
                return r.ok ? ok({ id: r.id }) : refuse(r.reason);
            }
            case 'upload.chunk': {
                const r = this.#staging.chunk(connection.id, String(args[0] ?? ''), args[1], args[2]);
                return r.ok ? ok({ received: r.received }) : refuse(r.reason);
            }
            case 'upload.abort':
                return ok({ aborted: this.#staging.abort(connection.id, String(args[0] ?? '')) });
        }

        // Allow is pressed on THIS machine's screen, never sent from another device — not even the owner's (q_8c07b142).
        if (method === 'features.act' && isAnswerPair(args)) return refuse(`a device is allowed on ${this.#hostName}’s own screen, never from another device`);

        // A phone has no terminals (genie#1346): refused here, before anything on the host is asked.
        if (connection.profile === 'mobile' && PHONE_REFUSES(method)) return refuse(`${method}: a phone has no terminals; open one on ${this.#hostName}`);

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

        // Staged bytes are taken only now, after every gate passed (genie#1346): never a path, never bytes inline.
        const materialized = this.#materialize(connection, method, args);
        if (!materialized.ok) return refuse(materialized.reason);

        try {
            const value = await this.#api.invoke(method, materialized.args);
            if (method === 'snapshot' && auth.workspaceId !== null) return ok(filterSnapshotForWorkspace(value as Parameters<typeof filterSnapshotForWorkspace>[0], auth.workspaceId));
            // SECURITY (genie#872): the feature snapshot carries the LIVE pairing PIN (enough to pair as an owner), the
            // paired devices, the share links (their URLs carry the secret) and the connections. Only an owner sees them.
            if (method === 'features.snapshot' && !auth.isOwner) return ok(withoutRemoteSecrets(value));
            if (method === 'features.snapshot') return ok(withoutPairRequests(value));
            return ok(value);
        } catch (error) {
            return refuse(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * `files.upload` and a prompt's attachments name bytes STAGED on this connection (`{ staged: id }`); they are swapped
     * for the bytes here, taken once. Anything else in their place — a path, inline bytes, another connection's id — is
     * refused. Every other call passes through untouched.
     */
    #materialize(connection: Connection, method: string, args: unknown[]): { ok: true; args: unknown[] } | { ok: false; reason: string } {
        const stagedId = (v: unknown): string | null => (typeof v === 'object' && v !== null && typeof (v as { staged?: unknown }).staged === 'string' ? (v as { staged: string }).staged : null);
        if (method === 'files.upload') {
            const id = stagedId(args[2]);
            const file = id === null ? null : this.#staging.take(connection.id, id);
            if (!file) return { ok: false, reason: 'that upload is not finished on this connection; send it again' };
            return { ok: true, args: [args[0], args[1], file] };
        }
        if (method === 'prompt' && args.length > 2 && args[2] !== undefined) {
            if (!Array.isArray(args[2])) return { ok: false, reason: 'attachments are a list' };
            const files: Array<{ name: string; type: string; bytes: Uint8Array }> = [];
            for (const a of args[2] as unknown[]) {
                const id = stagedId(a);
                const file = id === null ? null : this.#staging.take(connection.id, id);
                if (!file) return { ok: false, reason: 'an attachment is not finished on this connection; send it again' };
                const type = typeof (a as { type?: unknown }).type === 'string' ? (a as { type: string }).type : '';
                files.push({ name: file.name, type, bytes: file.bytes });
            }
            return { ok: true, args: [args[0], args[1], files] };
        }
        return { ok: true, args };
    }

    /** A phone opens a window on one agent's ledger: its detail without rows, and the window (core/mobile-wire.ts). */
    async #watch(connection: Connection, agentId: string, options: WatchOptions): Promise<{ seq: number; detail: unknown; rows: unknown }> {
        const auth = connection.auth!;
        if (auth.workspaceId !== null && this.#api.workspaceOfAgent(agentId) !== auth.workspaceId) throw new Error(`${agentId} is not in the workspace this link shares`);
        const detail = (await this.#api.invoke('agentDetail', [agentId])) as ({ rows?: readonly WireRow[] } & Record<string, unknown>) | null;
        if (detail === null || detail === undefined) {
            connection.watching.delete(agentId);
            return { seq: 0, detail: null, rows: { base: null, keep: 0, append: [] } };
        }
        const { rows = [], ...rest } = detail;
        const opened = openWindow(rows, options);
        connection.watching.set(agentId, opened.state);
        if (!this.#stopListening) this.#listen();
        return { seq: opened.state.seq, detail: rest, rows: opened.rows };
    }

    /** A phone hears `snapshot`, and `agent:<id>` for an agent it watches as a patch on its window; nothing else. */
    #forPhone(connection: Connection, channel: string, payload: unknown): unknown {
        if (channel === 'snapshot') return payload;
        if (!channel.startsWith('agent:')) return NOT_SENT;
        const agentId = channel.slice('agent:'.length);
        const state = connection.watching.get(agentId);
        if (!state) return NOT_SENT;
        if (payload === null || payload === undefined) {
            connection.watching.delete(agentId);
            return { seq: state.seq + 1, detail: null, rows: { base: null, keep: 0, append: [] } };
        }
        const { rows = [], ...rest } = payload as { rows?: readonly WireRow[] } & Record<string, unknown>;
        const next = nextWindow(state, rows);
        connection.watching.set(agentId, next.state);
        return { seq: next.state.seq, detail: rest, rows: next.rows };
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
            let out: unknown = channel === 'features' ? withoutPairRequests(payload) : payload;
            if (c.auth.workspaceId !== null) out = this.#forGuest(channel, out, c.auth.workspaceId);
            if (out !== NOT_SENT && c.profile === 'mobile') out = this.#forPhone(c, channel, out);
            if (out !== NOT_SENT) this.#send(c, { kind: 'event', channel, payload: out });
        }
    }

    /**
     * WHAT A GUEST RECEIVES (beta.33 item 26, SECURITY — builder-lanes, 2026-10-20: every push but the snapshot went to every
     * connection, another workspace's agent ledgers and terminal output included). Deny by default: only a push that is
     * placed in the guest's workspace by the same rule its requests are — its snapshot filtered, its own agents' details,
     * its own terminals' output and exit. The host's features and update state, and any channel not classified here, are
     * not sent to a guest at all.
     */
    #forGuest(channel: string, payload: unknown, workspaceId: string): unknown {
        if (channel === 'snapshot') return filterSnapshotForWorkspace(payload as Parameters<typeof filterSnapshotForWorkspace>[0], workspaceId);
        if (channel.startsWith('agent:')) return this.#api.workspaceOfAgent(channel.slice('agent:'.length)) === workspaceId ? payload : NOT_SENT;
        // An agent's activity feed (the Dashboard's lanes): only for an agent of the guest's workspace.
        if (channel === 'activity') {
            const agentId = (payload as { agentId?: unknown } | null)?.agentId;
            return typeof agentId === 'string' && this.#api.workspaceOfAgent(agentId) === workspaceId ? payload : NOT_SENT;
        }
        if (channel === 'terminal-data' || channel === 'terminal-exit') {
            const id = (payload as { id?: unknown } | null)?.id;
            return typeof id === 'string' && this.#api.workspaceOfTerminal?.(id) === workspaceId ? payload : NOT_SENT;
        }
        return NOT_SENT;
    }
}
