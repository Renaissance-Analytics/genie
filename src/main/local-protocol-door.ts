import type { IpcMainEvent, WebContents, WebFrameMain } from 'electron';
import { LOCAL_FRAME_CHANNELS, LOCAL_FRAME_LIMIT_BYTES, type LocalFrameReply } from '../core/local-frame.js';
import type { ServerConnection, ServerTransport } from '../core/remote-protocol.js';

export interface LocalDoorIpc {
    on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
    removeListener(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
}
export type LocalDoorContents = Pick<WebContents, 'id' | 'mainFrame' | 'isDestroyed' | 'on' | 'removeListener'>;
export interface LocalDoorOptions {
    /** Every connection that ends, and why. The renderer is told too, but nothing there outlives the window. */
    readonly onClosed?: (reason: string) => void;
    /** Which window a connection is decides what it may do (Tynn #578): main's own record, read when the page connects. */
    readonly windowKind?: (contents: LocalDoorContents) => 'main' | 'remote';
}
export interface LocalProtocolDoor extends ServerTransport {
    admit(contents: LocalDoorContents): void;
    dispose(): void;
}

interface WindowConnection {
    readonly handle: string;
    readonly messages: Set<(text: string) => void>;
    end(reason: string, refused?: boolean): void;
}
interface AdmittedWindow {
    readonly contents: LocalDoorContents;
    connection: WindowConnection | null;
    /** The connection live when a top-level navigation started: it ends only if that navigation lands. */
    navigating: WindowConnection | null;
    detach(): void;
}

/** Main owns admission and the local proof. The handle routes frames within one window; it grants no access. */
export function localProtocolDoor(ipcMain: LocalDoorIpc, options: LocalDoorOptions = {}): LocalProtocolDoor {
    const admitted = new Map<LocalDoorContents, AdmittedWindow>();
    const listeners = new Set<(connection: ServerConnection) => void>();
    let disposed = false;
    const capReason = 'a local protocol frame exceeds 1 MiB; this window’s protocol connection was closed';
    const startingReason = 'Genie is still starting';

    const reply = (frame: WebFrameMain, action: LocalFrameReply, handle: string, text: string): boolean => {
        try { frame.send(LOCAL_FRAME_CHANNELS.toWindow, action, handle, text); return true; }
        catch { return false; } // A frame already gone still releases everything it held.
    };
    const reject = (frame: WebFrameMain, handle: string, reason: string) => {
        reply(frame, 'frame', handle, JSON.stringify({ kind: 'refused', reason }));
        reply(frame, 'closed', handle, reason);
    };

    const open = (entry: AdmittedWindow, frame: WebFrameMain, handle: string) => {
        entry.connection?.end('this window opened a replacement protocol connection');
        if (listeners.size === 0) return reject(frame, handle, startingReason);
        const messages = new Set<(text: string) => void>();
        const closes = new Set<() => void>();
        let closed = false;
        const current: WindowConnection = {
            handle, messages,
            end: (reason, refused = false) => {
                if (closed) return;
                closed = true;
                if (entry.connection === current) entry.connection = null;
                options.onClosed?.(reason);
                if (refused) reply(frame, 'frame', handle, JSON.stringify({ kind: 'refused', reason }));
                reply(frame, 'closed', handle, reason);
                for (const listener of closes) listener();
                closes.clear();
                messages.clear();
            },
        };
        entry.connection = current;
        // Asked when the page opens its connection, not at admit: main records a remote window only once it has made it.
        const window = options.windowKind?.(entry.contents);
        const connection: ServerConnection = {
            remoteAddress: 'local-window',
            preAuth: { kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false, ...(window ? { window } : {}) },
            send: (text) => {
                if (closed) return;
                if (Buffer.byteLength(text, 'utf8') > LOCAL_FRAME_LIMIT_BYTES) return current.end(capReason, true);
                if (!reply(frame, 'frame', handle, text)) current.end('the local window frame is no longer available');
            },
            onMessage: (listener) => { if (!closed) messages.add(listener); return () => { messages.delete(listener); }; },
            onClose: (listener) => {
                if (closed) listener(); else closes.add(listener);
                return () => { closes.delete(listener); };
            },
            close: () => current.end('the local protocol connection closed'),
        };
        for (const listener of listeners) listener(connection);
        if (messages.size === 0) current.end(startingReason, true);
    };

    const receive = (event: IpcMainEvent, ...args: unknown[]): void => {
        const [action, handle, text] = args;
        // A bounded routing handle, unrelated to the proof. An invalid one names no connection to answer.
        if (typeof handle !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(handle)) return;
        const frame = event.senderFrame;
        if (!frame) return;
        const entry = admitted.get(event.sender);
        if (!entry || event.sender.isDestroyed()) return reject(frame, handle, 'this sender is not an admitted Genie main-preload window');
        if (frame !== event.sender.mainFrame) return reject(frame, handle, 'the local protocol door accepts only this window’s top-level main frame');
        const refuse = (reason: string) => {
            if (entry.connection?.handle === handle) entry.connection.end(reason, true);
            else reject(frame, handle, reason);
        };
        if (args.length !== 3 || typeof text !== 'string' || (action !== 'open' && action !== 'frame' && action !== 'close')) return refuse('the local frame port accepts string actions, handles and text only');
        if (action === 'open') {
            if (text !== '') return refuse('opening the local frame port carries no payload');
            open(entry, frame, handle);
            return;
        }
        const current = entry.connection;
        if (!current || current.handle !== handle) return reject(frame, handle, 'this local protocol connection is no longer live');
        if (action === 'close') return current.end('the local protocol connection closed');
        if (Buffer.byteLength(text, 'utf8') > LOCAL_FRAME_LIMIT_BYTES) return current.end(capReason, true);
        for (const listener of current.messages) listener(text);
    };
    ipcMain.on(LOCAL_FRAME_CHANNELS.toHost, receive);

    return {
        onConnection: (listener) => { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener); }; },
        admit: (contents) => {
            if (disposed || contents.isDestroyed() || admitted.has(contents)) return;
            const entry: AdmittedWindow = { contents, connection: null, navigating: null, detach: () => {} };
            const gone = () => { entry.connection?.end('the local window renderer ended'); };
            const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
                // STARTED IS NOT LANDED (Tynn #590). This fires before the window's link guard refuses a navigation, so a click
                // on an ordinary web link, which opens in the browser and leaves this page where it is, ended a live connection.
                if (details.isMainFrame && !details.isSameDocument) entry.navigating = entry.connection;
            };
            const landed = () => {
                const started = entry.navigating;
                entry.navigating = null;
                // A connection opened since the navigation started is the new page's.
                if (started && started === entry.connection) started.end('the local window reloaded or navigated');
            };
            const destroyed = () => { gone(); entry.detach(); admitted.delete(contents); };
            entry.detach = () => {
                contents.removeListener('destroyed', destroyed);
                contents.removeListener('render-process-gone', gone);
                contents.removeListener('did-start-navigation', navigate);
                contents.removeListener('did-navigate', landed);
            };
            admitted.set(contents, entry);
            contents.on('destroyed', destroyed);
            contents.on('render-process-gone', gone);
            contents.on('did-start-navigation', navigate);
            contents.on('did-navigate', landed);
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            ipcMain.removeListener(LOCAL_FRAME_CHANNELS.toHost, receive);
            for (const entry of admitted.values()) { entry.connection?.end('the local protocol door closed'); entry.detach(); }
            admitted.clear();
            listeners.clear();
        },
    };
}
