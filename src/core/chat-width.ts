import { CHAT_DOCK_DEFAULT_WIDTH, DOCK_WIDTH } from './dock.js';

type WidthStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Whether the thread is scrolled to its end (within a few pixels — fractional zoom never lands exactly). A thread that
 * is at its end follows new messages; one the person has scrolled up in stays where they put it.
 */
export function atThreadEnd(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
    return scrollHeight - scrollTop - clientHeight <= 8;
}


/**
 * THE PINNED CHAT'S WIDTH (Tynn #798; the owner, 2026-10-17: "expanding the chat panel when pinned. It's too thin
 * now."). Pinned, the chat was the dock's fixed 380px. It is wider by default, its edge drags while pinned too, and the
 * width is remembered. The chat is always docked now (2026-10-17), so this is its one width. The content row's reserve
 * reads this same width (`dockReserve('chat', width)`), so the two never diverge.
 */
export const CHAT_DOCK_WIDTH_KEY = 'genie.chat.dockWidth';
/** Wide enough for a rendered reply with code in it. */
export const CHAT_DOCK_DEFAULT = CHAT_DOCK_DEFAULT_WIDTH;
/** Never narrower than the dock was. */
export const CHAT_DOCK_MIN = DOCK_WIDTH;
/** What the view beside a pinned chat keeps, so pinning can never squeeze the work out of the window. */
export const CHAT_DOCK_KEEP = 560;

export function clampChatDockWidth(width: number, viewportWidth: number): number {
    const max = Math.max(CHAT_DOCK_MIN, Math.floor(viewportWidth) - CHAT_DOCK_KEEP);
    return Math.min(max, Math.max(CHAT_DOCK_MIN, Math.round(width)));
}

export function readChatDockWidth(storage: WidthStorage | null | undefined): number {
    let raw: string | null = null;
    try { raw = storage?.getItem(CHAT_DOCK_WIDTH_KEY) ?? null; } catch { /* storage unavailable: the default */ }
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n >= CHAT_DOCK_MIN ? Math.round(n) : CHAT_DOCK_DEFAULT;
}

export function writeChatDockWidth(storage: WidthStorage | null | undefined, width: number): void {
    try { storage?.setItem(CHAT_DOCK_WIDTH_KEY, String(Math.round(width))); } catch { /* storage unavailable: kept for this window */ }
}
