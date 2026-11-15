import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { DeckItem } from '../src/core/deck.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * APPROVALS AS PERSISTENT LEFT TOASTS, IN THE MAIN WINDOW (Tynn #730; the owner, 2026-11-14), and the Deck merged into the
 * Dashboard: the COMPOSED render — the Shell, fed the snapshot main builds, with the requests a real ApprovalQueue parks.
 * Names are RFC 2606 (`*.example`); agent names are fixtures.
 */

const kai: Caller = { agentId: ('agent_' + 'k'.repeat(32)) as Caller['agentId'], agentName: 'kai', workspaceId: 'ws_shop', workspacePath: '/w/shop.example' };
const wren: Caller = { agentId: ('agent_' + 'w'.repeat(32)) as Caller['agentId'], agentName: 'wren', workspaceId: 'ws_blog', workspacePath: '/w/blog.example' };
const NAMES: Record<string, string> = { ws_shop: 'shop.example', ws_blog: 'blog.example' };

/** Park `n` requests on a real queue and return its Deck items, named the way compose.ts names them. */
function parked(n: number): DeckItem[] {
    let t = 1_760_000_000_000;
    const q = new ApprovalQueue({ now: () => (t += 1_000) });
    const asks: Array<[Caller, string, string]> = [
        [kai, 'services.add', 'postgres 17 (postgres:17-alpine), dedicated'],
        [wren, 'sites.remove', 'docs.blog.example'],
        [kai, 'processes.add', 'worker: `node worker.js` in /w/shop.example, restart on-failure'],
        [wren, 'services.remove', 'redis 7'],
        [kai, 'create', 'npm run build'],
    ];
    for (const [caller, action, detail] of asks.slice(0, n)) void q.gate(caller, action, detail);
    return q.deckItems().map((i) => ({ ...i, workspaceName: NAMES[i.workspaceId ?? ''] }));
}

const agentRow = (caller: Caller): AgentRow => ({
    id: caller.agentId, name: caller.agentName, provider: 'claude', workspaceId: caller.workspaceId, fidelity: 'declared', state: 'working', duration: null,
    ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});
const snapshotWith = (deckItems: DeckItem[]): GenieSnapshot => ({
    ...EMPTY_SNAPSHOT,
    workspaces: [{ id: 'ws_shop', path: '/w/shop.example', name: 'shop.example' }, { id: 'ws_blog', path: '/w/blog.example', name: 'blog.example' }] as never,
    agents: [agentRow(kai), agentRow(wren)],
    deckItems,
});
const dnd = (on: boolean): FeatureData => ({ ...EMPTY_FEATURES, settings: { values: { do_not_disturb: on } } });

function render(route: string, deckItems: DeckItem[], features: FeatureData = EMPTY_FEATURES): string {
    return renderToStaticMarkup(
        <Shell
            route={route}
            snapshot={snapshotWith(deckItems)}
            features={features}
            servable={['dashboard', 'agent', 'settings', 'knowledge']}
            agentDetail={null}
            agentResolved
            selectedRowId={null}
            chatThread={null}
            pinned={null}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onAddWorkspace={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={() => {}}
            onSend={() => {}}
            onCloseChat={() => {}}
            answeringApproval={null}
            onAnswerApproval={() => {}}
            onAnswerDeckItem={() => {}}
        />,
    );
}

const count = (html: string, re: RegExp): number => html.match(re)?.length ?? 0;
const TOASTS = /data-approval-toasts=""/g;
const TOAST = /data-approval-toast="appr_[^"]+"/g;

