import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { EMPTY_TOASTS, TOAST_GAP, TOAST_LIMIT, TOAST_WIDTH, isApprovalToast, toastBox, toastReducer, toastView, type ToastEvent, type ToastState } from '../src/core/approval-toasts.js';

/**
 * APPROVALS AS PERSISTENT LEFT TOASTS (Tynn #730; the owner, 2026-11-14): everything in the Deck waiting for an approval is
 * a toast, stacked bottom-left, up to three drawn plus "+N more" that expands. It stays until answered — here, in the
 * agent's chat, or on another device — and then it leaves. Names are RFC 2606 fixtures.
 */
const T0 = 1_760_000_000_000;
const OPTIONS = [{ id: 'allow', label: 'Allow', tone: 'ok' as const }, { id: 'deny', label: 'Deny', tone: 'bad' as const }];

function approval(n: number, over: Partial<DeckItem> = {}): DeckItem {
    return {
        id: `appr_${n}`, source: 'agent-question', agentId: `a_${n}`, agentName: `agent${n}`, workspaceId: 'ws_shop', workspaceName: 'shop.example',
        title: `agent${n} wants to add a service`, blocking: true, priority: 'high', at: T0 + n * 1_000,
        answer: { kind: 'inline', options: OPTIONS }, forwardedFrom: null, ...over,
    };
}
const run = (events: ToastEvent[], from: ToastState = EMPTY_TOASTS): ToastState => events.reduce(toastReducer, from);
const items = (n: number): DeckItem[] => Array.from({ length: n }, (_, i) => approval(i + 1));

describe('which Deck items are toasts', () => {
    it('every approval — the queue’s (`appr_`), a provider’s own permission (`approval:`) — and nothing else', () => {
        const all: DeckItem[] = [
            approval(1),
            approval(2, { id: 'approval:agent_x' }),
            approval(3, { id: 'q_1', answer: { kind: 'form', fields: 1 } }),
            approval(4, { id: 'q_2' }),
            approval(5, { forwardedFrom: 'host.example' }),
            approval(6, { stale: 'agent-gone' }),
            approval(7, { id: 'msg_1', source: 'unread-dm' }),
        ];
        // COUNTED. A ForceTheQuestion (even a one-click one) has its own window; a forwarded one is answered on its host;
        // a stale one's agent no longer waits.
        expect(all.filter(isApprovalToast).map((i) => i.id)).toEqual(['appr_1', 'approval:agent_x']);
    });
});

describe('the stack: up to three, then "+N more"', () => {
    it('3 or fewer: every one drawn, nothing more', () => {
        const view = toastView(run([{ kind: 'items', items: items(3), dnd: false }]), items(3));
        expect(TOAST_LIMIT).toBe(3);
        expect(view.shown).toHaveLength(3);
        expect(view.more).toBe(0);
        expect(view.total).toBe(3);
    });

    it('5 waiting: three drawn and "+2 more"; the most urgent first (blocking, priority, oldest)', () => {
        const five = [...items(5), approval(6, { blocking: false, priority: 'low', at: T0 - 1_000_000 })];
        const view = toastView(run([{ kind: 'items', items: five, dnd: false }]), five);
        expect(view.shown.map((i) => i.id)).toEqual(['appr_1', 'appr_2', 'appr_3']);
        expect(view.more).toBe(3);
        expect(view.total).toBe(6);
    });

    it('"+N more" expands to every toast, and collapses back; CONTROL: nothing to expand at 3', () => {
        const five = items(5);
        let state = run([{ kind: 'items', items: five, dnd: false }]);
        state = toastReducer(state, { kind: 'expand', on: true });
        let view = toastView(state, five);
        expect(view.expanded).toBe(true);
        expect(view.shown).toHaveLength(5);
        expect(view.more).toBe(0);
        state = toastReducer(state, { kind: 'expand', on: false });
        view = toastView(state, five);
        expect(view.shown).toHaveLength(3);
        expect(view.more).toBe(2);
        // Answering down to three folds the expansion away: it never reads "expanded" over a stack that fits.
        const three = items(3);
        const folded = toastReducer(toastReducer(run([{ kind: 'items', items: five, dnd: false }]), { kind: 'expand', on: true }), { kind: 'items', items: three, dnd: false });
        expect(toastView(folded, three).expanded).toBe(false);
    });
});

