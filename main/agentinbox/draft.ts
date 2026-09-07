/**
 * What Genie believes is sitting in an agent terminal's input box, and what it
 * is therefore allowed to do with an incoming notice (owner, JOB 2).
 *
 * ## Why a model at all
 *
 * Genie cannot read a TUI's input box. The draft lives inside Claude Code or
 * Codex, and there is no keystroke that makes a TUI hand its buffer over — the
 * only way out would be a select-all-and-copy binding emitting OSC 52, which
 * neither has. All Genie has is the keystrokes it already receives on
 * `terminal:write`, so it reconstructs the box from those.
 *
 * ## Confidence is the safety property, and it answers exactly one question
 *
 * A reconstruction that quietly drifts would be worse than none: typing into a
 * box that is not empty fires whatever is in there as the notice's turn. So the
 * model carries its own CONFIDENCE, and this is the whole of what it promises:
 *
 *   **While `confident`, `text === ''` means the box is empty.**
 *
 * Nothing more. `text` may OVER-state what is really there — a kill or a
 * word-delete shrinks the box and not the model — and that is safe in the only
 * direction that matters, because it makes Genie more cautious rather than less.
 * Confidence is surrendered by the keystrokes that could put content Genie never
 * saw into an empty box: history recall, completion, an image paste, and
 * anything Genie cannot classify.
 *
 * It used to promise much more, because it had to. The plan it served could
 * `swap` — cut the draft out, submit the notice, paste the draft back — which
 * needed the exact text AND the caret position, so every key that moved the
 * caret cost confidence too. That plan is gone; {@link NudgePlan} is `submit` or
 * `defer`. What was left behind was a model that answered a question nobody asks
 * with a caution nobody could clear: one bare Escape — how every dialog in a TUI
 * is dismissed — refused every nudge at that terminal until someone happened to
 * press Enter, Ctrl-C or Ctrl-U (genie#333).
 *
 * Pure so every branch is unit-tested.
 */
import { CR, PASTE_SUBMIT_DELAY_MS } from '../terminal/keystrokes';
import { isHumanKey, tokenize } from './notify';

export interface Draft {
    /** Genie's reconstruction of the box's contents — an UPPER BOUND, not a
     *  transcript. Meaningless unless {@link confident}, and even then it may
     *  hold characters a kill or a word-delete has already taken out of the box. */
    text: string;
    /** Nothing has arrived that could put content into the box Genie did not
     *  see, so an EMPTY {@link text} means an empty box. */
    confident: boolean;
    /** An image chip is in the box. Genie cannot see it and cannot remove it,
     *  and submitting would fire it as the notice's turn — so it counts as
     *  content however empty {@link text} looks. */
    image: boolean;
}

/** A box known to be empty — the only state Genie is certain of for free. */
export const EMPTY_DRAFT: Draft = { text: '', confident: true, image: false };

/** Ctrl-U — kill line. Readline's, and the closest thing to a TUI-agnostic
 *  "empty the box": it works in Claude Code, Codex, bash and zsh alike. */
export const KILL_LINE = '\x15';
/** Bytes that submit or abandon the line, emptying the box: Enter (CR/LF),
 *  Ctrl-C (abort), Ctrl-U (kill line). */
const CLEARS_LINE = `\r\n\x03${KILL_LINE}`;
/** Backspace, in both the encodings terminals send. */
const BACKSPACE = '\x7f\x08';
/** The renderer's image-attach gestures (see renderer/lib/terminal-image-paste). */
const IMAGE_TRIGGERS = ['\x16', '\x1bv'];
/** Ctrl-A and Ctrl-E: readline's line-start and line-end. They move the caret
 *  and nothing else. */
const MOVES_CARET = '\x01\x05';

/**
 * Escapes that cannot put anything into the box — they move the caret, dismiss
 * something, or take a character out.
 *
 * The list is a WHITELIST and stays one: anything not named here keeps failing
 * closed, which is what a key Genie has never seen before deserves.
 *
 *  - `\x1b` alone is Escape: it closes menus and interrupts. It cannot type.
 *    (A split escape sequence arrives here as a bare `\x1b` and then a literal
 *    tail like `[A`, which lands in {@link Draft.text} — so a chunk boundary
 *    makes the model MORE cautious, never less.)
 *  - CSI/SS3 `C` `D` `H` `F` and `1~` `4~` `5~` `6~` are left, right, home, end
 *    and the page keys. `3~` is Delete, which only removes.
 *
 * Up and Down (`A`/`B`) are deliberately absent: they recall history, which is
 * how a whole command lands in a box Genie thinks is empty.
 */
