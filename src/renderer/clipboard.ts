import type { ContentClipboardWriter } from '@particle-academy/react-fancy';
import { contentCopyPayload, writeThroughHost, type ClipboardItemCtor, type ClipboardLike, type CopyPayload, type HostClipboard } from '../core/chat-copy.js';

/**
 * EVERY COPY GENIE'S RENDERER MAKES, through one door (genie#1263 follow-up).
 *
 * In the app, both windows that draw rendered Markdown have `window.genieClipboard` (main/preload.ts,
 * main/question-preload.ts): the copy is written by MAIN, through Electron's clipboard, and checked. A browser driving
 * another machine has no such bridge and uses the page's clipboard, which works there. Never both: a host that says no is
 * a failed copy, not a reason to try a clipboard that can claim success silently (core/chat-copy.ts `writeThroughHost`).
 */
declare global {
    interface Window {
        /** Present in the app's windows only (the preloads). Optional: a render test and a remote browser have none. */
        genieClipboard?: HostClipboard | undefined;
    }
}

export function copyToClipboard(payload: CopyPayload): Promise<boolean> {
    const g = globalThis as { genieClipboard?: HostClipboard; navigator?: { clipboard?: unknown }; ClipboardItem?: ClipboardItemCtor };
    return writeThroughHost(payload, g.genieClipboard, g.navigator?.clipboard as ClipboardLike | undefined, g.ClipboardItem);
}

/**
 * react-fancy's ContentRenderer copy buttons (code, tables — on by default since 5.67.0) write through this. `false` is a
 * failed copy: fancy shows its `x` and announces "Copy failed" (ContentRenderer docs, "Clipboard writer").
 */
export const genieClipboardWriter: ContentClipboardWriter = (payload) => copyToClipboard(contentCopyPayload(payload));
