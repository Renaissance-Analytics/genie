/**
 * A SITE PANEL'S RESTART ASKS AS THE TRAY'S DOES (the store guard's way out: Genie restarted once the key is there). The
 * panel's Restart is the tray's Restart: the same question, Cancel the default, and Genie restarts only on the answer.
 *
 * WAITED FOR: the tray's question is asynchronous (#1574: the busy marks are read off main first). Read as a boolean, the
 * Promise was always true and the panel restarted Genie on Cancel too; the answer is awaited, and only `true` restarts.
 */
export function panelRestart(ask: (action: 'restart') => boolean | Promise<boolean>, restart: () => void): () => void {
    return () => { void Promise.resolve(ask('restart')).then((ok) => { if (ok === true) restart(); }, () => { /* no answer, no restart */ }); };
}
