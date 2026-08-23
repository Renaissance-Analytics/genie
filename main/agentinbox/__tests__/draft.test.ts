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
        expect(EMPTY_DRAFT).toEqual({ text: '', confident: true, image: false });
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

    it('a confident single-line draft is cut, nudged, and restored', () => {
        expect(planNudge(d({ text: 'deploy the thing' }))).toEqual({
            mode: 'swap',
            restore: 'deploy the thing',
        });
    });

    it('an unconfident draft is appended to, never cut', () => {
        expect(planNudge(d({ text: 'deploy', confident: false }))).toEqual({ mode: 'append' });
    });

    it('a MULTI-LINE draft is appended to, because the cut only kills one line', () => {
        // Ctrl-A/Ctrl-K is a single-line operation; cutting a multi-line draft
        // would leave part of it behind and lose the rest.
        expect(planNudge(d({ text: 'first\nsecond' }))).toEqual({ mode: 'append' });
    });

    it('an image in the box is appended to — a text restore cannot bring it back', () => {
        expect(planNudge(d({ text: '', image: true, confident: false }))).toEqual({
            mode: 'append',
        });
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

    it('a swap: cut the line, deliver and submit the notice, then paste the draft back', () => {
        const w = buildNudgeSequence({ mode: 'swap', restore: 'deploy the thing' }, NOTICE);
        expect(w.map((x) => x.bytes)).toEqual([
            '\x01\x0b', // Ctrl-A to the start, Ctrl-K kills to the end
            NOTICE,
            '\r',
            '\x1b[200~deploy the thing\x1b[201~',
        ]);
    });

    it('the restored draft is bracket-pasted, so it can never submit itself', () => {
        const w = buildNudgeSequence({ mode: 'swap', restore: 'rm -rf something' }, NOTICE);
        const restore = w[w.length - 1]!;
        expect(restore.bytes.startsWith('\x1b[200~')).toBe(true);
        expect(restore.bytes.endsWith('\x1b[201~')).toBe(true);
        expect(restore.bytes).not.toContain('\r');
    });

    it('an append: paste the notice in, and NEVER submit', () => {
        const w = buildNudgeSequence({ mode: 'append' }, NOTICE);
        expect(w).toHaveLength(1);
        expect(w[0]!.bytes).toBe('\x1b[200~' + NOTICE + '\x1b[201~');
        expect(w.some((x) => x.bytes.includes('\r'))).toBe(false);
    });

    it('every mode leaves the person a settle gap between writes', () => {
        for (const plan of [
            { mode: 'submit' as const },
            { mode: 'swap' as const, restore: 'x' },
        ]) {
            const w = buildNudgeSequence(plan, NOTICE);
            expect(w.slice(1).every((x) => x.delayMs > 0)).toBe(true);
        }
    });
});
