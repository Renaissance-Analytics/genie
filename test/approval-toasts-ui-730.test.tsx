import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AUTONOMY_UNTRUSTED } from '../src/core/agent-ops.js';
import { EMPTY_TOASTS, toastReducer, toastView, type ToastState } from '../src/core/approval-toasts.js';
import type { DeckItem } from '../src/core/deck.js';
import { ApprovalToastStack, type ApprovalToastStackProps } from '../src/renderer/components/ApprovalToasts.js';

/**
 * THE APPROVAL TOASTS, DRAWN (Tynn #730): bottom-left of the page column, three stacked plus "+N more", each carrying the
 * item's own buttons, the note and trust. The rules are in approval-toasts-730.test.ts; this proves what is on screen.
 * Names are RFC 2606 fixtures.
 */
const T0 = 1_760_000_000_000;
const OPTIONS = [{ id: 'allow', label: 'Allow', tone: 'ok' as const }, { id: 'deny', label: 'Deny', tone: 'bad' as const }];

function approval(n: number, over: Partial<DeckItem> = {}): DeckItem {
    return {
        id: `appr_${n}`, source: 'agent-question', agentId: `a_${n}`, agentName: `agent${n}`, workspaceId: 'ws_shop', workspaceName: 'shop.example',
        title: `agent${n} wants to run npm test`, blocking: true, priority: 'high', at: T0 + n * 1_000,
        answer: { kind: 'inline', options: OPTIONS }, forwardedFrom: null, ...over,
    };
}
const items = (n: number): DeckItem[] => Array.from({ length: n }, (_, i) => approval(i + 1));
const stateFor = (list: DeckItem[], events: Parameters<typeof toastReducer>[1][] = []): ToastState => events.reduce(toastReducer, toastReducer(EMPTY_TOASTS, { kind: 'items', items: list, dnd: false }));
const noop = () => {};

function html(list: DeckItem[], over: Partial<ApprovalToastStackProps> = {}, events: Parameters<typeof toastReducer>[1][] = []): string {
    return renderToStaticMarkup(<ApprovalToastStack view={toastView(stateFor(list, events), list)} onAnswer={noop} onExpand={noop} {...over} />);
}
const count = (s: string, re: RegExp): number => s.match(re)?.length ?? 0;

describe('where the toasts are', () => {
    it('the stack only stacks: the shared bottom-left ToastColumn places it, so it has no position of its own to overlap the alerts', () => {
        const open = html(items(1)).match(/<div[^>]*data-approval-toasts=""[^>]*>/)![0];
        expect(open).not.toMatch(/\b(fixed|absolute|left-|right-|bottom-)/);
    });

    it('CONTROL: nothing waiting, nothing drawn', () => {
        expect(html([])).toBe('');
    });
});