describe('persistent: it leaves only when the request does', () => {
    it('the same requests, snapshot after snapshot, are the same toasts — nothing expires', () => {
        const a = items(2);
        const first = run([{ kind: 'items', items: a, dnd: false }]);
        const later = run([{ kind: 'items', items: a, dnd: false }, { kind: 'items', items: [...a], dnd: false }], first);
        expect(toastView(later, a).shown.map((i) => i.id)).toEqual(['appr_1', 'appr_2']);
        expect(later).toBe(first);
    });

    it('resolved ELSEWHERE (the chat, another device, the host): the next snapshot lacks it and the toast leaves; CONTROL: the other stays', () => {
        const both = items(2);
        const state = run([{ kind: 'items', items: both, dnd: false }]);
        expect(toastView(state, both).total).toBe(2);
        const after = [both[1]!];
        const next = toastReducer(state, { kind: 'items', items: after, dnd: false });
        expect(toastView(next, after).shown.map((i) => i.id)).toEqual(['appr_2']);
    });

    it('pressed: its buttons stop taking a second press until the request leaves (the in-flight lock)', () => {
        const a = items(2);
        const state = run([{ kind: 'items', items: a, dnd: false }, { kind: 'answering', id: 'appr_1' }]);
        expect(toastView(state, a).answering).toEqual(['appr_1']);
        // It leaves: the lock goes with it.
        const left = toastReducer(state, { kind: 'items', items: [a[1]!], dnd: false });
        expect(left.answering).toEqual([]);
    });
});

describe('Do Not Disturb', () => {
    it('DND on: nothing pops (the request waits on its agent’s row); turning it off does not throw the backlog; a later request pops', () => {
        const a = items(2);
        let state = run([{ kind: 'items', items: a, dnd: true }]);
        expect(toastView(state, a).total).toBe(0);
        state = toastReducer(state, { kind: 'items', items: a, dnd: false });
        expect(toastView(state, a).total).toBe(0);
        const more = [...a, approval(3)];
        state = toastReducer(state, { kind: 'items', items: more, dnd: false });
        expect(toastView(state, more).shown.map((i) => i.id)).toEqual(['appr_3']);
    });
});

describe('where the stack sits: bottom-left, never over the chat', () => {
    it('inside the page column, from the left edge, and never wider than the column less its margins', () => {
        for (const region of [1400, 900, 500, 340, 200]) {
            const box = toastBox(region);
            expect(box.left).toBe(TOAST_GAP);
            expect(box.bottom).toBe(TOAST_GAP);
            expect(box.width).toBeLessThanOrEqual(TOAST_WIDTH);
            // The right edge stays inside the column, with the gap: a toast cannot reach the chat dock beyond it.
            expect(box.left + box.width).toBeLessThanOrEqual(Math.max(region - TOAST_GAP, box.left + 1));
        }
        // CONTROL: a wide column gets the full width, so the clamp is not a constant.
        expect(toastBox(1400).width).toBe(TOAST_WIDTH);
        expect(toastBox(340).width).toBeLessThan(TOAST_WIDTH);
    });

    it('a toast and the chat dock never overlap, for any page width and dock width', () => {
        for (const row of [1600, 1200, 900]) for (const dock of [320, 420, 560]) {
            const column = row - 220 - dock; // the page column: the row less the rail and the dock
            const box = toastBox(column);
            const toastRight = 220 + box.left + box.width;
            expect(toastRight).toBeLessThanOrEqual(row - dock);
        }
    });
});

describe('what a toast carries', () => {
    it('the view lists every id a toast carries (drawn or behind "+N more"), and not one held back by Do Not Disturb', () => {
        const five = items(5);
        const view = toastView(run([{ kind: 'items', items: five, dnd: false }]), five);
        expect(view.shown).toHaveLength(3);
        expect(view.ids).toEqual(['appr_1', 'appr_2', 'appr_3', 'appr_4', 'appr_5']);
        const held = toastView(run([{ kind: 'items', items: five, dnd: true }]), five);
        expect(held.ids).toEqual([]);
    });
});
