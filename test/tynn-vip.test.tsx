import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { boardActionRequest } from '../src/core/tynn-board.js';
import { parseTynnPage, parseVip, tynnPagePath, vipActionRequest, vipCreateBody, TYNN_PAGES, TYNN_SECTIONS } from '../src/core/tynn-pages.js';
import type { TynnBoardPorts } from '../src/main/tynn-board-client.js';
import { runTynnPageAction } from '../src/main/tynn-page-client.js';
import { TynnTab } from '../src/renderer/components/TynnTab.js';
import { TynnVipPanel } from '../src/renderer/components/TynnVipPanel.js';

/**
 * THE TYNN TAB'S VIP LANE (genie#1295 row V1, Tynn story #321, workspace-ux 0.11.0 surface `vip`): tynn.ai's VIP page,
 * natively. Idle: what VIP is for, and Start VIP (a title and why it cannot wait) for a person who may manage the
 * project, or who can. In flight: the VIP version's banner with its task progress, the lane's five columns, each story's
 * one-click move to its next column, and Release once every story is done. The past VIPs below. Read through genie-host's
 * page door; Start VIP is the page's own write (`workspaces.tynnPageAction`); a story's move and the Release are board
 * verbs, through the board's door; live on the board's rings. The answers follow tynn.ai's ProjectVip builder at feffcba8.
 */
const story = (over: Record<string, unknown>) => ({ id: 's', slug: 's', story_number: 1, title: 'S', status: 'backlog', description: null, task_count: 0, tasks_done: 0, ...over });
const IN_FLIGHT = {
    project_id: 'p1',
    vip_version: { id: 'v9', number: '1.0.1', title: 'Login <is> down', status: 'active' },
    stories: [
        story({ id: 's1', story_number: 4, title: 'Fix it', status: 'in_progress', task_count: 3, tasks_done: 1 }),
        story({ id: 's2', story_number: 5, status: 'done', task_count: 1, tasks_done: 1 }),
    ],
    past_vips: [{ id: 'v1', number: '0.9.1', title: 'Old fire', status: 'released', story_count: 2, ended_at: '2026-10-01T00:00:00Z' }],
    can_start_vip: true,
};
const IDLE_JSON = { ...IN_FLIGHT, vip_version: null, stories: [] };
const noop = () => {};

describe('reading the VIP lane', () => {
    it('reads the VIP in flight: banner, task progress, columns and each story\'s next column', () => {
        const vip = parseVip(IN_FLIGHT)!;
        expect(vip.version).toEqual({ id: 'v9', number: '1.0.1', title: 'Login <is> down' });
        expect(vip.progress).toEqual({ done: 2, total: 4, percent: 50 });
        expect(vip.columns.map((c) => [c.status, c.label, c.stories.map((s) => s.id)])).toEqual([
            ['backlog', 'Backlog', []], ['blocked', 'Blocked', []], ['in_progress', 'In Progress', ['s1']], ['qa', 'QA', []], ['done', 'Done', ['s2']],
        ]);
        expect(vip.columns[2]!.stories[0]!.next).toBe('qa');
        expect(vip.columns[4]!.stories[0]!.next).toBeNull();
        expect(vip.past).toEqual([{ id: 'v1', number: '0.9.1', title: 'Old fire', status: 'released', storyCount: 2, endedAt: '2026-10-01T00:00:00Z' }]);
        expect(parseTynnPage('vip', IN_FLIGHT)).toMatchObject({ page: 'vip', view: { canStart: true } });
    });

    it('offers Release only once every story is done, and never for an empty lane', () => {
        expect(parseVip(IN_FLIGHT)!.allDone).toBe(false);
        expect(parseVip({ ...IN_FLIGHT, stories: [story({ status: 'done' })] })!.allDone).toBe(true);
        expect(parseVip({ ...IN_FLIGHT, stories: [] })!.allDone).toBe(false);
    });

    it('reads an idle lane, whether the person may start one, and anything else as nothing', () => {
        const idle = parseVip({ ...IDLE_JSON, can_start_vip: false })!;
        expect(idle.version).toBeNull();
        expect(idle.canStart).toBe(false);
        expect(parseVip({ view: 'active' })).toBeNull();
    });

    it('is read whole at the project\'s VIP door, and is a page of the tab after the board with tynn.ai\'s flame', () => {
        expect(TYNN_PAGES).toContain('vip');
        expect(tynnPagePath('p1', 'vip', { view: 'x', project_id: 'other' })).toBe('/api/v1/projects/p1/vip');
        const ids = TYNN_SECTIONS.map((s) => s.id);
        expect(ids.indexOf('vip')).toBe(ids.indexOf('board') + 1);
        expect(TYNN_SECTIONS.find((s) => s.id === 'vip')).toMatchObject({ icon: 'flame', label: 'VIP' });
    });
});

