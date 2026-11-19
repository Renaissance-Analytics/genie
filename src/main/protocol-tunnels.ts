import type { ServerConnection, ServerTransport } from '../core/remote-protocol.js';
import type { FeatureBrowser } from './feature-callers.js';

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

export class ProtocolTunnels implements ServerTransport {
    constructor(_options: ProtocolTunnelsOptions = {}) {}
    onConnection(_listener: (connection: ServerConnection) => void): () => void { throw new Error('2d-4b: not built'); }
    receive(_owner: string, _op: unknown, _tunnel: unknown, _payload: unknown, _send: (event: TunnelEvent) => void): void { throw new Error('2d-4b: not built'); }
    dropOwner(_owner: string): void { throw new Error('2d-4b: not built'); }
    bindingOf(_connectionId: string): TunnelBinding | null { throw new Error('2d-4b: not built'); }
}
