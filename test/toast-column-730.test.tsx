import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { DeckItem } from '../src/core/deck.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';
import { Shell } from '../src/renderer/Shell.js';
import type { AlertToast } from '../src/renderer/components/AlertToasts.js';

/**
 * ONE BOTTOM-LEFT COLUMN FOR EVERY TOAST (Tynn #730): the approval stack and Genie's own alert toasts (genie#1211) share a
 * single column, placed once in the page column before the chat dock - so the two kinds never overlap and neither can reach
 * the chat's composer. Both follow the same rule: three drawn, the rest "+N more". Names are RFC 2606 fixtures.
 */
const AGENT = 'agent_' + 'k'.repeat(32);
const approval = (n: number): DeckItem => ({
    id: `appr_${n}`, source: 'agent-question', agentId: AGENT, agentName: 'kai', workspaceId: 'ws_shop', workspaceName: 'shop.example',
    title: `kai wants to add a service ${n}`, blocking: true, priority: 'high', at: 1_760_000_000_000 + n,
    answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] }, forwardedFrom: null,
});
const alert = (n: number): AlertToast => ({ id: `alert_${n}`, title: `kai@shop.example`, body: `Finished: step ${n}` });
const row: AgentRow = {
    id: AGENT, name: 'kai', provider: 'claude', workspaceId: 'ws_shop', fidelity: 'declared', state: 'working', duration: null, ask: null, reason: null,
    fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
};

function render(approvals: number, alerts: number): string {
    const snapshot: GenieSnapshot = { ...EMPTY_SNAPSHOT, workspaces: [{ id: 'ws_shop', path: '/w/shop.example', name: 'shop.example' }] as never, agents: [row], deckItems: Array.from({ length: approvals }, (_, i) => approval(i + 1)) };
    return renderToStaticMarkup(
        <Shell
            route="genie://dashboard" snapshot={snapshot} features={EMPTY_FEATURES} servable={['dashboard', 'agent']} agentDetail={null} agentResolved selectedRowId={null}
            chatThread={null} pinned={null} onNavigate={() => {}} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} onOpenPalette={() => {}}
            onSelectRow={() => {}} onSend={() => {}} onCloseChat={() => {}} answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}}
            alertToasts={Array.from({ length: alerts }, (_, i) => alert(i + 1))} onDismissAlert={() => {}}
        />,
    );
}
const count = (s: string, re: RegExp): number => s.match(re)?.length ?? 0;

describe('approvals and alerts share one column', () => {
    it('both kinds in ONE column, approvals nearest the corner (first), alerts above', () => {
        const html = render(2, 2);
        expect(count(html, /data-toast-column=""/g)).toBe(1);
        const column = html.indexOf('data-toast-column');
        const approvals = html.indexOf('data-approval-toasts');
        const alerts = html.indexOf('data-alert-toasts');
        expect(column).toBeGreaterThan(-1);
        expect(column).toBeLessThan(approvals);
        expect(approvals).toBeLessThan(alerts);
        // CONTROL: neither kind present, nothing of it drawn - the column holds only what exists.
        const none = render(0, 0);
        expect(none).not.toContain('data-approval-toasts');
        expect(none).not.toContain('data-alert-toasts');
    });

    it('they never overlap: the column is the only placed element; each stack and every toast in it is in flow', () => {
        const html = render(2, 2);
        const opening = (attr: string): string => html.match(new RegExp(`<div[^>]*${attr}=""[^>]*>`))![0];
        // The column is placed (absolute, bottom-left); the stacks inside it are not, and it stacks them in one flex column.
        expect(opening('data-toast-column')).toMatch(/\babsolute\b[^"]*\bbottom-4\b[^"]*\bleft-4\b|\bleft-4\b[^"]*\bbottom-4\b/);
        expect(opening('data-toast-column')).toMatch(/\bflex\b[^"]*\bflex-col-reverse\b[^"]*\bgap-2\b/);
        for (const attr of ['data-approval-toasts', 'data-alert-toasts']) {
            expect(opening(attr), attr).not.toMatch(/\b(fixed|absolute|left-|right-|top-|bottom-)/);
            expect(opening(attr), attr).toMatch(/\bflex-col-reverse\b/);
        }
        // COUNTED: every toast card is a plain block in the flow of its stack.
        const cards = html.match(/<div[^>]*data-(approval-toast|alert-toast)="[^"]+"[^>]*>/g) ?? [];
        expect(cards).toHaveLength(4);
        for (const card of cards) expect(card).not.toMatch(/\b(fixed|absolute)\b/);
    });

    it('never reach the composer: the column is inside the page column, before the chat dock, and nothing of either kind is in the dock', () => {
        const html = render(3, 3);
        const region = html.indexOf('data-toast-region');
        const column = html.indexOf('data-toast-column');
        const dock = html.indexOf('data-dock-frame="chat"');
        expect(region).toBeLessThan(column);
        expect(column).toBeLessThan(dock);
        expect(count(html.slice(dock), /data-approval-toast|data-alert-toast/g)).toBe(0);
        // Never wider than the page column less its margins, so it cannot spill under the dock.
        expect(html.match(/<div[^>]*data-toast-column=""[^>]*>/)![0]).toMatch(/max-w-\[calc\(100%-2rem\)\]/);
    });
});

describe('the same "+N more" rule for both', () => {
    it('five approvals: three and "+2 more"; five alerts: three and "+2 more" - each counted on its own', () => {
        const html = render(5, 5);
        expect(count(html, /data-approval-toast="appr_/g)).toBe(3);
        expect(html).toMatch(/data-toast-more="2"/);
        expect(count(html, /data-alert-toast="alert_/g)).toBe(3);
        expect(html).toMatch(/data-alert-more="2"[^>]*>(<[^>]*>)*\+2 more</);
    });

    it('CONTROL: three of each fit - no "+N more" anywhere', () => {
        const html = render(3, 3);
        expect(count(html, /data-approval-toast="appr_/g)).toBe(3);
        expect(count(html, /data-alert-toast="alert_/g)).toBe(3);
        expect(html).not.toContain('data-toast-more');
        expect(html).not.toContain('data-alert-more');
    });

    it('the newest alert is nearest the corner of ITS stack', () => {
        const html = render(0, 2);
        expect(html.indexOf('data-alert-toast="alert_2"')).toBeLessThan(html.indexOf('data-alert-toast="alert_1"'));
    });
});
