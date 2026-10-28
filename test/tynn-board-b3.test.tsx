import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    BOARD_API,
    BOARD_GAPS,
    boardActionRequest,
    initialsOf,
    parseBoard,
    parseClaimants,
    performClaimThenStart,
    startPlan,
    type BoardActionInput,
    type BoardOp,
    type TynnBoardHost,
} from '../src/core/tynn-board.js';
import { runTynnBoardAction, type TynnBoardPorts } from '../src/main/tynn-board-client.js';
import { TynnBoardPanel } from '../src/renderer/components/TynnBoardPanel.js';

/**
 * THE TYNN TAB, ROW B3 (genie#1295; workspace-ux 0.3.0): claim, unclaim, assign and the claimant list, as tynn.ai's board
 * offers them. Tynn's genie:board door has POST /stories|tasks/{id}/claim|release|assign and GET /claimants, through the
 * web board's own claim rules; the board answer carries the project's `claims` {mode, policy, can_assign}.
 *
 * As on tynn.ai: a claimed card shows its claimant (a person's initials, or an agent's mark) with the name on hover, and
 * the person who holds the claim can release it; a backlog card's Start follows the claim mode (off or already mine:
 * Start; optional: Claim + Start or Start; required: claim, then start); a person who may manage the project assigns from
 * the project's eligible claimants. Every one of these says it is running, then that it worked, or Tynn's reason and a
 * Retry (the owner: obvious actions, visible progress). Buttons are icons named for a screen reader.
 */
const noop = () => {};
const story = (id: string, extra: Record<string, unknown> = {}) => ({
    id, story_number: 7, title: `Story ${id}`, status: 'backlog', order: 0, task_count: 0, tasks_done: 0,
    claimed_by: null, claimed_by_me: false, can_start: true, can_move_to_qa: false, version_active: true, ...extra,
});
const board = (stories: unknown[], claims: unknown = { mode: 'optional', policy: 'any', can_assign: true }) => parseBoard({
    project_id: 'p1', level: 'stories', version_id: 'v1', story_id: null, active_story: null, versions: [], tasks: null,
    active_version: { id: 'v1', number: '0.4', title: 'Line', status: 'active' }, stories, claims,
})!;
const ADA = { type: 'user', id: 'u1', name: 'Ada Lovelace' };
const BOT = { type: 'agent', id: 'a1', name: 'Builder Bot' };

// ── The calls ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the calls behind claim, unclaim, assign and the claimant list', () => {
    it('are the contract\'s paths under the workspace\'s project, and none is a gap any more', () => {
        expect(boardActionRequest('p1', 'story.claim', { storyId: 's1' })).toEqual({ method: 'POST', path: '/api/v1/projects/p1/stories/s1/claim' });
        expect(boardActionRequest('p1', 'story.unclaim', { storyId: 's1' })).toEqual({ method: 'POST', path: '/api/v1/projects/p1/stories/s1/release' });
        expect(boardActionRequest('p1', 'story.assign', { storyId: 's1' })).toEqual({ method: 'POST', path: '/api/v1/projects/p1/stories/s1/assign' });
        expect(boardActionRequest('p1', 'task.claim', { taskId: 't1' })).toEqual({ method: 'POST', path: '/api/v1/projects/p1/tasks/t1/claim' });
        expect(boardActionRequest('p1', 'task.unclaim', { taskId: 't1' })).toEqual({ method: 'POST', path: '/api/v1/projects/p1/tasks/t1/release' });
        expect(boardActionRequest('p1', 'task.assign', { taskId: 't1' })).toEqual({ method: 'POST', path: '/api/v1/projects/p1/tasks/t1/assign' });
        expect(boardActionRequest('p1', 'board.claimants', {})).toEqual({ method: 'GET', path: '/api/v1/projects/p1/claimants' });
        for (const id of ['story.claim', 'story.unclaim', 'story.assign', 'task.claim', 'task.unclaim', 'task.assign', 'board.claimants']) {
            expect(BOARD_API[id]).toBeDefined();
            expect(BOARD_GAPS[id]).toBeUndefined();
        }
    });
});

