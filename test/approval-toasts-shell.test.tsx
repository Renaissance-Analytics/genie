import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * APPROVAL REQUESTS AS TOASTS, IN THE MAIN WINDOW (the owner, 2026-10-15: "I should not have to go to the deck to respond
 * to every single thing an agent needs. Approval requests that trigger a genie workflow like setting up a site or DB, etc,
 * need to be Toasts that stack gracefully").
 *
 * The COMPOSED render: the Shell, fed the snapshot main builds, with the requests a real ApprovalQueue parks. Only modules
 * that exist on origin/main are imported here, so on origin/main this file runs and goes red on the missing toast — not on
 * a missing import. Names are RFC 2606 (`*.example`); agent names are fixtures.
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

const snapshotWith = (deckItems: DeckItem[]): GenieSnapshot => ({ ...EMPTY_SNAPSHOT, workspaces: [], deckItems });
const dnd = (on: boolean): FeatureData => ({ ...EMPTY_FEATURES, settings: { values: { do_not_disturb: on } } });

function render(route: string, deckItems: DeckItem[], features: FeatureData = EMPTY_FEATURES): string {
    return renderToStaticMarkup(
        <Shell
            route={route}
            snapshot={snapshotWith(deckItems)}
            features={features}
            servable={['dashboard', 'deck', 'agent', 'settings', 'knowledge']}
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
const STACKS = /data-approval-toasts=""/g;
const FRONT = /data-approval-toast="appr_[^"]+"/g;
const BEHIND = /data-approval-toast-behind="appr_[^"]+"/g;
const DECK_ROWS = /data-deck-item="appr_[^"]+"/g;

describe('a parked approval is a toast in the main window', () => {
    it('one parked request: one toast naming the agent, the workspace and what it wants, with Allow and Deny', () => {
        const [item] = parked(1);
        const html = render('genie://dashboard', [item!]);
        expect(count(html, STACKS)).toBe(1);
        expect(count(html, FRONT)).toBe(1);
        expect(html).toContain(`data-approval-toast="${item!.id}"`);
        // The request as the Deck says it — the queue's own title.
        expect(item!.title).toBe('kai wants to add a service: postgres 17 (postgres:17-alpine), dedicated');
        expect(html).toContain(item!.title);
        expect(html).toMatch(/data-approval-toast-agent=""[^>]*>kai</);
        expect(html).toMatch(/data-approval-toast-workspace=""[^>]*>shop\.example</);
        expect(count(html, /data-toast-option="allow"/g)).toBe(1);
        expect(count(html, /data-toast-option="deny"/g)).toBe(1);
        expect(count(html, /data-toast-later=""/g)).toBe(1);
    });

    it('CONTROL: nothing parked, no toast', () => {
        const html = render('genie://dashboard', []);
        expect(count(html, STACKS)).toBe(0);
        expect(count(html, /data-toast-option=/g)).toBe(0);
    });

    it('whatever screen is open: the same toast on the Dashboard, Settings, Knowledge and an agent page', () => {
        const items = parked(1);
        const routes = ['genie://dashboard', 'genie://settings', 'genie://knowledge', 'genie://agent/agent_unknown?tab=stream'];
        expect(routes.map((r) => count(render(r, items), FRONT))).toEqual([1, 1, 1, 1]);
    });

    it('not drawn over the Deck, which lists the same request with the same Allow / Deny (one set of buttons on screen)', () => {
        const items = parked(1);
        const html = render('genie://deck', items);
        expect(count(html, STACKS)).toBe(0);
        expect(count(html, DECK_ROWS)).toBe(1);
    });
});

describe('the stack', () => {
    it('5 parked: ONE stack, 3 cards drawn (the newest in front, two behind) and Fancy’s "+2"', () => {
        const items = parked(5);
        const html = render('genie://dashboard', items);
        expect(count(html, STACKS)).toBe(1);
        expect(count(html, FRONT)).toBe(1);
        expect(count(html, BEHIND)).toBe(2);
        expect(html).toMatch(/data-react-fancy-toast-stack-more=""[^>]*>\+2</);
        expect(html).toContain('data-total="5"');
        // Newest in front: the fifth request parked last.
        const newest = [...items].sort((a, b) => b.at - a.at)[0]!;
        expect(html).toContain(`data-approval-toast="${newest.id}"`);
        expect(html).toMatch(/data-approval-toast-position=""[^>]*>1 of 5</);
    });

    it('CONTROL: 3 parked fit — three cards, no "+N"', () => {
        const html = render('genie://dashboard', parked(3));
        expect(count(html, FRONT) + count(html, BEHIND)).toBe(3);
        expect(count(html, /data-react-fancy-toast-stack-more=/g)).toBe(0);
    });
});

describe('Do Not Disturb', () => {
    it('DND on: no toast pops, and the Deck lists the request', () => {
        const items = parked(2);
        expect(count(render('genie://dashboard', items, dnd(true)), STACKS)).toBe(0);
        expect(count(render('genie://deck', items, dnd(true)), DECK_ROWS)).toBe(2);
    });

    it('CONTROL: DND off, the same requests pop', () => {
        expect(count(render('genie://dashboard', parked(2), dnd(false)), STACKS)).toBe(1);
    });
});
