import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, buildNudgeSequence, noteDraft, planNudge, type Draft } from '../draft';

/**
 * What Genie believes is in an agent terminal's input box, and what it is
 * therefore allowed to do with a notice (owner, JOB 2).
 *
 * Genie cannot read a TUI's input box — the draft lives inside Claude Code or
 * Codex. All it has is the keystrokes it already sees on `terminal:write`. So it
 * models the box from those, and the model carries its own CONFIDENCE: the
 * moment a keystroke arrives that Genie cannot interpret — an arrow key, history
 * recall, tab completion, a word-delete — the model stops claiming to know what
 * is in there.
 *
 * That flag is the whole safety story. A confident model lets Genie cut the
 * draft out, deliver the notice, and put the draft back. An unconfident one
 * means Genie must not touch what is there: it appends the notice WITHOUT
 * submitting and warns the person instead, so nothing of theirs is ever lost.
 */
const d = (over: Partial<Draft> = {}): Draft => ({ ...EMPTY_DRAFT, ...over });

describe('noteDraft — modelling plain typing', () => {
    it('starts empty, confident, and imageless', () => {
        expect(EMPTY_DRAFT).toEqual({
            text: '',
            confident: true,
            image: false,
        });
    });

    it('accumulates typed characters', () => {
        let s = EMPTY_DRAFT;
        s = noteDraft(s, 'des');
        s = noteDraft(s, 'ign');
        expect(s.text).toBe('design');
        expect(s.confident).toBe(true);
    });

    it('Enter submits, emptying the box and restoring confidence', () => {
        const s = noteDraft(d({ text: 'ship it', confident: false }), '\r');
        expect(s).toEqual(EMPTY_DRAFT);
    });

    it('Ctrl-C abandons the line', () => {
        expect(noteDraft(d({ text: 'half a thought' }), '\x03')).toEqual(EMPTY_DRAFT);
    });

    it('Ctrl-U kills the line', () => {
        expect(noteDraft(d({ text: 'half a thought' }), '\x15')).toEqual(EMPTY_DRAFT);
    });

    it('backspace removes the last character', () => {
        expect(noteDraft(d({ text: 'teh' }), '\x7f').text).toBe('te');
        expect(noteDraft(d({ text: 'teh' }), '\x08').text).toBe('te');
    });

    it('backspace on an empty box is a harmless no-op', () => {
        const s = noteDraft(EMPTY_DRAFT, '\x7f');
        expect(s.text).toBe('');
        expect(s.confident).toBe(true);
    });

    it('text typed after an Enter in one chunk is the new draft', () => {
        expect(noteDraft(EMPTY_DRAFT, 'go\rnext').text).toBe('next');
    });

    it('a bracketed paste lands as literal text', () => {
        const s = noteDraft(EMPTY_DRAFT, '\x1b[200~from the clipboard\x1b[201~');
        expect(s.text).toBe('from the clipboard');
        expect(s.confident).toBe(true);
    });
});

describe('noteDraft — the emulator talking is not the person typing', () => {
    it('a cursor-position report leaves the model untouched', () => {
        const s = noteDraft(d({ text: 'keep me' }), '\x1b[38;1R');
        expect(s.text).toBe('keep me');
        expect(s.confident).toBe(true);
    });

    it("Genie's own OSC 52 clipboard reply leaves the model untouched", () => {
        const s = noteDraft(d({ text: 'keep me' }), '\x1b]52;c;SGVsbG8=\x07');
        expect(s.text).toBe('keep me');
        expect(s.confident).toBe(true);
    });

    it('a focus report leaves the model untouched', () => {
        expect(noteDraft(d({ text: 'keep me' }), '\x1b[I').confident).toBe(true);
    });
});

