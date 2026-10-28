import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { changedEdit, editBody, parseBoard, parseDetail } from '../src/core/tynn-board.js';
import { runTynnBoardAction, type TynnBoardPorts } from '../src/main/tynn-board-client.js';
import { TynnBoardPanel } from '../src/renderer/components/TynnBoardPanel.js';

/**
 * THE TYNN TAB, ROW B2 LEFTOVERS (genie#1295): the rest of tynn.ai's focus-flyout edit.
 *
 * tynn.ai's flyout edits a story's tags, persona, outcome, risk, effort and definition of done, and a task's environment,
 * blocking-on and produces. Tynn's pairing-token door already takes every one of them (BoardItems::storyEditRules /
 * taskEditRules) and its detail (FocusPayloadService) answers them. The tab shows them, edits them, and sends only what
 * the person changed, so a field this Genie could not read (a Tynn whose task detail lacks `env_requirements`) is never
 * sent back empty over what Tynn holds.
 */
const noop = () => {};
const STORIES = parseBoard({
    project_id: 'p1', level: 'stories', version_id: 'v1', story_id: null, active_story: null, versions: [], tasks: null,
    active_version: { id: 'v1', number: '0.4', title: 'Line', status: 'active' },
    stories: [],
})!;

const STORY = {
    kind: 'story', id: 's1', number: 7, title: 'Ship', description: 'D', status: 'backlog', acceptance_criteria: ['A'],
    tags: ['ux', 'board'], persona: 'A maintainer', outcome_metric: 'Fewer clicks', risk_level: 'medium', effort_points: 3,
    dod_reference: 'docs/dod.md', features: [], tasks: [], version: { id: 'v1', number: '0.4' },
};
const TASK = {
    kind: 'task', id: 't1', number: 1, title: 'Wire', description: 'D', status: 'doing', features: [],
    verification_steps: ['Open it'], code_area: 'src', env_requirements: ['Node 22'], blocking_on: ['#4'], produces: ['an API'],
    story: { id: 's1', number: 7, title: 'Ship' },
};
const { env_requirements: _gone, ...OLDER_TASK } = TASK;

describe('the detail carries the rest of the flyout', () => {
    it('a story: tags, persona, outcome, risk, effort and definition of done', () => {
        expect(parseDetail(STORY)).toMatchObject({
            tags: ['ux', 'board'], persona: 'A maintainer', outcomeMetric: 'Fewer clicks', riskLevel: 'medium', effortPoints: 3, dodReference: 'docs/dod.md',
        });
        expect(parseDetail({ ...STORY, tags: null, persona: null, outcome_metric: '', risk_level: 'extreme', effort_points: 'x', dod_reference: null }))
            .toMatchObject({ tags: [], persona: null, outcomeMetric: null, riskLevel: null, effortPoints: null, dodReference: null });
    });

    it('a task: environment, blocking-on and produces; an environment Tynn did not send is unknown, not empty', () => {
        expect(parseDetail(TASK)).toMatchObject({ envRequirements: ['Node 22'], blockingOn: ['#4'], produces: ['an API'] });
        expect(parseDetail(OLDER_TASK)).toMatchObject({ envRequirements: null, blockingOn: ['#4'] });
    });
});