describe('a parked approval is a persistent toast in the main window', () => {
    it('one parked request: one toast naming the agent, the workspace and what it wants, with Allow and Deny and the note', () => {
        const [item] = parked(1);
        const html = render('genie://dashboard', [item!]);
        expect(count(html, TOASTS)).toBe(1);
        expect(html).toContain(`data-approval-toast="${item!.id}"`);
        expect(item!.title).toBe('kai wants to add a service: postgres 17 (postgres:17-alpine), dedicated');
        expect(html).toContain(item!.title);
        expect(html).toMatch(/data-approval-toast-agent=""[^>]*>kai</);
        expect(html).toMatch(/data-approval-toast-workspace=""[^>]*>shop\.example</);
        const toast = html.slice(html.indexOf('data-approval-toasts'));
        expect(count(toast, /data-approval-option="allow"/g)).toBe(1);
        expect(count(toast, /data-approval-option="deny"/g)).toBe(1);
        expect(toast).toContain('data-approval-note=""');
    });

    it('CONTROL: nothing parked, no toast', () => {
        const html = render('genie://dashboard', []);
        expect(count(html, TOASTS)).toBe(0);
        expect(html).not.toContain('data-toast-more');
    });

    it('whatever screen is open: the same toast on the Dashboard, Settings, Knowledge and an agent page', () => {
        const items = parked(1);
        const routes = ['genie://dashboard', 'genie://settings', 'genie://knowledge', 'genie://agent/agent_unknown?tab=stream'];
        expect(routes.map((r) => count(render(r, items), TOAST))).toEqual([1, 1, 1, 1]);
    });

    it('five parked: three toasts and "+2 more"', () => {
        const html = render('genie://dashboard', parked(5));
        expect(count(html, TOASTS)).toBe(1);
        expect(count(html, TOAST)).toBe(3);
        expect(html).toMatch(/data-toast-more="2"[^>]*>\+2 more waiting for approval</);
    });

    it('on its agent’s row the item carries a marker where the buttons were — the toast holds the only Allow / Deny', () => {
        const items = parked(2);
        const route = `genie://dashboard?item=${encodeURIComponent(items.find((i) => i.agentId === kai.agentId)!.id)}`;
        const html = render(route, items);
        expect(count(html, /data-approval-option="allow"/g)).toBe(2); // the two toasts' — none on the opened row
        expect(count(html, /data-approval-marker/g)).toBe(1);
        // CONTROL: under Do Not Disturb no toast carries it, so the row's own card answers and there is no marker.
        const held = render(route, items, dnd(true));
        expect(count(held, TOASTS)).toBe(0);
        expect(count(held, /data-approval-option="allow"/g)).toBe(1);
        expect(count(held, /data-approval-marker/g)).toBe(0);
    });
});

describe('where the toasts are: bottom-left of the page column, never over the chat', () => {
    it('inside the page column, after the page and BEFORE the chat dock — so a toast cannot cover the chat input', () => {
        const html = render('genie://dashboard', parked(3));
        const region = html.indexOf('data-toast-region');
        const toasts = html.indexOf('data-approval-toasts');
        const dock = html.indexOf('data-dock-frame="chat"');
        expect(region).toBeGreaterThan(-1);
        expect(dock).toBeGreaterThan(-1);
        expect(region).toBeLessThan(toasts);
        expect(toasts).toBeLessThan(dock);
        // COUNTED: nothing of the stack is inside the dock, where the chat and its input are.
        expect(count(html.slice(dock), /data-approval-toast/g)).toBe(0);
        // And it is the page column that carries the sidebar's width out of the way: the rail comes before the region.
        expect(html.indexOf('data-rail')).toBeLessThan(region);
    });

    it('the column is bottom-left, no wider than the page column, with no right offset to slide it under the dock', () => {
        const html = render('genie://dashboard', parked(1));
        const open = html.match(/<div[^>]*data-toast-column=""[^>]*>/)![0];
        expect(open).toMatch(/\bw-\[372px\]/);
        expect(open).toMatch(/max-w-\[calc\(100%-2rem\)\]/);
        expect(open).toMatch(/\bleft-4\b/);
        expect(open).toMatch(/\bbottom-4\b/);
        expect(open).not.toMatch(/\bright-/);
    });
});

describe('Do Not Disturb', () => {
    it('DND on: no toast pops; the request waits on its agent’s row', () => {
        const items = parked(2);
        const html = render('genie://dashboard', items, dnd(true));
        expect(count(html, TOASTS)).toBe(0);
        expect(html).toContain('data-waiting-badge="approval"');
    });

    it('CONTROL: DND off, the same requests pop', () => {
        expect(count(render('genie://dashboard', parked(2), dnd(false)), TOASTS)).toBe(1);
    });
});

describe('the Deck is the Dashboard', () => {
    it('genie://deck?item=<id> draws the Dashboard with that item’s agent row open on it — never a Deck page', () => {
        const items = parked(2);
        const item = items.find((i) => i.agentId === kai.agentId)!;
        const html = render(`genie://deck?item=${encodeURIComponent(item.id)}`, items);
        expect(html).toContain('data-surface="dashboard"');
        expect(html).not.toContain('data-surface="deck"');
        expect(html).toContain(`data-waiting-items="${kai.agentId}"`);
        expect(html).toContain(`data-deck-item="${item.id}"`);
        // CONTROL: the other agent's row is not opened by it.
        expect(html).not.toContain(`data-waiting-items="${wren.agentId}"`);
    });

    it('the rail has no Deck row; the waiting count rides the Dashboard’s', () => {
        const html = render('genie://dashboard', parked(3));
        expect(html).not.toContain('data-nav="genie://deck"');
        expect(html).toMatch(/data-nav="genie:\/\/dashboard"/);
        expect(html).toContain('data-deck-badge="3"');
    });
});
