import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_TOASTS, TOAST_DEPTH, isApprovalToast, toastReducer, toastView, type ToastEvent, type ToastState } from '../src/core/approval-toasts.js';
import type { DeckItem, SignalState } from '../src/core/deck.js';
import { deckAnswerRoute } from '../src/core/deck-resolve.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { Caller } from '../src/main/mcp-tools.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { ApprovalToastStack, ApprovalToasts, type ApprovalToastStackProps } from '../src/renderer/components/ApprovalToasts.js';
import { Deck } from '../src/renderer/components/Deck.js';

/**
 * APPROVAL TOASTS — the rules (core/approval-toasts.ts) and the stack's controls (ApprovalToasts.tsx), pressed for real:
 * the stack is a pure function of its view, so the test reads its element tree and calls the handlers a click would.
 * The stack itself is Fancy's Toast.Stack (react-fancy 5.41, built at Genie's request): Fancy turns it — wheel, arrows —
 * and hands Genie the new front through onFrontIndexChange; Genie decides WHICH requests and in what order. A card's
 * content is Genie's renderItem, so the test renders the front card the way Fancy does and presses its buttons. Allow travels the Deck's own path into a real composed ApprovalQueue (feature-ipc `deck.answer`).
 *
 * On origin/main this file is red on the missing modules (`core/approval-toasts`, `ApprovalToasts`): the feature does
 * not exist there. Its sibling approval-toasts-shell.test.tsx imports only what origin/main has and goes red on the
 * missing toast itself. Names are RFC 2606; agent names are fixtures.
 */

// ---- the element tree, read and pressed --------------------------------------------------------------------------

type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const props = node.props as Props;
    if (match(props)) out.push(props);
    findAll(props.children, match, out);
    return out;
}
const one = (node: ReactNode, match: (p: Props) => boolean): Props => {
    const hits = findAll(node, match);
    expect(hits).toHaveLength(1);
    return hits[0]!;
};

// ---- fixtures -----------------------------------------------------------------------------------------------------

const QUIET: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false };

function approval(n: number, over: Partial<DeckItem> = {}): DeckItem {
    return {
        id: `appr_${n}_${1_760_000_000_000 + n}`,
        source: 'agent-question',
        agentId: 'agent_' + 'k'.repeat(32),
        agentName: 'kai',
        workspaceId: 'ws_shop',
        workspaceName: 'shop.example',
        title: `kai wants to add a service: engine ${n}`,
        blocking: true,
        priority: 'high',
        at: 1_760_000_000_000 + n * 1_000,
        answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] },
        forwardedFrom: null,
        ...over,
    };
}
const FIVE = [1, 2, 3, 4, 5].map((n) => approval(n));

const run = (events: ToastEvent[], from: ToastState = EMPTY_TOASTS): ToastState => events.reduce(toastReducer, from);
const frontOf = (state: ToastState, items: readonly DeckItem[]): string | undefined => { const v = toastView(state, items); return v.ring[v.front]?.id; };

/** The stack's element tree for a state, with every handler counting into `calls`. */
function stack(state: ToastState, items: readonly DeckItem[], over: Partial<ApprovalToastStackProps> = {}) {
    const calls = { answer: [] as Array<[string, string]>, later: [] as string[], front: [] as number[], engage: [] as boolean[] };
    const view = toastView(state, items);
    const tree = ApprovalToastStack({
        view,
        onAnswer: (item, optionId) => { calls.answer.push([item.id, optionId]); },
        onLater: (item) => { calls.later.push(item.id); },
        onFront: (index) => { calls.front.push(index); },
        onEngage: (on) => { calls.engage.push(on); },
        ...over,
    });
    // Fancy's Toast.Stack, as Genie configures it; and the front card rendered the way Fancy renders it.
    const fancy = (): Props => one(tree, (p) => typeof p.renderItem === 'function');
    // renderItem gives Genie's front-card element; it is rendered here as React would (it holds no hooks), so its buttons
    // are in the tree read.
    const frontCard = (): ReactNode => {
        const el = (fancy().renderItem as (i: DeckItem, s: { index: number; isFront: boolean }) => ReactNode)(view.ring[view.front]!, { index: view.front, isFront: true });
        if (!isValidElement(el) || typeof el.type !== 'function') return el;
        return (el.type as (p: unknown) => ReactNode)(el.props);
    };
    return { tree, calls, fancy, frontCard };
}

describe('which Deck items are toasts', () => {
    it('the approval queue’s requests (`appr_`), and nothing else: a question, a provider’s own permission, a forwarded one, a finish', () => {
        const items: DeckItem[] = [
            approval(1),
            { ...approval(2), id: 'q_1', answer: { kind: 'form', fields: 1 } },
            { ...approval(3), id: 'approval:agent_x' },
            approval(4, { forwardedFrom: 'host.example' }),
            { ...approval(5), id: 'fin_1', source: 'finished-handoff' },
        ];
        // COUNTED: exactly the one.
        expect(items.filter(isApprovalToast).map((i) => i.id)).toEqual([approval(1).id]);
    });
});

