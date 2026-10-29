import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    applyBoardChanges,
    BoardFollower,
    BOARD_LIVE,
    boardChangesPath,
    liveChannel,
    LIVE_QUIET_MS,
    liveReconnectDelay,
    parseBoard,
    parseBoardChanges,
    ringIds,
    type BoardView,
} from '../src/core/tynn-board.js';
import { TynnBoardPanel } from '../src/renderer/components/TynnBoardPanel.js';

/**
 * THE LIVE BOARD (genie#1295 row B4, workspace-ux 0.4.0 `data.live`).
 *
 * Tynn rings the web board's own channel (`private-project.{id}`) when the board changes, by a person or an agent. A ring
 * is a doorbell: the tab asks `GET /board/changes?since=<cursor>` and applies only what came back — the rows that
 * changed, and the ids of every row now at the level (a card not among them is gone). It never re-reads the whole
 * board, and it never rebuilds the whole view: a card that did not change keeps its object, a column whose cards did
 * not change keeps its object, so React redraws only what changed (the owner's rule for live views).
 */
const story = (id: string, status: string, order: number, extra: Record<string, unknown> = {}) => ({ id, story_number: order + 1, title: `Story ${id}`, status, order, task_count: 2, tasks_done: 0, claimed_by: null, claimed_by_me: false, can_start: true, can_move_to_qa: false, version_active: true, ...extra });
const BOARD = {
    project_id: 'p1', cursor: '2026-10-28T12:00:00Z', level: 'stories', version_id: 'v1', story_id: null,
    versions: [], features: [], stories_for_picker: null, tasks: null,
    active_version: { id: 'v1', number: '0.4', title: 'Live', status: 'active' }, active_story: null,
    claims: { mode: 'optional', policy: 'any', can_assign: true },
    stories: [story('s1', 'backlog', 0), story('s2', 'backlog', 1), story('s3', 'in_progress', 0), story('s4', 'qa', 0)],
};
const changes = (rows: unknown[], ids: string[], extra: Record<string, unknown> = {}) => ({
    project_id: 'p1', level: 'stories', version_id: 'v1', story_id: null, cursor: '2026-10-28T12:05:00Z', ids, rows,
    active_version: BOARD.active_version, active_story: null, claims: BOARD.claims, ...extra,
});
const ALL = ['s1', 's2', 's3', 's4'];
const view = () => parseBoard(BOARD)!;
const col = (v: BoardView, status: string) => v.columns.find((c) => c.status === status)!;
const apply = (v: BoardView, json: unknown) => applyBoardChanges(v, parseBoardChanges(json)!);

