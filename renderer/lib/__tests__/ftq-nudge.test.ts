import { describe, expect, it } from 'vitest';
import { FTQ_NUDGE_TEXT, NUDGE_MAX_CHARS, ftqNudgeBytes } from '../ftq-nudge';
import { PASTE_HEURISTIC_CHARS } from '../../../main/terminal/keystrokes';

/**
 * The F5 nudge has to actually SUBMIT (Tynn story #246).
 *
 * Agent TUIs treat bulk input as a paste, and in paste mode a trailing CR lands in
 * the buffer as a newline instead of submitting (genie#218). Main's write path
 * splits the submit out for long input; the renderer writes raw bytes, so the
 * nudge has to stay under the heuristic instead. A nudge that is merely TYPED into
 * the prompt and left sitting there is indistinguishable, from the user's side,
 * from the agent ignoring it.
 */
describe('the nudge text', () => {
    it('submits — one line, ending in CR', () => {
        expect(ftqNudgeBytes()).toBe(`${FTQ_NUDGE_TEXT}\r`);
        expect(FTQ_NUDGE_TEXT).not.toContain('\n');
    });

    it('stays under the paste heuristic, so the CR is a submit', () => {
        expect(FTQ_NUDGE_TEXT.length).toBeLessThan(NUDGE_MAX_CHARS);
    });

    it('keeps its limit in step with main, rather than guessing at one', () => {
        // The constant is mirrored, so pin it to the source. If main ever lowers
        // the heuristic, this fails here instead of silently in a terminal.
        expect(NUDGE_MAX_CHARS).toBe(PASTE_HEURISTIC_CHARS);
    });

    it('names the tool and asks for the re-ask', () => {
        // An agent that has already asked in plaintext needs an instruction, not a
        // hint it can acknowledge and carry on from.
        expect(FTQ_NUDGE_TEXT).toContain('ForceTheQuestion');
    });
});
