import { OS_WORKSPACE } from './registry.js';
import type { TerminalOptions } from './terminal-host.js';

/**
 * THE TRAY'S NEW SCRATCH TERMINAL (Tynn #761, Genie 1's tray). The owner, 2026-10-19, chose "Genie's own": a shell in
 * the person's home folder, filed under Genie's workspace — not a project's, so it needs no project open and never joins
 * a project's terminals — in a window of its own (the Take Over window, `genie://takeover/<id>`).
 *
 * It takes the header Terminal button's path (genie#1596): a DISPOSABLE terminal through {@link ScratchTerminals}, so
 * closing its window ends it. Before, it was an ordinary terminal and the window's close reached only an agent's Take
 * Over, which left the shell running with nothing showing it.
 */
export interface ScratchTerminalOptions {
    scratch: Pick<ScratchTerminals, 'open'>;
    /** The person's home folder (`os.homedir()`). */
    home: string;
}

export function openScratchTerminal(options: ScratchTerminalOptions): { ok: true; terminalId: string } | { ok: false; reason: string } {
    return options.scratch.open({ workspaceId: OS_WORKSPACE, cwd: options.home });
}

/**
 * THE WORKSPACE HEADER'S TERMINAL BUTTON (Tynn story #378). The owner: "we need an ability to open a window with a throw
 * away terminal without needing to create a tab … closing the window deletes the terminal and removes all trace of it's
 * existance from memory and file." Each click: a shell in the workspace's folder with the workspace's environment, like
 * a workspace terminal, opened DISPOSABLE (the host enforces it: terminal-host.ts) in a Take Over window of its own.
 * Closing that window closes it; nothing here outlives it.
 */
export interface ScratchTerminalsOptions {
    terminals: { open(options: TerminalOptions): { id: string }; close(id: string): boolean };
    openWindow: (route: string) => void;
}

export class ScratchTerminals {
    readonly #options: ScratchTerminalsOptions;
    /** The terminals this opened whose windows are still open. */
    readonly #open = new Set<string>();

    constructor(options: ScratchTerminalsOptions) {
        this.#options = options;
    }

    open(where: { workspaceId: string; cwd: string; env?: Readonly<Record<string, string>> | undefined }): { ok: true; terminalId: string } | { ok: false; reason: string } {
        let opened: { id: string };
        try {
            opened = this.#options.terminals.open({
                workspaceId: where.workspaceId,
                cwd: where.cwd,
                ...(where.env && Object.keys(where.env).length > 0 ? { env: where.env } : {}),
                personal: true,
                // Genie's own throwaway shell, like the tray's: not counted against the workspace's terminal limit.
                limited: false,
                disposable: true,
            });
        } catch (error) {
            return { ok: false, reason: `The terminal could not start: ${(error as Error).message}` };
        }
        this.#open.add(opened.id);
        this.#options.openWindow(`genie://takeover/${opened.id}`);
        return { ok: true, terminalId: opened.id };
    }

    /** A Take Over window closed: when it was one of these, its terminal goes with it. */
    windowClosed(terminalId: string): void {
        if (!this.#open.delete(terminalId)) return;
        this.#options.terminals.close(terminalId);
    }
}
