/**
 * A SITE PANEL'S RESTART ASKS AS THE TRAY'S DOES (the store guard's way out: Genie restarted once the key is there). The
 * panel's Restart is the tray's Restart: the same question, Cancel the default, and Genie restarts only on the answer.
 */
export function panelRestart(ask: (action: 'restart') => unknown, restart: () => void): () => void {
    return () => { if (ask('restart')) restart(); };
}
