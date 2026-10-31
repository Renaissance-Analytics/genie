import { describe, expect, it } from 'vitest';
import { PageFollower, parseWip, tynnPagePath, WIP_LIVE } from '../src/core/tynn-pages.js';

/**
 * THE TYNN TAB'S WIP (genie#1295 row W1, workspace-ux 0.6.0): tynn.ai's WIP page, natively. What is in flight in the
 * active version, by lens (Active, Attention, Done), the chosen story's tasks with what is in motion first, and each
 * task's one inline next step, held back by the web page's own guard.
 */
const task = (over: Record<string, unknown>) => ({
    id: 't', task_number: 1, title: 'T', status: 'backlog', claimed_by: null, claimed_by_me: false, can_start: true, version_active: true, features: [], ...over,
});
const story = (over: Record<string, unknown>) => ({ id: 's', slug: 's', story_number: 1, title: 'S', status: 'in_progress', description: null, task_count: 0, tasks_done: 0, ...over });
const ANSWER = {
    project_id: 'p1',
    view: 'active',
    active_version: { id: 'v1', number: '0.4.0', title: 'The line', status: 'active' },
    available_versions: [],
    stories: [story({ id: 's1', slug: 'ship-it', story_number: 7, title: 'Ship <it>', task_count: 2, tasks_done: 1 }), story({ id: 's2', slug: 'next', story_number: 8, status: 'backlog' })],
    selected_story: story({ id: 's1', slug: 'ship-it', story_number: 7, title: 'Ship <it>', description: 'Why it matters', task_count: 2, tasks_done: 1 }),
    tasks: [
        task({ id: 't2', task_number: 12, title: 'Doing it', status: 'doing', version_active: false }),
        task({ id: 't1', task_number: 11, title: 'Queued', status: 'backlog', can_start: true, claimed_by: { type: 'agent', id: 'a1', name: 'tynn-slave' }, features: [{ id: 'f1', title: 'Board' }] }),
        task({ id: 't3', task_number: 13, title: 'Shipped', status: 'done' }),
    ],
    story_counts: { active: 1, attention: 2, done: 3, backlog: 1 },
};

describe('reading WIP', () => {
    it('reads the version, the lens, its counts and stories, the chosen story and its tasks', () => {
        const wip = parseWip(ANSWER)!;
        expect(wip.lens).toBe('active');
        expect(wip.version).toEqual({ id: 'v1', number: '0.4.0', title: 'The line' });
        expect(wip.counts).toEqual({ active: 1, attention: 2, done: 3, backlog: 1 });
        // The version's progress is the web banner's: done of all four counts.
        expect(wip.progress).toEqual({ done: 3, total: 7, percent: 43 });
        expect(wip.stories.map((s) => [s.id, s.number, s.progress])).toEqual([['s1', '#7', '1/2'], ['s2', '#8', null]]);
        expect(wip.selected).toMatchObject({ id: 's1', slug: 'ship-it', title: 'Ship <it>', description: 'Why it matters' });
        expect(wip.doneTasks).toBe(1);
    });

    it('lists tasks in motion first, as the web page sorts them, whatever order they arrive in', () => {
        const shuffled = { ...ANSWER, tasks: [...ANSWER.tasks].reverse() };
        expect(parseWip(shuffled)!.tasks.map((t) => t.status)).toEqual(['doing', 'backlog', 'done']);
    });

    it('offers each task\'s one next step, held back by the web page\'s guard', () => {
        const [doing, queued, shipped] = parseWip(ANSWER)!.tasks;
        // Doing → Ready for QA, only while the version is active (it is not, here).
        expect(doing!.step).toMatchObject({ actionId: 'task.ready', disabled: true });
        expect(queued!.step).toMatchObject({ actionId: 'task.start', disabled: false });
        expect(shipped!.step).toBeNull();
        expect(queued!.claim).toMatchObject({ type: 'agent', name: 'tynn-slave' });
        expect(queued!.features).toEqual(['Board']);
    });

    it('says there is no active version, and reads anything that is not WIP as nothing, never an empty WIP', () => {
        const none = parseWip({ ...ANSWER, active_version: null, stories: [], selected_story: null, tasks: [], story_counts: { active: 0, attention: 0, done: 0, backlog: 0 } })!;
        expect(none.version).toBeNull();
        expect(none.progress.total).toBe(0);
        expect(parseWip({ level: 'versions' })).toBeNull();
        expect(parseWip(null)).toBeNull();
    });
});

describe('where WIP is read', () => {
    it('asks for the lens and the story the person chose, on the workspace\'s project', () => {
        expect(tynnPagePath('p1', 'wip', {})).toBe('/api/v1/projects/p1/wip');
        expect(tynnPagePath('p1', 'wip', { view: 'attention', story: 'ship-it' })).toBe('/api/v1/projects/p1/wip?view=attention&story=ship-it');
        // A lens that is not one is not sent.
        expect(tynnPagePath('p1', 'wip', { view: 'everything' })).toBe('/api/v1/projects/p1/wip');
    });
});

describe('WIP going live', () => {
    it('reads again on the board\'s channel and events', () => {
        expect(WIP_LIVE.channel).toBe('private-project-board.{projectId}');
        expect(WIP_LIVE.refresh).toBe('read');
    });

    function rig() {
        const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
        let reads = 0;
        let release: (() => void) | null = null;
        const follower = new PageFollower({
            read: () => new Promise<void>((resolve) => { reads += 1; release = resolve; }),
            schedule: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; },
        });
        const fire = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
        return { follower, fire, reads: () => reads, finish: async () => { release?.(); release = null; await Promise.resolve(); await Promise.resolve(); } };
    }

    it('reads once per burst of rings, after a quiet moment', async () => {
        const r = rig();
        r.follower.ring(); r.follower.ring(); r.follower.ring();
        expect(r.reads()).toBe(0);
        r.fire();
        expect(r.reads()).toBe(1);
    });

    it('never reads twice at once: a ring during a read is one more read after it', async () => {
        const r = rig();
        r.follower.ring(); r.fire();
        r.follower.ring(); r.follower.ring(); r.fire();
        expect(r.reads()).toBe(1);
        await r.finish();
        r.fire();
        expect(r.reads()).toBe(2);
        await r.finish();
        r.fire();
        expect(r.reads()).toBe(2);
    });

    it('stops: no read after stop', () => {
        const r = rig();
        r.follower.ring(); r.follower.stop(); r.fire();
        expect(r.reads()).toBe(0);
    });
});