describe('Allow from the toast is the Deck’s own answer — one resolution path', () => {
    const pty: PtyPort = { open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
    let dir: string;
    let services: ComposedServices;
    const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
    const kai: Caller = { agentId: ('agent_' + 'k'.repeat(32)) as Caller['agentId'], agentName: 'kai', workspaceId: 'ws_shop', workspacePath: '/w/shop.example' };

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-approval-toasts-'));
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true });
    });

    it('Allow resolves THAT approval id once (counted), its gate says allowed, and neither the Deck nor the toasts list it after', async () => {
        const verdict = services.approvals.gate(kai, 'services.add', 'postgres 17 (postgres:17-alpine), dedicated');
        // Counts every resolution the queue performs, with the id it resolved.
        const resolved: string[] = [];
        const real = services.approvals.resolve.bind(services.approvals);
        services.approvals.resolve = (id, choice) => { resolved.push(`${id}:${choice}`); return real(id, choice); };

        let items = services.deckItems();
        const item = items.find(isApprovalToast)!;
        expect(item).toBeDefined();
        let toasts = run([{ kind: 'items', items, dnd: false }]);
        expect(frontOf(toasts, items)).toBe(item.id);

        // What App wires as the Deck's onAnswer: the route, then `deck.answer` to main.
        const pending: Promise<unknown>[] = [];
        const onAnswer = (it: DeckItem, optionId: string) => {
            const route = deckAnswerRoute(it, optionId);
            expect(route.kind).toBe('feature');
            pending.push(handleFeatureAction(services, { kind: 'deck.answer', item: it, optionId }, state()));
        };
        const { frontCard } = stack(toasts, items, { onAnswer: (it, opt) => { toasts = toastReducer(toasts, { kind: 'answering', id: it.id }); onAnswer(it, opt); } });
        (one(frontCard(), (p) => p['data-toast-option'] === 'allow').onClick as () => void)();
        await Promise.all(pending);

        expect(resolved).toEqual([`${item.id}:allow`]);
        expect(await verdict).toBe('allowed');
        // A second press cannot happen: the pressed toast's buttons are disabled until it leaves.
        expect(one(stack(toasts, items).frontCard(), (p) => p['data-toast-option'] === 'allow').disabled).toBe(true);

        // The next snapshot: gone from the Deck and from the toasts.
        items = services.deckItems();
        expect(items.filter(isApprovalToast)).toEqual([]);
        expect(renderToStaticMarkup(<Deck items={items} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} />)).not.toContain(item.id);
        toasts = toastReducer(toasts, { kind: 'items', items, dnd: false });
        expect(toastView(toasts, items).total).toBe(0);
        expect(resolved).toHaveLength(1);
    });

    it('answered in the DECK, the toast goes too (CONTROL: before it, the toast was there)', async () => {
        void services.approvals.gate(kai, 'sites.remove', 'docs.shop.example');
        let items = services.deckItems();
        let toasts = run([{ kind: 'items', items, dnd: false }]);
        expect(toastView(toasts, items).total).toBe(1);
        await handleFeatureAction(services, { kind: 'deck.answer', item: items.find(isApprovalToast)!, optionId: 'deny' }, state());
        items = services.deckItems();
        toasts = toastReducer(toasts, { kind: 'items', items, dnd: false });
        expect(toastView(toasts, items).total).toBe(0);
    });
});

