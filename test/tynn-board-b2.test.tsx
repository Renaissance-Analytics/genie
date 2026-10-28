import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    boardActionRequest,
    parseBoard,
    parseDetail,
    performBoardAction,
    type BoardActionInput,
    type BoardOp,
    type TynnBoardHost,
} from '../src/core/tynn-board.js';
import { readTynnBoard, runTynnBoardAction, type TynnBoardPorts } from '../src/main/tynn-board-client.js';
import { TynnBoardPanel } from '../src/renderer/components/TynnBoardPanel.js';

/**
 * THE TYNN TAB, ROW B2 (genie#1295; workspace-ux 0.2.0): create, edit and detail for stories and tasks, as tynn.ai's board
 * offers them — a "New …" in the start column, a card's detail flyout, and its edit. Tynn's JSON door (genie:board) has
 * POST /stories, POST /tasks, PATCH and GET /stories/{id} and /tasks/{id}; a new item starts in backlog there.
 *
 * Every action shows that it is running, then that it worked — or Tynn's reason and a Retry (the owner, 2026-10-27: real
 * buttons, visible progress, never silent). Buttons are icons named for a screen reader.
 */
const noop = () => {};

const STORIES = parseBoard({
    project_id: 'p1', level: 'stories', version_id: 'v1', story_id: null, active_story: null,
    active_version: { id: 'v1', number: '0.4', title: 'Line', status: 'active', story_count: 1, stories_done: 0, task_count: 0, tasks_done: 0 },
    versions: [], tasks: null,
    stories: [{ id: 's1', story_number: 7, title: 'Ship the board', status: 'backlog', order: 0, task_count: 0, tasks_done: 0, claimed_by: null, can_start: true, can_move_to_qa: false, version_active: true }],
})!;
const VERSIONS = parseBoard({ project_id: 'p1', level: 'versions', version_id: null, story_id: null, versions: [], stories: null, tasks: null, active_version: null, active_story: null })!;

/** Tynn's FocusPayloadService story, trimmed to what the flyout reads. */
const STORY_DETAIL = {
    kind: 'story', id: 's1', number: 7, slug: 'ship', title: 'Ship <the> board', description: 'Make it so.\nSecond line.',
    status: 'backlog', acceptance_criteria: ['It ships', 'It is tested'], tags: [], features: [{ id: 'f1', title: 'Board' }],
    tasks: [{ id: 't1', number: 1, title: 'Wire it', status: 'doing', description: null, code_area: null, features: [] }],
    version: { id: 'v1', number: '0.4', title: 'Line', status: 'active' },
};
const TASK_DETAIL = {
    kind: 'task', id: 't1', number: 1, title: 'Wire it', description: 'Do the wiring.', status: 'doing',
    features: [], verification_steps: ['Open the tab'], code_area: 'src/renderer', blocking_on: [], produces: [],
    story: { id: 's1', number: 7, title: 'Ship the board' },
};

