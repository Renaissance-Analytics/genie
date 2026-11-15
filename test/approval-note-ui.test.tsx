import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { ApprovalCardView } from '../src/renderer/components/ApprovalCard.js';
import { ApprovalToastStack } from '../src/renderer/components/ApprovalToasts.js';

/**
 * EVERY APPROVAL TAKES A NOTE (beta.33 item 16): the card (in the chat, the Agent view and the Deck row) and the toast
 * each have an optional note field, and the answer carries what was typed — Genie then tells the agent ("You rejected
 * <what>: <note>", test/approval-note.test.ts). The presses are made on the elements themselves (hook-free views).
 */
type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const p = node.props as Props;
    if (match(p)) out.push(p);
    findAll(p.children, match, out);
    return out;
}
function findElements(node: ReactNode, match: (p: Props) => boolean, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
    if (Array.isArray(node)) { for (const n of node) findElements(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const el = node as ReactElement<Props>;
    if (match(el.props)) out.push(el);
    findElements(el.props.children, match, out);
    return out;
}
const approval = { question: 'Edit src/config.ts', tool: null, options: [{ id: 'allow', label: 'Allow', tone: 'ok' as const }, { id: 'deny', label: 'Reject', tone: 'bad' as const }] };

describe('the approval card', () => {
    it('has a note field, and each option sends the note typed with it', () => {
        const html = renderToStaticMarkup(<ApprovalCardView approval={approval as never} answering={null} onAnswer={() => {}} agentName="compass" note="" onNote={() => {}} />);
        expect(html).toContain('data-approval-note');
        expect(html).toContain('Note for compass (optional)');
        const answered: string[][] = [];
        const tree = ApprovalCardView({ approval: approval as never, answering: null, onAnswer: (id, note) => answered.push([id, note]), agentName: 'compass', note: 'use the .env instead', onNote: () => {} });
        for (const b of findAll(tree, (p) => p['data-approval-option'] !== undefined)) (b.onClick as () => void)();
        expect(answered).toEqual([['allow', 'use the .env instead'], ['deny', 'use the .env instead']]);
        // Typing reaches the holder.
        const typed: string[] = [];
        const [field] = findAll(ApprovalCardView({ approval: approval as never, answering: null, onAnswer: () => {}, note: '', onNote: (n) => typed.push(n) }), (p) => p['data-approval-note'] !== undefined);
        (field!.onValueChange as (v: string) => void)('why');
        expect(typed).toEqual(['why']);
    });
});

describe('the approval toast', () => {
    const item: DeckItem = {
        id: 'appr_1_1', source: 'agent-question', agentId: 'agent_compass', agentName: 'compass', workspaceId: 'tynn', title: 'compass wants to open a terminal: npm test',
        blocking: true, priority: 'high', at: 1, answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] }, forwardedFrom: null,
    } as DeckItem;
    const view = { shown: [item], ids: [item.id], more: 0, total: 1, expanded: false, answering: [] };

    it('has a note field per request, and an option sends the note typed on THAT request', () => {
        expect(renderToStaticMarkup(<ApprovalToastStack view={view} onAnswer={() => {}} onExpand={() => {}} />)).toContain('data-approval-note');
        const answered: unknown[][] = [];
        const tree = ApprovalToastStack({ view, onAnswer: (i, o, n) => answered.push([i.id, o, n]), onExpand: () => {} });
        // The toast's card is a component holding no hooks: render it to reach the ApprovalCard it draws, then press as it does.
        const [card] = findElements(tree, (p) => typeof p['item'] === 'object' && 'busy' in p);
        const drawn = (card!.type as (p: unknown) => ReactNode)(card!.props);
        const [approvalCard] = findAll(drawn, (p) => typeof p['onAnswer'] === 'function' && 'approval' in p);
        (approvalCard!['onAnswer'] as (o: string, n: string) => void)('allow', 'run it in the background');
        (approvalCard!['onAnswer'] as (o: string, n: string) => void)('deny', 'run it in the background');
        expect(answered).toEqual([['appr_1_1', 'allow', 'run it in the background'], ['appr_1_1', 'deny', 'run it in the background']]);
    });
});
