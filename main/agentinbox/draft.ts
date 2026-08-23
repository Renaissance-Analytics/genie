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
 * ## Confidence is the safety property
 *
 * A reconstruction that quietly drifts would be worse than none: restoring the
 * wrong text destroys what someone was writing. So the model carries its own
 * CONFIDENCE, and surrenders it the instant a keystroke arrives that Genie
 * cannot interpret — an arrow key (the cursor is now somewhere Genie does not
 * track), history recall, tab completion, a word-delete, an image paste. Once
 * lost, confidence stays lost until the box is emptied by a submit or an abort,
 * which is the one moment Genie knows the true state for certain.
 *
 * The owner's rule follows from it: swap only when CERTAIN. Otherwise Genie must
 * not touch what is there — it appends the notice WITHOUT submitting it and
 * warns the person, so nothing of theirs is ever lost.
 *
 * Pure so every branch is unit-tested.
 */
import { CR, PASTE_END, PASTE_START, PASTE_SUBMIT_DELAY_MS } from '../terminal/keystrokes';
import { isHumanKey, tokenize } from './notify';

export interface Draft {
    /** Genie's reconstruction of the box's contents. Meaningless unless
     *  {@link confident}. */
    text: string;
    /** Every keystroke since the box was last empty was one Genie could
     *  interpret, so {@link text} can be trusted enough to restore. */
    confident: boolean;
    /** An image chip is in the box. It cannot survive a text restore, so this
     *  rules out the swap even when the text is known. */
    image: boolean;
}

/** A box known to be empty — the only state Genie is certain of for free. */
export const EMPTY_DRAFT: Draft = { text: '', confident: true, image: false };

/** Bytes that submit or abandon the line, emptying the box: Enter (CR/LF),
 *  Ctrl-C (abort), Ctrl-U (kill line). */
const CLEARS_LINE = '\r\n\x03\x15';
/** Backspace, in both the encodings terminals send. */
const BACKSPACE = '\x7f\x08';
/** The renderer's image-attach gestures (see renderer/lib/terminal-image-paste). */
const IMAGE_TRIGGERS = ['\x16', '\x1bv'];

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
    const { literal, escapes } = tokenize(data);

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

    for (const esc of escapes) {
        if (IMAGE_TRIGGERS.includes(esc)) {
            image = true;
            confident = false;
        } else if (isHumanKey(esc)) {
            // A person pressed a navigation/function key: the cursor moved, or
            // history was recalled. Genie models neither.
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
        } else if (BACKSPACE.includes(ch)) {
            text = text.slice(0, -1);
        } else if (ch >= ' ' && ch !== '\x7f') {
            text += ch;
        } else {
            // Tab (completion may insert text Genie never saw), Ctrl-W (word
            // boundaries are the TUI's), Ctrl-A/E/K (cursor-relative), and every
            // other control byte: Genie is guessing from here.
            confident = false;
        }
    }

    return { text, confident, image };
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
 *  - `swap` — Genie knows the draft: cut it out, submit the notice, put the
 *    draft back. `restore` is the text to put back.
 *  - `append` — Genie is not certain. The notice is appended to whatever is
 *    there and NOT submitted, and the person is warned by a toast. Nothing of
 *    theirs is cut, so nothing can be lost.
 */
export type NudgePlan =
    | { mode: 'submit' }
    | { mode: 'swap'; restore: string }
    | { mode: 'append' };

/** One pty write, and the pause that must precede it. */
export interface NudgeWrite {
    bytes: string;
    /** Milliseconds to wait BEFORE this write. Zero for the first. */
    delayMs: number;
}

/** Ctrl-A then Ctrl-K: go to the start of the line, kill to the end. Readline's
 *  genuine "select all and cut", and the closest thing to a TUI-agnostic one —
 *  it works in Claude Code, Codex, bash and zsh alike. */
const CUT_LINE = '\x01\x0b';

/** Wrap text so a TUI takes it as pasted literal content: it lands in the box
 *  and cannot submit itself, whatever it contains. */
function bracketPaste(text: string): string {
    return `${PASTE_START}${text}${PASTE_END}`;
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
export function buildNudgeSequence(plan: NudgePlan, notice: string): NudgeWrite[] {
    const gap = PASTE_SUBMIT_DELAY_MS;
    if (plan.mode === 'append') {
        // Appended, never submitted: the person's draft keeps the box, the
        // notice sits behind it, and a toast tells them it is there.
        return [{ bytes: bracketPaste(notice), delayMs: 0 }];
    }
    const deliver: NudgeWrite[] = [
        { bytes: notice, delayMs: 0 },
        { bytes: CR, delayMs: gap },
    ];
    if (plan.mode === 'submit') return deliver;
    return [
        { bytes: CUT_LINE, delayMs: 0 },
        { ...deliver[0]!, delayMs: gap },
        deliver[1]!,
        // The draft goes back as a paste so it cannot submit itself on the way
        // in — it may well contain the newline that started this.
        { bytes: bracketPaste(plan.restore), delayMs: gap },
    ];
}

export function planNudge(draft: Draft): NudgePlan {
    // Confidence is checked FIRST, before the empty-box shortcut. "Genie's model
    // says empty" is not "the box is empty": the up-arrow that cost us
    // confidence may have recalled a whole command into it, and submitting then
    // would fire the person's history off as the notice's turn.
    // An image chip counts as content for the same reason.
    if (!draft.confident || draft.image) return { mode: 'append' };
    if (draft.text === '') return { mode: 'submit' };
    // The cut is Ctrl-A then Ctrl-K — a SINGLE-line operation. On a multi-line
    // draft it would kill one line and leave the rest, so don't cut at all.
    if (draft.text.includes('\n')) return { mode: 'append' };
    return { mode: 'swap', restore: draft.text };
}
