import { useEffect, useRef, useState } from 'react';
import { COPIED_MS } from '../../core/chat-copy.js';
import { copyToClipboard } from '../clipboard.js';
import type { CopyState } from './ChatProse.js';

/**
 * A PLAIN-TEXT COPY BUTTON'S DOOR AND VOICE (genie#1263 follow-up, after react-fancy 5.68).
 *
 * The buttons outside the chat ("Copy log", the Tynn sign-in link, the GitHub code, the files panel's copy-path, the share
 * link, the editor wand's Copy) wrote `navigator.clipboard` directly and ignored the answer. In a sandboxed Electron
 * window that can resolve with nothing on the clipboard (Genie 1, v0.7.0-beta.342), so a failed copy said "Copied" or said
 * nothing. Each now copies through main's clipboard, read back (`renderer/clipboard.ts`, the chat's door), and says what
 * happened: on the button, and in a polite live region beside it.
 */

/** Copy plain text through main. `true` only when main wrote it and read the same text back. */
export function copyText(text: string): Promise<boolean> {
    return copyToClipboard({ plain: text });
}

/** What a copy button says: its own word at rest, then "Copied" or "Copy failed" for a moment. */
export function copyWords(state: CopyState, idle: string): string {
    return state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : idle;
}

/** The outcome, ANNOUNCED: a polite live region, empty at rest (drawn always, so the change is what is read out). */
export function CopyAnnounce({ state }: { state: CopyState }) {
    return <span data-copy-announce="" role="status" aria-live="polite" className="sr-only">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}</span>;
}

/** A copy and its outcome for a while (`COPIED_MS`, as the chat's buttons): `copy(text)` resolves to whether it landed. */
export function useCopyText(): { state: CopyState; copy: (text: string) => Promise<boolean>; reset: () => void } {
    const [state, setState] = useState<CopyState>('idle');
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    const reset = () => { if (timer.current) clearTimeout(timer.current); setState('idle'); };
    const copy = (text: string) => copyText(text).then((ok) => {
        setState(ok ? 'copied' : 'failed');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), COPIED_MS);
        return ok;
    });
    return { state, copy, reset };
}
