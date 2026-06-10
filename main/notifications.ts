import { BrowserWindow } from 'electron';
import { setInboxBadge, rebuildMenu } from './tray';
import { fetchMergedInbox } from './backend/registry';

/**
 * Inbox poller — every 60s sum unread counts across every signed-in
 * backend (Tynn + Aionima) and update the tray badge. Native
 * notifications are intentionally OFF: agents produce a high volume of
 * activity that would feel like spam as toasts. Revisit once Tynn ships
 * a "notable events" surface that's filtered by intent rather than
 * raw activity log.
 */

const POLL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;

export function startInboxPoller(): void {
    if (timer) return;
    void pollOnce();
    timer = setInterval(() => void pollOnce(), POLL_MS);
}

export function stopInboxPoller(): void {
    if (timer) clearInterval(timer);
    timer = null;
}

async function pollOnce(): Promise<void> {
    try {
        const inbox = await fetchMergedInbox();
        setInboxBadge(inbox.count);
        for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send('inbox:updated', { count: inbox.count });
        }
    } catch {
        // fetchMergedInbox swallows backend errors per-backend, so a
        // failure here is exotic — keep the badge at whatever it was.
        rebuildMenu();
    }
}

export async function refreshInbox(): Promise<void> {
    await pollOnce();
}
