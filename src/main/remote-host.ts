import { randomBytes } from 'node:crypto';
import { LOCAL_FRAME_LIMIT_BYTES } from '../core/local-frame.js';
import { BATON_REFUSAL, type Baton, type PairingPins } from '../core/remote.js';
import { isLocalTerminalMethod } from '../core/local-terminals.js';
import { LocalTerminalServer } from './local-terminal-server.js';
import type { NativeTerminalPort } from './local-terminal-native.js';
import {
    AGENT_SCOPED_METHODS,
    BATON_EVENT,
    COMPANION_EVENT,
    WORKSPACE_SCOPED_METHODS,
    LOCAL_EVENTS as LOCAL_EVENT_CHANNELS,
    capabilityOf,
    filterSnapshotForWorkspace,
    parseMessage,
    REMOTE_PROTOCOL,
    CONTROL_METHODS as CONTROL_METHOD_LIST,
    type BatonEvent,
    type CompanionEvent,
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
import type { BlobOpener } from '../core/local-blobs.js';
import { LocalBlobs } from './local-blobs.js';
import type { PageOpener } from '../core/local-content.js';
import { LocalUploads } from './local-uploads.js';
import { LocalPages } from './local-pages.js';
import { LocalFilesContent } from './local-files-content.js';
import { isLocalFilesMethod } from '../core/local-files.js';
import { localFilesArguments } from './local-files-arguments.js';
import { isLocalDraftMethod } from '../core/local-drafts.js';
import { localDraftArguments } from './local-drafts-api.js';
import { isLocalArtboardMethod } from '../core/local-artboard.js';
import { localArtboardArguments } from './local-artboard-api.js';
import { LocalFilesWatches, type FilesWatchPort } from './local-files-watches.js';
import type { FilesHubEvent } from './files-watch-hub.js';

/**
 * THE REMOTE HOST (§6.8) — another machine (or a phone) drives THIS Genie over a transport.
 *
 * A connection says hello with a PIN read off this screen (pairs a device of the OWNER's and mints
 * a durable token), a token from an earlier pairing, or — on the Tynn relay only — the relay's own proof (the
 * owner, or a GUEST a Tynn share link admitted, scoped as its grant says).
 * Then every call is gated by the one table in core/remote-protocol.ts: a read is never
 * gated, a write needs the baton, an upgrade needs ownership, a host-only method is refused with
 * where to do it. Events reach every connection; a guest's are filtered to its workspace. The
 * transport is a port — fancy-ws on a real socket, an in-memory pair in tests.
 */

export interface HostApi {
    readonly filesWatch?: FilesWatchPort;
    readonly localTerminals?: NativeTerminalPort;
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
    /** A TUI started for another machine's Take Over window is done with: its window closed, or never came (Tynn #529 A). */
    takeOverEnded?(terminalId: string): void;
}

/** The largest payload a local event may carry: room left in one door frame for its envelope (P4 family 11). */
const LOCAL_EVENT_MAX_BYTES = LOCAL_FRAME_LIMIT_BYTES - 4 * 1024;

/** How long a Take over ticket waits for its window (Tynn #529 part A). */
const TICKET_TTL_MS = 30_000;
const TICKET_SPENT = 'this Take Over ticket was used already, or has expired';
const TICKET_FOREIGN = 'this Take Over ticket belongs to another window';
const COMPANION_ONLY = 'this Take Over window types only into its own terminal';
const COMPANION_DOES_NOT_DRIVE = 'a Take Over window does not drive; the window it was opened from does';
const COMPANION_TERMINAL_METHODS: readonly string[] = ['terminals.write', 'terminals.resize', 'terminals.close'];

// 'workspaces.create' too: New can create a repository under the host owner's GitHub and declare it on their Tynn (Add workspace parity 11).
/** What only the host's OWNER may do, whoever the guest is: it adds to the host itself (Tynn #835). */
const OWNER_ONLY: readonly string[] = ['workspaces.previewAdd', 'workspaces.confirmAdd', 'workspaces.create', 'workspaces.previewAddFromGit', 'workspaces.confirmAddFromGit', 'workspaces.readSource', 'workspaces.stageFromGit', 'workspaces.registerExisting', 'workspaces.buildEnvelope', 'workspaces.discardStaged', 'workspaces.githubRepos', 'workspaces.tynnProjects', 'workspaces.tynnOwnerOptions', 'workspaces.createTynnProject', 'workspaces.importedAgents', 'workspaces.adoptAgent', 'workspaces.previewAddFromTynn', 'workspaces.confirmAddFromTynn', 'workspaces.tynnBoard', 'workspaces.tynnBoardAction', 'workspaces.tynnIssues', 'workspaces.tynnIssueAction', 'workspaces.tynnPage', 'workspaces.tynnPageAction', 'host.mkdir'];

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
    /** Only the local frame door proves this; a hello alone never does. */
    local: boolean;
    /** A phone's windows on the agents it watches (core/mobile-wire.ts). */
    readonly watching: Map<string, WindowState<WireRow>>;
    /** Independent activity views belonging to this admitted local window. */
    readonly activityViews: Set<string>;
    filesViews: LocalFilesWatches | null;
    blobs: LocalBlobs | null;
    uploads: LocalUploads | null;
    uploadOpening: Promise<LocalUploads> | null;
    pages: LocalPages | null;
    content: LocalFilesContent | null;
    /** This window asked to be told who drives (`baton.watch`, Tynn #529). */
    batonWatch: boolean;
    /**
     * A TAKE OVER WINDOW (Tynn #529 part A): the window it was opened from, its one terminal, whether its click started the
     * TUI, and, once its window lost the baton or left, why it may type no more.
     */
    companion: { parentId: string; terminalId: string; started: boolean; revoked: string | null } | null;
}