describe('noteDraft — confidence is surrendered the moment Genie is guessing', () => {
    it('an arrow key means the cursor moved somewhere Genie does not track', () => {
        expect(noteDraft(d({ text: 'abc' }), '\x1b[A').confident).toBe(false);
    });

    it('history recall (up arrow) does not pretend the text is unchanged', () => {
        const s = noteDraft(d({ text: '' }), '\x1b[A');
        expect(s.confident).toBe(false);
    });

    it('tab completion may insert text Genie never saw', () => {
        expect(noteDraft(d({ text: 'npm ru' }), '\t').confident).toBe(false);
    });

    it('Ctrl-W deletes a word by the TUI/s own rules, not Genie/s', () => {
        expect(noteDraft(d({ text: 'one two' }), '\x17').confident).toBe(false);
    });

    it('cursor-relative kills (Ctrl-A, Ctrl-E, Ctrl-K) are not modelled', () => {
        expect(noteDraft(d({ text: 'abc' }), '\x01').confident).toBe(false);
        expect(noteDraft(d({ text: 'abc' }), '\x05').confident).toBe(false);
        expect(noteDraft(d({ text: 'abc' }), '\x0b').confident).toBe(false);
    });

    it('an unknown control byte surrenders confidence', () => {
        expect(noteDraft(d({ text: 'abc' }), '\x12').confident).toBe(false);
    });

    it('an image paste marks the box unrestorable', () => {
        const s = noteDraft(d({ text: 'look' }), '\x16');
        expect(s.image).toBe(true);
        expect(s.confident).toBe(false);
    });

    it('Meta-V image paste counts too', () => {
        expect(noteDraft(EMPTY_DRAFT, '\x1bv').image).toBe(true);
    });

    it('once lost, confidence stays lost while the draft stands', () => {
        let s = noteDraft(d({ text: 'abc' }), '\x1b[A');
        s = noteDraft(s, 'more typing');
        expect(s.confident).toBe(false);
    });

    it('submitting clears the doubt along with the box', () => {
        let s = noteDraft(d({ text: 'abc', image: true, confident: false }), '\r');
        expect(s).toEqual(EMPTY_DRAFT);
        s = noteDraft(s, 'fresh');
        expect(s.confident).toBe(true);
    });

    it('Codex enhanced Enter clears an unconfident draft before the idle terminal reply', () => {
        let s = noteDraft(EMPTY_DRAFT, '\t');
        s = noteDraft(s, 'the submitted prompt');
        s = noteDraft(s, '\x1b[13u');
        s = noteDraft(s, '\x1b[?1;2c');

        expect(planNudge(s)).toEqual({ mode: 'submit' });

        // Positive control for the fail-safe: Shift+Enter inserts a newline in
        // Codex, so it must not be mistaken for the submitting Enter.
        const shifted = noteDraft(d({ text: 'still here', confident: false }), '\x1b[13;2u');
        expect(planNudge(shifted)).toEqual({ mode: 'defer' });
    });

    it('recognizes enhanced Enter without retaining its keyboard encoding for automation', () => {
        const enter = '\x1b[13;1u';
        const s = noteDraft(d({ text: 'submit me' }), enter);

        expect(s).toEqual({ text: '', confident: true, image: false });
        // Positive control: Shift+Enter is content, not the submit key to replay.
        const shifted = noteDraft(d({ text: 'still here' }), '\x1b[13;2u');
        expect(shifted.text).toBe('still here');
        expect(planNudge(shifted)).toEqual({ mode: 'defer' });
    });
});

/**
 * The decision the owner specified: swap only when Genie is CERTAIN; otherwise
 * do not skip the nudge and do not clobber anything — append the text to the box
 * WITHOUT submitting it, and warn the person with a toast.
 */
describe('planNudge', () => {
    it('an empty box just takes the nudge and submits it', () => {
        expect(planNudge(EMPTY_DRAFT)).toEqual({ mode: 'submit' });
    });

    it('a confident single-line draft defers without touching the prompt', () => {
        expect(planNudge(d({ text: 'deploy the thing' }))).toEqual({ mode: 'defer' });
    });

    it('an unconfident draft is appended to, never cut', () => {
        expect(planNudge(d({ text: 'deploy', confident: false }))).toEqual({ mode: 'defer' });
    });

    it('a MULTI-LINE draft is appended to, because the cut only kills one line', () => {
        // Ctrl-A/Ctrl-K is a single-line operation; cutting a multi-line draft
        // would leave part of it behind and lose the rest.
        expect(planNudge(d({ text: 'first\nsecond' }))).toEqual({ mode: 'defer' });
    });

    it('an image in the box is appended to — a text restore cannot bring it back', () => {
        expect(planNudge(d({ text: '', image: true, confident: false }))).toEqual({ mode: 'defer' });
    });

    it('an image with an otherwise-empty box is NOT treated as an empty box', () => {
        // Submitting here would send the person's image as the nudge's turn.
        expect(planNudge(d({ text: '', image: true, confident: true }))).not.toEqual({
            mode: 'submit',
        });
    });
});

