import { describe, expect, it } from 'vitest';
import { readTynnPage, runTynnPageAction } from '../src/main/tynn-page-client.js';
import type { TynnBoardPorts } from '../src/main/tynn-board-client.js';

/**
 * THE TYNN TAB'S OTHER PAGES TALK TO TYNN AS AN APP, like the board (genie#1295): through the person's pairing, on the
 * workspace's own project (looked up on this side), and every refusal Tynn makes is its 404 — which the tab reads as
 * "sign in to Tynn again", never as an empty page.
 */
type Call = { path: string; method: string };
function ports(answer: { status: number; body: unknown }, opts: { signedIn?: boolean; project?: string | null } = {}) {
    const calls: Call[] = [];
    const p: TynnBoardPorts = {
        signedIn: () => opts.signedIn ?? true,
        projectFor: () => (opts.project === undefined ? 'p1' : opts.project),
        request: async (path, init) => {
            calls.push({ path, method: init.method });
            return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
        },
    };
    return { p, calls };
}
const WIP = { project_id: 'p1', view: 'done', active_version: null, available_versions: [], stories: [], selected_story: null, tasks: [], story_counts: { active: 0, attention: 0, done: 0, backlog: 0 } };

describe('reading a page of the tab', () => {
    it('reads WIP for the workspace\'s own project, with the lens asked for', async () => {
        const { p, calls } = ports({ status: 200, body: WIP });
        const r = await readTynnPage(p, 'w1', 'wip', { view: 'done' });
        expect(r).toMatchObject({ ok: true, page: 'wip', view: { lens: 'done' } });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/wip?view=done', method: 'GET' }]);
    });

    it('says why there is nothing — not linked, not signed in — and asks Tynn nothing', async () => {
        const unlinked = ports({ status: 200, body: WIP }, { project: null });
        expect(await readTynnPage(unlinked.p, 'w1', 'wip', {})).toMatchObject({ ok: false, state: 'not-linked' });
        const out = ports({ status: 200, body: WIP }, { signedIn: false });
        expect(await readTynnPage(out.p, 'w1', 'wip', {})).toMatchObject({ ok: false, state: 'signed-out' });
        expect([...unlinked.calls, ...out.calls]).toEqual([]);
    });

    it('reads Tynn\'s 404 as "sign in again" (an older pairing, or no access), and a page that is not one as an error', async () => {
        expect(await readTynnPage(ports({ status: 404, body: {} }).p, 'w1', 'wip', {})).toMatchObject({ ok: false, state: 'signed-out' });
        expect(await readTynnPage(ports({ status: 500, body: { message: 'Boom' } }).p, 'w1', 'wip', {})).toMatchObject({ ok: false, state: 'error', reason: 'Boom' });
        expect(await readTynnPage(ports({ status: 200, body: { level: 'versions' } }).p, 'w1', 'wip', {})).toMatchObject({ ok: false, state: 'error' });
    });

    it('refuses a page the tab does not have, without asking Tynn', async () => {
        const { p, calls } = ports({ status: 200, body: WIP });
        expect(await readTynnPage(p, 'w1', 'manage' as never, {})).toMatchObject({ ok: false, state: 'error' });
        expect(calls).toEqual([]);
    });
});

describe('the VIP lane (row V1)', () => {
    const VIP = { project_id: 'p1', vip_version: null, stories: [], past_vips: [], can_start_vip: true };

    it('reads the lane', async () => {
        const { p, calls } = ports({ status: 200, body: VIP });
        expect(await readTynnPage(p, 'w1', 'vip', {})).toMatchObject({ ok: true, page: 'vip', view: { canStart: true } });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/vip', method: 'GET' }]);
    });

    it('starts VIP work with a title and why, and says Tynn\'s reason when it refuses', async () => {
        const ok = ports({ status: 201, body: VIP });
        expect(await runTynnPageAction(ok.p, 'w1', { action: 'vip.create', body: { title: 'Down', why: 'Nobody can sign in' } })).toEqual({ ok: true });
        expect(ok.calls).toEqual([{ path: '/api/v1/projects/p1/vip', method: 'POST' }]);
        const busy = ports({ status: 422, body: { errors: { is_vip: ['Only one VIP version can be active at a time.'] } } });
        expect(await runTynnPageAction(busy.p, 'w1', { action: 'vip.create', body: { title: 'Down', why: 'x' } }))
            .toMatchObject({ ok: false, state: 'transition-refused', reason: 'Only one VIP version can be active at a time.' });
    });

    it('asks Tynn nothing for a start with no why, or an action the tab does not have', async () => {
        const { p, calls } = ports({ status: 201, body: VIP });
        expect(await runTynnPageAction(p, 'w1', { action: 'vip.create', body: { title: 'Down' } })).toMatchObject({ ok: false, state: 'error' });
        expect(await runTynnPageAction(p, 'w1', { action: 'manage.delete', body: {} })).toMatchObject({ ok: false, state: 'error' });
        expect(calls).toEqual([]);
    });
});
