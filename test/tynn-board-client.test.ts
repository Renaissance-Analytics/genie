import { describe, expect, it } from 'vitest';
import { readTynnBoard, runTynnBoardAction, type TynnBoardPorts } from '../src/main/tynn-board-client.js';

/**
 * THE TYNN TAB TALKS TO TYNN AS AN APP (genie#1295; the owner, 2026-10-27: "the mcp is for agents, the api is for apps"):
 * through the person's pairing (TynnAccount.request — Bearer gpk_, /api/v1 only), never an agent's MCP key. The project is
 * the WORKSPACE's (project.json's tynn link), looked up on this side: the tab has no project picker, and a renderer cannot
 * name another project.
 */
type Call = { path: string; method: string; body?: unknown };
function ports(answer: { status: number; body: unknown }, opts: { signedIn?: boolean; project?: string | null } = {}) {
    const calls: Call[] = [];
    const p: TynnBoardPorts = {
        signedIn: () => opts.signedIn ?? true,
        projectFor: () => (opts.project === undefined ? 'p1' : opts.project),
        request: async (path, init) => {
            calls.push({ path, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) });
            return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
        },
    };
    return { p, calls };
}
const BOARD = { project_id: 'p1', level: 'versions', version_id: null, story_id: null, versions: [], stories: null, tasks: null, active_version: null, active_story: null };

describe('reading the board', () => {
    it('reads the workspace\'s own project, with the scope asked for', async () => {
        const { p, calls } = ports({ status: 200, body: BOARD });
        const r = await readTynnBoard(p, 'w1', { version: 'v1' });
        expect(r.ok).toBe(true);
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/board?version=v1', method: 'GET' }]);
    });

    it('says why there is nothing: not linked, or not signed in — and asks Tynn nothing', async () => {
        const unlinked = ports({ status: 200, body: BOARD }, { project: null });
        expect(await readTynnBoard(unlinked.p, 'w1', {})).toMatchObject({ ok: false, state: 'not-linked' });
        const out = ports({ status: 200, body: BOARD }, { signedIn: false });
        expect(await readTynnBoard(out.p, 'w1', {})).toMatchObject({ ok: false, state: 'signed-out' });
        expect([...unlinked.calls, ...out.calls]).toEqual([]);
    });

    it('a 404 is Tynn\'s refusal (no board scope, or no access): signed-out, with what to do', async () => {
        const { p } = ports({ status: 404, body: { message: 'The route could not be found.' } });
        expect(await readTynnBoard(p, 'w1', {})).toMatchObject({ ok: false, state: 'signed-out', reason: expect.stringMatching(/sign in to Tynn again/i) });
    });

    it('an answer that is not a board is an error, never an empty board', async () => {
        const { p } = ports({ status: 200, body: { level: 'nope' } });
        expect(await readTynnBoard(p, 'w1', {})).toMatchObject({ ok: false, state: 'error' });
    });
});

describe('acting on the board', () => {
    it('a card\'s step posts to the contract\'s path under the workspace\'s project', async () => {
        const { p, calls } = ports({ status: 200, body: { id: 't1', status: 'doing', order: 0 } });
        expect(await runTynnBoardAction(p, 'w1', { action: 'task.start', ids: { taskId: 't1' } })).toEqual({ ok: true });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/tasks/t1/start', method: 'POST' }]);
    });

    it('a drag sends the column, the place and the person\'s Shift override', async () => {
        const { p, calls } = ports({ status: 200, body: { id: 's1', status: 'qa', order: 2 } });
        await runTynnBoardAction(p, 'w1', { action: 'story.move', ids: { storyId: 's1' }, body: { status: 'qa', order: 2, override: true } });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/stories/s1/move', method: 'POST', body: { status: 'qa', order: 2, override: true } }]);
    });

    it('a refused step carries Tynn\'s reason, in Tynn\'s words', async () => {
        const { p } = ports({ status: 422, body: { message: 'x', errors: { status: ['Cannot start story: parent version is not active.'] } } });
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.start', ids: { storyId: 's1' } }))
            .toEqual({ ok: false, state: 'transition-refused', reason: 'Cannot start story: parent version is not active.' });
    });

    it('an action Genie does not offer, or a body that is not a drag, is refused here and never sent', async () => {
        const { p, calls } = ports({ status: 200, body: {} });
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.claim', ids: { storyId: 's1' } })).toMatchObject({ ok: false, state: 'error' });
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.move', ids: { storyId: 's1' }, body: { status: 1 } })).toMatchObject({ ok: false, state: 'error' });
        expect(calls).toEqual([]);
    });
});
