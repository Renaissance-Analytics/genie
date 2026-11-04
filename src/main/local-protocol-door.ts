import type { IpcMainEvent, WebContents, WebFrameMain } from 'electron';
import { LOCAL_FRAME_CHANNELS, LOCAL_FRAME_LIMIT_BYTES, type LocalFrameReply } from '../core/local-frame.js';
import type { ServerConnection, ServerTransport } from '../core/remote-protocol.js';

export interface LocalDoorIpc {
    on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
    removeListener(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
}
export type LocalDoorContents = Pick<WebContents, 'id' | 'mainFrame' | 'isDestroyed' | 'on' | 'removeListener'>;
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
    connection: WindowConnection | null;
    detach(): void;
}

/** Main owns admission and the local proof. The handle routes frames within one window; it grants no access. */
export function localProtocolDoor(ipcMain: LocalDoorIpc): LocalProtocolDoor {
    const admitted = new Map<LocalDoorContents, AdmittedWindow>();
    const listeners = new Set<(connection: ServerConnection) => void>();
    let disposed = false;
    const capReason = 'a local protocol frame exceeds 1 MiB; this window’s protocol connection was closed';

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
        const messages = new Set<(text: string) => void>();
        const closes = new Set<() => void>();
        let closed = false;
        const current: WindowConnection = {
            handle, messages,
            end: (reason, refused = false) => {
                if (closed) return;
                closed = true;
                if (entry.connection === current) entry.connection = null;
                if (refused) reply(frame, 'frame', handle, JSON.stringify({ kind: 'refused', reason }));
                reply(frame, 'closed', handle, reason);
                for (const listener of closes) listener();
                closes.clear();
                messages.clear();
            },
        };
        entry.connection = current;
        const connection: ServerConnection = {
            remoteAddress: 'local-window',
            preAuth: { kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false },
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
            const entry: AdmittedWindow = { connection: null, detach: () => {} };
            const gone = () => { entry.connection?.end('the local window renderer ended'); };
            const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
                if (details.isMainFrame && !details.isSameDocument) entry.connection?.end('the local window reloaded or navigated');
            };
            const destroyed = () => { gone(); entry.detach(); admitted.delete(contents); };
            entry.detach = () => {
                contents.removeListener('destroyed', destroyed);
                contents.removeListener('render-process-gone', gone);
                contents.removeListener('did-start-navigation', navigate);
            };
            admitted.set(contents, entry);
            contents.on('destroyed', destroyed);
            contents.on('render-process-gone', gone);
            contents.on('did-start-navigation', navigate);
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