type Call = { path: string; method: string; body?: unknown };
function ports(answers: Array<{ status: number; body: unknown }>) {
    const calls: Call[] = [];
    let i = 0;
    const p: TynnBoardPorts = {
        signedIn: () => true,
        projectFor: () => 'p1',
        request: async (path, init) => {
            calls.push({ path, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) });
            const a = answers[Math.min(i++, answers.length - 1)]!;
            return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
        },
    };
    return { p, calls };
}

describe('claiming and releasing', () => {
    it('POSTs with no body', async () => {
        const { p, calls } = ports([{ status: 200, body: { id: 't1', claimed_by: ADA, claimed_by_me: true } }]);
        expect(await runTynnBoardAction(p, 'w1', { action: 'task.claim', ids: { taskId: 't1' }, body: { anything: 1 } })).toEqual({ ok: true });
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.unclaim', ids: { storyId: 's1' } })).toEqual({ ok: true });
        expect(calls).toEqual([
            { path: '/api/v1/projects/p1/tasks/t1/claim', method: 'POST' },
            { path: '/api/v1/projects/p1/stories/s1/release', method: 'POST' },
        ]);
    });

    it('a claim Tynn refuses comes back in Tynn\'s words (errors.claim)', async () => {
        const { p } = ports([{ status: 422, body: { message: 'x', errors: { claim: ['Already claimed by Builder Bot.'] } } }]);
        expect(await runTynnBoardAction(p, 'w1', { action: 'task.claim', ids: { taskId: 't1' } }))
            .toEqual({ ok: false, state: 'transition-refused', reason: 'Already claimed by Builder Bot.' });
    });
});

describe('assigning', () => {
    it('sends the claimant\'s type and id, and nothing else', async () => {
        const { p, calls } = ports([{ status: 200, body: { id: 't1', claimed_by: BOT, claimed_by_me: false } }]);
        await runTynnBoardAction(p, 'w1', { action: 'task.assign', ids: { taskId: 't1' }, body: { type: 'agent', id: 'a1', name: 'Builder Bot', extra: true } });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/tasks/t1/assign', method: 'POST', body: { assignee_type: 'agent', assignee_id: 'a1' } }]);
    });

    it('without a claimant, or with one that is neither a person nor an agent, nothing is sent', async () => {
        const { p, calls } = ports([{ status: 200, body: {} }]);
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.assign', ids: { storyId: 's1' } })).toMatchObject({ ok: false, state: 'error' });
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.assign', ids: { storyId: 's1' }, body: { type: 'robot', id: 'r1' } })).toMatchObject({ ok: false, state: 'error' });
        expect(calls).toEqual([]);
    });

    it('a claimant Tynn will not take comes back in Tynn\'s words (errors.assignee)', async () => {
        const { p } = ports([{ status: 422, body: { errors: { assignee: ['User is not a member of this project.'] } } }]);
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.assign', ids: { storyId: 's1' }, body: { type: 'user', id: 'u9' } }))
            .toEqual({ ok: false, state: 'transition-refused', reason: 'User is not a member of this project.' });
    });
});

describe('the claimant list', () => {
    it('is read with GET /claimants and handed back', async () => {
        const { p, calls } = ports([{ status: 200, body: { claimants: [ADA, BOT, { type: 'robot', id: 'x', name: 'X' }, { type: 'user', name: 'no id' }] } }]);
        expect(await runTynnBoardAction(p, 'w1', { action: 'board.claimants', ids: {} })).toEqual({ ok: true, claimants: [ADA, BOT] });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/claimants', method: 'GET' }]);
    });

    it('a list Tynn will not show (the person may not assign) is the board\'s refusal', async () => {
        const { p } = ports([{ status: 404, body: {} }]);
        expect(await runTynnBoardAction(p, 'w1', { action: 'board.claimants', ids: {} })).toMatchObject({ ok: false });
    });

    it('parses only people and agents with an id and a name', () => {
        expect(parseClaimants({ claimants: [ADA, BOT, null, { type: 'agent', id: 'a2' }] })).toEqual([ADA, BOT]);
        expect(parseClaimants('nope')).toEqual([]);
    });

    it('a detail read is still not something to run', async () => {
        const { p, calls } = ports([{ status: 200, body: {} }]);
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.detail', ids: { storyId: 's1' } })).toMatchObject({ ok: false, state: 'error' });
        expect(calls).toEqual([]);
    });
});