describe('the stack turns', () => {
    const items = FIVE;
    const at = (s: ToastState) => toastView(s, items).position;

    it('5 parked: the ring newest first, the newest in front; Fancy draws 3 (front + 2 behind) and counts the rest', () => {
        expect(TOAST_DEPTH).toBe(3);
        const s = run([{ kind: 'items', items, dnd: false }]);
        const view = toastView(s, items);
        expect(view.ring.map((c) => c.id)).toEqual([5, 4, 3, 2, 1].map((n) => approval(n).id));
        expect(view.front).toBe(0);
        expect(view.position).toBe(1);
        const fancy = stack(s, items).fancy();
        expect(fancy.depth).toBe(TOAST_DEPTH - 1);
        expect(fancy.position).toBe('inline');
        expect((fancy.items as DeckItem[]).map((c) => c.id)).toEqual(view.ring.map((c) => c.id));
        expect(fancy.frontIndex).toBe(0);
    });

    it('Fancy’s new front (wheel or arrow) is the front: the index chosen, round the ring both ways', () => {
        let s = run([{ kind: 'items', items, dnd: false }, { kind: 'engage', on: true }]);
        expect(at(s)).toBe(1);
        s = toastReducer(s, { kind: 'front', index: 1 });
        expect(at(s)).toBe(2);
        expect(frontOf(s, items)).toBe(approval(4).id);
        s = toastReducer(s, { kind: 'front', index: 4 });
        expect(frontOf(s, items)).toBe(approval(1).id);
        // Out of range wraps, as Fancy's own does: past the oldest is the newest again.
        s = toastReducer(s, { kind: 'front', index: 5 });
        expect(at(s)).toBe(1);
        s = toastReducer(s, { kind: 'front', index: -1 });
        expect(frontOf(s, items)).toBe(approval(1).id);
    });

    it('Fancy’s onFrontIndexChange is passed through (counted); Genie adds no wheel or key handler of its own; the pointer engages', () => {
        const s = run([{ kind: 'items', items, dnd: false }]);
        const { tree, calls, fancy } = stack(s, items);
        (fancy().onFrontIndexChange as (i: number) => void)(3);
        (fancy().onFrontIndexChange as (i: number) => void)(0);
        expect(calls.front).toEqual([3, 0]);
        const root = one(tree, (p) => p['data-approval-toasts'] === '');
        expect(root.onWheel).toBeUndefined();
        expect(root.onKeyDown).toBeUndefined();
        (root.onMouseEnter as () => void)();
        (root.onMouseLeave as () => void)();
        expect(calls.engage).toEqual([true, false]);
    });

    it('the front never changes under the pointer: an arrival while hovered joins BEHIND; CONTROL: at rest it comes to the front', () => {
        const four = items.slice(0, 4);
        const hovered = run([{ kind: 'items', items: four, dnd: false }, { kind: 'engage', on: true }, { kind: 'items', items, dnd: false }]);
        expect(frontOf(hovered, items)).toBe(approval(4).id);
        expect(toastView(hovered, items).total).toBe(5);
        const atRest = run([{ kind: 'items', items: four, dnd: false }, { kind: 'items', items, dnd: false }]);
        expect(frontOf(atRest, items)).toBe(approval(5).id);
    });

    it('staggering: the one answered leaves and the one behind it comes forward', () => {
        let s = run([{ kind: 'items', items, dnd: false }, { kind: 'engage', on: true }, { kind: 'cycle', by: 1 }]);
        expect(frontOf(s, items)).toBe(approval(4).id);
        const rest = items.filter((i) => i.id !== approval(4).id);
        s = toastReducer(s, { kind: 'items', items: rest, dnd: false });
        expect(frontOf(s, rest)).toBe(approval(3).id);
    });
});

describe('Later, and never expiring', () => {
    it('Later takes the toast off and the Deck keeps the request (counted); CONTROL: the other toasts stay', () => {
        const items = [approval(1), approval(2)];
        let s = run([{ kind: 'items', items, dnd: false }]);
        const { calls, frontCard } = stack(s, items);
        (one(frontCard(), (p) => p['data-toast-later'] === '').onClick as () => void)();
        expect(calls.later).toEqual([approval(2).id]);
        expect(calls.answer).toEqual([]);
        s = toastReducer(s, { kind: 'later', id: approval(2).id });
        const view = toastView(s, items);
        expect(view.ring.map((c) => c.id)).toEqual([approval(1).id]);
        // Still in the Deck: nothing was answered.
        const deck = renderToStaticMarkup(<Deck items={items} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} />);
        expect(deck.match(/data-deck-item="appr_[^"]+"/g)).toHaveLength(2);
        // And it does not come back on the next snapshot.
        s = toastReducer(s, { kind: 'items', items: [...items], dnd: false });
        expect(toastView(s, items).total).toBe(1);
    });

    it('a toast does not expire: the same requests, snapshot after snapshot, are the same toasts (and the same state)', () => {
        const items = [approval(1)];
        const s = run([{ kind: 'items', items, dnd: false }]);
        expect(toastReducer(s, { kind: 'items', items: [...items], dnd: false })).toBe(s);
        expect(toastView(run([{ kind: 'items', items, dnd: false }], s), items).total).toBe(1);
    });
});

describe('Do Not Disturb', () => {
    it('DND on: nothing pops; turning it off does not throw the backlog; a request after that pops', () => {
        const two = [approval(1), approval(2)];
        let s = run([{ kind: 'items', items: two, dnd: true }]);
        expect(toastView(s, two).total).toBe(0);
        s = toastReducer(s, { kind: 'items', items: two, dnd: false });
        expect(toastView(s, two).total).toBe(0);
        const three = [...two, approval(3)];
        s = toastReducer(s, { kind: 'items', items: three, dnd: false });
        expect(toastView(s, three).ring.map((c) => c.id)).toEqual([approval(3).id]);
    });

    it('the stateful stack, first render under DND: no toast markup; CONTROL: DND off, the toast', () => {
        const items = [approval(1)];
        const html = (dnd: boolean) => renderToStaticMarkup(<ApprovalToasts items={items} dnd={dnd} onAnswer={() => {}} />);
        expect(html(true)).not.toContain('data-approval-toasts');
        expect(html(false)).toContain(`data-approval-toast="${approval(1).id}"`);
    });
});