describe('starting VIP work, moving its stories, releasing it', () => {
    it('starts VIP work at its own door with a title and why it cannot wait, both required, nothing else', () => {
        expect(vipActionRequest('p1', 'vip.create')).toEqual({ method: 'POST', path: '/api/v1/projects/p1/vip' });
        expect(vipActionRequest('p1', 'vip.delete')).toBeNull();
        expect(vipCreateBody({ title: ' Login is down ', why: 'Nobody can sign in', what: 'x', extra: 1 })).toEqual({ title: 'Login is down', why: 'Nobody can sign in' });
        expect(vipCreateBody({ title: 'x', why: ' ' })).toBeNull();
        expect(vipCreateBody(null)).toBeNull();
    });

    it('a story\'s move and the Release are the board\'s own verbs, at the board\'s doors', () => {
        expect(boardActionRequest('p1', 'story.move', { storyId: 's1' })).toMatchObject({ method: 'POST', path: '/api/v1/projects/p1/stories/s1/move' });
        expect(boardActionRequest('p1', 'version.release', { versionId: 'v9' })).toMatchObject({ method: 'POST', path: '/api/v1/projects/p1/versions/v9/release' });
    });

    const ports = (answer: { ok: boolean; status: number; body: unknown }) => {
        const requests: Array<{ path: string; method: string; body?: unknown }> = [];
        const p: TynnBoardPorts = {
            signedIn: () => true,
            projectFor: (id) => (id === 'work' ? 'proj' : null),
            request: async (path, init) => { requests.push({ path, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) }); return { ok: answer.ok, status: answer.status, json: async () => answer.body }; },
        };
        return { p, requests };
    };

    it('Start VIP goes through the page-write door and answers the lane as Tynn now has it', async () => {
        const { p, requests } = ports({ ok: true, status: 201, body: IN_FLIGHT });
        expect(await runTynnPageAction(p, 'work', { action: 'vip.create', body: { title: 'Login is down', why: 'Nobody can sign in', project_id: 'other' } }))
            .toMatchObject({ ok: true, page: 'vip', view: { version: { id: 'v9' } } });
        expect(requests).toEqual([{ path: '/api/v1/projects/proj/vip', method: 'POST', body: { title: 'Login is down', why: 'Nobody can sign in' } }]);
    });

    it('a second VIP is refused in Tynn\'s words; a start with no why asks Tynn nothing (control: the start above)', async () => {
        const second = ports({ ok: false, status: 422, body: { message: 'The given data was invalid.', errors: { is_vip: ['Only one VIP version can be active at a time. Please release or archive the existing VIP version first.'] } } });
        expect(await runTynnPageAction(second.p, 'work', { action: 'vip.create', body: { title: 'Another', why: 'Also urgent' } }))
            .toMatchObject({ ok: false, reason: 'Only one VIP version can be active at a time. Please release or archive the existing VIP version first.' });
        const empty = ports({ ok: true, status: 201, body: IN_FLIGHT });
        expect(await runTynnPageAction(empty.p, 'work', { action: 'vip.create', body: { title: 'No why' } })).toMatchObject({ ok: false, state: 'error', reason: 'VIP work needs a title and why it cannot wait.' });
        expect(empty.requests).toEqual([]);
    });
});

