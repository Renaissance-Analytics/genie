import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_TOASTS, toastReducer, toastView } from '../src/core/approval-toasts.js';
import type { DeckItem } from '../src/core/deck.js';
import { ApprovalToastStack } from '../src/renderer/components/ApprovalToasts.js';

/**
 * An approval toast names the asking agent's workspace (Tynn #730). The item can arrive with a workspaceId and no
 * workspaceName; the toast then reads the name from the snapshot's workspaces, the way the Dashboard row does, instead
 * of saying the workspace is not known. Names are RFC 2606 fixtures.
 */
const OPTIONS = [{ id: 'allow', label: 'Allow', tone: 'ok' as const }, { id: 'deny', label: 'Deny', tone: 'bad' as const }];
const item = (over: Partial<DeckItem> = {}): DeckItem => ({
    id: 'appr_1', source: 'agent-question', agentId: 'a_1', agentName: 'agent1', workspaceId: 'ws_docs',
    title: 'agent1 wants to run npm test', blocking: true, priority: 'high', at: 1_760_000_000_000,
    answer: { kind: 'inline', options: OPTIONS }, forwardedFrom: null, ...over,
});
const html = (i: DeckItem, extra: object = {}): string => {
    const list = [i];
    const view = toastView(toastReducer(EMPTY_TOASTS, { kind: 'items', items: list, dnd: false }), list);
    return renderToStaticMarkup(<ApprovalToastStack view={view} onAnswer={() => {}} onExpand={() => {}} {...extra} />);
};
const workspaces = [{ id: 'ws_docs', path: '/work/docs.example', name: 'docs.example', color: '#3b82f6' }];

describe('the workspace a toast names', () => {
    it('an item with a workspaceId and no name takes the name from the known workspaces', () => {
        const out = html(item(), { workspaces });
        expect(out).toMatch(/data-approval-toast-workspace="">docs\.example</);
        expect(out).not.toContain('not known here');
    });

    it('an item with no name falls back to the workspace folder when the workspace has no name', () => {
        const out = html(item(), { workspaces: [{ id: 'ws_docs', path: '/work/docs.example' }] });
        expect(out).toMatch(/data-approval-toast-workspace="">docs\.example</);
    });

    it('an item with no workspaceId resolves through its agent', () => {
        const out = html(item({ workspaceId: null }), { workspaces, agents: [{ id: 'a_1', workspaceId: 'ws_docs' }] });
        expect(out).toMatch(/data-approval-toast-workspace="">docs\.example</);
    });

    it('CONTROL: a workspace nobody knows still says so', () => {
        expect(html(item({ workspaceId: 'ws_gone' }), { workspaces })).toContain('a workspace not known here');
    });

    it('CONTROL: the item\'s own name wins', () => {
        expect(html(item({ workspaceName: 'own.example' }), { workspaces })).toMatch(/data-approval-toast-workspace="">own\.example</);
    });
});