// ── The board's claim settings and the claim-aware Start ──────────────────────────────────────────────────────────────

describe('the board\'s claims', () => {
    it('reads the project\'s claim settings, and each card\'s claimant: initials for a person, the agent mark for an agent', () => {
        const v = board([story('s1', { claimed_by: ADA, claimed_by_me: true }), story('s2', { claimed_by: BOT })], { mode: 'required', policy: 'human', can_assign: false });
        expect(v.claims).toEqual({ mode: 'required', policy: 'human', canAssign: false });
        const [mine, bots] = v.columns[0]!.cards;
        expect(mine!.claim).toEqual({ type: 'user', id: 'u1', name: 'Ada Lovelace', initials: 'AL', mine: true });
        expect(bots!.claim).toEqual({ type: 'agent', id: 'a1', name: 'Builder Bot', initials: 'BB', mine: false });
    });

    it('an older Tynn without claim settings: no claims, and Start is plain', () => {
        const v = board([story('s1')], undefined);
        expect(v.claims).toBeNull();
        expect(startPlan(v.columns[0]!.cards[0]!, v.claims)).toBe('start');
    });

    it('a backlog card\'s Start follows the claim mode, as tynn.ai\'s: off or mine starts; optional chooses; required claims first', () => {
        const card = (extra: Record<string, unknown> = {}) => board([story('s1', extra)]).columns[0]!.cards[0]!;
        const at = (mode: string) => ({ mode, policy: 'any', canAssign: false }) as const;
        expect(startPlan(card(), at('off'))).toBe('start');
        expect(startPlan(card(), at('optional'))).toBe('choose');
        expect(startPlan(card(), at('required'))).toBe('claim-then-start');
        expect(startPlan(card({ claimed_by: ADA, claimed_by_me: true }), at('required'))).toBe('start');
    });

    it('initials: first and last word, upper case; one word gives one letter', () => {
        expect(initialsOf('Ada Lovelace')).toBe('AL');
        expect(initialsOf('ada king lovelace')).toBe('AL');
        expect(initialsOf('Cher')).toBe('C');
        expect(initialsOf('  ')).toBe('?');
    });
});

describe('claim, then start', () => {
    const ids = { storyId: 's1' };
    it('claims, then starts once the claim lands, and says so', async () => {
        const seen: BoardOp[] = [];
        const ran: string[] = [];
        const host: Pick<TynnBoardHost, 'act'> = { act: async (_w, input) => { ran.push(input.action); return { ok: true }; } };
        expect(await performClaimThenStart(host, 'w1', 'story', ids, (op) => seen.push(op))).toEqual({ ok: true });
        expect(ran).toEqual(['story.claim', 'story.start']);
        expect(seen).toEqual([{ action: 'story.claim-start', phase: 'running' }, { action: 'story.claim-start', phase: 'done' }]);
    });

    it('a refused claim does not start, and says why', async () => {
        const seen: BoardOp[] = [];
        const ran: string[] = [];
        const host: Pick<TynnBoardHost, 'act'> = { act: async (_w, input) => { ran.push(input.action); return { ok: false, state: 'transition-refused', reason: 'Claiming is turned off for this project.' }; } };
        await performClaimThenStart(host, 'w1', 'story', ids, (op) => seen.push(op));
        expect(ran).toEqual(['story.claim']);
        expect(seen.at(-1)).toEqual({ action: 'story.claim-start', phase: 'failed', reason: 'Claiming is turned off for this project.' });
    });

    it('a refused start after the claim says the start\'s reason', async () => {
        const seen: BoardOp[] = [];
        const host: Pick<TynnBoardHost, 'act'> = { act: async (_w, input: BoardActionInput) => (input.action.endsWith('.claim') ? { ok: true } : { ok: false, state: 'transition-refused', reason: 'Cannot start story: parent version is not active.' }) };
        await performClaimThenStart(host, 'w1', 'story', ids, (op) => seen.push(op));
        expect(seen.at(-1)).toEqual({ action: 'story.claim-start', phase: 'failed', reason: 'Cannot start story: parent version is not active.' });
    });
});

