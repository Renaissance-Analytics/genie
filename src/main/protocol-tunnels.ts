import { LOCAL_FRAME_LIMIT_BYTES } from '../core/local-frame.js';
import type { ServerConnection, ServerTransport } from '../core/remote-protocol.js';
import type { FeatureBrowser } from './feature-callers.js';

/**
 * THIS MACHINE'S WINDOWS, TUNNELLED TO GENIE-HOST'S REMOTEHOST (client/host split step 2d-4b, Tynn #898, story #910).
 *
 * A window's page speaks the one protocol over main's IPC door (local-protocol-door.ts). main used to serve that door
 * with a RemoteHost of its own; now it forwards each connection over its engine link (`engine.protocol`), and this
 * transport hands it to genie-host's RemoteHost (through its remote hub), admitted as this machine's own window, as the
 * door admitted it. So every client, this machine's window included, is served by the same host, and what one person
 * does (a Pilot's typing, Tynn #730) reaches every other.
 *
 * Only a LOCAL window's engine link may open one (session-engine-server.ts checks): the link on this host's own pipe,
 * token-checked. The window's process says which of its windows a connection is (`main` or `remote`), as the door
 * did; it cannot say more (the preAuth is fixed here). The 1 MiB frame cap is the door's, kept both ways.
 */

/** Which of this machine's windows a tunnel carries: the main window, or a window showing another workstation. */
export type TunnelWindow = 'main' | 'remote';
/** What genie-host sends back down one tunnel: a protocol frame, or its end. */
export type TunnelEvent = { readonly tunnel: string; readonly kind: 'frame'; readonly text: string } | { readonly tunnel: string; readonly kind: 'closed'; readonly reason: string };
export type TunnelOp = 'open' | 'frame' | 'close' | 'browser';
/** Who a tunnelled RemoteHost connection belongs to: the engine connection (one window process) and its tunnel. */
export interface TunnelBinding { readonly owner: string; readonly tunnel: string; readonly window: TunnelWindow }

export interface ProtocolTunnelsOptions {
    /** The RemoteHost connection id said in this tunnel's welcome, with its owner and the window's browser pane now. */
    readonly onBound?: (connectionId: string, binding: TunnelBinding, browser: FeatureBrowser | null) => void;
    readonly onUnbound?: (connectionId: string, binding: TunnelBinding) => void;
    /** The window's browser pane changed (said by its owner). */
    readonly onBrowser?: (connectionId: string, browser: FeatureBrowser | null) => void;
}

const CAP_REASON = 'a local protocol frame exceeds 1 MiB; this window’s protocol connection was closed';
const HANDLE = /^[A-Za-z0-9_-]{1,80}$/;

interface Tunnel {
    readonly binding: TunnelBinding;
    readonly messages: Set<(text: string) => void>;
    readonly closes: Set<() => void>;
    readonly send: (event: TunnelEvent) => void;
    connectionId: string | null;
    browser: FeatureBrowser | null;
    closed: boolean;
}

const browserOf = (value: unknown): FeatureBrowser | null => {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if ((v.url !== null && typeof v.url !== 'string') || typeof v.canGoBack !== 'boolean' || typeof v.canGoForward !== 'boolean') return null;
    return { url: v.url as string | null, canGoBack: v.canGoBack, canGoForward: v.canGoForward };
};

export class ProtocolTunnels implements ServerTransport {
    readonly #options: ProtocolTunnelsOptions;
    readonly #listeners = new Set<(connection: ServerConnection) => void>();
    /** By owner, then tunnel id: a tunnel id is the window process's own, unique only on its link. */
    readonly #tunnels = new Map<string, Map<string, Tunnel>>();
    readonly #bound = new Map<string, Tunnel>();

    constructor(options: ProtocolTunnelsOptions = {}) {
        this.#options = options;
    }

