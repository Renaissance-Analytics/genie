/**
 * THE COMPOSER-FOCUS LOG (genie#1235). The owner: the chat composer takes the caret every time an agent does something,
 * even out of another app. Whatever moves it, the `focusin` it causes is dispatched SYNCHRONOUSLY inside the call that
 * moved it, so a stack taken there names that call (a `.focus()`, a selection placed in the contenteditable); a focus
 * the browser restores when the WINDOW is activated has no page caller at all. One line in the log tells the two apart.
 *
 * The person's own click or key in Genie is not logged: a focus within `USER_INPUT_GRACE_MS` of one is theirs.
 */

export const USER_INPUT_GRACE_MS = 1500;

export interface ComposerFocusInput {
    /** The element that took focus is inside `[data-chat-composer]`. */
    readonly inComposer: boolean;
    /** `document.hasFocus()` at that moment. */
    readonly windowFocused: boolean;
    /** Milliseconds since the person's last pointerdown or keydown in this window; `null` = none yet. */
    readonly sinceUserInputMs: number | null;
    /** What had focus before (`relatedTarget`), described; `none` when nothing in the page did. */
    readonly from: string;
    /** `new Error().stack` taken in the focusin listener. */
    readonly stack: string;
}

/** The log line for a composer focus nobody in Genie asked for, or `null` when it is not one. */
export function composerFocusLine(input: ComposerFocusInput): string | null {
    if (!input.inComposer) return null;
    if (input.sinceUserInputMs !== null && input.sinceUserInputMs >= 0 && input.sinceUserInputMs < USER_INPUT_GRACE_MS) return null;
    const frames = input.stack.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(1, 9);
    const caller = frames.length > 0 ? frames.join(' <- ') : 'no page caller (the window was activated and the browser restored the caret)';
    return `[genie] focus: the chat composer took the caret with no click or key in Genie (window ${input.windowFocused ? 'focused' : 'not focused'}, from ${input.from}); ${caller}`;
}
