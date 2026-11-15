import { deckBand, type DeckItem } from './deck.js';

/**
 * APPROVALS AS PERSISTENT LEFT TOASTS (Tynn #730; the owner, 2026-11-14: "everything that lands in the Deck waiting for
 * approval appears as a persistent toast on the left, with its action buttons … stays until answered or resolved
 * elsewhere, stacks when there are several, and never covers the chat input").
 *
 * Pure: what the stack holds and what each gesture does to it. The component (renderer/components/ApprovalToasts.tsx)
 * draws this and dispatches to it; nothing here touches the DOM. It supersedes the right-hand ring of 2026-10-15 (a
 * wheel-turned stack with Later); the Deck is a page no more (core/waiting.ts), so the toast is where an approval is answered.
 *
 * - WHAT TOASTS: every APPROVAL waiting on the person — the approval queue's requests (`appr_`, a gated Genie workflow),
 *   a provider's own permission request (`approval:<agent>`), and whatever approval comes next (Tynn's, #699): an agent's
 *   question with inline answers whose id is not `q_`. NOT a ForceTheQuestion (`q_`: it has its own window), a forwarded
 *   item (answered on its host), a stale one (its agent no longer waits), or mail and to-dos.
 * - ONE ACTIONABLE PLACE: the toast. The agent's page and its chat show a marker (agent-view.ts `approvalPlacement`); the
 *   Dashboard shows the item on its agent's row, as an item to open the agent, not a second set of buttons.
 * - ORDER: the Deck's own rank — blocking first, then priority, then the one waiting longest — so the first toast is the
 *   one most worth answering. Three are drawn; the rest are "+N more", which expands the stack to all of them.
 * - THEY NEVER EXPIRE. A toast leaves when its request leaves the snapshot: answered here, in the chat, on another device,
 *   cancelled, or swept by the queue's own timeout. Nothing here puts one off.
 * - DO NOT DISTURB (Settings → General, `do_not_disturb`): nothing pops; a request that arrives meanwhile waits on its
 *   agent's row, and turning DND off does not throw that backlog at the person — the question window's rule
 *   (main/question-window.ts), and Genie 1's.
 */

/** How many toasts are drawn before "+N more". */
export const TOAST_LIMIT = 3;
/** A toast's width and its distance from the page column's left and bottom edges, in px. */
export const TOAST_WIDTH = 372;
export const TOAST_GAP = 16;

/** An approval the toasts carry. */
export function isApprovalToast(item: DeckItem): boolean {
    return item.source === 'agent-question'
        && !item.id.startsWith('q_')
        && item.answer.kind === 'inline'
        && item.forwardedFrom === null
        && item.stale === undefined;
}

/** The toastable items, most worth answering first (the Deck's rank). */
const toastable = (items: readonly DeckItem[]): DeckItem[] => deckBand(items).filter(isApprovalToast);

export interface ToastState {
    /** Every approval id seen so far, so an arrival is told from a request that was already there. */
    readonly seen: readonly string[];
    /** Arrived while Do Not Disturb was on: never toasted, waiting on its agent's row. */
    readonly held: readonly string[];
    /** Pressed Allow / Deny; its buttons stop taking a second press until the request leaves. */
    readonly answering: readonly string[];
    /** "+N more" opened: every toast drawn. */
    readonly expanded: boolean;
}

export const EMPTY_TOASTS: ToastState = { seen: [], held: [], answering: [], expanded: false };

export type ToastEvent =
    | { kind: 'items'; items: readonly DeckItem[]; dnd: boolean }
    | { kind: 'expand'; on: boolean }
    | { kind: 'answering'; id: string };

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function toastReducer(state: ToastState, event: ToastEvent): ToastState {
    switch (event.kind) {
        case 'items': {
            const ids = toastable(event.items).map((i) => i.id);
            const present = new Set(ids);
            const arrivals = ids.filter((id) => !state.seen.includes(id));
            const held = [...state.held.filter((id) => present.has(id)), ...(event.dnd ? arrivals : [])];
            const answering = state.answering.filter((id) => present.has(id));
            const shownCount = ids.filter((id) => !held.includes(id)).length;
            // An expansion over a stack that fits is nothing: it folds away, so a later arrival starts collapsed.
            const expanded = state.expanded && shownCount > TOAST_LIMIT;
            const next: ToastState = { seen: ids, held, answering, expanded };
            // The same state back when nothing changed, so a re-render with an equal list is not a new state (no loop).
            return same(next.seen, state.seen) && same(next.held, state.held) && same(next.answering, state.answering) && next.expanded === state.expanded ? state : next;
        }
        case 'expand':
            return event.on === state.expanded ? state : { ...state, expanded: event.on };
        case 'answering':
            return state.answering.includes(event.id) ? state : { ...state, answering: [...state.answering, event.id] };
    }
}

/** What the stack draws. */
export interface ToastStackView {
    /** The toasts drawn, most worth answering first. */
    readonly shown: readonly DeckItem[];
    /** Every item id a toast carries (drawn, or behind "+N more"): where the agent's page and chat show a marker instead of buttons. */
    readonly ids: readonly string[];
    /** How many more are waiting behind "+N more" (0 when expanded or when everything fits). */
    readonly more: number;
    /** How many toasts there are in all. */
    readonly total: number;
    readonly expanded: boolean;
    /** Ids whose answer is in flight. */
    readonly answering: readonly string[];
}

export function toastView(state: ToastState, items: readonly DeckItem[]): ToastStackView {
    const all = toastable(items).filter((i) => !state.held.includes(i.id));
    const expanded = state.expanded && all.length > TOAST_LIMIT;
    const shown = expanded ? all : all.slice(0, TOAST_LIMIT);
    return { shown, ids: all.map((i) => i.id), more: all.length - shown.length, total: all.length, expanded, answering: state.answering };
}

/**
 * Where the stack sits INSIDE THE PAGE COLUMN (the main content, beside the rail and before the chat dock): bottom-left,
 * a margin from both edges, never wider than the column less its margins. The chat — and its input — is a column AFTER
 * the page, so a stack that stays inside the page column cannot reach it, at any width.
 */
export function toastBox(regionWidth: number): { left: number; bottom: number; width: number } {
    return { left: TOAST_GAP, bottom: TOAST_GAP, width: Math.max(0, Math.min(TOAST_WIDTH, regionWidth - 2 * TOAST_GAP)) };
}
