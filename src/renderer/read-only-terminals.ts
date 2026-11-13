import type { GenieBridge } from './bridge.js';

/**
 * A READ-ONLY WINDOW'S TERMINALS (Tynn #691): output is read; nothing that acts is sent. The host refuses a read-only
 * share's keystrokes, resizes, opens and closes anyway (main/remote-host.ts); this keeps the window from sending them at
 * all, wherever a terminal is drawn — the Terminals view, a designed tab's terminal cell, an observed agent's TUI.
 */
const READ_ONLY = 'You have read-only access to this workspace: its terminals show output only.';

export function readOnlyTerminals(terminals: GenieBridge['terminals']): GenieBridge['terminals'] {
    return {
        ...terminals,
        open: () => Promise.reject(new Error(READ_ONLY)),
        write: () => {},
        resize: () => {},
        close: () => {},
    };
}
