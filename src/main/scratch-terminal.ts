import { OS_WORKSPACE } from './registry.js';
import type { TerminalHost } from './terminal-host.js';

/**
 * THE TRAY'S NEW SCRATCH TERMINAL (Tynn #761, Genie 1's tray). The owner, 2026-10-19, chose "Genie's own": a shell in
 * the person's home folder, filed under Genie's workspace — not a project's, so it needs no project open and never joins
 * a project's terminals — in a window of its own (the Take Over window, `genie://takeover/<id>`). Closing the window
 * ends the shell, as for every Take Over window.
 */
export interface ScratchTerminalOptions {
    terminals: Pick<TerminalHost, 'open'>;
    openWindow: (route: string) => void;
    /** The person's home folder (`os.homedir()`). */
    home: string;
}

export function openScratchTerminal(options: ScratchTerminalOptions): { ok: true; terminalId: string } | { ok: false; reason: string } {
    let opened: { id: string };
    try {
        opened = options.terminals.open({ workspaceId: OS_WORKSPACE, cwd: options.home, limited: false });
    } catch (error) {
        return { ok: false, reason: `The scratch terminal could not start: ${(error as Error).message}` };
    }
    options.openWindow(`genie://takeover/${opened.id}`);
    return { ok: true, terminalId: opened.id };
}
