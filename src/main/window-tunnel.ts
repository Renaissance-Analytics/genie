import { isAbsolute, relative, resolve } from 'node:path';
import type { ServerConnection, ServerTransport } from '../core/remote-protocol.js';
import type { FeatureBrowser } from './feature-callers.js';
import type { TunnelEvent, TunnelOp } from './protocol-tunnels.js';

/**
 * MAIN FORWARDS ITS DOOR OVER THE ENGINE LINK (client/host split step 2d-4b, Tynn #898, story #910). The window's page
 * still opens its protocol connection on main's IPC door (local-protocol-door.ts: main admits the window and proves it
 * local); main no longer serves it. Each connection is carried to genie-host (`engine.protocol`), whose RemoteHost
 * serves every client of this machine: the renderer and the preload are unchanged.
 *
 * When the link is not up the connection is refused as still starting, and when the link drops every connection is
 * closed: the page's session (local-session.ts) reconnects, to the host that is there next.
 */

/** The engine link as the window's door tunnels over it. */
export interface TunnelLink {
    live(): boolean;
    send(op: TunnelOp, tunnel: string, payload: unknown): boolean;
    onFrame(listener: (event: TunnelEvent) => void): () => void;
    onDown(listener: (reason: string) => void): () => void;
}

export interface TunnelDoorOptions {
    /** A window's browser pane, by the RemoteHost connection id its welcome said; null = this window has none. */
    readonly browser?: (connectionId: string) => FeatureBrowser | null;
    readonly newId?: () => string;
}

const STARTING = 'Genie is still starting; this window connects again in a moment';

interface Carried {
    readonly connection: ServerConnection;
    connectionId: string | null;
}

export function tunnelDoor(door: ServerTransport, link: TunnelLink, options: TunnelDoorOptions = {}): { refreshBrowser(): void; dispose(): void } {
    let next = 0;
    const newId = options.newId ?? (() => `w${(++next).toString(36)}`);
    const carried = new Map<string, Carried>();
    const sayBrowser = (tunnel: string, c: Carried) => {
        if (options.browser && c.connectionId !== null) link.send('browser', tunnel, options.browser(c.connectionId));
    };
    const drop = (tunnel: string, c: Carried) => {
        if (carried.get(tunnel) !== c) return;
        carried.delete(tunnel);
        c.connection.close();
    };
    const offFrame = link.onFrame((event) => {
        const c = carried.get(event.tunnel);
        if (!c) return;
        if (event.kind === 'closed') return drop(event.tunnel, c);
        c.connection.send(event.text);
        // The welcome names genie-host's connection: the window's browser pane is said for it from then on.
        if (c.connectionId === null && event.text.includes('"welcome"')) {
            try {
                const sent = JSON.parse(event.text) as { kind?: unknown; connectionId?: unknown };
                if (sent.kind === 'welcome' && typeof sent.connectionId === 'string') { c.connectionId = sent.connectionId; sayBrowser(event.tunnel, c); }
            } catch { /* not a welcome */ }
        }
    });
    const offDown = link.onDown(() => { for (const [tunnel, c] of [...carried]) drop(tunnel, c); });
    const offDoor = door.onConnection((connection) => {
        if (!link.live()) {
            connection.send(JSON.stringify({ kind: 'refused', reason: STARTING }));
            connection.close();
            return;
        }
        const tunnel = newId();
        const c: Carried = { connection, connectionId: null };
        carried.set(tunnel, c);
        const pre = connection.preAuth;
        if (!link.send('open', tunnel, { window: pre?.kind === 'local' && pre.window === 'remote' ? 'remote' : 'main', label: pre?.label ?? 'this Genie window' })) {
            carried.delete(tunnel);
            connection.send(JSON.stringify({ kind: 'refused', reason: STARTING }));
            connection.close();
            return;
        }
        connection.onMessage((text) => { if (carried.get(tunnel) === c && !link.send('frame', tunnel, text)) drop(tunnel, c); });
        connection.onClose(() => {
            if (carried.get(tunnel) !== c) return;
            carried.delete(tunnel);
            link.send('close', tunnel, 'the window closed its protocol connection');
        });
    });
    return {
        refreshBrowser: () => { for (const [tunnel, c] of carried) sayBrowser(tunnel, c); },
        dispose: () => {
            offDoor(); offFrame(); offDown();
            for (const [tunnel, c] of [...carried]) { carried.delete(tunnel); link.send('close', tunnel, 'Genie’s window is closing'); c.connection.close(); }
        },
    };
}

/** The window process's engine client, as the door's tunnel. */
export function tunnelLinkOf(client: {
    readonly linked: boolean;
    protocolSend(op: TunnelOp, tunnel: string, payload: unknown): boolean;
    onProtocolFrame(listener: (event: TunnelEvent) => void): () => void;
    onLink(up: () => void, down: (reason: string) => void): () => void;
}): TunnelLink {
    return {
        live: () => client.linked,
        send: (op, tunnel, payload) => client.protocolSend(op, tunnel, payload),
        onFrame: (listener) => client.onProtocolFrame(listener),
        onDown: (listener) => client.onLink(() => {}, listener),
    };
}

/** What only a window can do for genie-host: move a file to the OS trash, open an app's window. */
export interface WindowOpsDeps {
    readonly trash: (absolutePath: string) => Promise<void>;
    readonly workspaces: () => readonly { readonly path: string }[];
    readonly openApp: (packageId: string, preview: boolean) => Promise<void>;
}

/**
 * WINDOW-LOCAL CLIENT OPERATIONS (the owner's ruling: the window now, the launcher later), asked by genie-host as
 * `client.windowOp`: Electron's trash and an app's BrowserWindow. genie-host confines a path before it asks; the window
 * checks again, so nothing outside this machine's registered workspaces is ever moved, whoever asks.
 */
export function windowOpsHandler(deps: WindowOpsDeps): (op: string, args: unknown[]) => Promise<unknown> {
    return async (op, args) => {
        if (op === 'trash') {
            const path = args[0];
            if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('the trash takes a file’s full path');
            const full = resolve(path);
            const inside = deps.workspaces().some((w) => {
                const rel = relative(resolve(w.path), full);
                return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
            });
            if (!inside) throw new Error('Genie moves to the trash only a file inside one of this machine’s workspaces');
            await deps.trash(full);
            return true;
        }
        if (op === 'gapps.open' || op === 'gapps.preview') {
            const id = args[0];
            if (typeof id !== 'string' || id.length === 0) throw new Error('name the app to open');
            await deps.openApp(id, op === 'gapps.preview');
            return null;
        }
        throw new Error(`${op} is not something this window does for genie-host`);
    };
}