    onConnection(listener: (connection: ServerConnection) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** One op from a LOCAL window's engine link (the server checks that); `send` answers down that same link. */
    receive(owner: string, op: unknown, tunnel: unknown, payload: unknown, send: (event: TunnelEvent) => void): void {
        if (typeof tunnel !== 'string' || !HANDLE.test(tunnel)) return;
        const mine = this.#tunnels.get(owner);
        const current = mine?.get(tunnel);
        if (op === 'open') return this.#open(owner, tunnel, payload, send);
        if (!current) {
            // Nothing to close for a tunnel that is gone; anything else is told it is gone.
            if (op !== 'close') send({ tunnel, kind: 'closed', reason: 'this local protocol connection is no longer live' });
            return;
        }
        if (op === 'close') return this.#end(current, typeof payload === 'string' ? payload : 'the local protocol connection closed', false);
        if (op === 'browser') {
            current.browser = browserOf(payload);
            if (current.connectionId !== null) this.#options.onBrowser?.(current.connectionId, current.browser);
            return;
        }
        if (op !== 'frame' || typeof payload !== 'string') return this.#end(current, 'the local frame port accepts string frames only', true);
        if (Buffer.byteLength(payload, 'utf8') > LOCAL_FRAME_LIMIT_BYTES) return this.#end(current, CAP_REASON, true);
        for (const listener of [...current.messages]) listener(payload);
    }

    /** A window process's link closed: every connection it tunnelled ends with it. */
    dropOwner(owner: string): void {
        const mine = this.#tunnels.get(owner);
        if (!mine) return;
        for (const t of [...mine.values()]) this.#end(t, 'Genie’s window lost its link to genie-host', false);
        this.#tunnels.delete(owner);
    }

    /** Which window process owns a RemoteHost connection (by the id its welcome said); null = not a tunnelled one. */
    bindingOf(connectionId: string): TunnelBinding | null {
        const t = this.#bound.get(connectionId);
        return t && !t.closed ? t.binding : null;
    }

    #open(owner: string, id: string, payload: unknown, send: (event: TunnelEvent) => void): void {
        // A window reopening the same tunnel id replaces it, as the door replaces a window's connection.
        const previous = this.#tunnels.get(owner)?.get(id);
        if (previous) this.#end(previous, 'this window opened a replacement protocol connection', false);
        const said = (payload && typeof payload === 'object' ? payload : {}) as { window?: unknown; label?: unknown };
        const window: TunnelWindow = said.window === 'remote' ? 'remote' : 'main';
        const label = typeof said.label === 'string' && said.label.length > 0 && said.label.length <= 120 ? said.label : 'this Genie window';
        const t: Tunnel = { binding: { owner, tunnel: id, window }, messages: new Set(), closes: new Set(), send, connectionId: null, browser: null, closed: false };
        let mine = this.#tunnels.get(owner);
        if (!mine) { mine = new Map(); this.#tunnels.set(owner, mine); }
        mine.set(id, t);
        if (this.#listeners.size === 0) return this.#end(t, 'Genie is still starting', true);
        const connection: ServerConnection = {
            remoteAddress: 'local-window',
            preAuth: { kind: 'local', label, isOwner: true, workspaceId: null, readonly: false, window },
            send: (text) => {
                if (t.closed) return;
                if (Buffer.byteLength(text, 'utf8') > LOCAL_FRAME_LIMIT_BYTES) return this.#end(t, CAP_REASON, true);
                if (t.connectionId === null) this.#sniff(t, text);
                t.send({ tunnel: id, kind: 'frame', text });
            },
            onMessage: (listener) => { if (!t.closed) t.messages.add(listener); return () => { t.messages.delete(listener); }; },
            onClose: (listener) => {
                if (t.closed) listener(); else t.closes.add(listener);
                return () => { t.closes.delete(listener); };
            },
            close: () => this.#end(t, 'the local protocol connection closed', false),
        };
        for (const listener of [...this.#listeners]) listener(connection);
    }

    /** The welcome names the RemoteHost connection: what binds it to its window process. A malformed frame binds nothing. */
    #sniff(t: Tunnel, text: string): void {
        let sent: { kind?: unknown; connectionId?: unknown };
        try { sent = JSON.parse(text) as typeof sent; } catch { return; }
        if (sent.kind !== 'welcome' || typeof sent.connectionId !== 'string') return;
        t.connectionId = sent.connectionId;
        this.#bound.set(sent.connectionId, t);
        this.#options.onBound?.(sent.connectionId, t.binding, t.browser);
    }

    #end(t: Tunnel, reason: string, refused: boolean): void {
        if (t.closed) return;
        t.closed = true;
        const mine = this.#tunnels.get(t.binding.owner);
        if (mine?.get(t.binding.tunnel) === t) mine.delete(t.binding.tunnel);
        if (mine?.size === 0) this.#tunnels.delete(t.binding.owner);
        if (refused) t.send({ tunnel: t.binding.tunnel, kind: 'frame', text: JSON.stringify({ kind: 'refused', reason }) });
        t.send({ tunnel: t.binding.tunnel, kind: 'closed', reason });
        if (t.connectionId !== null && this.#bound.get(t.connectionId) === t) {
            this.#bound.delete(t.connectionId);
            this.#options.onUnbound?.(t.connectionId, t.binding);
        }
        for (const listener of [...t.closes]) listener();
        t.closes.clear();
        t.messages.clear();
    }
}