/**
 * The actual pty writes each plan turns into. Ordered, with the delay that must
 * precede each one — the caller does the waiting, so this stays pure.
 *
 * The delays are not decoration: a TUI treats a chunk that arrives all at once
 * as PASTED input, and a newline inside a paste is a newline in the buffer
 * rather than a submit (genie#218). A ~180-character notice is comfortably over
 * that threshold, which is exactly how a nudge once landed in the prompt and
 * started no turn at all.
 */
describe('buildNudgeSequence', () => {
    const NOTICE = '[Genie] You just received a message from guardian as a DM.';

    it('an empty box: type the notice, then submit it as its own write', () => {
        const w = buildNudgeSequence({ mode: 'submit' }, NOTICE);
        expect(w.map((x) => x.bytes)).toEqual([NOTICE, '\r']);
        expect(w[0]!.delayMs).toBe(0);
        expect(w[1]!.delayMs).toBeGreaterThan(0);
    });

    it('uses the canonical PTY submit byte even after Codex reported enhanced Enter', () => {
        const codexKeyboardEnter = '\x1b[13;1u';
        const afterCodexSubmit = noteDraft(d({ text: 'previous prompt' }), codexKeyboardEnter);
        const w = buildNudgeSequence(planNudge(afterCodexSubmit), NOTICE);

        // CSI-u is xterm's encoding of a HUMAN key while enhanced-keyboard mode
        // is active. Automated PTY input uses the same canonical CR path as
        // runAgent send; replaying CSI-u can print "^[13u" into Codex instead.
        expect(w.map((x) => x.bytes)).toEqual([NOTICE, '\r']);

        // Positive control: Claude continues to submit with CR too.
        expect(buildNudgeSequence({ mode: 'submit' }, NOTICE)[1]!.bytes).toBe('\r');
    });

    it('a deferred nudge writes absolutely nothing into the prompt', () => {
        expect(buildNudgeSequence({ mode: 'defer' }, NOTICE)).toEqual([]);
    });

    it('every mode leaves the person a settle gap between writes', () => {
        for (const plan of [{ mode: 'submit' as const }]) {
            const w = buildNudgeSequence(plan, NOTICE);
            expect(w.slice(1).every((x) => x.delayMs > 0)).toBe(true);
        }
    });
});

/**
 * A key that cannot type is not a reason to stop nudging (genie#333).
 *
 * The owner watched "Send nudge" refuse over a visibly EMPTY input box, and keep
 * refusing. One bare Escape does it: `isHumanKey` counts a lone `\x1b` as a
 * human key, `noteDraft` drops confidence, and `planNudge` checks confidence
 * BEFORE the empty-box shortcut — so an empty box is refused until someone
 * happens to press Enter, Ctrl-C or Ctrl-U. Escape is how every dialog in a TUI
 * is dismissed, so the gate jams during ordinary use.
 *
 * The flag was built for a `swap` plan that cut the draft out and pasted it back,
 * which needed to know WHAT was in the box and WHERE the caret was. That plan is
 * gone — `NudgePlan` is `submit | defer` — so only one question is left: could
 * there be anything in the box at all? Keys that cannot put content into an
 * empty box no longer answer "maybe".
 *
 * THE INVARIANT, and the only one this model owes anyone: while `confident`,
 * `text === ''` implies the box is empty. `text` may over-state what is really
 * there (a kill or a word-delete shrinks the box and not the model), and that
 * only ever makes Genie more cautious.
 */
