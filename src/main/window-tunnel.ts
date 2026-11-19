import type { ServerTransport } from '../core/remote-protocol.js';
import type { FeatureBrowser } from './feature-callers.js';
import type { TunnelEvent, TunnelOp } from './protocol-tunnels.js';

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

export function tunnelDoor(_door: ServerTransport, _link: TunnelLink, _options: TunnelDoorOptions = {}): { refreshBrowser(): void; dispose(): void } {
    throw new Error('2d-4b: not built');
}

export function tunnelLinkOf(_client: unknown): TunnelLink {
    throw new Error('2d-4b: not built');
}

/** What only a window can do for genie-host: move a file to the OS trash, open an app's window. */
export interface WindowOpsDeps {
    readonly trash: (absolutePath: string) => Promise<void>;
    readonly workspaces: () => readonly { readonly path: string }[];
    readonly openApp: (packageId: string, preview: boolean) => Promise<void>;
}

export function windowOpsHandler(_deps: WindowOpsDeps): (op: string, args: unknown[]) => Promise<unknown> {
    throw new Error('2d-4b: not built');
}