// ── The calls ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the calls behind create, edit and detail', () => {
    it('are the contract\'s paths under the workspace\'s project', () => {
        expect(boardActionRequest('p1', 'story.create', { versionId: 'v1' })).toEqual({ method: 'POST', path: '/api/v1/projects/p1/stories' });
        expect(boardActionRequest('p1', 'task.create', { storyId: 's1' })).toEqual({ method: 'POST', path: '/api/v1/projects/p1/tasks' });
        expect(boardActionRequest('p1', 'story.edit', { storyId: 's 1' })).toEqual({ method: 'PATCH', path: '/api/v1/projects/p1/stories/s%201' });
        expect(boardActionRequest('p1', 'task.edit', { taskId: 't1' })).toEqual({ method: 'PATCH', path: '/api/v1/projects/p1/tasks/t1' });
        expect(boardActionRequest('p1', 'story.detail', { storyId: 's1' })).toEqual({ method: 'GET', path: '/api/v1/projects/p1/stories/s1' });
        expect(boardActionRequest('p1', 'task.detail', { taskId: 't1' })).toEqual({ method: 'GET', path: '/api/v1/projects/p1/tasks/t1' });
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
const BOARD_JSON = { project_id: 'p1', level: 'stories', version_id: 'v1', story_id: null, versions: [], stories: [], tasks: null, active_version: { id: 'v1', number: '0.4' }, active_story: null };

describe('creating', () => {
    it('a story: POST /stories with its version, title and description — nothing else, and no status', async () => {
        const { p, calls } = ports([{ status: 201, body: STORY_DETAIL }]);
        const r = await runTynnBoardAction(p, 'w1', { action: 'story.create', ids: { versionId: 'v1' }, body: { title: ' New one ', description: 'Why.', status: 'done', extra: 1 } });
        expect(r).toEqual({ ok: true });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/stories', method: 'POST', body: { version_id: 'v1', title: 'New one', description: 'Why.' } }]);
    });

    it('a task: POST /tasks with its story', async () => {
        const { p, calls } = ports([{ status: 201, body: TASK_DETAIL }]);
        await runTynnBoardAction(p, 'w1', { action: 'task.create', ids: { storyId: 's1' }, body: { title: 'T', description: 'D' } });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/tasks', method: 'POST', body: { story_id: 's1', title: 'T', description: 'D' } }]);
    });

    it('without a title, a description or its parent is refused here, and nothing is sent', async () => {
        const { p, calls } = ports([{ status: 201, body: {} }]);
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.create', ids: { versionId: 'v1' }, body: { title: '  ', description: 'D' } })).toMatchObject({ ok: false, state: 'error' });
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.create', ids: { versionId: 'v1' }, body: { title: 'T' } })).toMatchObject({ ok: false, state: 'error' });
        expect(await runTynnBoardAction(p, 'w1', { action: 'task.create', ids: {}, body: { title: 'T', description: 'D' } })).toMatchObject({ ok: false, state: 'error' });
        expect(calls).toEqual([]);
    });

    it('a refusal comes back in Tynn\'s words', async () => {
        const { p } = ports([{ status: 422, body: { message: 'x', errors: { title: ['The title field must not be greater than 255 characters.'] } } }]);
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.create', ids: { versionId: 'v1' }, body: { title: 'T', description: 'D' } }))
            .toEqual({ ok: false, state: 'transition-refused', reason: 'The title field must not be greater than 255 characters.' });
    });
});

describe('editing', () => {
    it('a story: PATCH with only the fields the flyout edits; never a status', async () => {
        const { p, calls } = ports([{ status: 200, body: STORY_DETAIL }]);
        await runTynnBoardAction(p, 'w1', { action: 'story.edit', ids: { storyId: 's1' }, body: { title: 'New', description: '', acceptance_criteria: ['a', ' ', 'b'], status: 'done', verification_steps: ['x'] } });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/stories/s1', method: 'PATCH', body: { title: 'New', description: '', acceptance_criteria: ['a', 'b'] } }]);
    });

    it('a task: title, description, verification steps and code area', async () => {
        const { p, calls } = ports([{ status: 200, body: TASK_DETAIL }]);
        await runTynnBoardAction(p, 'w1', { action: 'task.edit', ids: { taskId: 't1' }, body: { title: 'T', verification_steps: ['Open it'], code_area: 'src', acceptance_criteria: ['no'] } });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/tasks/t1', method: 'PATCH', body: { title: 'T', verification_steps: ['Open it'], code_area: 'src' } }]);
    });

    it('an edit with nothing to change, or an empty title, is refused here', async () => {
        const { p, calls } = ports([{ status: 200, body: {} }]);
        expect(await runTynnBoardAction(p, 'w1', { action: 'story.edit', ids: { storyId: 's1' }, body: { status: 'done' } })).toMatchObject({ ok: false, state: 'error' });
        expect(await runTynnBoardAction(p, 'w1', { action: 'task.edit', ids: { taskId: 't1' }, body: { title: ' ' } })).toMatchObject({ ok: false, state: 'error' });
        expect(calls).toEqual([]);
    });
});

describe('the detail (the focus flyout)', () => {
    it('is read with the board when the scope names a focus, as tynn.ai\'s ?focus= does', async () => {
        const { p, calls } = ports([{ status: 200, body: BOARD_JSON }, { status: 200, body: STORY_DETAIL }]);
        const r = await readTynnBoard(p, 'w1', { version: 'v1', focus: 'story:s1' });
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/projects/p1/board?version=v1', 'GET /api/v1/projects/p1/stories/s1']);
        expect(r).toMatchObject({ ok: true, detail: { kind: 'story', id: 's1', title: 'Ship <the> board', acceptanceCriteria: ['It ships', 'It is tested'] } });
    });

    it('a detail Tynn will not show is said, and the board still shows', async () => {
        const { p } = ports([{ status: 200, body: BOARD_JSON }, { status: 404, body: {} }]);
        const r = await readTynnBoard(p, 'w1', { version: 'v1', focus: 'task:t9' });
        expect(r).toMatchObject({ ok: true, detail: null, detailRefused: expect.stringMatching(/\S/) });
    });

    it('parses a story and a task as the flyout draws them', () => {
        expect(parseDetail(STORY_DETAIL)).toMatchObject({ kind: 'story', number: '#7', description: 'Make it so.\nSecond line.', features: ['Board'], tasks: [{ id: 't1', number: '#1', title: 'Wire it', status: 'doing' }] });
        expect(parseDetail(TASK_DETAIL)).toMatchObject({ kind: 'task', verificationSteps: ['Open the tab'], codeArea: 'src/renderer', parent: { id: 's1', label: '#7 Ship the board' } });
        expect(parseDetail({ kind: 'version' })).toBeNull();
    });
});

// ── Progress: running, then worked or failed with a retry ─────────────────────────────────────────────────────────────

describe('an action\'s progress', () => {
    const input: BoardActionInput = { action: 'story.create', ids: { versionId: 'v1' }, body: { title: 'T', description: 'D' } };
    const host = (answer: Awaited<ReturnType<TynnBoardHost['act']>>): Pick<TynnBoardHost, 'act'> => ({ act: async () => answer });

    it('says it is running, then that it worked', async () => {
        const seen: BoardOp[] = [];
        const r = await performBoardAction(host({ ok: true }), 'w1', input, (op) => seen.push(op));
        expect(r).toEqual({ ok: true });
        expect(seen).toEqual([{ action: 'story.create', phase: 'running' }, { action: 'story.create', phase: 'done' }]);
    });

    it('says it is running, then why it failed — never silent', async () => {
        const seen: BoardOp[] = [];
        await performBoardAction(host({ ok: false, state: 'transition-refused', reason: 'Stories are created in Backlog.' }), 'w1', input, (op) => seen.push(op));
        expect(seen).toEqual([{ action: 'story.create', phase: 'running' }, { action: 'story.create', phase: 'failed', reason: 'Stories are created in Backlog.' }]);
    });

    it('a host that throws is a failure with its message, not a hang', async () => {
        const seen: BoardOp[] = [];
        await performBoardAction({ act: async () => { throw new Error('Tynn is unreachable'); } }, 'w1', input, (op) => seen.push(op));
        expect(seen.at(-1)).toEqual({ action: 'story.create', phase: 'failed', reason: 'Tynn is unreachable' });
    });
});

// ── The tab ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the tab', () => {
    it('offers "New story" as an icon on a version\'s stories — not on the versions board, which has no API for it yet', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES }} onScope={noop} onAction={noop} />);
        expect(html).toMatch(/data-tynn-new="story"[^>]*aria-label="New story"|aria-label="New story"[^>]*data-tynn-new="story"/);
        expect(renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: VERSIONS }} onScope={noop} onAction={noop} />)).not.toMatch(/data-tynn-new=/);
    });

    it('opens a card\'s detail from an icon on the card', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES }} onScope={noop} onAction={noop} />);
        expect(html).toMatch(/data-tynn-details="s1"[^>]*aria-label="Details"|aria-label="Details"[^>]*data-tynn-details="s1"/);
    });

    it('while a create runs: the form is held, its button disabled, and it says so', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, op: { action: 'story.create', phase: 'running' } }} onScope={noop} onAction={noop} />);
        expect(html).toMatch(/data-tynn-new-form="story"/);
        expect(html).toMatch(/data-tynn-op="running"/);
        expect(html).toContain('Creating story');
        expect(html).toMatch(/<button[^>]*data-tynn-submit=""[^>]*disabled=""|<button[^>]*disabled=""[^>]*data-tynn-submit=""/);
    });

    it('a failed create keeps the form, says why in Tynn\'s words, and offers Retry', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, op: { action: 'story.create', phase: 'failed', reason: 'Stories are created in Backlog.' } }} onScope={noop} onAction={noop} onRetry={noop} />);
        expect(html).toMatch(/data-tynn-new-form="story"/);
        expect(html).toMatch(/data-tynn-op="failed"[^>]*role="alert"|role="alert"[^>]*data-tynn-op="failed"/);
        expect(html).toContain('Stories are created in Backlog.');
        expect(html).toMatch(/data-tynn-retry=""/);
    });

    it('a finished action says it worked', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, op: { action: 'story.create', phase: 'done' } }} onScope={noop} onAction={noop} />);
        expect(html).toMatch(/data-tynn-op="done"/);
        expect(html).not.toMatch(/data-tynn-new-form=/);
    });

    it('the detail flyout: Tynn\'s text as text, the criteria, the tasks, an Edit icon and a Close', () => {
        const detail = parseDetail(STORY_DETAIL)!;
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, detail }} onScope={noop} onAction={noop} />);
        expect(html).toMatch(/data-tynn-detail="s1"/);
        expect(html).toContain('Ship &lt;the&gt; board');
        expect(html).toContain('It is tested');
        expect(html).toContain('Wire it');
        expect(html).toMatch(/aria-label="Edit"/);
        expect(html).toMatch(/aria-label="Close"/);
    });

    it('while an edit saves: the edit form is held, Save disabled, and it says so', () => {
        const detail = parseDetail(TASK_DETAIL)!;
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, detail, op: { action: 'task.edit', phase: 'running' } }} onScope={noop} onAction={noop} />);
        expect(html).toMatch(/data-tynn-edit-form="t1"/);
        expect(html).toContain('Saving');
        expect(html).toMatch(/<button[^>]*data-tynn-submit=""[^>]*disabled=""|<button[^>]*disabled=""[^>]*data-tynn-submit=""/);
    });

    it('a detail Tynn would not show says why, beside the board', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, detail: null, detailRefused: 'Tynn did not show this story.' }} onScope={noop} onAction={noop} />);
        expect(html).toContain('Tynn did not show this story.');
    });
});
