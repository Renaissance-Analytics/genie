import type { DeckItem } from './deck.js';

/**
 * APPROVAL REQUESTS AS STACKED TOASTS (the owner, 2026-10-15): "I should not have to go to the deck to respond to every
 * single thing an agent needs. Approval requests that trigger a genie workflow like setting up a site or DB, etc, need
 * to be Toasts that stack gracefully (let them stack behind each other with slight top offset and when hovering over the
 * stack the user can scroll the mouse to review each request. this will let the user stagger operations if they need to"
 *
 * Pure: what the stack holds, which one is in front, and what each gesture does to it. The component
 * (renderer/components/ApprovalToasts.tsx) draws this and dispatches to it; nothing here touches the DOM.
 *
 * - WHAT TOASTS: the approval queue's requests (main/approval-queue.ts, ids `appr_`) — the gated Genie workflows an
 *   agent asked for: services add/remove, sites add/update/remove, processes add/remove, terminal create/write. The
 *   SAME Deck items the Deck lists, so there is one list and one way to answer it (core/deck-resolve.ts): answered in
 *   either place, the item leaves the snapshot and both. A provider's own permission request (`approval:<agent>`) is
 *   answered where its composer is (ApprovalCard) and is not a toast; a question (`q_`) has the question window.
 * - ORDER: newest in front, the rest behind it. Scrolling or an arrow key brings the next one to the front; the order
 *   is a ring, so scrolling past the oldest comes back to the newest. The turning itself is Fancy's (Toast.Stack,
 *   react-fancy 5.41, built at Genie's request): it reports the new front, and that is the `front` event here.
 * - THE FRONT NEVER CHANGES UNDER THE PERSON: while the pointer is over the stack (or focus is in it) a new arrival
 *   joins BEHIND the one they are reading — an Allow pressed a moment after a new toast landed must still answer the
 *   request that was read. At rest, a new arrival comes to the front.
 * - STAGGERING: the one answered (or put off) leaves, and the one that was behind it comes forward.
 * - THEY NEVER EXPIRE. A toast leaves when its request is answered (here or in the Deck), put off with Later, or gone
 *   from the queue (cancelled on quit, swept after the queue's own timeout). Later keeps it in the Deck only.
 * - DO NOT DISTURB (Settings → General, `do_not_disturb`): nothing pops; a request that arrives meanwhile waits in the
 *   Deck, and turning DND off does not throw that backlog at the person — the question window's rule
 *   (main/question-window.ts), and Genie 1's (genie main/ask/force-question.ts: under DND "the modal never popped").
 */

/** How many toasts are drawn in the stack (the front one and two behind); Fancy counts the rest as "+N". */
export const TOAST_DEPTH = 3;

/** An approval the toasts carry: the approval queue's own, answered here by Allow / Deny. */
export function isApprovalToast(item: DeckItem): boolean {
    return item.source === 'agent-question' && item.id.startsWith('appr_') && item.answer.kind === 'inline' && item.forwardedFrom === null;
}

export interface ToastState {
    /** Every approval id seen so far, so an arrival is told from a request that was already there. */
    readonly seen: readonly string[];
    /** Deck only: put off with Later, or arrived while Do Not Disturb was on. */
    readonly held: readonly string[];
    /** Pressed Allow / Deny; its buttons stop taking a second press until the request leaves. */
    readonly answering: readonly string[];
    /** The toastable ids, newest first — the ring the stack turns. */
    readonly order: readonly string[];
    /** The one brought to the front; `null` = the newest. */
    readonly frontId: string | null;
    /** The pointer is over the stack, or focus is in it. */
    readonly engaged: boolean;
}

export const EMPTY_TOASTS: ToastState = { seen: [], held: [], answering: [], order: [], frontId: null, engaged: false };

export type ToastEvent =
    | { kind: 'items'; items: readonly DeckItem[]; dnd: boolean }
    | { kind: 'cycle'; by: number }
    /** Fancy's new front: an index into the ring (it wraps both ways). */
    | { kind: 'front'; index: number }
    | { kind: 'engage'; on: boolean }
    | { kind: 'later'; id: string }
    | { kind: 'answering'; id: string };

const newestFirst = (a: DeckItem, b: DeckItem): number => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const mod = (n: number, m: number): number => ((n % m) + m) % m;