/** What a phone may never call: it has no terminals (the owner, 2026-10-11; Genie 1 streamed them to the phone). */
const PHONE_REFUSES = (method: string): boolean => method.startsWith('terminals.');

/** Extended only when a family moves. Unmoved local views retain their existing subscriptions. */
const LOCAL_EVENTS = new Set<string>(['workspace-settings-changed', ...Object.values(LOCAL_EVENT_CHANNELS)]);

/** A push a connection does not receive. */
const NOT_SENT = Symbol('not sent');

/** A feature snapshot for a non-owner: the remote section's secrets emptied, its shape kept (the window still renders). */
function withoutRemoteSecrets(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || !('remote' in value)) return value;
    const remote = (value as { remote: unknown }).remote;
    if (typeof remote !== 'object' || remote === null) return value;
    return { ...value, remote: { ...remote, pin: null, devices: [], connections: [], pairRequests: [] } };
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
    readonly #openBlob: BlobOpener | undefined;
    readonly #openPage: PageOpener | undefined;
    readonly #createLocalUploads: (() => LocalUploads | Promise<LocalUploads>) | undefined;
    readonly #hostName: string;
    /** This Genie's build, said in `welcome` with the wire's protocol (P10.1e). */
    readonly #build: string;
    readonly #baton: Baton;
    readonly #pins: PairingPins;
    readonly #devices: DeviceStore;
    readonly #confirm: PairConfirm;
    readonly #changeListeners = new Set<() => void>();
    /** Re-pair: the device the PIN on screen was issued to replace, if any. */
    #pinReplaces: string | null = null;
    readonly #connections = new Map<string, Connection>();
    #localTerminals: LocalTerminalServer | null = null;
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
    /** Take over tickets not yet presented (Tynn #529 part A): by ticket, the window that asked and its terminal. */
    readonly #tickets = new Map<string, { parentId: string; terminalId: string; started: boolean; expiresAt: number; cancel: () => void }>();
    readonly #schedule: (ms: number, fn: () => void) => () => void;

    /**
     * `confirm`: the desktop's "Pair this device?" (core/pair-confirm.ts). Required — a correct PIN pairs nothing until the
     * person presses Allow on this machine (q_8c07b142; Genie 1's confirmPair).
     */
    constructor(deps: { api: HostApi; hostName: string; baton: Baton; pins: PairingPins; devices: DeviceStore; confirm: PairConfirm; transport: ServerTransport; now?: () => number; build?: string; openBlob?: BlobOpener; openPage?: PageOpener; createLocalUploads?: () => LocalUploads | Promise<LocalUploads>; schedule?: (ms: number, fn: () => void) => () => void }) {
        this.#api = deps.api;
        this.#openBlob = deps.openBlob;
        this.#hostName = deps.hostName;
        this.#build = deps.build ?? 'dev';
        this.#baton = deps.baton;
        this.#pins = deps.pins;
        this.#devices = deps.devices;
        this.#confirm = deps.confirm;
        this.#transport = deps.transport;
        this.#now = deps.now ?? Date.now;
        this.#openPage = deps.openPage;
        this.#createLocalUploads = deps.createLocalUploads;
        this.#staging = new UploadStaging({ now: this.#now });
        this.#schedule = deps.schedule ?? ((ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
        deps.transport.onConnection((socket) => this.#accept(socket));
    }

    /** Someone is connected and known: hear the host API (once, however many connect). */
    #listen(): void {
        if (![...this.#connections.values()].some((connection) => connection.auth !== null)) return;
        this.#stopListening ??= this.#api.onEvent((channel, payload) => this.#broadcast(channel, payload), { wantsAgent: (agentId) => this.#wantsAgent(agentId) });
    }

    /** Someone wants this agent's detail: a window that is not a phone (it hears every agent), or a phone watching it. */
    #wantsAgent(agentId: string): boolean {
        for (const c of this.#connections.values()) {
            if (c.auth === null || c.local) continue;
            if (c.profile !== 'mobile' || c.watching.has(agentId)) return true;
        }
        return false;
    }

    /** A connection left: with no authenticated connection remaining, stop hearing the host API. */
    #drop(connection: Connection): void {
        this.#localTerminals?.dropOwner(connection.id);
        connection.filesViews?.dispose();
        connection.content?.dispose();
        connection.blobs?.dispose();
        connection.pages?.dispose();
        // Disposal marks the connection closed synchronously, then drains any pending disk operation.
        if (connection.uploads) void connection.uploads.dispose().catch(() => console.warn('[genie] a local upload area could not be released'));
        connection.activityViews.clear();
        if (connection.pendingPair !== null) {
            this.#confirm.cancel(connection.pendingPair);
            connection.pendingPair = null;
        }
        const was = this.#connections.delete(connection.id);
        if (was && connection.auth !== null && !connection.local) this.#changed();
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
            if (this.#baton.connectionLost(c.id)) this.#batonChanged(c.id, null);
            this.#refuse(c, `this device is not paired with ${this.#hostName} any more`, true);
        }
        this.#changed();
        return true;
    }

    connections(): Array<{ id: string; label: string; isOwner: boolean; workspaceId: string | null; driving: boolean }> {
        const driver = this.#baton.holder()?.connectionId ?? null;
        return [...this.#connections.values()]
            .filter((c) => c.auth !== null && !c.local)
            .map((c) => ({ id: c.id, label: c.auth!.label, isOwner: c.auth!.isOwner, workspaceId: c.auth!.workspaceId, driving: c.id === driver }));
    }

    /** The owner's kill-switch: every write refused for everyone until unlocked; reads still answer. */
    lock(except: string | null = null): void {
        this.#locked = true;
        this.#baton.lock();
        this.#batonChanged(except, null);
    }

    unlock(except: string | null = null): void {
        this.#locked = false;
        this.#baton.unlock();
        this.#batonChanged(except, null);
    }

    /** A window lost the baton or left: its unused tickets go (and the TUIs they started), its Take Over windows are told why. */
    #companionsOf(parentId: string, reason: string): void {
        for (const [ticket, t] of this.#tickets) {
            if (t.parentId !== parentId) continue;
            this.#tickets.delete(ticket);
            t.cancel();
            if (t.started) this.#api.takeOverEnded?.(t.terminalId);
        }
        for (const c of this.#connections.values()) {
            if (c.companion?.parentId !== parentId || c.companion.revoked !== null) continue;
            c.companion.revoked = reason;
            const payload: CompanionEvent = { revoked: reason };
            this.#send(c, { kind: 'event', channel: COMPANION_EVENT, payload });
        }
    }

    /** Take over answered: a ticket for the window that asked, good once, for that terminal, for 30 s. */
    #issueTicket(parentId: string, terminalId: string, started: boolean): string {
        const ticket = randomBytes(24).toString('base64url');
        const cancel = this.#schedule(TICKET_TTL_MS, () => {
            if (!this.#tickets.delete(ticket)) return;
            if (started) this.#api.takeOverEnded?.(terminalId);
        });
        this.#tickets.set(ticket, { parentId, terminalId, started, expiresAt: this.#now() + TICKET_TTL_MS, cancel });
        return ticket;
    }

    /** A Take Over window's hello: the ticket must be live, its window's, and from the same device or Tynn identity. */
    #redeem(connection: Connection, ticket: string): string | null {
        const t = this.#tickets.get(ticket);
        if (!t || this.#now() > t.expiresAt) return TICKET_SPENT;
        const parent = this.#connections.get(t.parentId);
        const auth = connection.auth!;
        const same = parent?.auth != null && auth.isOwner && parent.auth.isOwner && !auth.readonly && auth.workspaceId === null
            && (parent.deviceId !== null ? connection.deviceId === parent.deviceId : connection.deviceId === null && parent.auth.label === auth.label);
        if (!same) return TICKET_FOREIGN;
        this.#tickets.delete(ticket);
        t.cancel();
        connection.companion = { parentId: t.parentId, terminalId: t.terminalId, started: t.started, revoked: null };
        return null;
    }

    /**
     * Who drives changed by something `except` did not do itself: every OTHER remote window that asked is told at once,
     * and by whom (`by`; `null` when it was released or lost). The window that did it learns from its own answer.
     */
    #batonChanged(except: string | null, by: string | null): void {
        const holder = this.#baton.holder();
        // Every ticket, and every Take Over window, of a window that no longer drives stops here (Tynn #529 part A).
        const parents = new Set([...this.#tickets.values()].map((t) => t.parentId));
        for (const c of this.#connections.values()) if (c.companion) parents.add(c.companion.parentId);
        for (const parentId of parents) {
            if (holder?.connectionId === parentId) continue;
            this.#companionsOf(parentId, holder ? `${holder.label} took control of ${this.#hostName}` : `nobody is driving ${this.#hostName} now`);
        }
        for (const c of this.#connections.values()) {
            if (c.auth === null || c.local || !c.batonWatch || c.id === except) continue;
            const payload: BatonEvent = { driver: holder?.label ?? null, mine: holder?.connectionId === c.id, locked: this.#locked, by };
            this.#send(c, { kind: 'event', channel: BATON_EVENT, payload });
        }
    }

    #accept(socket: ServerConnection): void {
        const connection: Connection = { id: `conn_${++this.#next}`, socket, auth: null, deviceId: null, pendingPair: null, profile: null, local: false, watching: new Map(), activityViews: new Set(), filesViews: null, blobs: null, uploads: null, uploadOpening: null, pages: null, content: null, batonWatch: false, companion: null };
        this.#connections.set(connection.id, connection);
        socket.onMessage((text) => { void this.#onFrame(connection, text); });
        socket.onClose(() => {
            const held = this.#baton.connectionLost(connection.id);
            this.#staging.dropOwner(connection.id);
            this.#drop(connection);
            this.#companionsOf(connection.id, 'the window this was taken over from closed');
            // A Take Over window closed: the TUI its click started goes with it, as a local one's does.
            if (connection.companion?.started) this.#api.takeOverEnded?.(connection.companion.terminalId);
            // The driver left: nobody drives now, and every window left is told (Tynn #529).
            if (held) this.#batonChanged(null, null);
        });
    }

    /** One first-use preparation per connection; a registry that arrives after close never gets to stage bytes. */
    async #uploads(connection: Connection): Promise<LocalUploads> {
        if (connection.uploads) return connection.uploads;
        if (connection.uploadOpening) return connection.uploadOpening;
        const create = this.#createLocalUploads;
        if (!create) throw new Error('local staging is not configured on this host');
        const opening = (async () => {
            const uploads = await create();
            if (this.#connections.get(connection.id) !== connection) {
                await uploads.dispose();
                throw new Error('the local upload connection closed');
            }
            connection.uploads = uploads;
            return uploads;
        })();
        connection.uploadOpening = opening;
        try { return await opening; }
        finally { if (connection.uploadOpening === opening) connection.uploadOpening = null; }
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
        if (message.kind === 'hello') return this.#refuse(connection, 'this connection has already said hello', false);
        if (message.kind !== 'call') return; // A client sends calls; anything else is noise, not an error worth a frame.
        this.#send(connection, await this.#call(connection, message.id, message.method, message.args));
    }

    async #hello(connection: Connection, message: Extract<WireMessage, { kind: 'hello' }>): Promise<void> {
        const auth = message.auth;
        const label = auth.label ?? message.label ?? 'a device';
        let token: string | undefined;
        if (connection.pendingPair !== null) return this.#refuse(connection, `this device is already waiting for Allow on ${this.#hostName}`, false);
        const pre = connection.socket.preAuth;
        if (auth.kind === 'local' && pre?.kind !== 'local') return this.#refuse(connection, 'local authentication is available only on this Genie window’s protocol door', true);
        if (pre?.kind === 'local' && auth.kind !== 'local') return this.#refuse(connection, 'this local window connection accepts only local authentication', true);
        /*
         * SECURITY (pairing vs share link, H1): a connection the Tynn relay admitted is already somebody, proved by its Tynn
         * grant; that grant is its only way in. A PIN or a device token are tailnet hellos: said over the relay they would
         * let a guest admitted by a link pair as the owner. Refused before anything is redeemed, so a
         * refused hello spends no PIN try and raises no "Pair this device?".
         */
        if (pre && pre.kind !== 'local' && auth.kind !== 'relay') return this.#refuse(connection, `this connection came through the Tynn relay: its Tynn grant admits it, never a PIN or a device token`, true);
        if (auth.kind === 'local') {
            connection.local = true;
            connection.auth = { label: pre!.label, isOwner: true, workspaceId: null, readonly: false };
        } else if (auth.kind === 'pin') {
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
        } else {
            // The transport proved who this is (a Tynn grant and its key); without that proof there is nothing to take.
            const pre = connection.socket.preAuth;
            if (!pre) return this.#refuse(connection, 'this connection did not come through the Tynn relay', true);
            connection.auth = { label: pre.label, isOwner: pre.isOwner, workspaceId: pre.workspaceId, readonly: pre.readonly };
        }
        if (!connection.local && message.profile === 'mobile') connection.profile = 'mobile';
        if (typeof message.companion === 'string') {
            const refused = connection.local ? TICKET_FOREIGN : this.#redeem(connection, message.companion);
            if (refused !== null) { connection.auth = null; connection.deviceId = null; return this.#refuse(connection, refused, true); }
        }
        this.#send(connection, {
            kind: 'welcome',
            connectionId: connection.id,
            host: this.#hostName,
            isOwner: connection.auth.isOwner,
            workspaceId: connection.auth.workspaceId,
            ...(token ? { token } : {}),
            // The version handshake (P10.1e), additive: an old client reads the fields above as it always has.
            protocol: REMOTE_PROTOCOL,
            build: this.#build,
        });
        this.#listen();
        if (!connection.local) this.#changed();
    }

    async #call(connection: Connection, id: number, method: RemoteMethod | ControlMethod, args: unknown[]): Promise<WireMessage> {
        const auth = connection.auth!;
        const ok = (value: unknown): WireMessage => ({ kind: 'result', id, ok: true, value });
        const refuse = (reason: string): WireMessage => ({ kind: 'result', id, ok: false, reason });

        if (connection.local && (method === 'baton.take' || method === 'host.lock' || method === 'host.unlock')) return refuse(`${method} is a remote connection control; local windows do not use it`);
        // A local window takes over through its own window opener (genie:take-over), never this door.
        if (connection.local && method === 'takeOver') return refuse(`takeOver opens a window on ${this.#hostName}; this window does it itself`);

        // A TAKE OVER WINDOW (Tynn #529 part A): reads as any window; types into its one terminal while its window drives.
        const companion = connection.companion;
        if (companion) {
            if (method === 'baton.take' || method === 'baton.release' || method === 'host.lock' || method === 'host.unlock') return refuse(COMPANION_DOES_NOT_DRIVE);
            if (COMPANION_TERMINAL_METHODS.includes(method)) {
                if (String(args[0] ?? '') !== companion.terminalId) return refuse(COMPANION_ONLY);
                if (companion.revoked !== null) return refuse(companion.revoked);
                if (this.#locked) return refuse('this Genie is locked');
                try { return ok(await this.#api.invoke(method as RemoteMethod, args)); } catch (error) { return refuse(error instanceof Error ? error.message : String(error)); }
            }
            const read = method === 'baton.status' || method === 'agent.watch' || method === 'agent.unwatch'
                || (!(CONTROL_METHOD_LIST as readonly string[]).includes(method) && capabilityOf(method as RemoteMethod) === 'read');
            if (!read) return refuse(COMPANION_ONLY);
        }

        switch (method) {
            case 'files.watch':
            case 'files.unwatch':
            case 'files.watchState': {
                if (!connection.local) return refuse(`${method} is available only in ${this.#hostName}'s own Genie window`);
                if (!this.#connections.has(connection.id)) return refuse('the Files watch connection closed');
                const views = connection.filesViews ??= new LocalFilesWatches(this.#api.filesWatch);
                try {
                    if (method === 'files.watch') return ok(await views.watch(args[0], args[1], args[2]));
                    if (method === 'files.unwatch') return ok(views.unwatch(args[0]));
                    return ok(this.#content(connection).capture(views.state(args[0]), 'workspace-tree', false, method));
                } catch (error) { return refuse(error instanceof Error ? error.message : String(error)); }
            }
            case 'content.release': {
                if (!connection.local) return refuse(`${method} is available only in ${this.#hostName}'s own Genie window`);
                return ok(await connection.content?.releaseAndWait(args[0]) ?? { released: false });
            }
            case 'localUpload.begin':
            case 'localUpload.chunk':
            case 'localUpload.abort': {
                if (!connection.local) return refuse(`${method} is available only in ${this.#hostName}'s own Genie window`);
                if (!this.#connections.has(connection.id)) return refuse('the local upload connection closed');
                if (!this.#createLocalUploads) return refuse('local staging is not configured on this host');
                try {
                    const uploads = await this.#uploads(connection);
                    if (method === 'localUpload.begin') return ok(await uploads.begin(args[0]));
                    if (method === 'localUpload.chunk') return ok(await uploads.chunk(args[0], args[1], args[2]));
                    return ok(await uploads.abort(args[0]));
                } catch (error) { return refuse(error instanceof Error ? error.message : String(error)); }
            }
            case 'page.open':
            case 'page.next':
            case 'page.close': {
                if (!connection.local) return refuse(`${method} is available only in ${this.#hostName}'s own Genie window`);
                if (!this.#connections.has(connection.id)) return refuse('the list connection closed');
                const pages = connection.pages ??= this.#content(connection).pages;
                try {
                    if (method === 'page.open') return ok(await pages.open(args[0], args[1]));
                    if (method === 'page.next') return ok(await pages.next(args[0]));
                    return ok(await pages.close(args[0]));
                } catch (error) { return refuse(error instanceof Error ? error.message : String(error)); }
            }
            case 'blob.open':
            case 'blob.read':
            case 'blob.close': {
                if (!connection.local) return refuse(`${method} is available only in ${this.#hostName}'s own Genie window`);
                if (!this.#connections.has(connection.id)) return refuse('the blob connection closed');
                const blobs = connection.blobs ??= this.#content(connection).blobs;
                try {
                    if (method === 'blob.open') return ok(await blobs.open(args[0], args[1]));
                    if (method === 'blob.read') return ok(await blobs.read(args[0], args[1], args[2]));
                    return ok(await blobs.close(args[0]));
                } catch (error) { return refuse(error instanceof Error ? error.message : String(error)); }
            }
            case 'baton.take': {
                // Holding the baton would keep everyone who CAN change things from doing so.
                if (auth.readonly) return refuse(`${auth.label} has read-only access to ${this.#hostName}`);
                // `{ force: true }` is Take control (Tynn #529): the owner from anyone; anyone else from anyone but the owner.
                const force = (args[0] as { force?: unknown } | undefined)?.force === true;
                const before = this.#baton.holder()?.connectionId ?? null;
                const r = this.#baton.take(connection.id, auth.label, { force, isOwner: auth.isOwner });
                if (!r.ok) return refuse(r.ownerHolds ? `${r.driverLabel} is driving ${this.#hostName}, and only the owner can take control from the owner` : `${r.driverLabel} is driving ${this.#hostName}`);
                if (before !== connection.id) this.#batonChanged(connection.id, auth.label);
                return ok({ driver: auth.label, mine: true });
            }
            case 'baton.release': {
                const released = this.#baton.release(connection.id);
                if (released) this.#batonChanged(connection.id, null);
                return ok({ released });
            }
            case 'baton.watch':
                connection.batonWatch = true;
                return ok({ watching: true });
            case 'baton.status': {
                const holder = this.#baton.holder();
                return ok({ driver: holder?.label ?? null, mine: holder?.connectionId === connection.id, locked: this.#locked });
            }
            case 'host.lock':
                if (!auth.isOwner) return refuse(`only the host owner may lock ${this.#hostName}`);
                this.lock(connection.id);
                return ok({ locked: true });
            case 'host.unlock':
                if (!auth.isOwner) return refuse(`only the host owner may unlock ${this.#hostName}`);
                this.unlock(connection.id);
                return ok({ locked: false });
            case 'agent.watch':
                return this.#watch(connection, String(args[0] ?? ''), (args[1] ?? {}) as WatchOptions).then(ok, (error: unknown) => refuse(error instanceof Error ? error.message : String(error)));
            case 'agent.unwatch':
                return ok({ unwatched: connection.watching.delete(String(args[0] ?? '')) });
            case 'activity.watch':
            case 'activity.unwatch': {
                if (!connection.local) return refuse(`${method} is available only in ${this.#hostName}'s own Genie window`);
                const viewId = args[0];
                if (typeof viewId !== 'string' || viewId.length === 0) return refuse('An activity view id is required.');
                if (method === 'activity.unwatch') return ok({ unwatched: connection.activityViews.delete(viewId) });
                connection.activityViews.add(viewId);
                return ok({ watching: true });
            }
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

        const capability = capabilityOf(method);
        if (capability === 'local' && !connection.local) return refuse(`${method} is available only in ${this.#hostName}'s own Genie window`);

        // Allow is pressed on THIS machine's screen, never sent from another device — not even the owner's (q_8c07b142).
        if (method === 'features.act' && isAnswerPair(args)) return refuse(`a device is allowed on ${this.#hostName}’s own screen, never from another device`);

        // A phone has no terminals (genie#1346): refused here, before anything on the host is asked.
        if (connection.profile === 'mobile' && PHONE_REFUSES(method)) return refuse(`${method}: a phone has no terminals; open one on ${this.#hostName}`);

        // A read-only grant (Tynn #838): reads, nothing else.
        if (auth.readonly && capability !== 'read') return refuse(`${auth.label} has read-only access to ${this.#hostName}`);
        // Only the owner changes the host itself — a guest of the whole host included.
        if (!auth.isOwner && auth.workspaceId === null && (method === 'features.act' || method.startsWith('updates.'))) return refuse(`${method} changes ${this.#hostName} itself; only its owner can`);
        if (!auth.isOwner && OWNER_ONLY.includes(method)) return refuse(`${method} changes ${this.#hostName} itself; only its owner can`);
        // A guest browses inside what it was given; the owner, the whole disk (Genie 1's approved scope, Tynn #835).
        // A guest's picker opens in what it was given, never at the host's home (Tynn #527): the host is not asked.
        if (!auth.isOwner && method === 'host.home') {
            const paths = this.#api.workspacePaths?.() ?? {};
            const given = auth.workspaceId !== null ? paths[auth.workspaceId] : Object.values(paths)[0];
            return ok(typeof given === 'string' ? given : '/');
        }
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
        if (!connection.local && (capability === 'write' || capability === 'upgrade')) {
            const may = this.#baton.may(connection.id, capability, { isOwner: auth.isOwner });
            if (!may.ok) return refuse(may.reason);
            if (capability === 'write' && this.#baton.holder() === null) return refuse(`nobody is driving ${this.#hostName}; ${BATON_REFUSAL}`);
        }
        // Take over from another machine is the OWNER's: its window opens there, on the TUI started here (Tynn #529 A).
        if (method === 'takeOver' && !auth.isOwner) return refuse(`only the owner of ${this.#hostName} can take over its agents from another machine`);
        if (auth.workspaceId !== null) {
            const scoped = this.#guestScope(auth.workspaceId, method, args);
            if (scoped) return refuse(scoped);
        }

        // Staged bytes are taken only now, after every gate passed (genie#1346): never a path, never bytes inline.
        if (isLocalTerminalMethod(method)) {
            if (!connection.local || !this.#connections.has(connection.id)) return refuse('the local terminal connection is closed');
            if (!this.#api.localTerminals) return refuse('the local terminal service is not available');
            const terminals = this.#localTerminals ??= new LocalTerminalServer(this.#api.localTerminals);
            try {
                const value = await terminals.call(connection.id, method, args, (channel, payload) => this.#send(connection, { kind: 'event', channel, payload }));
                if (!this.#connections.has(connection.id)) return refuse('the local terminal connection is closed');
                return ok(this.#content(connection).terminalResult(value, method));
            } catch (error) { return refuse(error instanceof Error ? error.message : String(error)); }
        }
        const materialized = this.#materialize(connection, method, args);
        if (!materialized.ok) return refuse(materialized.reason);

        let files: Awaited<ReturnType<typeof localFilesArguments>> | null = null, drafts: Awaited<ReturnType<typeof localDraftArguments>> | null = null, artboard: Awaited<ReturnType<typeof localArtboardArguments>> | null = null, response: string | null = null;
        try {
            if (isLocalFilesMethod(method)) { files = await localFilesArguments(method, materialized.args, connection.uploads); response = this.#content(connection).begin(method); }
            if (isLocalDraftMethod(method)) {
                drafts = await localDraftArguments(method, materialized.args, connection.uploads);
                if (method === 'chatDrafts.load' || method === 'chatDrafts.readFile') response = this.#content(connection).begin(method);
            }
            if (isLocalArtboardMethod(method)) {
                artboard = await localArtboardArguments(method, materialized.args, connection.uploads);
                if (method === 'artboard.read') response = this.#content(connection).begin(method);
            }
            const value = await this.#api.invoke(method, files?.args ?? drafts?.args ?? artboard?.args ?? materialized.args);
            if (files) { await files.close(); files = null; }
            if (drafts) { await drafts.close(); drafts = null; }
            if (artboard) { await artboard.close(); artboard = null; }
            if (isLocalFilesMethod(method)) return ok(this.#content(connection).result(response!, value, method === 'files.localChildren' ? 'folder-children' : 'workspace-tree', method === 'files.localReadMedia' || method === 'files.readBytes'));
            if (isLocalDraftMethod(method) && response !== null) return ok(await connection.content!.draftResult(response, method, value));
            if (method === 'artboard.read') return ok(connection.content!.artboardResult(response!, value));
            if (method === 'snapshot' && auth.workspaceId !== null) return ok(filterSnapshotForWorkspace(value as Parameters<typeof filterSnapshotForWorkspace>[0], auth.workspaceId));
            // SECURITY (genie#872): the feature snapshot carries the LIVE pairing PIN (enough to pair as an owner), the
            // paired devices and the connections. Only an owner sees them.
            // This machine's own window (P4 family 11): the whole snapshot, the pairing requests included, inline when small
            // and through a blob when not, so nothing it carries can reach the door's frame cap. A sound's data the same.
            if (connection.local && (method === 'features.snapshot' || method === 'features.soundData')) return ok(this.#content(connection).jsonResult(value, method));
            if (method === 'features.snapshot' && !auth.isOwner) return ok(withoutRemoteSecrets(value));
            if (method === 'features.snapshot') return ok(withoutPairRequests(value));
            // The TUI started (or was open): a ticket for this window's own Take Over window, which presents it (Tynn #529 A).
            if (method === 'takeOver') {
                const started = value as { ok?: unknown; terminalId?: unknown; started?: unknown } | null;
                if (started?.ok === true && typeof started.terminalId === 'string') return ok({ ...started, ticket: this.#issueTicket(connection.id, started.terminalId, started.started === true) });
            }
            return ok(value);
        } catch (error) {
            if (response !== null) connection.content?.release(response);
            return refuse(error instanceof Error ? error.message : String(error));
        } finally {
            if (files) { try { await files.close(); } catch { console.warn('[genie] a consumed Files stage could not be released'); } }
            if (drafts) { try { await drafts.close(); } catch { console.warn('[genie] a consumed draft stage could not be released'); } }
            if (artboard) { try { await artboard.close(); } catch { console.warn('[genie] a consumed ArtBoard stage could not be released'); } }
        }
    }

    #content(connection: Connection): LocalFilesContent {
        if (!this.#connections.has(connection.id)) throw new Error('the local content connection closed');
        return connection.content ??= new LocalFilesContent({ now: this.#now, ...(this.#openBlob ? { openBlob: this.#openBlob } : {}), ...(this.#openPage ? { openPage: this.#openPage } : {}) });
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
        if (!this.#connections.has(connection.id)) throw new Error('the connection closed before its agent watch was ready');
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
            if (c.local ? !LOCAL_EVENTS.has(channel) : LOCAL_EVENTS.has(channel)) continue;
            if (channel === LOCAL_EVENT_CHANNELS.files) {
                const push = c.filesViews?.event(payload as FilesHubEvent);
                if (push) this.#send(c, { kind: 'event', channel, payload: push });
                continue;
            }
            if (channel === LOCAL_EVENT_CHANNELS.activity && c.activityViews.size === 0) continue;
            let out: unknown = channel === 'features' ? withoutPairRequests(payload) : payload;
            // Every non-owner, whatever its scope, through ONE deny-by-default filter (pairing vs share link, H2).
            if (!c.auth.isOwner) out = this.#forNonOwner(channel, out, c.auth.workspaceId);
            if (out !== NOT_SENT && c.profile === 'mobile') out = this.#forPhone(c, channel, out);
            if (out === NOT_SENT) continue;
            // THE GUARD (P4 family 11): a frame over the door's cap ends a window's whole connection, so a local event that
            // large is dropped and said, never sent. Local events are signals; content crosses through a read.
            if (c.local && Buffer.byteLength(JSON.stringify(out)) > LOCAL_EVENT_MAX_BYTES) {
                console.warn(`[genie] the local event ${channel} was too large to send and was dropped`);
                continue;
            }
            this.#send(c, { kind: 'event', channel, payload: out });
        }
    }

    /**
     * WHAT A NON-OWNER RECEIVES (SECURITY, pairing vs share link H2). A guest of one workspace: #forGuest. A guest of the
     * whole workstation (a Tynn link with `host:all`) hears every workspace — the snapshot, agents, activity, terminals —
     * and the host's features WITHOUT the remote section's secrets (the live PIN, paired devices, local links,
     * connections), exactly as its `features.snapshot` call is answered (genie#872). It may not act on updates, so it
     * does not hear them; any channel not classified here is not sent.
     */
    #forNonOwner(channel: string, payload: unknown, workspaceId: string | null): unknown {
        if (workspaceId !== null) return this.#forGuest(channel, payload, workspaceId);
        if (channel === 'features') return withoutRemoteSecrets(payload);
        if (channel === 'snapshot' || channel === 'activity' || channel === 'terminal-data' || channel === 'terminal-exit' || channel.startsWith('agent:')) return payload;
        return NOT_SENT;
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