describe('the contract\'s live block, as the tab declares it', () => {
    it('listens on the web board\'s own channel, to the board\'s own events', () => {
        expect(liveChannel('01JPROJ')).toBe('private-project.01JPROJ');
        expect(BOARD_LIVE.events).toEqual(['version.created', 'version.updated', 'version.deleted', 'story.created', 'story.updated', 'story.deleted', 'task.created', 'task.updated', 'task.deleted']);
    });

    it('asks what changed since its cursor, in the board\'s own scope, and for rows by id', () => {
        expect(boardChangesPath('p 1', { version: 'v1' }, '2026-10-28T12:00:00Z', []))
            .toBe('/api/v1/projects/p%201/board/changes?version=v1&since=2026-10-28T12%3A00%3A00Z');
        expect(boardChangesPath('p1', { story: 's1', focus: 'task:t1' }, 'c', ['t1', 't2']))
            .toBe('/api/v1/projects/p1/board/changes?story=s1&since=c&ids%5B%5D=t1&ids%5B%5D=t2');
    });

    it('the board read carries the cursor the first catch-up starts from', () => {
        expect(view().cursor).toBe('2026-10-28T12:00:00Z');
        expect(parseBoard({ ...BOARD, cursor: undefined })!.cursor).toBeNull();
    });

    it('reconnects with a growing backoff, capped', () => {
        expect([0, 1, 2, 3, 4, 5, 6, 12].map(liveReconnectDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    });

    it('reads the ids a ring names: the item, and the parent it belongs to', () => {
        expect(ringIds('task.updated', { task: { id: 't1', story_id: 's1' } })).toEqual(['t1', 's1']);
        expect(ringIds('story.deleted', { story: { id: 's1', project_version_id: 'v1' } })).toEqual(['s1', 'v1']);
        expect(ringIds('version.updated', { version: { id: 'v1' } })).toEqual(['v1']);
        expect(ringIds('story.updated', 'garbage')).toEqual([]);
    });
});

describe('what changed, applied to the board', () => {
    it('changes ONLY the card that changed: every other card and column keeps its object', () => {
        const before = view();
        const { view: after, missing } = apply(before, changes([story('s2', 'backlog', 1, { title: 'Renamed live' })], ALL));

        expect(missing).toEqual([]);
        expect(col(after, 'backlog').cards.map((c) => c.title)).toEqual(['Story s1', 'Renamed live']);
        expect(col(after, 'backlog').cards[0]).toBe(col(before, 'backlog').cards[0]);
        for (const status of ['blocked', 'in_progress', 'qa', 'done']) expect(col(after, status)).toBe(col(before, status));
    });

    it('moves a card between columns: only those two columns change', () => {
        const before = view();
        const { view: after } = apply(before, changes([story('s1', 'in_progress', 1)], ALL));

        expect(col(after, 'backlog').cards.map((c) => c.id)).toEqual(['s2']);
        expect(col(after, 'in_progress').cards.map((c) => c.id)).toEqual(['s3', 's1']);
        expect(col(after, 'qa')).toBe(col(before, 'qa'));
        expect(col(after, 'in_progress').cards[0]).toBe(col(before, 'in_progress').cards[0]);
    });

    it('a card missing from the ids is gone (deleted, or moved off this level)', () => {
        const before = view();
        const { view: after } = apply(before, changes([], ['s1', 's2', 's4']));
        expect(col(after, 'in_progress').cards).toEqual([]);
        expect(col(after, 'backlog')).toBe(col(before, 'backlog'));
    });

    it('a new card appears where Tynn put it', () => {
        const { view: after } = apply(view(), changes([story('s5', 'backlog', 2, { title: 'Made by an agent' })], [...ALL, 's5']));
        expect(col(after, 'backlog').cards.map((c) => c.title)).toEqual(['Story s1', 'Story s2', 'Made by an agent']);
    });

    it('an id it holds no row for is asked for, never invented', () => {
        const { view: after, missing } = apply(view(), changes([], [...ALL, 's9']));
        expect(missing).toEqual(['s9']);
        expect(after.columns.flatMap((c) => c.cards).map((c) => c.id)).not.toContain('s9');
    });

    it('nothing changed: the very same view, so nothing redraws', () => {
        const before = view();
        expect(apply(before, changes([], ALL)).view).toBe(before);
    });

    it('takes the new cursor, and the version\'s new name in the crumbs', () => {
        const { view: after } = apply(view(), changes([], ALL, { active_version: { ...BOARD.active_version, number: '0.5' } }));
        expect(after.cursor).toBe('2026-10-28T12:05:00Z');
        expect(after.crumbs).toEqual([{ label: '0.5', scope: { version: 'v1' } }]);
    });

    it('an answer for another level or scope (the person moved on meanwhile) changes nothing', () => {
        const before = view();
        expect(apply(before, changes([story('s1', 'done', 0)], ALL, { version_id: 'v2' })).view).toBe(before);
        expect(apply(before, changes([], [], { level: 'tasks', story_id: 's1' })).view).toBe(before);
    });

    it('refuses what is not a changes answer', () => {
        expect(parseBoardChanges(null)).toBeNull();
        expect(parseBoardChanges({ ...changes([], ALL), ids: 'x' })).toBeNull();
        expect(parseBoardChanges({ ...changes([], ALL), cursor: null })).toBeNull();
        expect(parseBoardChanges({ ...changes([], ALL), level: 'nope' })).toBeNull();
    });
});

describe('following the board: rings in, what changed out', () => {
    function follower(answers: Array<{ ok: true; cursor: string; missing?: string[] } | { ok: false; reason: string }>) {
        const fetches: Array<{ cursor: string; ids: readonly string[] }> = [];
        const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
        const refused: string[] = [];
        let cursor: string | null = 'c0';
        let i = 0;
        let release: (() => void) | null = null;
        let hold = false;
        const f = new BoardFollower({
            cursor: () => cursor,
            fetch: async (c, ids) => {
                fetches.push({ cursor: c, ids });
                if (hold) await new Promise<void>((r) => { release = r; });
                const a = answers[Math.min(i++, answers.length - 1)]!;
                return a.ok ? { ok: true as const, changes: { ...parseBoardChanges(changes([], ALL))!, cursor: a.cursor, missing: a.missing ?? [] } as never } : { ok: false as const, state: 'error', reason: a.reason };
            },
            apply: (ch) => { cursor = ch.cursor; return (ch as unknown as { missing: string[] }).missing; },
            refused: (r) => { refused.push(r.reason); },
            schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
        });
        const settle = async () => { for (let n = 0; n < 6; n += 1) await new Promise((r) => setTimeout(r, 0)); };
        const fire = async () => { const t = timers.filter((x) => !x.cancelled).at(-1)!; t.cancelled = true; t.fn(); await settle(); };
        return { f, fetches, timers, refused, settle, fire, holdNext: () => { hold = true; }, releaseHeld: async () => { hold = false; release?.(); await settle(); } };
    }

    it('a burst of rings is ONE ask, after a short quiet, with every id they named, from the board\'s cursor', async () => {
        const h = follower([{ ok: true, cursor: 'c1' }]);
        h.f.ring(['t1', 's1'], false);
        h.f.ring(['t2', 's1'], false);
        expect(h.fetches).toEqual([]);
        expect(h.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([LIVE_QUIET_MS]);
        await h.fire();
        expect(h.fetches).toEqual([{ cursor: 'c0', ids: ['t1', 's1', 't2'] }]);
    });

    it('a ring while an ask is out is asked after it, from the cursor that ask returned', async () => {
        const h = follower([{ ok: true, cursor: 'c1' }, { ok: true, cursor: 'c2' }]);
        h.holdNext();
        h.f.ring(['t1'], false);
        await h.fire();
        h.f.ring(['t9'], false);
        await h.settle();
        expect(h.fetches).toHaveLength(1);
        await h.releaseHeld();
        await h.fire();
        expect(h.fetches).toEqual([{ cursor: 'c0', ids: ['t1'] }, { cursor: 'c1', ids: ['t9'] }]);
    });

    it('a catch-up (the socket came back) asks at once for everything since the cursor', async () => {
        const h = follower([{ ok: true, cursor: 'c1' }]);
        h.f.ring([], true);
        expect(h.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([0]);
        await h.fire();
        expect(h.fetches).toEqual([{ cursor: 'c0', ids: [] }]);
    });

    it('asks once more for rows the answer named but did not carry', async () => {
        const h = follower([{ ok: true, cursor: 'c1', missing: ['s9'] }, { ok: true, cursor: 'c2' }]);
        h.f.ring(['s1'], false);
        await h.fire();
        await h.fire();
        expect(h.fetches).toEqual([{ cursor: 'c0', ids: ['s1'] }, { cursor: 'c1', ids: ['s9'] }]);
    });

    it('a refusal is said, and the cursor stays where it was', async () => {
        const h = follower([{ ok: false, reason: 'Tynn did not show this board' }, { ok: true, cursor: 'c1' }]);
        h.f.ring(['s1'], false);
        await h.fire();
        expect(h.refused).toEqual(['Tynn did not show this board']);
        h.f.ring(['s2'], false);
        await h.fire();
        expect(h.fetches.at(-1)!.cursor).toBe('c0');
    });

    it('stopped (the tab closed), it asks nothing', async () => {
        const h = follower([{ ok: true, cursor: 'c1' }]);
        h.f.stop();
        h.f.ring(['s1'], false);
        await h.settle();
        expect(h.timers.filter((t) => !t.cancelled)).toEqual([]);
        expect(h.fetches).toEqual([]);
    });
});

describe('the live icon', () => {
    const ready = { state: 'ready' as const, view: view() };
    it('says live, or reconnecting, as an icon named for a screen reader; nothing when the board is not live', () => {
        const live = renderToStaticMarkup(createElement(TynnBoardPanel, { state: ready, onScope: () => {}, onAction: () => {}, live: 'live' }));
        expect(live).toContain('data-tynn-live="live"');
        expect(live).toContain('aria-label="Live: following Tynn"');
        const back = renderToStaticMarkup(createElement(TynnBoardPanel, { state: ready, onScope: () => {}, onAction: () => {}, live: 'reconnecting' }));
        expect(back).toContain('data-tynn-live="reconnecting"');
        expect(back).toContain('aria-label="Reconnecting to Tynn"');
        for (const off of ['off', undefined] as const) {
            expect(renderToStaticMarkup(createElement(TynnBoardPanel, { state: ready, onScope: () => {}, onAction: () => {}, live: off }))).not.toContain('data-tynn-live');
        }
    });
});
