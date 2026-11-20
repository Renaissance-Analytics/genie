import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sharedProtocol } from '../src/core/genie-protocol.js';
import { parseBoard, parseDetail } from '../src/core/tynn-board.js';
import { parseWip, TYNN_SECTIONS } from '../src/core/tynn-pages.js';
import { SLICE_STATE_LABEL, sliceStateOf } from '../src/core/slice-state.js';
import { TynnBoardPanel } from '../src/renderer/components/TynnBoardPanel.js';
import { TynnWipPanel } from '../src/renderer/components/TynnWipPanel.js';

/**
 * PM G-0 (Tynn #933; spec .ai/plans/specs/pm-model.md §7, §11, §16). Tynn PM-1 renamed a Story to a Slice and gave it
 * states: proposed → ready → running → awaiting review → accepted, plus blocked, rejected, cancelled and failed. Genie
 * tells its agents the new verbs, and its board shows the new names over the SAME protocol methods: columns, drags and
 * card steps stay keyed by the legacy `status` Tynn's board answer and the workspace-UX contract still carry. A row with
 * a `state` shows that state; a row with only `status` (every Tynn answer before PM-1, and the board answer today) shows
 * the state the spec's own migration maps it to (§13.1).
 */
const noop = () => {};

describe('the agents are told the Slice verbs', () => {
    const md = sharedProtocol([], 'tynn');

    it('names every new verb', () => {
        for (const verb of ['propose', 'ready', 'run', 'submit', 'accept', 'reject', 'decide', 'record']) expect(md).toContain(`\`${verb}\``);
    });

    it('calls a story a Slice and a VIP a hotfix', () => {
        expect(md).toMatch(/Slice is one PR/);
        expect(md).toMatch(/hotfix/i);
        expect(md).not.toMatch(/\bVIP\b/);
    });

    it('no longer teaches start / test / finish', () => {
        expect(md).not.toMatch(/start when you pick it up, test when the PR is green, finish when/);
    });

    it('CONTROL: with no Tynn, no Slice verbs', () => {
        expect(sharedProtocol([], 'files')).not.toContain('`submit`');
    });
});

describe('a Slice\'s state', () => {
    it('is the row\'s state when Tynn sends one', () => {
        expect(sliceStateOf({ state: 'ready', status: 'backlog' })).toBe('ready');
        expect(sliceStateOf({ state: 'failed', status: 'backlog' })).toBe('failed');
        expect(sliceStateOf({ state: 'cancelled', status: 'archived' })).toBe('cancelled');
    });

    it('is mapped from a legacy-only status as the migration maps it', () => {
        expect(sliceStateOf({ status: 'backlog' })).toBe('proposed');
        expect(sliceStateOf({ status: 'in_progress' })).toBe('running');
        expect(sliceStateOf({ status: 'qa' })).toBe('awaiting_review');
        expect(sliceStateOf({ status: 'done' })).toBe('accepted');
        expect(sliceStateOf({ status: 'blocked' })).toBe('blocked');
    });

    it('is nothing for what it cannot name (an archived row, an unknown state falls back to status)', () => {
        expect(sliceStateOf({ status: 'archived' })).toBeNull();
        expect(sliceStateOf({ status: 'weird' })).toBeNull();
        expect(sliceStateOf({ state: 'nonsense', status: 'qa' })).toBe('awaiting_review');
    });

    it('has a label for all nine states', () => {
        expect(SLICE_STATE_LABEL).toEqual({
            proposed: 'Proposed', ready: 'Ready', running: 'Running', awaiting_review: 'Awaiting review', accepted: 'Accepted',
            blocked: 'Blocked', rejected: 'Rejected', cancelled: 'Cancelled', failed: 'Failed',
        });
    });
});

const story = (over: Record<string, unknown>) => ({ id: 's', story_number: 1, title: 'S', status: 'backlog', order: 0, task_count: 0, tasks_done: 0, claimed_by: null, can_start: true, can_move_to_qa: true, version_active: true, ...over });
const board = (stories: unknown[]) => parseBoard({
    project_id: 'p1', level: 'stories', version_id: 'v1', story_id: null, active_story: null,
    active_version: { id: 'v1', number: '0.4', title: 'Line', status: 'active' }, versions: [], tasks: null, stories,
})!;

