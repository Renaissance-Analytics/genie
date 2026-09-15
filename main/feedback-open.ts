/**
 * Asking the main window to open Feedback (genie#675) — what the global hotkey
 * and the tray's "Send feedback…" do.
 *
 * A window that is still loading has no listener yet, so a send would be lost.
 * The request is parked instead and the page claims it once, when it mounts.
 */

export const OPEN_FEEDBACK_CHANNEL = 'open-feedback';

interface FeedbackTarget {
    isDestroyed(): boolean;
    webContents: { isLoading(): boolean; send(channel: string): void };
}

let pending = false;

export function requestFeedback(win: FeedbackTarget | null): void {
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isLoading()) {
        pending = true;
        return;
    }
    win.webContents.send(OPEN_FEEDBACK_CHANNEL);
}

/** True once per parked request; the page calls this when it mounts. */
export function claimPendingFeedback(): boolean {
    const had = pending;
    pending = false;
    return had;
}
