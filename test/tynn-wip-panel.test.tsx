import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseWip, TYNN_SECTIONS } from '../src/core/tynn-pages.js';
import { TynnWipPanel } from '../src/renderer/components/TynnWipPanel.js';
import { TynnSectionNav } from '../src/renderer/components/TynnTab.js';

/**
 * THE TYNN TAB IS tynn.ai's WORKSPACE, NOT ONLY ITS BOARD (the owner, 2026-10-31: "all I see is the board view for the
 * tynn features in Genie"). Its pages sit in tynn.ai's order with tynn.ai's icons, named for a screen reader; WIP looks
 * and behaves like tynn.ai's WIP page: the version banner, the lens chips with their counts, the story rail, the chosen
 * story's tasks with the one next step each, and a line for every state with nothing to show.
 */
const noop = () => {};
const task = (over: Record<string, unknown>) => ({ id: 't', task_number: 1, title: 'T', status: 'backlog', claimed_by: null, claimed_by_me: false, can_start: true, version_active: true, features: [], ...over });
const story = (over: Record<string, unknown>) => ({ id: 's', slug: 's', story_number: 1, title: 'S', status: 'in_progress', description: null, task_count: 0, tasks_done: 0, ...over });
const counts = { active: 1, attention: 0, done: 1, backlog: 2 };
const WIP = parseWip({
    project_id: 'p1', view: 'active', available_versions: [],
    active_version: { id: 'v1', number: '0.4.0', title: 'The line' },
    stories: [story({ id: 's1', slug: 'ship', story_number: 7, title: 'Ship <it>', task_count: 2, tasks_done: 1 })],
    selected_story: story({ id: 's1', slug: 'ship', story_number: 7, title: 'Ship <it>', description: 'Why', task_count: 2, tasks_done: 1 }),
    tasks: [task({ id: 't2', task_number: 12, title: 'Doing it', status: 'doing', version_active: false }), task({ id: 't1', task_number: 11, title: 'Queued' })],
    story_counts: counts,
})!;
const render = (over: Partial<Parameters<typeof TynnWipPanel>[0]> = {}) =>
    renderToStaticMarkup(<TynnWipPanel state={{ state: 'ready', view: WIP }} onLens={noop} onStory={noop} onAction={noop} {...over} />);

describe('the tab\'s pages', () => {
    it('sit in tynn.ai\'s order with tynn.ai\'s icons; WIP comes before the board', () => {
        const ids = TYNN_SECTIONS.map((s) => s.id);
        expect(ids.indexOf('wip')).toBeLessThan(ids.indexOf('board'));
        expect(TYNN_SECTIONS.find((s) => s.id === 'wip')).toMatchObject({ icon: 'play', label: 'WIP' });
        expect(TYNN_SECTIONS.find((s) => s.id === 'board')).toMatchObject({ icon: 'columns-3', label: 'Board' });
    });

    it('are icons named for a screen reader, the open one marked', () => {
        const html = renderToStaticMarkup(<TynnSectionNav current="wip" onSection={noop} />);
        expect(html).toMatch(/data-tynn-section="wip"[^>]*aria-current="page"|aria-current="page"[^>]*data-tynn-section="wip"/);
        expect(html).toMatch(/aria-label="Board"/);
        expect(html).toMatch(/aria-label="WIP"/);
    });
});

describe('WIP', () => {
    it('shows the active version with its progress, and the lens chips with their counts', () => {
        const html = render();
        expect(html).toContain('0.4.0');
        expect(html).toContain('The line');
        expect(html).toContain('1 / 4 stories');
        expect(html).toMatch(/data-wip-lens="active"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-wip-lens="active"/);
        expect(html).toMatch(/aria-label="Attention"/);
        expect(html).toMatch(/data-wip-count="done"[^>]*>1</);
    });

    it('lists the lens\'s stories and the chosen one\'s tasks, in motion first; titles are text, never markup', () => {
        const html = render();
        expect(html).toMatch(/data-wip-story="s1"[^>]*aria-current="true"|aria-current="true"[^>]*data-wip-story="s1"/);
        expect(html).toContain('Ship &lt;it&gt;');
        expect(html).toContain('0 of 2 done');
        expect(html.indexOf('Doing it')).toBeLessThan(html.indexOf('Queued'));
    });

    it('offers each task\'s next step as an icon named for it, held back by the guard with the web page\'s reason', () => {
        const html = render();
        expect(html).toMatch(/data-tynn-step="task.ready"[^>]*disabled=""|disabled=""[^>]*data-tynn-step="task.ready"/);
        expect(html).toMatch(/aria-label="Ready for QA"/);
        expect(html).toContain('Version must be active');
        expect(html).toMatch(/data-tynn-step="task.start"/);
    });

    it('says there is no active version, that a lens is empty, and lists what is done', () => {
        const none = parseWip({ project_id: 'p1', view: 'active', available_versions: [], active_version: null, stories: [], selected_story: null, tasks: [], story_counts: { active: 0, attention: 0, done: 0, backlog: 0 } })!;
        expect(render({ state: { state: 'ready', view: none } })).toContain('No active version');
        const calm = parseWip({ project_id: 'p1', view: 'attention', available_versions: [], active_version: { id: 'v1', number: '1', title: 'x' }, stories: [], selected_story: null, tasks: [], story_counts: counts })!;
        expect(render({ state: { state: 'ready', view: calm } })).toContain('Nothing needs attention.');
        const done = parseWip({ project_id: 'p1', view: 'done', available_versions: [], active_version: { id: 'v1', number: '1', title: 'x' }, stories: [story({ id: 's9', story_number: 9, status: 'done', title: 'Delivered', task_count: 3 })], selected_story: null, tasks: [], story_counts: counts })!;
        const html = render({ state: { state: 'ready', view: done } });
        expect(html).toContain('Delivered');
        expect(html).toContain('3 tasks completed');
    });

    it('says a step is running, then Tynn\'s reason with Retry when it fails', () => {
        expect(render({ state: { state: 'ready', view: WIP, op: { action: 'task.start', phase: 'running' } } })).toMatch(/data-tynn-op="running"/);
        const failed = render({ state: { state: 'ready', view: WIP, op: { action: 'task.start', phase: 'failed', reason: 'Story must be in progress first' } }, onRetry: noop });
        expect(failed).toContain('Story must be in progress first');
        expect(failed).toMatch(/data-tynn-retry/);
    });

    it('nothing to show says why: loading, not linked, signed out, an error', () => {
        expect(render({ state: { state: 'loading' } })).toMatch(/data-tynn-page-state="loading"/);
        expect(render({ state: { state: 'not-linked' } })).toMatch(/no Tynn project/);
        expect(render({ state: { state: 'signed-out', reason: 'Sign in to Tynn again.' } })).toContain('Sign in to Tynn again.');
        expect(render({ state: { state: 'error', reason: 'Tynn is unreachable.' } })).toContain('Tynn is unreachable.');
    });

    it('shows live, or reconnecting, as an icon', () => {
        expect(render({ live: 'live' })).toMatch(/data-tynn-live="live"/);
        expect(render({ live: 'reconnecting' })).toMatch(/data-tynn-live="reconnecting"/);
    });
});
