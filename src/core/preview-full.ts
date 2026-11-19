import type { KeyPress } from './keys.js';

/**
 * A FILE PREVIEW CAN FILL ITS WINDOW (the owner, beta.65: "a full-screen button for file previews, to make reading specs
 * easier"). The pure half: which key restores it, and what "full" is in each window.
 *
 * FULL IS THE WINDOW, BELOW ITS DRAG STRIP — not the whole screen, and not over the strip. Making the OS window full
 * screen would move a window the person placed (the question window is centred and sized by main, question-drawer.ts),
 * and the main window's previews would need the same IPC for no gain in reading space. Covering the strip is worse:
 * Chromium keeps a `-webkit-app-region: drag` area live under an overlay, so the preview's own buttons drawn over it would
 * drag the window instead of answering a click. The strip is each window's one app region (genie#1298), so the preview
 * stops at it: the question window's header is `h-11`, the main window's title bar `h-9`.
 */
export type PreviewWindow = 'question' | 'main';

const BELOW_STRIP: Record<PreviewWindow, string> = { question: 'top-11', main: 'top-9' };

/** The class of a preview that fills its window: fixed, edge to edge, below the window's drag strip, over everything else. */
export function previewFullClass(window: PreviewWindow): string {
    return `fixed inset-x-0 bottom-0 ${BELOW_STRIP[window]} z-50 flex flex-col bg-[var(--bg-1)]`;
}

/** A bare Esc restores a full preview; anything else, or a preview that is not full, is not the preview's. */
export function previewFullKey(press: KeyPress, full: boolean): 'restore' | null {
    if (!full || press.key !== 'Escape' || press.ctrlKey || press.metaKey || press.altKey || press.shiftKey) return null;
    return 'restore';
}
