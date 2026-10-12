import type { Approval } from './approval.js';
import { LANES, type Lane } from './stream-view.js';

/**
 * KEYS — §4.2's single-letter shortcuts, as pure decisions.
 *
 * > **An unmodified letter must never act while a human is typing.**
 *
 * Everything here is a function of a plain description of the keypress, so the rule above is
 * proven in `test/keys.test.ts` without a DOM. The renderer's one `keydown` listener translates
 * the event into that description and acts on the answer; it decides nothing itself.
 *
 * The map, from §4.2:
 *
 *   j / k   stream cursor                     ↵   open/close the Inspector
 *   Esc     close the Inspector FIRST, and only then leave for the Deck
 *   t       toggle the Thought lane (the one letter; no other lane gets one)
 *   a / d   allow / deny the parked approval  E   next edit
 *   ⌘⇧T     Take Over — the ONE chord; Meta on macOS, Ctrl elsewhere, Shift on both
 *
 * Not bound here: `L` (the Lanes pulldown — Lanes is always visible in this build), `/` (find
 * in stream — not built), `⌘↵` (the composer's, in the chat flyout). Each is a deliberate
 * addition with its own test when it comes, never a fall-through.
 */

/** The shape of an event target this module cares about. `null` when the event has none. */
export interface TargetLike {
    tagName: string;
    isContentEditable?: boolean | undefined;
}

/** Is a key pressed on this target TEXT rather than a command? */
export function isTypingTarget(target: TargetLike | null): boolean {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface KeyPress {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    /** The result of {@link isTypingTarget} for the event's target. */
    typing: boolean;
}

/**
 * Keys that work on EVERY surface — chords, so they work while typing. ⌘B / Ctrl+B toggles the workspace file panel
 * (§4.3); ⌘J / Ctrl+J toggles the chat flyout on genie (the board's `Chat ⌘J`).
 */
export type GlobalAction = 'toggle-files' | 'toggle-chat';

export function globalAction(press: KeyPress): GlobalAction | null {
    const chord = (press.metaKey || press.ctrlKey) && !press.altKey && !press.shiftKey;
    if (chord && (press.key === 'b' || press.key === 'B')) return 'toggle-files';
    if (chord && (press.key === 'j' || press.key === 'J')) return 'toggle-chat';
    return null;
}

export type ChatAction = 'close-chat';

/**
 * The chat flyout's keys (§4.4). `Esc` closes an UNPINNED flyout — nothing underneath moved, so nothing has to move
 * back. **`Esc` does not close a pinned dock**: a pin says this panel stays. Never while typing: an `Esc` in the
 * composer is the composer's (it blurs), not a command to close the conversation someone is mid-sentence in.
 */
export function chatAction(press: KeyPress, chat: { open: boolean; pinned: boolean }): ChatAction | null {
    if (!chat.open || chat.pinned || press.typing) return null;
    if (press.key === 'Escape' && !press.metaKey && !press.ctrlKey && !press.altKey && !press.shiftKey) return 'close-chat';
    return null;
}

export type AgentViewAction =
    | 'next-edit'
    | 'next-row'
    | 'prev-row'
    | 'toggle-inspector'
    | 'escape'
    | 'toggle-thoughts'
    | 'allow'
    | 'deny'
    | 'take-over';

/**
 * What a key means in the Agent view, or `null`.
 *
 * `null` for anything unbound and for anything modified — a modifier means the key belongs to
 * the OS or the browser (Ctrl+E, ⌘E). While TYPING every letter is text and answers `null`;
 * the one exception is `Escape`, which in a field means "stop typing" and is reported so the
 * handler can blur rather than navigate — the decision stays the handler's.
 *
 * `⌘⇧T` is the one CHORD, and it is decided before the modifier rule because it is the rule's
 * complement: a modified key is the OS's unless §4.2 claims it, and §4.2 claims exactly this
 * one. A chord is not a letter, so it acts while typing too — the composer must not swallow
 * the shortcut that opens the Take Over window. Meta is the ⌘ of macOS; Ctrl stands in for it
 * elsewhere; Alt on top makes it something else, so it answers `null`.
 */
export function agentViewAction(press: KeyPress): AgentViewAction | null {
    if ((press.key === 't' || press.key === 'T') && press.shiftKey && (press.metaKey || press.ctrlKey) && !press.altKey) {
        return 'take-over';
    }
    if (press.ctrlKey || press.metaKey || press.altKey) return null;
    if (press.key === 'Escape') return 'escape';
    if (press.typing) return null;

    switch (press.key) {
        case 'e':
        case 'E':
            return 'next-edit';
        case 'j':
        case 'J':
            return 'next-row';
        case 'k':
        case 'K':
            return 'prev-row';
        case 'Enter':
            return 'toggle-inspector';
        case 't':
        case 'T':
            return 'toggle-thoughts';
        case 'a':
        case 'A':
            return 'allow';
        case 'd':
        case 'D':
            return 'deny';
        default:
            return null;
    }
}

/**
 * `j` / `k` — the stream cursor, over the VISIBLE rows' ids.
 *
 * Stops at the ends rather than wrapping: a cursor that teleports is disorienting. (`E` wraps,
 * because `E` is a search — "find me the next one" — and a cursor is not.) From nothing
 * selected, `j` enters at the top and `k` at the bottom. A selection that is no longer visible
 * — filtered out by a lane or range change — is treated as nothing selected, so the cursor
 * re-enters at the edge the key points at rather than stepping from nowhere.
 */
export function stepRow(visibleIds: readonly string[], currentId: string | null, direction: 'next' | 'prev'): string | null {
    if (visibleIds.length === 0) return null;
    const index = currentId === null ? -1 : visibleIds.indexOf(currentId);

    if (index === -1) return direction === 'next' ? (visibleIds[0] ?? null) : (visibleIds[visibleIds.length - 1] ?? null);
    const next = direction === 'next' ? Math.min(index + 1, visibleIds.length - 1) : Math.max(index - 1, 0);
    return visibleIds[next] ?? null;
}

/**
 * `t` — toggle the Thought lane, and ONLY that lane.
 *
 * From not filtering (`null`), the common wish is to hide thoughts, so that is what the first
 * press does. Every other transition adds or removes `thoughts` from the selection and leaves
 * the rest alone; a selection that becomes all four lanes is recorded as not filtering, the
 * same one-state-for-one-view rule the lane toggles follow.
 */
export function toggleThoughts(lanes: readonly Lane[] | null): readonly Lane[] | null {
    if (lanes === null) return LANES.filter((l) => l !== 'thoughts');
    const next = lanes.includes('thoughts') ? lanes.filter((l) => l !== 'thoughts') : [...lanes, 'thoughts' as const];
    return next.length === LANES.length ? null : next;
}

/**
 * `a` / `d` — which option a single letter answers with.
 *
 * The FIRST option of the matching tone: the least-committal allow, the least-committal deny.
 * `null` when nothing is parked, and `null` when no option carries that tone — a request whose
 * options are all `neutral` (kinds the protocol table did not recognise) cannot be answered by
 * a letter, because guessing would send the provider a decision nobody made.
 */
export function approvalChoice(approval: Approval | null, which: 'allow' | 'deny'): string | null {
    if (!approval) return null;
    const tone = which === 'allow' ? 'ok' : 'bad';
    return approval.options.find((o) => o.tone === tone)?.id ?? null;
}