describe('the stack', () => {
    it('five waiting: three toasts and "+2 more"', () => {
        const out = html(items(5));
        expect(count(out, /data-approval-toast="appr_/g)).toBe(3);
        expect(out).toMatch(/data-toast-more="2"[^>]*>(<[^>]*>)*\+2 more waiting for approval</);
    });

    it('CONTROL: three fit — no "+N more"', () => {
        const out = html(items(3));
        expect(count(out, /data-approval-toast="appr_/g)).toBe(3);
        expect(count(out, /data-toast-more=/g)).toBe(0);
    });

    it('expanded: every toast is drawn, with a way back', () => {
        const out = html(items(5), {}, [{ kind: 'expand', on: true }]);
        expect(count(out, /data-approval-toast="appr_/g)).toBe(5);
        expect(count(out, /data-toast-more=/g)).toBe(0);
        expect(count(out, /data-toast-fewer=/g)).toBe(1);
    });

    it('"+N more" is a real Button that asks to expand', () => {
        const asked: boolean[] = [];
        const tree = ApprovalToastStack({ view: toastView(stateFor(items(5)), items(5)), onAnswer: noop, onExpand: (on) => asked.push(on) });
        const more = findAll(tree, (p) => p['data-toast-more'] !== undefined);
        expect(more).toHaveLength(1);
        (more[0]!.onClick as () => void)();
        expect(asked).toEqual([true]);
    });
});

describe('each toast carries the item’s own action buttons', () => {
    it('who, where and what — the agent, the workspace, the exact command — with Allow and Deny and the optional note', () => {
        const out = html(items(1));
        expect(out).toMatch(/data-approval-toast-agent=""[^>]*>agent1</);
        expect(out).toMatch(/data-approval-toast-workspace=""[^>]*>shop\.example</);
        expect(out).toContain('agent1 wants to run npm test');
        expect(out).toContain('data-approval-option="allow"');
        expect(out).toContain('data-approval-option="deny"');
        expect(out).toContain('data-approval-note=""');
        // The A / D key hints act in the chat, never on a toast.
        expect(out).not.toContain('data-key-hint');
    });

    it('an item with its own options shows THOSE, not a fixed Allow / Deny', () => {
        const own = approval(1, { answer: { kind: 'inline', options: [{ id: 'approve', label: 'Approve', tone: 'ok' }, { id: 'changes', label: 'Request changes', tone: 'neutral' }, { id: 'deny', label: 'Deny', tone: 'bad' }] } });
        const out = html([own]);
        expect(count(out, /data-approval-option="/g)).toBe(3);
        expect(out).toContain('Request changes');
        expect(out).not.toContain('data-approval-option="allow"');
    });

    it('"Trust this workspace" only where the card offers it — asked only because the workspace is not trusted', () => {
        const untrusted = approval(1, { why: AUTONOMY_UNTRUSTED });
        const offered = html([untrusted], { onTrustWorkspace: () => Promise.resolve({ ok: true }) });
        expect(offered).toContain('data-action="approval-trust-workspace"');
        // CONTROL: the same card without a way to trust, and an ordinary approval with one, offer nothing.
        expect(html([untrusted])).not.toContain('data-action="approval-trust-workspace"');
        expect(html([approval(1)], { onTrustWorkspace: () => Promise.resolve({ ok: true }) })).not.toContain('data-action="approval-trust-workspace"');
    });

    it('pressing an option answers THAT item with that option and the note, once; the pressed toast refuses a second press', () => {
        const list = items(2);
        const answered: Array<[string, string, string]> = [];
        const tree = ApprovalToastStack({ view: toastView(stateFor(list), list), onAnswer: (i, o, n) => answered.push([i.id, o, n]), onExpand: noop });
        const cards = elements(tree, isToastCard);
        expect(cards).toHaveLength(2);
        const card = findAll(renderCard(cards[1]!), (p) => typeof p.onAnswer === 'function' && 'approval' in p);
        expect(card).toHaveLength(1);
        (card[0]!.onAnswer as (o: string, n: string) => void)('deny', 'not now');
        expect(answered).toEqual([['appr_2', 'deny', 'not now']]);

        const busy = ApprovalToastStack({ view: toastView(stateFor(list, [{ kind: 'answering', id: 'appr_1' }]), list), onAnswer: noop, onExpand: noop });
        const busyCards = elements(busy, isToastCard);
        expect(busyCards.map((c) => c.props.busy)).toEqual([true, false]);
        expect(findAll(renderCard(busyCards[0]!), (p) => 'approval' in p)[0]!.answering).not.toBeNull();
        // CONTROL: the other toast is live.
        expect(findAll(renderCard(busyCards[1]!), (p) => 'approval' in p)[0]!.answering).toBeNull();
    });
});

// ---- the element tree, read -----------------------------------------------------------------------------------------

type Props = Record<string, unknown> & { children?: ReactNode };
function elements(node: ReactNode, match: (p: Props) => boolean, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
    if (Array.isArray(node)) { for (const n of node) elements(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const el = node as ReactElement<Props>;
    if (match(el.props)) out.push(el);
    elements(el.props.children, match, out);
    return out;
}
const findAll = (node: ReactNode, match: (p: Props) => boolean): Props[] => elements(node, match).map((e) => e.props);
const isToastCard = (p: Props): boolean => typeof p.item === 'object' && p.item !== null && 'busy' in p;
/** A toast card element rendered the way React does (it holds no hooks of its own): its ApprovalCard is in the result. */
const renderCard = (el: ReactElement<Props>): ReactNode => (el.type as (p: unknown) => ReactNode)(el.props);
