import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseBoard } from '../src/core/tynn-board.js';
import { parseRoute } from '../src/core/route.js';
import { tabStrip } from '../src/core/workspace-tabs.js';
import { TynnBoardPanel } from '../src/renderer/components/TynnBoardPanel.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';

/**
 * THE TYNN TAB (genie#1295): a workspace linked to a Tynn project gets tynn.ai's board in a tab of its own — no user menu
 * and no project picker, because the tab IS the workspace's project. The tab is Tynn's logo, not its name (the owner:
 * logos over words); the card buttons are icons named for a screen reader; when there is nothing to show it says why.
 */
const noop = () => {};
const STORIES = parseBoard({
    project_id: 'p1', level: 'stories', version_id: 'v1', story_id: null, active_story: null,
    active_version: { id: 'v1', number: '0.4', title: 'Line', status: 'active', story_count: 1, stories_done: 0, task_count: 0, tasks_done: 0 },
    versions: [], tasks: null,
    stories: [{ id: 's1', story_number: 7, title: 'Ship <the> board', status: 'backlog', order: 0, task_count: 0, tasks_done: 0, claimed_by: null, can_start: true, can_move_to_qa: false, version_active: true }],
})!;

describe('the tab', () => {
    it('is in the strip only for a linked workspace, before + and Settings, and routes to its own view', () => {
        expect(tabStrip({ tabs: [] }, [], { tynn: true }).map((t) => t.kind)).toEqual(['dashboard', 'files', 'tynn', 'add', 'settings']);
        expect(tabStrip({ tabs: [] }, [], {}).map((t) => t.kind)).not.toContain('tynn');
        expect(parseRoute('genie://workspace/w1?view=tynn')).toMatchObject({ surface: 'workspace', view: 'tynn' });
    });

    it('shows Tynn\'s logo, named for a screen reader, not the word', () => {
        const html = renderToStaticMarkup(<WorkspaceTabs designed={{ tabs: [] }} agents={[]} current={{ kind: 'view', view: 'home' }} canDesign={false} hasSettings={false} tynn onView={noop} onAdd={noop} onOpenAgent={noop} />);
        expect(html).toMatch(/data-workspace-tab="tynn"/);
        expect(html).toMatch(/aria-label="Tynn"/);
        expect(html).toMatch(/data-tynn-logo/);
    });
});

describe('the board', () => {
    it('draws tynn.ai\'s columns and cards; titles are text, never markup', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES }} onScope={noop} onAction={noop} />);
        for (const label of ['Backlog', 'Blocked', 'In progress', 'QA', 'Done']) expect(html).toContain(label);
        expect(html).toContain('Ship &lt;the&gt; board');
        expect(html).toContain('#7');
        expect(html).toMatch(/data-tynn-card="s1"/);
    });

    it('offers the card\'s next step as an icon named for what it does, and says an empty column is empty', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES }} onScope={noop} onAction={noop} />);
        expect(html).toMatch(/data-tynn-step="story.start"[^>]*aria-label="Start"|aria-label="Start"[^>]*data-tynn-step="story.start"/);
        expect(html).toContain('No stories');
    });

    it('goes back up a level from a version\'s stories', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES }} onScope={noop} onAction={noop} />);
        expect(html).toMatch(/data-tynn-up/);
        expect(html).toContain('0.4');
    });

    it('shows a refused step in Tynn\'s words', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, refused: 'Cannot start story: parent version is not active.' }} onScope={noop} onAction={noop} />);
        expect(html).toMatch(/data-tynn-board-refused/);
        expect(html).toContain('parent version is not active');
    });

    it('nothing to show says why: loading, not linked, signed out, an error', () => {
        expect(renderToStaticMarkup(<TynnBoardPanel state={{ state: 'loading' }} onScope={noop} onAction={noop} />)).toMatch(/data-tynn-board-state="loading"/);
        expect(renderToStaticMarkup(<TynnBoardPanel state={{ state: 'not-linked' }} onScope={noop} onAction={noop} />)).toMatch(/no Tynn project/);
        expect(renderToStaticMarkup(<TynnBoardPanel state={{ state: 'signed-out', reason: 'Sign in to Tynn again.' }} onScope={noop} onAction={noop} />)).toContain('Sign in to Tynn again.');
        expect(renderToStaticMarkup(<TynnBoardPanel state={{ state: 'error', reason: 'Tynn is unreachable.' }} onScope={noop} onAction={noop} />)).toContain('Tynn is unreachable.');
    });
});
