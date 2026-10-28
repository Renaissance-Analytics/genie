import { describe, expect, it } from 'vitest';
import { boardActionRequest, boardQueryPath, canDrop, parseBoard } from '../src/core/tynn-board.js';

/**
 * THE TYNN TAB'S BOARD (genie#1295): tynn.ai's board, natively in Genie — versions → a version's stories → a story's
 * tasks, the columns tynn.ai shows, each card's one-click next step with the same guards, drag gated by the same
 * transitions (Shift drops anywhere, as on tynn.ai). Read from Tynn's JSON door with the pairing credential.
 */
const version = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, number: id.toUpperCase(), title: `Version ${id}`, status, story_count: 2, stories_done: 1, task_count: 4, tasks_done: 3, ...extra });
const story = (id: string, status: string, order: number, extra: Record<string, unknown> = {}) => ({ id, story_number: order + 1, title: `Story ${id}`, status, order, task_count: 2, tasks_done: 0, claimed_by: null, can_start: true, can_move_to_qa: false, version_active: true, ...extra });
const task = (id: string, status: string, order: number, extra: Record<string, unknown> = {}) => ({ id, task_number: order + 1, title: `Task ${id}`, status, order, story_id: 's1', claimed_by: null, can_start: true, version_active: true, ...extra });

const VERSIONS = { project_id: 'p1', level: 'versions', version_id: null, story_id: null, versions: [version('v1', 'active'), version('v2', 'draft'), version('v3', 'released')], stories: null, tasks: null, active_version: null, active_story: null };
const STORIES = { ...VERSIONS, level: 'stories', version_id: 'v1', active_version: version('v1', 'active'), stories: [story('s2', 'backlog', 1), story('s1', 'backlog', 0, { can_start: false }), story('s3', 'in_progress', 0), story('s4', 'qa', 0)] };
const TASKS = { ...VERSIONS, level: 'tasks', story_id: 's1', active_story: { id: 's1', slug: 'story-s1', title: 'Story s1', story_number: 1, version_id: 'v1' }, tasks: [task('t1', 'doing', 0, { version_active: false }), task('t2', 'blocked', 0, { claimed_by: { type: 'agent', id: 'a1', name: 'tynn' } })] };

describe('reading the board', () => {
    it('the versions board: tynn.ai\'s four columns; a released version is off the board, as on tynn.ai', () => {
        const v = parseBoard(VERSIONS)!;
        expect(v.level).toBe('versions');
        expect(v.columns.map((c) => c.status)).toEqual(['draft', 'accepted', 'active', 'review']);
        expect(v.columns.find((c) => c.status === 'active')!.cards.map((c) => c.id)).toEqual(['v1']);
        expect(v.columns.flatMap((c) => c.cards).map((c) => c.id)).not.toContain('v3');
        expect(v.draggable).toBe(false);
        expect(v.up).toBeNull();
    });

    it('a version\'s stories, in tynn.ai\'s order, with the way back up to the versions', () => {
        const v = parseBoard(STORIES)!;
        expect(v.columns.map((c) => c.status)).toEqual(['backlog', 'blocked', 'in_progress', 'qa', 'done']);
        expect(v.columns[0]!.cards.map((c) => c.id)).toEqual(['s1', 's2']);
        expect(v.up).toEqual({});
        expect(v.crumbs).toEqual([{ label: 'V1', scope: { version: 'v1' } }]);
        expect(v.draggable).toBe(true);
    });

    it('a story\'s tasks, with the way back up to its version\'s stories', () => {
        const v = parseBoard(TASKS)!;
        expect(v.columns.map((c) => c.status)).toEqual(['backlog', 'blocked', 'doing', 'qa', 'done']);
        expect(v.up).toEqual({ version: 'v1' });
        expect(v.columns.find((c) => c.status === 'blocked')!.cards[0]!.claimedBy).toBe('tynn');
    });

    it('refuses what is not a board, rather than drawing an empty one', () => {
        expect(parseBoard(null)).toBeNull();
        expect(parseBoard({ level: 'nonsense' })).toBeNull();
        expect(parseBoard({ ...STORIES, stories: 'x' })).toBeNull();
    });
});

