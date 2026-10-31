import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseVip } from '../src/core/tynn-pages.js';
import { TynnVipPanel } from '../src/renderer/components/TynnVipPanel.js';

/**
 * THE VIP LANE LOOKS AND BEHAVES LIKE tynn.ai's (genie#1295 row V1): the idle lane with Start VIP (or who can start one),
 * the rose banner with progress and a gated Release, the five columns with each story's one-click move (an icon named for
 * where it goes), the past VIPs, and every action running → done or Tynn's reason with Retry.
 */
const noop = () => {};
const story = (over: Record<string, unknown>) => ({ id: 's', slug: 's', story_number: 1, title: 'S', status: 'backlog', description: null, task_count: 0, tasks_done: 0, ...over });
const base = { project_id: 'p1', past_vips: [{ id: 'v1', number: '0.9.1', title: 'Old fire', status: 'released', story_count: 2, ended_at: null }], can_start_vip: true };
const FLIGHT = parseVip({ ...base, vip_version: { id: 'v9', number: '1.0.1', title: 'Login <is> down' }, stories: [story({ id: 's1', story_number: 4, title: 'Fix it', status: 'in_progress', task_count: 2, tasks_done: 1 })] })!;
const IDLE = parseVip({ ...base, vip_version: null, stories: [] })!;
const render = (over: Partial<Parameters<typeof TynnVipPanel>[0]> = {}) =>
    renderToStaticMarkup(<TynnVipPanel state={{ state: 'ready', view: FLIGHT }} onAction={noop} onStart={noop} {...over} />);

describe('the VIP lane', () => {
    it('idle: says what VIP is for, offers Start VIP to a person who may, and tells anyone else who can', () => {
        const may = render({ state: { state: 'ready', view: IDLE } });
        expect(may).toContain('No VIP in flight');
        expect(may).toMatch(/data-vip-start/);
        const may_not = render({ state: { state: 'ready', view: { ...IDLE, canStart: false } } });
        expect(may_not).not.toMatch(/data-vip-start/);
        expect(may_not).toContain('Someone who can manage this project can start VIP work here.');
    });

    it('in flight: the banner with its number, title (as text) and task progress, and Release held back with why', () => {
        const html = render();
        expect(html).toContain('1.0.1');
        expect(html).toContain('Login &lt;is&gt; down');
        expect(html).toContain('1/2');
        expect(html).toMatch(/data-tynn-step="version.release"[^>]*disabled=""|disabled=""[^>]*data-tynn-step="version.release"/);
        expect(html).toContain('All stories must be Done to release the VIP');
    });

    it('draws the five columns, says an empty one is empty, and moves a story on with one icon', () => {
        const html = render();
        for (const label of ['Backlog', 'Blocked', 'In Progress', 'QA', 'Done']) expect(html).toContain(label);
        expect(html).toContain('Empty');
        expect(html).toMatch(/data-tynn-step="story.move"[^>]*aria-label="Move to qa"|aria-label="Move to qa"[^>]*data-tynn-step="story.move"/);
    });

    it('lists the past VIPs', () => {
        expect(render({ state: { state: 'ready', view: IDLE } })).toContain('Old fire');
    });

    it('says a step is running, then Tynn\'s reason with Retry when it fails', () => {
        const failed = render({ state: { state: 'ready', view: IDLE, op: { action: 'vip.create', phase: 'failed', reason: 'Only one VIP version can be active at a time.' } }, onRetry: noop });
        expect(failed).toContain('Only one VIP version can be active at a time.');
        expect(failed).toMatch(/data-tynn-retry/);
        expect(render({ state: { state: 'ready', view: FLIGHT, op: { action: 'story.move', phase: 'running' } } })).toMatch(/data-tynn-op="running"/);
    });

    it('nothing to show says why', () => {
        expect(render({ state: { state: 'loading' } })).toMatch(/data-tynn-page-state="loading"/);
        expect(render({ state: { state: 'signed-out', reason: 'Sign in to Tynn again.' } })).toContain('Sign in to Tynn again.');
    });
});