describe('the board shows the Slice names over the same protocol', () => {
    const LEGACY = board([
        story({ id: 'a', status: 'backlog' }), story({ id: 'b', status: 'in_progress' }), story({ id: 'c', status: 'qa' }),
        story({ id: 'd', status: 'done' }), story({ id: 'e', status: 'blocked' }),
    ]);

    it('labels the story columns with the states, still keyed by the legacy status', () => {
        expect(LEGACY.columns.map((c) => [c.status, c.label])).toEqual([
            ['backlog', 'Proposed'], ['blocked', 'Blocked'], ['in_progress', 'Running'], ['qa', 'Awaiting review'], ['done', 'Accepted'],
        ]);
    });

    it('an older Tynn answer (status only) still renders every card, each with its mapped state', () => {
        expect(LEGACY.cards.map((c) => [c.id, c.status, c.state])).toEqual([
            ['a', 'backlog', 'proposed'], ['b', 'in_progress', 'running'], ['c', 'qa', 'awaiting_review'], ['d', 'done', 'accepted'], ['e', 'blocked', 'blocked'],
        ]);
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: LEGACY }} onScope={noop} onAction={noop} />);
        for (const label of ['Proposed', 'Running', 'Awaiting review', 'Accepted', 'Blocked']) expect(html).toContain(label);
        for (const id of ['a', 'b', 'c', 'd', 'e']) expect(html).toMatch(new RegExp(`data-tynn-card="${id}"`));
    });

    it('a card whose state is not its column\'s says which (ready, rejected, failed in the proposed column)', () => {
        const view = board([story({ id: 'r', state: 'ready' }), story({ id: 'x', state: 'rejected' }), story({ id: 'f', state: 'failed' }), story({ id: 'p', state: 'proposed' })]);
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view }} onScope={noop} onAction={noop} />);
        expect(html).toMatch(/data-tynn-card-state="ready"[^>]*>Ready</);
        expect(html).toMatch(/data-tynn-card-state="rejected"[^>]*>Rejected</);
        expect(html).toMatch(/data-tynn-card-state="failed"[^>]*>Failed</);
        // The column already says Proposed: a proposed card carries no second label.
        expect(html).not.toMatch(/data-tynn-card-state="proposed"/);
        expect(view.columns[0]!.cards.map((c) => c.id)).toEqual(['r', 'x', 'f', 'p']);
    });

    it('names the card steps with the new verbs, over the same actions', () => {
        const [a, b, c] = [LEGACY.cards[0]!, LEGACY.cards[1]!, LEGACY.cards[2]!];
        expect([a.quick?.actionId, a.quick?.label]).toEqual(['story.start', 'Run']);
        expect([b.quick?.actionId, b.quick?.label]).toEqual(['story.ready', 'Submit for review']);
        expect([c.quick?.actionId, c.quick?.label]).toEqual(['story.done', 'Accept']);
    });

    it('CONTROL: tasks are not Slices; their columns and steps keep their names', () => {
        const tasks = parseBoard({
            project_id: 'p1', level: 'tasks', version_id: 'v1', story_id: 's1', active_story: { id: 's1', title: 'S', story_number: 1, version_id: 'v1' },
            active_version: null, versions: [], stories: null,
            tasks: [{ id: 't1', task_number: 1, title: 'T', status: 'doing', order: 0, story_id: 's1', claimed_by: null, can_start: true, version_active: true }],
        })!;
        expect(tasks.columns.map((c) => c.label)).toEqual(['Backlog', 'Blocked', 'Doing', 'QA', 'Done']);
        expect(tasks.cards[0]!.state).toBeNull();
        expect(tasks.cards[0]!.quick?.label).toBe('Ready for QA');
    });

    it('the story detail names its state; a task\'s keeps its status', () => {
        const s = parseDetail({ kind: 'story', id: 's1', number: 3, title: 'S', status: 'qa' })!;
        expect(renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: LEGACY, detail: s }} onScope={noop} onAction={noop} />)).toMatch(/data-tynn-detail-status="qa" data-tynn-detail-state="awaiting_review"[^>]*>Awaiting review</);
        const t = parseDetail({ kind: 'task', id: 't1', number: 4, title: 'T', status: 'doing' })!;
        expect(renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: LEGACY, detail: t }} onScope={noop} onAction={noop} />)).toMatch(/data-tynn-detail-status="doing" class[^>]*>Doing</);
    });
});

describe('WIP and the pages', () => {
    const wip = parseWip({
        project_id: 'p1', view: 'active', available_versions: [], active_version: { id: 'v1', number: '0.4.0', title: 'The line' },
        stories: [{ id: 's1', slug: 's', story_number: 7, title: 'S', status: 'in_progress', task_count: 1, tasks_done: 0 }],
        selected_story: { id: 's1', slug: 's', story_number: 7, title: 'S', status: 'qa', state: 'awaiting_review', task_count: 1, tasks_done: 0 },
        tasks: [{ id: 't1', task_number: 1, title: 'T', status: 'doing', claimed_by: null, claimed_by_me: false, can_start: true, version_active: true, features: [] }],
        story_counts: { active: 1, attention: 0, done: 0, backlog: 0 },
    })!;

    it('a story\'s chip is its Slice state; a task\'s chip is its status', () => {
        const html = renderToStaticMarkup(<TynnWipPanel state={{ state: 'ready', view: wip }} onLens={noop} onStory={noop} onAction={noop} />);
        // data-wip-status stays the legacy status (the live tests read it); data-wip-state is the Slice state.
        expect(html).toMatch(/data-wip-status="in_progress" data-wip-state="running"[^>]*>Running</);
        expect(html).toMatch(/data-wip-status="qa" data-wip-state="awaiting_review"[^>]*>Awaiting review</);
        expect(html).toMatch(/data-wip-status="doing" class[^>]*>Doing</);
        expect(html).not.toMatch(/>In Progress</);
    });

    it('the hotfix lane is named Hotfix, not VIP', () => {
        expect(TYNN_SECTIONS.find((s) => s.id === 'vip')).toMatchObject({ label: 'Hotfix' });
    });
});