/** Where the stack stands in its ring: the front's index in `order` (0 = the newest). */
export function frontIndex(state: ToastState): number {
    if (state.order.length === 0) return 0;
    const at = state.frontId === null ? -1 : state.order.indexOf(state.frontId);
    return at < 0 ? 0 : at;
}

/**
 * The one that comes forward when `gone` leaves the ring: the next one behind it that is still there — the person
 * staggering through the stack keeps their place — else the newest.
 */
function successor(prevOrder: readonly string[], gone: string, nextOrder: readonly string[]): string | null {
    const at = prevOrder.indexOf(gone);
    if (at < 0) return null;
    const keep = new Set(nextOrder);
    return prevOrder.slice(at + 1).find((id) => keep.has(id)) ?? null;
}

function withOrder(state: ToastState, order: readonly string[], frontOverride?: string | null): ToastState {
    let frontId = frontOverride === undefined ? state.frontId : frontOverride;
    if (frontId !== null && !order.includes(frontId)) frontId = successor(state.order, frontId, order);
    return { ...state, order, frontId };
}

export function toastReducer(state: ToastState, event: ToastEvent): ToastState {
    switch (event.kind) {
        case 'items': {
            const toastable = event.items.filter(isApprovalToast);
            const ids = new Set(toastable.map((i) => i.id));
            const arrivals = toastable.filter((i) => !state.seen.includes(i.id)).map((i) => i.id);
            const seen = toastable.map((i) => i.id);
            const held = [...state.held.filter((id) => ids.has(id)), ...(event.dnd ? arrivals : [])];
            const answering = state.answering.filter((id) => ids.has(id));
            const order = toastable.filter((i) => !held.includes(i.id)).sort(newestFirst).map((i) => i.id);
            // At rest, a new arrival comes to the front; engaged, it joins behind the one being read.
            const popped = arrivals.some((id) => order.includes(id));
            let next = withOrder(state, order, popped && !state.engaged ? null : undefined);
            next = { ...next, seen, held, answering };
            const unchanged = same(next.seen, state.seen) && same(next.held, state.held) && same(next.answering, state.answering) && same(next.order, state.order) && next.frontId === state.frontId;
            // The same state back when nothing changed, so a re-render with an equal list is not a new state (no loop).
            return unchanged ? state : next;
        }
        case 'cycle': {
            if (state.order.length === 0 || event.by === 0) return state;
            const frontId = state.order[mod(frontIndex(state) + Math.trunc(event.by), state.order.length)]!;
            return frontId === state.frontId ? state : { ...state, frontId };
        }
        case 'front': {
            if (state.order.length === 0) return state;
            const frontId = state.order[mod(Math.trunc(event.index), state.order.length)]!;
            return frontId === state.frontId ? state : { ...state, frontId };
        }
        case 'engage': {
            if (event.on === state.engaged) return state;
            // Engaging pins what is in front now, so an arrival cannot replace it under the pointer.
            return event.on ? { ...state, engaged: true, frontId: state.frontId ?? state.order[0] ?? null } : { ...state, engaged: false };
        }
        case 'later': {
            if (state.held.includes(event.id) || !state.order.includes(event.id)) return state;
            const order = state.order.filter((id) => id !== event.id);
            return { ...withOrder(state, order), held: [...state.held, event.id] };
        }
        case 'answering':
            return state.answering.includes(event.id) ? state : { ...state, answering: [...state.answering, event.id] };
    }
}

/** What the stack draws. */
export interface ToastStackView {
    /** Every toast, newest first — the ring Fancy's stack turns. */
    readonly ring: readonly DeckItem[];
    /** The front one's index in `ring`. */
    readonly front: number;
    /** How many toasts the stack holds. */
    readonly total: number;
    /** The front one's place in the ring, from 1 (the newest). */
    readonly position: number;
    /** Ids whose answer is in flight. */
    readonly answering: readonly string[];
}

export function toastView(state: ToastState, items: readonly DeckItem[]): ToastStackView {
    const byId = new Map(items.filter(isApprovalToast).map((i) => [i.id, i]));
    const ring = state.order.filter((id) => byId.has(id));
    const total = ring.length;
    if (total === 0) return { ring: [], front: 0, total: 0, position: 0, answering: [] };
    const front = Math.max(0, ring.indexOf(state.order[frontIndex(state)]!));
    return { ring: ring.map((id) => byId.get(id)!), front, total, position: front + 1, answering: state.answering };
}

