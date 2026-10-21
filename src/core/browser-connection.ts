import { relayWorkstationOf } from './remote-window.js';

/**
 * WHICH GENIE BROWSER A WINDOW GETS (browser rebuild step 4; Genie 1's per-connKey browser) — decided by the window
 * that asked, never by what its renderer says:
 *
 * - a window that is not driving another workstation browses THIS machine's sites;
 * - a window driving a Tynn workstation (`relay:<id>`) browses THAT workstation's, over its own open relay channel;
 *   while that channel is down it is refused in words — never handed this machine's sites, which would look like the
 *   other workstation's and are not (Genie 1 had that bug: a dropped remote window opened the local browser);
 * - a window that reaches its host directly (`ws://` / `wss://`) is refused for now: its socket lives in the renderer,
 *   so there is no stream for a page to ride. Through Tynn it works.
 */
export type BrowserConnection<T> =
    | { readonly kind: 'local' }
    | { readonly kind: 'relay'; readonly workstationId: string; readonly transport: T }
    | { readonly kind: 'refused'; readonly reason: string };

export function browserConnectionFor<T>(input: {
    /** The `remote` address of the window that asked, or `null` for a window that is not driving another workstation. */
    readonly remoteUrl: string | null;
    /** That window's open relay channels. */
    readonly relays: readonly { readonly workstationId: string; readonly transport: T }[];
}): BrowserConnection<T> {
    if (input.remoteUrl === null) return { kind: 'local' };
    const workstationId = relayWorkstationOf(input.remoteUrl);
    if (workstationId === null) {
        return { kind: 'refused', reason: 'This window reaches its host directly. To browse that workstation’s sites, connect to it through the Tynn network.' };
    }
    const channel = input.relays.find((r) => r.workstationId === workstationId);
    if (!channel) return { kind: 'refused', reason: 'This window is not connected to its workstation right now. Reconnect, then open the browser again.' };
    return { kind: 'relay', workstationId, transport: channel.transport };
}