describe('noteDraft — keys that cannot type do not jam the gate', () => {
    const after = (...chunks: string[]): Draft =>
        chunks.reduce((s, c) => noteDraft(s, c), EMPTY_DRAFT);

    it('a bare Escape leaves an empty box nudgeable — the live symptom', () => {
        // Dismissing a `/mcp` dialog is one Escape, and it used to cost the
        // terminal every nudge for the rest of the session.
        expect(planNudge(after('\x1b'))).toEqual({ mode: 'submit' });
    });

    it('caret keys move through a box without changing what is in it', () => {
        for (const key of [
            '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F', // right, left, home, end
            '\x1bOC', '\x1bOD', '\x1bOH', '\x1bOF', // the same in application mode
            '\x1b[1~', '\x1b[4~', '\x1b[5~', '\x1b[6~', // home, end, page up/down
            '\x1b[3~', // delete — it can only take characters out
            '\x1b[1;5C', // ctrl-right: parameters do not change what the key does
            '\x01', '\x05', // ctrl-a, ctrl-e
        ]) {
            expect({ key, plan: planNudge(after(key)) }).toEqual({
                key,
                plan: { mode: 'submit' },
            });
        }
    });

    it('a caret key still costs confidence once Genie believes there IS text', () => {
        // POSITIVE CONTROL for the one real hole: after the caret moves, a
        // backspace deletes a character Genie cannot identify, so the model
        // would under-count and reach '' while the box still holds something.
        expect(planNudge(after('ab', '\x1b[D', '\x7f', '\x7f'))).toEqual({ mode: 'defer' });
        expect(after('ab', '\x1b[D').confident).toBe(false);
    });

    it('history recall still fails closed — it can put a whole command in the box', () => {
        expect(planNudge(after('\x1b[A'))).toEqual({ mode: 'defer' });
        expect(planNudge(after('\x1b[B'))).toEqual({ mode: 'defer' });
        expect(planNudge(after('\x1bOA'))).toEqual({ mode: 'defer' });
    });

    it('completion still fails closed — it inserts text Genie never saw', () => {
        expect(planNudge(after('\t'))).toEqual({ mode: 'defer' });
        // Shift-Tab is CSI Z, which `isHumanKey` does not match at all — so it
        // used to pass through as "the emulator answering a query" and left the
        // model claiming an empty box while a completion had been cycled into it.
        expect(planNudge(after('\x1b[Z'))).toEqual({ mode: 'defer' });
    });

    it('a key Genie cannot classify still fails closed', () => {
        expect(planNudge(after('\x12'))).toEqual({ mode: 'defer' }); // ctrl-r, reverse search
        expect(planNudge(after('\x19'))).toEqual({ mode: 'defer' }); // ctrl-y, yanks a kill back
        expect(planNudge(after('\x1bd'))).toEqual({ mode: 'defer' }); // alt-<key>
        expect(planNudge(after('\x1b[15~'))).toEqual({ mode: 'defer' }); // F5, bound to anything
    });

    it('typing is still typing — a real draft is never nudged over', () => {
        // POSITIVE CONTROL. Everything above widens what counts as an empty box;
        // this is the case that must not widen with it.
        expect(planNudge(after('deploy the thing'))).toEqual({ mode: 'defer' });
        expect(planNudge(after('\x1b', 'deploy the thing'))).toEqual({ mode: 'defer' });
        expect(planNudge(after('deploy', '\x1b'))).toEqual({ mode: 'defer' });
        expect(planNudge(after('\x16'))).toEqual({ mode: 'defer' }); // an image chip
    });
});

/**
 * The human's override.
 *
 * The model cannot see a TUI empty its own composer, and no amount of parsing
 * will change that — Genie is reading the bytes going IN. So the person who can
 * see the box gets to say so, and `clear-and-submit` is how they say it: a
 * kill-line first, which is not a guess but the one byte that both empties the
 * box and re-syncs the model ({@link CLEARS_LINE}).
 */
describe('buildNudgeSequence — clear-and-submit', () => {
    const NOTICE = '[Genie] You just received a message from guardian as a DM.';

    it('kills the line first, then types the notice and submits it', () => {
        const w = buildNudgeSequence({ mode: 'clear-and-submit' }, NOTICE);
        expect(w.map((x) => x.bytes)).toEqual(['\x15', NOTICE, '\r']);
        expect(w[0]!.delayMs).toBe(0);
        expect(w.slice(1).every((x) => x.delayMs > 0)).toBe(true);
    });

    it('is never what the automatic gate asks for', () => {
        // POSITIVE CONTROL: clearing someone's box is a human's call. Nothing
        // `planNudge` can return may destroy what is in there.
        for (const draft of [
            EMPTY_DRAFT,
            d({ text: 'deploy the thing' }),
            d({ text: '', confident: false }),
            d({ text: '', image: true }),
        ]) {
            expect(planNudge(draft).mode).not.toBe('clear-and-submit');
        }
    });
});
