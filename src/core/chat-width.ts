import { DOCK_WIDTH } from './dock.js';

/**
 * THE UNPINNED CHAT'S WIDTH — the owner's, remembered (2026-10-13: "I need to be able to also resize the chat flyout
 * and have it remember the size I have it at even after closing or pinning it. Pinning does not use that flyout size,
 * it should use the size you designed it for already.").
 *
 * Two geometries, two widths:
 *
 * - **Unpinned** overlays the right edge, so its width moves nothing underneath — the person may drag it to any width
 *   that leaves the view usable, and that width is kept across closing, pinning and restarts.
 * - **Pinned** is the dock: it reserves `DOCK_WIDTH` as a margin on the content row (`core/dock.ts`), and the reserve
 *   and the panel read that ONE token. A pinned chat at the remembered width would overlap the content by the
 *   difference — the failure the dock's geometry rules exist to prevent — so pinning ignores it.
 */

/** Where the width lives: the renderer's localStorage, next to the open chat tabs (`genie.chat.threads`). */
export const CHAT_WIDTH_KEY = 'genie.chat.width';

/** Narrower than this and a rendered reply wraps every few words. */
export const CHAT_MIN_WIDTH = 320;

/** What a wide flyout must leave of the view behind it, so it can never cover the whole window. */
export const CHAT_VIEW_KEEP = 240;

/** `[CHAT_MIN_WIDTH, viewport − CHAT_VIEW_KEEP]`, rounded; a viewport too narrow for both gets the minimum. */
export function clampChatWidth(width: number, viewportWidth: number): number {
    const max = Math.max(CHAT_MIN_WIDTH, Math.floor(viewportWidth) - CHAT_VIEW_KEEP);
    return Math.min(max, Math.max(CHAT_MIN_WIDTH, Math.round(width)));
}

/**
 * The width while dragging the flyout's LEFT edge: the panel is anchored right, so moving the pointer left by N
 * widens it by N.
 */
export function dragChatWidth(fromWidth: number, startX: number, x: number, viewportWidth: number): number {
    return clampChatWidth(fromWidth + (startX - x), viewportWidth);
}

type WidthStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The remembered width, or the designed one when nothing (or nothing sane) was stored. */
export function readChatWidth(storage: WidthStorage | null | undefined): number {
    let raw: string | null = null;
    try { raw = storage?.getItem(CHAT_WIDTH_KEY) ?? null; } catch { /* storage unavailable: the designed width */ }
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n >= CHAT_MIN_WIDTH ? Math.round(n) : DOCK_WIDTH;
}

export function writeChatWidth(storage: WidthStorage | null | undefined, width: number): void {
    try { storage?.setItem(CHAT_WIDTH_KEY, String(Math.round(width))); } catch { /* storage unavailable: kept for this window */ }
}

/**
 * Whether the thread is scrolled to its end (within a few pixels — fractional zoom never lands exactly). A thread that
 * is at its end follows new messages; one the person has scrolled up in stays where they put it.
 */
export function atThreadEnd(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
    return scrollHeight - scrollTop - clientHeight <= 8;
}
