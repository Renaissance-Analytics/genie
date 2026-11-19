import type { CallContext } from '../core/remote-protocol.js';

/**
 * A TERMINAL'S WINDOW, OPENED BY THE CLIENT THAT ASKED (Tynn #898 step 2b, story #896). genie-host starts the terminal (a
 * Take Over TUI); a client is a dumb terminal, so it opens no window of its own: the window process that carries the
 * caller's connection (protocol-tunnels.ts) is asked over `client.windowOp`, and that op settles when the window closes.
 * So the host hears the window close and ends what it started, with no call back from the window.
 */
export interface TerminalWindowPorts {
    /** The window process (engine connection) that carries this protocol connection; null = none of this machine's. */
    readonly ownerOf: (connectionId: string) => string | null;
    readonly windowOp: (owner: string, op: string, args: unknown[]) => Promise<unknown>;
    readonly log: (line: string) => void;
}

/**
 * Asks the caller's window process to open `route`'s window. `false` = the caller is not one of this machine's windows
 * (another machine opens its own, with its ticket). `ended` runs when the window closed, or when it could not be shown
 * (or its process went away first) for a terminal this ask started (`startedHere`); one already open stays with whoever
 * has it. Never for a window that was already open and only raised.
 */
export function openCallersTerminalWindow(ports: TerminalWindowPorts, context: CallContext | undefined, route: string, terminal: { readonly startedHere: boolean; readonly ended: () => void }): boolean {
    const owner = context ? ports.ownerOf(context.connectionId) : null;
    if (owner === null) return false;
    ports.windowOp(owner, 'terminal.window', [route]).then((answer) => {
        if (answer === 'closed') terminal.ended();
    }, (error: unknown) => {
        ports.log(`[genie-host] the window for ${route} could not be shown: ${error instanceof Error ? error.message : String(error)}`);
        if (terminal.startedHere) terminal.ended();
    });
    return true;
}