describe('each card\'s one-click next step (tynn.ai\'s card buttons)', () => {
    it('versions: accept a draft, start an accepted, review an active, release a review', () => {
        const v = parseBoard({ ...VERSIONS, versions: [version('a', 'draft'), version('b', 'accepted'), version('c', 'active'), version('d', 'review')] })!;
        const steps = Object.fromEntries(v.columns.flatMap((c) => c.cards).map((c) => [c.status, c.quick?.actionId]));
        expect(steps).toEqual({ draft: 'version.accept', accepted: 'version.start', active: 'version.review', review: 'version.release' });
    });

    it('stories: start is held while it cannot start, ready while tasks are open — the reason tynn.ai gives', () => {
        const v = parseBoard(STORIES)!;
        const card = (id: string) => v.columns.flatMap((c) => c.cards).find((c) => c.id === id)!;
        expect(card('s1').quick).toMatchObject({ actionId: 'story.start', disabled: true });
        expect(card('s2').quick).toMatchObject({ actionId: 'story.start', disabled: false });
        expect(card('s3').quick).toMatchObject({ actionId: 'story.ready', disabled: true });
        expect(card('s4').quick).toMatchObject({ actionId: 'story.done', disabled: false });
    });

    it('tasks: ready is held while the version is not active; a blocked task restarts', () => {
        const v = parseBoard(TASKS)!;
        const card = (id: string) => v.columns.flatMap((c) => c.cards).find((c) => c.id === id)!;
        expect(card('t1').quick).toMatchObject({ actionId: 'task.ready', disabled: true });
        expect(card('t2').quick).toMatchObject({ actionId: 'task.restart', disabled: false });
    });
});

describe('drag', () => {
    it('drops only where the card can go; Shift drops anywhere; versions never drag', () => {
        expect(canDrop('stories', 'backlog', 'in_progress', false)).toBe(true);
        expect(canDrop('stories', 'backlog', 'done', false)).toBe(false);
        expect(canDrop('stories', 'backlog', 'done', true)).toBe(true);
        expect(canDrop('tasks', 'doing', 'qa', false)).toBe(true);
        expect(canDrop('tasks', 'doing', 'doing', false)).toBe(true);
        expect(canDrop('versions', 'draft', 'accepted', true)).toBe(false);
    });
});

describe('the requests', () => {
    it('the board for a scope, under the workspace\'s own project — never one the person picks', () => {
        expect(boardQueryPath('p1', {})).toBe('/api/v1/projects/p1/board');
        expect(boardQueryPath('p1', { version: 'v1' })).toBe('/api/v1/projects/p1/board?version=v1');
        expect(boardQueryPath('p 1', { story: 's/1' })).toBe('/api/v1/projects/p%201/board?story=s%2F1');
    });

    it('an action on an item: the contract\'s method and path, ids encoded; an action Genie does not offer is null', () => {
        expect(boardActionRequest('p1', 'task.start', { taskId: 't1' })).toEqual({ method: 'POST', path: '/api/v1/projects/p1/tasks/t1/start' });
        expect(boardActionRequest('p1', 'story.move', { storyId: 'a/b' })).toEqual({ method: 'POST', path: '/api/v1/projects/p1/stories/a%2Fb/move' });
        expect(boardActionRequest('p1', 'version.delete', { versionId: 'v1' })).toEqual({ method: 'DELETE', path: '/api/v1/projects/p1/versions/v1' });
        // A BOARD_GAPS entry (versions' edit has no API yet) is not offered; claiming is, since workspace-ux 0.3.0.
        expect(boardActionRequest('p1', 'version.edit', { versionId: 'v1' })).toBeNull();
        // An id the path needs and was not given is no request at all, never a path with a hole in it.
        expect(boardActionRequest('p1', 'task.start', {})).toBeNull();
    });
});
