import { describe, expect, it } from 'vitest';
import { parseVip, tynnPageActionRequest, tynnPagePath, vipCreateBody, TYNN_SECTIONS } from '../src/core/tynn-pages.js';

/**
 * THE TYNN TAB'S VIP LANE (genie#1295 row V1): tynn.ai's VIP page, natively. Idle: what VIP is for, and Start VIP for a
 * person who may manage the project. In flight: the VIP version's banner with its task progress, the lane's columns, each
 * story's one-click move to its next column, and Release once every story is done. The past VIPs below.
 */
const story = (over: Record<string, unknown>) => ({ id: 's', slug: 's', story_number: 1, title: 'S', status: 'backlog', description: null, task_count: 0, tasks_done: 0, ...over });
const IN_FLIGHT = {
    project_id: 'p1',
    vip_version: { id: 'v9', number: '1.0.1', title: 'Login is down', status: 'vip' },
    stories: [
        story({ id: 's1', story_number: 4, status: 'in_progress', task_count: 3, tasks_done: 1 }),
        story({ id: 's2', story_number: 5, status: 'done', task_count: 1, tasks_done: 1 }),
    ],
    past_vips: [{ id: 'v1', number: '0.9.1', title: 'Old fire', status: 'released', story_count: 2, ended_at: '2026-10-01T00:00:00Z' }],
    can_start_vip: true,
};

describe('reading the VIP lane', () => {
    it('reads the VIP in flight: banner, task progress, columns and each story\'s next column', () => {
        const vip = parseVip(IN_FLIGHT)!;
        expect(vip.version).toEqual({ id: 'v9', number: '1.0.1', title: 'Login is down' });
        expect(vip.progress).toEqual({ done: 2, total: 4, percent: 50 });
        expect(vip.columns.map((c) => [c.status, c.label, c.stories.map((s) => s.id)])).toEqual([
            ['backlog', 'Backlog', []], ['blocked', 'Blocked', []], ['in_progress', 'In Progress', ['s1']], ['qa', 'QA', []], ['done', 'Done', ['s2']],
        ]);
        expect(vip.columns[2]!.stories[0]!.next).toBe('qa');
        expect(vip.columns[4]!.stories[0]!.next).toBeNull();
        expect(vip.past).toEqual([{ id: 'v1', number: '0.9.1', title: 'Old fire', status: 'released', storyCount: 2, endedAt: '2026-10-01T00:00:00Z' }]);
    });

    it('offers Release only once every story is done, and never for an empty lane', () => {
        expect(parseVip(IN_FLIGHT)!.allDone).toBe(false);
        expect(parseVip({ ...IN_FLIGHT, stories: [story({ status: 'done' })] })!.allDone).toBe(true);
        expect(parseVip({ ...IN_FLIGHT, stories: [] })!.allDone).toBe(false);
    });

    it('reads an idle lane, whether the person may start one, and anything else as nothing', () => {
        const idle = parseVip({ ...IN_FLIGHT, vip_version: null, stories: [], can_start_vip: false })!;
        expect(idle.version).toBeNull();
        expect(idle.canStart).toBe(false);
        expect(parseVip({ view: 'active' })).toBeNull();
    });
});

describe('where the VIP lane is read and started', () => {
    it('reads the workspace\'s project\'s lane, and starts VIP work at its own door', () => {
        expect(tynnPagePath('p1', 'vip', {})).toBe('/api/v1/projects/p1/vip');
        expect(tynnPageActionRequest('p1', 'vip.create')).toEqual({ method: 'POST', path: '/api/v1/projects/p1/vip' });
        expect(tynnPageActionRequest('p1', 'nope.nope')).toBeNull();
    });

    it('sends a title and why it cannot wait, both required, nothing else', () => {
        expect(vipCreateBody({ title: ' Login is down ', why: 'Nobody can sign in', extra: 1 })).toEqual({ title: 'Login is down', why: 'Nobody can sign in' });
        expect(vipCreateBody({ title: 'x', why: ' ' })).toBeNull();
        expect(vipCreateBody(null)).toBeNull();
    });

    it('is a page of the tab, after the board, with tynn.ai\'s flame', () => {
        const ids = TYNN_SECTIONS.map((s) => s.id);
        expect(ids.indexOf('vip')).toBe(ids.indexOf('board') + 1);
        expect(TYNN_SECTIONS.find((s) => s.id === 'vip')).toMatchObject({ icon: 'flame', label: 'VIP' });
    });
});