// ── The tab ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the tab', () => {
    const render = (v: ReturnType<typeof board>, extra: Record<string, unknown> = {}) =>
        renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: v, ...extra }} onScope={noop} onAction={noop} onRetry={noop} />);

    it('a claimed card shows the person\'s initials, named on hover and for a screen reader', () => {
        const html = render(board([story('s1', { claimed_by: ADA })]));
        expect(html).toMatch(/data-tynn-claimant="u1"/);
        expect(html).toContain('>AL<');
        expect(html).toContain('title="Claimed by Ada Lovelace"');
        expect(html).not.toMatch(/data-tynn-release=/);
    });

    it('an agent\'s claim shows the agent mark, not initials', () => {
        const html = render(board([story('s1', { claimed_by: BOT })]));
        expect(html).toMatch(/data-tynn-claimant="a1"[^>]*data-tynn-claimant-kind="agent"|data-tynn-claimant-kind="agent"[^>]*data-tynn-claimant="a1"/);
        expect(html).toContain('title="Claimed by Builder Bot (agent)"');
        expect(html).not.toContain('>BB<');
    });

    it('the person who holds the claim can release it, from an icon', () => {
        const html = render(board([story('s1', { claimed_by: ADA, claimed_by_me: true })]));
        expect(html).toMatch(/data-tynn-release="s1"[^>]*aria-label="Release claim"|aria-label="Release claim"[^>]*data-tynn-release="s1"/);
    });

    it('Start follows the claim mode: required is one "Claim and start" icon; optional opens a choice; off is a plain Start', () => {
        const required = render(board([story('s1')], { mode: 'required', policy: 'any', can_assign: false }));
        expect(required).toMatch(/data-tynn-step="story.claim-start"[^>]*aria-label="Claim and start"|aria-label="Claim and start"[^>]*data-tynn-step="story.claim-start"/);
        const optional = render(board([story('s1')], { mode: 'optional', policy: 'any', can_assign: false }));
        expect(optional).toMatch(/data-tynn-start-choice="s1"/);
        expect(optional).toMatch(/aria-haspopup="menu"/);
        const off = render(board([story('s1')], { mode: 'off', policy: 'any', can_assign: false }));
        expect(off).toMatch(/data-tynn-step="story.start"[^>]*aria-label="Start"|aria-label="Start"[^>]*data-tynn-step="story.start"/);
    });

    it('offers Assign only to a person who may manage the project', () => {
        expect(render(board([story('s1')], { mode: 'optional', policy: 'any', can_assign: true }))).toMatch(/data-tynn-assign="s1"[^>]*aria-label="Assign to…"|aria-label="Assign to…"[^>]*data-tynn-assign="s1"/);
        expect(render(board([story('s1')], { mode: 'optional', policy: 'any', can_assign: false }))).not.toMatch(/data-tynn-assign=/);
    });

    it('a claim in flight says so; a failed one says why and offers Retry; a finished one says it worked', () => {
        const v = board([story('s1')]);
        const running = render(v, { op: { action: 'story.claim-start', phase: 'running' } });
        expect(running).toMatch(/data-tynn-op="running"/);
        expect(running).toContain('Claiming and starting');
        const failed = render(v, { op: { action: 'story.assign', phase: 'failed', reason: 'User is not a member of this project.' } });
        expect(failed).toMatch(/data-tynn-op="failed"/);
        expect(failed).toContain('User is not a member of this project.');
        expect(failed).toMatch(/data-tynn-retry=""/);
        expect(render(v, { op: { action: 'task.unclaim', phase: 'done' } })).toContain('Claim released');
    });
});
