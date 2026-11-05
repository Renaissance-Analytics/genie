/**
 * THE QUESTION WINDOW'S QUEUE AS ONE ROW OF TABS (Tynn story #378). The owner: "make FTQ use tabs for the request queue
 * instead of buttons that stack and push the question ui down. We don't want UI that jumps around and rearranges just
 * because a label or pending action or list is growing."
 *
 * Every tab is the same width, so how many fit is arithmetic on the strip's width; the rest go behind "+N" at its end.
 * The selected question always has a tab: when it is past the ones that fit, it takes the last place. A question
 * arriving is added at the end, so it never moves the tabs before it.
 */

/** One tab's width in px (Tailwind `w-44`). */
export const QUESTION_TAB_PX = 176;
/** The "+N" control's room at the strip's end, in px. */
export const QUESTION_MORE_PX = 56;
/** How many tabs are drawn before the strip has been measured (the first paint, server-side). */
export const QUESTION_TABS_UNMEASURED = 4;

/** How many tabs a strip `width` px wide holds for `count` questions: all of them, or as many as leave room for "+N". */
export function tabsThatFit(width: number, count: number): number {
    if (count * QUESTION_TAB_PX <= width) return count;
    return Math.max(1, Math.floor((width - QUESTION_MORE_PX) / QUESTION_TAB_PX));
}

/** Which questions have a tab and which are behind "+N", in queue order; the selected one always has a tab. */
export function questionTabs(ids: readonly string[], selected: string | null, fit: number): { shown: string[]; more: string[] } {
    const n = Math.max(1, Math.min(fit, ids.length));
    let shown = ids.slice(0, n);
    if (selected !== null && ids.includes(selected) && !shown.includes(selected)) shown = [...shown.slice(0, n - 1), selected];
    return { shown, more: ids.filter((id) => !shown.includes(id)) };
}