describe('the VIP lane looks and behaves like tynn.ai\'s', () => {
    const FLIGHT = parseVip(IN_FLIGHT)!;
    const IDLE = parseVip(IDLE_JSON)!;
    const render = (over: Partial<Parameters<typeof TynnVipPanel>[0]> = {}) =>
        renderToStaticMarkup(<TynnVipPanel state={{ state: 'ready', view: FLIGHT }} onAction={noop} onStart={noop} {...over} />);

    it('idle: says what VIP is for, offers Start VIP to a person who may, and tells anyone else who can', () => {
        const may = render({ state: { state: 'ready', view: IDLE } });
        expect(may).toContain('No VIP in flight');
        expect(may).toMatch(/data-vip-start=""/);
        const mayNot = render({ state: { state: 'ready', view: { ...IDLE, canStart: false } } });
        expect(mayNot).not.toMatch(/data-vip-start/);
        expect(mayNot).toContain('Someone who can manage this project can start VIP work here.');
    });

    it('in flight: the banner with its number, title (as text) and task progress, and Release held back with why', () => {
        const html = render();
        expect(html).toContain('1.0.1');
        expect(html).toContain('Login &lt;is&gt; down');
        expect(html).not.toContain('<is>');
        expect(html).toContain('2/4');
        expect(html).toMatch(/data-tynn-step="version.release"[^>]*disabled=""|disabled=""[^>]*data-tynn-step="version.release"/);
        expect(html).toContain('All stories must be Done to release the VIP');
        // Control: once every story is done, Release is offered.
        const ready = render({ state: { state: 'ready', view: parseVip({ ...IN_FLIGHT, stories: [story({ status: 'done' })] })! } });
        expect(ready).not.toMatch(/data-tynn-step="version.release"[^>]*disabled=""|disabled=""[^>]*data-tynn-step="version.release"/);
    });

    it('draws the five columns, says an empty one is empty, and moves a story on with one icon', () => {
        const html = render();
        for (const label of ['Backlog', 'Blocked', 'In Progress', 'QA', 'Done']) expect(html).toContain(label);
        expect(html).toContain('Empty');
        expect(html).toMatch(/data-tynn-step="story.move"[^>]*aria-label="Move to QA"|aria-label="Move to QA"[^>]*data-tynn-step="story.move"/);
    });

    it('lists the past VIPs, and every step says running, then Tynn\'s reason with Retry', () => {
        expect(render({ state: { state: 'ready', view: IDLE } })).toContain('Old fire');
        const failed = render({ state: { state: 'ready', view: IDLE, op: { action: 'vip.create', phase: 'failed', reason: 'Only one VIP version can be active at a time.' } }, onRetry: noop });
        expect(failed).toContain('Only one VIP version can be active at a time.');
        expect(failed).toMatch(/data-tynn-retry/);
        expect(render({ state: { state: 'ready', view: FLIGHT, op: { action: 'story.move', phase: 'running' } } })).toMatch(/data-tynn-op="running"/);
    });

    it('nothing to show says why; live is an icon', () => {
        expect(render({ state: { state: 'loading' } })).toMatch(/data-tynn-page-state="loading"/);
        expect(render({ state: { state: 'not-linked' } })).toContain('This workspace has no Tynn project.');
        expect(render({ state: { state: 'signed-out', reason: 'Sign in to Tynn again.' } })).toContain('Sign in to Tynn again.');
        expect(render({ live: 'live' })).toMatch(/data-tynn-live="live"/);
        expect(render({ live: 'reconnecting' })).toMatch(/data-tynn-live="reconnecting"/);
    });

    it('the tab offers VIP with a page door, and not without one', () => {
        const refused = async () => ({ ok: false as const, state: 'error' as const, reason: 'x' });
        const html = renderToStaticMarkup(<TynnTab workspaceId="w1" host={{ read: refused, act: async () => ({ ok: true as const }), page: refused, pageAct: refused } as never} initialSection="vip" />);
        expect(html).toMatch(/data-tynn-section="vip"/);
        expect(html).toMatch(/data-tynn-page-state="loading"/);
        expect(renderToStaticMarkup(<TynnTab workspaceId="w1" host={{ read: refused, act: async () => ({ ok: true as const }) } as never} />)).not.toMatch(/data-tynn-section="vip"/);
    });
});