describe('what an edit sends', () => {
    it('a story\'s extra fields, cleaned; an empty one clears; an invalid risk or effort is not sent', () => {
        expect(editBody('story', { tags: [' ux ', '', 'board'], persona: ' P ', outcome_metric: '', risk_level: 'high', effort_points: 5, dod_reference: 'x' }))
            .toEqual({ tags: ['ux', 'board'], persona: 'P', outcome_metric: null, risk_level: 'high', effort_points: 5, dod_reference: 'x' });
        expect(editBody('story', { title: 'T', risk_level: '', effort_points: null })).toEqual({ title: 'T', risk_level: null, effort_points: null });
        expect(editBody('story', { title: 'T', risk_level: 'extreme', effort_points: -1 })).toEqual({ title: 'T' });
        expect(editBody('story', { title: 'T', effort_points: 2.5 })).toEqual({ title: 'T' });
        // A story has no environment.
        expect(editBody('story', { title: 'T', env_requirements: ['x'] })).toEqual({ title: 'T' });
    });

    it('a task\'s environment, blocking-on and produces, one entry per line, blanks dropped', () => {
        expect(editBody('task', { env_requirements: ['Node 22', ' '], blocking_on: [' #4 '], produces: [], tags: ['no'] }))
            .toEqual({ env_requirements: ['Node 22'], blocking_on: ['#4'], produces: [] });
    });

    it('only what the person changed: an untouched field is not sent', () => {
        const story = parseDetail(STORY)!;
        expect(changedEdit(story, { title: 'Ship', description: 'D', acceptance_criteria: ['A'], tags: ['ux', 'board'], persona: 'A maintainer', outcome_metric: 'Fewer clicks', risk_level: 'medium', effort_points: 3, dod_reference: 'docs/dod.md' }))
            .toEqual({});
        expect(changedEdit(story, { title: 'Ship', tags: ['ux'], risk_level: 'low', effort_points: 3 })).toEqual({ tags: ['ux'], risk_level: 'low' });
    });

    it('never sends an environment Tynn did not show, even if the form has one', () => {
        expect(changedEdit(parseDetail(OLDER_TASK)!, { title: 'Wire', env_requirements: [], blocking_on: ['#4'], produces: ['an API'] })).toEqual({});
        expect(changedEdit(parseDetail(TASK)!, { env_requirements: ['Node 22', 'Postgres'] })).toEqual({ env_requirements: ['Node 22', 'Postgres'] });
    });

    it('reaches Tynn as a PATCH with exactly those fields', async () => {
        const calls: Array<{ path: string; method: string; body?: unknown }> = [];
        const p: TynnBoardPorts = {
            signedIn: () => true,
            projectFor: () => 'p1',
            request: async (path, init) => { calls.push({ path, method: init.method, body: init.body }); return { ok: true, status: 200, json: async () => TASK }; },
        };
        expect(await runTynnBoardAction(p, 'w1', { action: 'task.edit', ids: { taskId: 't1' }, body: { produces: ['a test'], blocking_on: [] } })).toEqual({ ok: true });
        expect(calls).toEqual([{ path: '/api/v1/projects/p1/tasks/t1', method: 'PATCH', body: { blocking_on: [], produces: ['a test'] } }]);
    });
});

describe('the flyout', () => {
    it('shows a story\'s tags, persona, outcome, risk, effort and definition of done', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, detail: parseDetail(STORY)! }} onScope={noop} onAction={noop} />);
        for (const text of ['ux', 'board', 'A maintainer', 'Fewer clicks', 'medium', 'docs/dod.md']) expect(html).toContain(text);
        expect(html).toMatch(/data-tynn-detail-effort="3"/);
    });

    it('shows a task\'s environment, blocking-on and produces', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, detail: parseDetail(TASK)! }} onScope={noop} onAction={noop} />);
        for (const text of ['Node 22', '#4', 'an API']) expect(html).toContain(text);
    });

    it('a story\'s edit has every field tynn.ai\'s flyout edits, filled from the detail', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, detail: parseDetail(STORY)!, op: { action: 'story.edit', phase: 'failed', reason: 'x' } }} onScope={noop} onAction={noop} />);
        expect(html).toMatch(/data-tynn-edit-form="s1"/);
        for (const label of ['Tags, comma separated', 'Persona', 'Outcome metric', 'Risk', 'Effort points', 'Definition of done']) expect(html).toContain(`aria-label="${label}"`);
        expect(html).toContain('value="ux, board"');
        expect(html).toMatch(/<option value="medium" selected="">/);
        expect(html).toContain('value="3"');
    });

    it('a task\'s edit has environment, blocking-on and produces, and no environment box when Tynn did not show it', () => {
        const html = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, detail: parseDetail(TASK)!, op: { action: 'task.edit', phase: 'failed', reason: 'x' } }} onScope={noop} onAction={noop} />);
        for (const label of ['Environment, one per line', 'Blocking on, one per line', 'Produces, one per line']) expect(html).toContain(`aria-label="${label}"`);
        const without = renderToStaticMarkup(<TynnBoardPanel state={{ state: 'ready', view: STORIES, detail: parseDetail(OLDER_TASK)!, op: { action: 'task.edit', phase: 'failed', reason: 'x' } }} onScope={noop} onAction={noop} />);
        expect(without).not.toContain('aria-label="Environment, one per line"');
        expect(without).toContain('aria-label="Produces, one per line"');
    });
});
