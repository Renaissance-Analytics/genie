import { DEVICE_PIECE_CHARS, FrameJoiner, framePieces } from '../core/device-frames.js';

/**
 * A WINDOW'S CHANNELS TO ANOTHER MACHINE, OVER ITS OWN PROTOCOL SESSION (Tynn #941, client/host split step 2f-2). genie-host
 * holds the socket (a device socket, or a Tynn workstation's relay) and this window a channel, opened, used and closed over
 * the window's own connection (`deviceLink.*`) and heard on its `local-device` events. A frame crosses in pieces, both ways
 * (core/device-frames.ts): cut here before it is sent, joined here before anyone reads it.
 *
 * The channels are the CONNECTION'S: when this window's session to genie-host drops, genie-host closes them, and nothing
 * can say so over the connection that went. `lost` says it here, once for each channel still open.
 */
export type DeviceOpened = { ok: true; channel: string } | { ok: false; reason: string };
export type RelayOpenedForWindow = { ok: true; channel: string } | { ok: false; reason: string; stage?: 'tynn' | 'relay'; offline?: boolean };
/** Where the browser window opens, and what it is called (cosmetic; device-link-protocol.ts). */
export interface BrowserView { readonly title?: string; readonly anchor?: { x: number; y: number; width: number; height: number } | null }

export interface DeviceChannelsPorts {
    /** A protocol call on the session; rejects with the host's reason. */
    call(method: string, ...args: unknown[]): Promise<unknown>;
    /** The session's `local-device` events. */
    on(listener: (payload: unknown) => void): () => void;
}

export interface DeviceChannels {
    open(url: string): Promise<DeviceOpened>;
    openRelay(workstationId: string): Promise<RelayOpenedForWindow>;
    send(channel: string, text: string): void;
    close(channel: string): void;
    onMessage(listener: (channel: string, text: string) => void): () => void;
    onClosed(listener: (channel: string, reason: string | null) => void): () => void;
    onOpenStep(listener: (workstationId: string, step: 'relay') => void): () => void;
    openBrowser(channel: string, address: string | null, hosts: readonly string[], view: BrowserView): Promise<{ ok: true } | { ok: false; error: string }>;
    /** The session went: every channel still open is closed, with this reason. */
    lost(reason: string): void;
}

/** The most a window joins from pieces: what genie-host carries from another machine (device-link-service.ts). */
const JOIN_LIMIT_CHARS = 100 * 1024 * 1024;
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function deviceChannels(ports: DeviceChannelsPorts): DeviceChannels {
    const messages = new Set<(channel: string, text: string) => void>();
    const closes = new Set<(channel: string, reason: string | null) => void>();
    const steps = new Set<(workstationId: string, step: 'relay') => void>();
    const open = new Set<string>();
    const joiner = new FrameJoiner(JOIN_LIMIT_CHARS);
    // Pieces go out in order: each frame's after the one before it (calls on one connection are answered in order).
    let outbox: Promise<unknown> = Promise.resolve();
    const closed = (channel: string, reason: string | null) => {
        if (!open.delete(channel)) return;
        joiner.drop(channel);
        for (const l of [...closes]) l(channel, reason);
    };
    ports.on((payload) => {
        const p = payload as { type?: unknown; channel?: unknown; text?: unknown; more?: unknown; reason?: unknown; workstationId?: unknown; step?: unknown } | null;
        if (!p || typeof p !== 'object') return;
        if (p.type === 'step' && typeof p.workstationId === 'string') { for (const l of [...steps]) l(p.workstationId, 'relay'); return; }
        if (typeof p.channel !== 'string') return;
        if (p.type === 'closed') { closed(p.channel, typeof p.reason === 'string' ? p.reason : null); return; }
        if (p.type !== 'frame' || typeof p.text !== 'string') return;
        const joined = joiner.add(p.channel, p.text, p.more === true);
        if (joined === null) return;
        if (!joined.ok) { closed(p.channel, joined.reason); return; }
        for (const l of [...messages]) l(p.channel, joined.text);
    });
    const opened = <T extends { ok: boolean; channel?: string }>(result: T): T => {
        if (result.ok && typeof result.channel === 'string') open.add(result.channel);
        return result;
    };
    return {
        open: (url) => ports.call('deviceLink.open', url).then((r) => opened(r as DeviceOpened), (e: unknown) => ({ ok: false as const, reason: reasonOf(e) })),
        openRelay: (workstationId) => ports.call('deviceLink.openRelay', workstationId).then((r) => opened(r as RelayOpenedForWindow), (e: unknown) => ({ ok: false as const, reason: reasonOf(e) })),
        send: (channel, text) => {
            const pieces = text.length <= DEVICE_PIECE_CHARS ? [text] : framePieces(text);
            for (const [i, piece] of pieces.entries()) {
                const more = i < pieces.length - 1;
                outbox = outbox.then(() => ports.call('deviceLink.send', channel, piece, more)).catch(() => {});
            }
        },
        close: (channel) => {
            open.delete(channel);
            joiner.drop(channel);
            outbox = outbox.then(() => ports.call('deviceLink.close', channel)).catch(() => {});
        },
        onMessage: (l) => { messages.add(l); return () => { messages.delete(l); }; },
        onClosed: (l) => { closes.add(l); return () => { closes.delete(l); }; },
        onOpenStep: (l) => { steps.add(l); return () => { steps.delete(l); }; },
        openBrowser: (channel, address, hosts, view) => ports.call('deviceLink.openBrowser', channel, address, [...hosts], view)
            .then((r) => r as { ok: true } | { ok: false; error: string }, (e: unknown) => ({ ok: false as const, error: reasonOf(e) })),
        lost: (reason) => { for (const channel of [...open]) closed(channel, reason); },
    };
}