function cannotType(esc: string): boolean {
    if (esc === '\x1b') return true;
    if (/^\x1b\[[0-9;]*[CDHF]$/.test(esc)) return true;
    if (/^\x1bO[CDHF]$/.test(esc)) return true;
    return /^\x1b\[[13456]~$/.test(esc);
}

/**
 * Escapes that CAN insert content Genie never saw, and so must always fail
 * closed — even the ones `isHumanKey` does not recognise.
 *
 * Shift-Tab is the reason this is not simply "everything `isHumanKey` matches".
 * It arrives as CSI Z, which that predicate does not match, so it used to pass
 * through as the emulator answering a query — leaving the model claiming an
 * empty box while a completion had been cycled into it. That is the model
 * failing OPEN, which is the failure that types over someone's work.
 */
function insertsUnseenContent(esc: string): boolean {
    return esc === '\x1b[Z';
}

/**
 * Fold one chunk of `terminal:write` bytes into the model.
 *
 * The emulator's own replies — cursor-position reports, device attributes,
 * Genie's OSC 52 clipboard answer — pass through with no effect at all: they are
 * not the person typing, and treating them as input is exactly the mistake that
 * once jammed the draft guard permanently.
 */
export function noteDraft(draft: Draft, data: string): Draft {
    if (!data) return draft;

    let { text, confident, image } = draft;

    // A bracketed paste is literal content, so its body belongs in the text and
    // its markers must not be read as cursor keys. tokenize() hands the markers
    // back as escapes, so reassemble by walking the original chunk instead.
    const parts = splitPaste(data);
    if (parts) {
        let next: Draft = { text, confident, image };
        for (const p of parts) {
            next = p.pasted
                ? { ...next, text: next.text + p.body }
                : noteDraft(next, p.body);
        }
        return next;
    }

    // Codex enables the Kitty enhanced-keyboard protocol on terminals that
    // support it. Plain Enter is then CSI 13 u (optionally spelling out the
    // default modifier/event fields) instead of CR, but it has the same
    // semantic guarantee for this model: the prompt was submitted and the box
    // is empty. Normalize only an unmodified press/repeat. Shift+Enter is a
    // newline in Codex and must keep the fail-safe closed.
    data = normalizeSubmittingEnter(data);
    const { literal, escapes } = tokenize(data);

    for (const esc of escapes) {
        if (IMAGE_TRIGGERS.includes(esc)) {
            image = true;
            confident = false;
        } else if (insertsUnseenContent(esc)) {
            confident = false;
        } else if (cannotType(esc)) {
            // The caret moved, or a dialog was dismissed. Neither can add
            // anything, so an empty box is still an empty box — but once Genie
            // believes there IS text, a moved caret makes the next backspace
            // delete a character Genie cannot identify, and the model would
            // count its way down to '' while the box still held something.
            if (text !== '') confident = false;
        } else if (isHumanKey(esc)) {
            // History recall, a function key bound to who-knows-what, Alt-<key>:
            // any of them can put content in the box that Genie never saw.
            confident = false;
        }
        // Anything else is the emulator answering a query — not input.
    }

    for (const ch of literal) {
        if (CLEARS_LINE.includes(ch)) {
            // The one moment the true state is known: the box is empty.
            text = '';
            confident = true;
            image = false;
        } else if (IMAGE_TRIGGERS.includes(ch)) {
            image = true;
            confident = false;
        } else if (MOVES_CARET.includes(ch)) {
            if (text !== '') confident = false;
        } else if (BACKSPACE.includes(ch)) {
            text = text.slice(0, -1);
        } else if (ch >= ' ' && ch !== '\x7f') {
            text += ch;
        } else {
            // Tab (completion may insert text Genie never saw), Ctrl-R (reverse
            // search pulls a command in), Ctrl-Y (yanks a kill back), Ctrl-W and
            // Ctrl-K (the TUI's own word and line boundaries), and every other
            // control byte: Genie is guessing from here.
            confident = false;
        }
    }

    return { text, confident, image };
}

function normalizeSubmittingEnter(data: string): string {
    return data.replace(
        /\x1b\[13(?::13){0,2}(?:;1(?::[12])?)?u/g,
        '\r',
    );
}

/** Split a chunk around bracketed-paste markers, or null when it has none. */
function splitPaste(data: string): { body: string; pasted: boolean }[] | null {
    if (!data.includes('\x1b[200~')) return null;
    const out: { body: string; pasted: boolean }[] = [];
    let rest = data;
    while (rest.length > 0) {
        const start = rest.indexOf('\x1b[200~');
        if (start < 0) {
            out.push({ body: rest, pasted: false });
            break;
        }
        if (start > 0) out.push({ body: rest.slice(0, start), pasted: false });
        const after = rest.slice(start + 6);
        const end = after.indexOf('\x1b[201~');
        if (end < 0) {
            out.push({ body: after, pasted: true });
            break;
        }
        out.push({ body: after.slice(0, end), pasted: true });
        rest = after.slice(end + 6);
    }
    return out;
}

/**
 * How a notice may be delivered to this box.
 *
 *  - `submit` — the box is empty, so the notice is simply typed and submitted,
 *    which is what starts the agent's turn.
 *  - `defer` — Genie is not certain the box is empty. Nothing is typed at all;
 *    the notice is parked and the person is shown a banner.
 *  - `clear-and-submit` — a PERSON has looked at the box and said to go ahead.
 *    The line is killed first, then the notice is typed and submitted.
 *
 * Only the first two are decisions Genie makes. {@link planNudge} can never
 * return `clear-and-submit`: it destroys whatever is in the box, so it comes
 * from a human hand or not at all.
 */
export type NudgePlan =
    | { mode: 'submit' }
    | { mode: 'defer' }
    | { mode: 'clear-and-submit' };

/** One pty write, and the pause that must precede it. */
export interface NudgeWrite {
    bytes: string;
    /** Milliseconds to wait BEFORE this write. Zero for the first. */
    delayMs: number;
}

/**
 * Turn a plan into the ordered pty writes that carry it out.
 *
 * Every write after the first is separated by a settle gap, and that is
 * load-bearing rather than cosmetic. A TUI treats a chunk arriving all at once
 * as PASTED input, and a newline inside a paste is a newline in the buffer, not
 * a submit (genie#218) — which is exactly how a ~180-character notice once
 * landed in the prompt and started no turn at all. So the submitting Enter is
 * always its own write.
 */
export function buildNudgeSequence(
    plan: NudgePlan,
    notice: string,
): NudgeWrite[] {
    if (plan.mode === 'defer') return [];
    const gap = PASTE_SUBMIT_DELAY_MS;
    return [
        // Ctrl-U — the same byte a person would press, and the same one
        // `noteDraft` already reads as "the box is empty now". So the clear is
        // not a guess Genie has to remember it made: it is the model's own
        // truth-restoring signal, sent out loud.
        ...(plan.mode === 'clear-and-submit'
            ? [{ bytes: KILL_LINE, delayMs: 0 }]
            : []),
        { bytes: notice, delayMs: plan.mode === 'clear-and-submit' ? gap : 0 },
        // Automated PTY input follows the same stable submit contract as
        // runAgent send. CSI-u is xterm's encoding of a human keypress and is
        // useful for modelling the draft, but replaying it can print literally.
        { bytes: CR, delayMs: gap },
    ];
}

export function planNudge(draft: Draft): NudgePlan {
    // Confidence is checked FIRST, before the empty-box shortcut. "Genie's model
    // says empty" is not "the box is empty": the up-arrow that cost us
    // confidence may have recalled a whole command into it, and submitting then
    // would fire the person's history off as the notice's turn.
    // An image chip counts as content for the same reason.
    if (!draft.confident || draft.image) return { mode: 'defer' };
    if (draft.text === '') return { mode: 'submit' };
    return { mode: 'defer' };
}
