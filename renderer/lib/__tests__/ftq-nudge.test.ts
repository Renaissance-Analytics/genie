import { describe, expect, it } from 'vitest';
import { FTQ_NUDGE_TEXT, ftqNudgeDelivery } from '../ftq-nudge';
import { PASTE_HEURISTIC_CHARS, PASTE_SUBMIT_DELAY_MS } from '../../../main/terminal/keystrokes';

/**
 * The F5 nudge has to actually SUBMIT (Tynn story #246), whatever it says.
 *
 * Agent TUIs treat bulk input as a paste, and in paste mode a trailing CR lands
 * in the buffer as a newline instead of submitting (genie#218). A nudge that is
 * merely TYPED into the prompt and left sitting there is indistinguishable, from
 * the user's side, from the agent ignoring it.
 *
 * The old rule was "keep the text under the heuristic" — the renderer wrote raw
 * bytes in one go, so short was the only way to be sure. That put a 48-character
 * ceiling on what the nudge could SAY, and the owner's wording is 56:
 *
 *     Use ForceTheQuestion to help me understand what you need
 *
 * Truncating the copy to fit the transport would be backwards. Main's write path
 * already splits the submit for long input; this does the same thing on the
 * renderer side, so the length ceiling stops being a constraint on the words.
 *
 * `ftqNudgeDelivery()` is therefore the unit under test rather than a byte
 * string: it decides whether the CR rides along or is delivered separately.
 */
describe('the nudge text', () => {
    it('is the owner\'s wording', () => {
        expect(FTQ_NUDGE_TEXT).toBe('Use ForceTheQuestion to help me understand what you need');
    });

    it('names the tool and asks for what is needed', () => {
        // An agent that has already asked in plaintext needs an instruction, not
        // a hint it can acknowledge and carry on from.
        expect(FTQ_NUDGE_TEXT).toContain('ForceTheQuestion');
    });

    it('stays one line — a newline would submit early, mid-sentence', () => {
        expect(FTQ_NUDGE_TEXT).not.toContain('\n');
    });
});

describe('delivering it so it submits', () => {
    it('splits the submit, because the wording is past the paste heuristic', () => {
        const delivery = ftqNudgeDelivery();

        // This is the case that matters: at 56 chars the TUI reads a single
        // write as a paste and swallows the CR into the buffer.
        expect(FTQ_NUDGE_TEXT.length).toBeGreaterThan(PASTE_HEURISTIC_CHARS);
        expect(delivery.body).toBe(FTQ_NUDGE_TEXT);
        expect(delivery.submitSeparately).toBe(true);
        expect(delivery.submit).toBe('\r');
        expect(delivery.delayMs).toBe(PASTE_SUBMIT_DELAY_MS);
    });

    it('the body carries NO carriage return of its own', () => {
        // The whole point: a CR inside the pasted body is the newline that
        // parks the prompt instead of starting a turn.
        expect(ftqNudgeDelivery().body).not.toContain('\r');
    });

    /**
     * POSITIVE CONTROL on the split. Every assertion above is satisfied by a
     * function that ALWAYS splits — which would be a needless extra write for a
     * short nudge and, worse, would hide a regression where the text silently
     * shrinks back under the heuristic and nobody notices the delivery no
     * longer matches the reason for it.
     */
    it('POSITIVE CONTROL: a short nudge rides its CR inline', () => {
        const short = ftqNudgeDelivery('Re-ask with ForceTheQuestion.');

        expect(short.submitSeparately).toBe(false);
        expect(short.body).toBe('Re-ask with ForceTheQuestion.\r');
    });

    it('keeps its threshold in step with main, rather than guessing at one', () => {
        // Mirrored constant pinned to its source. If main ever changes the
        // heuristic, this fails here instead of silently in a terminal.
        const atLimit = 'x'.repeat(PASTE_HEURISTIC_CHARS);
        const overLimit = 'x'.repeat(PASTE_HEURISTIC_CHARS + 1);

        expect(ftqNudgeDelivery(atLimit).submitSeparately).toBe(false);
        expect(ftqNudgeDelivery(overLimit).submitSeparately).toBe(true);
    });
});
