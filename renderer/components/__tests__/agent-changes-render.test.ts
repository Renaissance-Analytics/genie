import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentChanges } from '../Master/AgentChanges';
import { emptyAgentSession, type AgentSession, type ToolCall } from '../../../main/agentsession/model';

/**
 * That the CHANGES TAB draws what the projection says.
 *
 * The grouping, the attribution and the line counts are tested in
 * `renderer/lib/__tests__/agent-changes-view.test.ts`. This asserts the render carries them,
 * because a decision made correctly and then dropped on the floor is indistinguishable on
 * screen from one made wrong — and this very view existed as a placeholder rendering its own
 * name for a release.
 *
 * Two of these are about what must NOT appear, and each is paired with a positive control in
 * the same markup: a `not.toContain` passes just as well on a component that rendered nothing
 * at all.
 */

const NOW = 1_000_000;

function session(agentId: string, tools: ToolCall[]): AgentSession {
    const base = emptyAgentSession(
        { agentId, specId: `spec-${agentId}`, provider: 'claude', name: agentId, cwd: '/w', workspaceId: 'tynn' },
        NOW,
    );
    return { ...base, tools };
}

const edit = (path: string, at: number, over: Partial<ToolCall> = {}): ToolCall => ({
    id: `t-${path}-${at}`,
    name: 'Edit',
    status: 'success',
    kind: 'edit',
    rawInput: { file_path: path },
    result: null,
    at,
    ...over,
});

const editWithDiff = (path: string, at: number, before: string, after: string): ToolCall =>
    edit(path, at, { result: [{ type: 'diff', path, oldText: before, newText: after }] });

type Props = React.ComponentProps<typeof AgentChanges>;

const render = (props: Props): string => renderToStaticMarkup(React.createElement(AgentChanges, props));

describe('the changes tab', () => {
    it('POSITIVE CONTROL: names the file, its folder, the author and the counts', () => {
        const html = render({
            sessions: [session('atlas', [editWithDiff('/w/src/Auth/Store.php', NOW, 'one\n', 'one\ntwo\n')])],
            agentId: 'atlas',
        });
        expect(html).toContain('Store.php');
        expect(html).toContain('src/Auth');
        expect(html).toContain('atlas');
        expect(html).toContain('+1');
    });

    it('makes a row a real BUTTON when there is somewhere to open it', () => {
        const html = render({
            sessions: [session('atlas', [edit('/w/a.ts', NOW), edit('/w/b.ts', NOW - 1)])],
            agentId: 'atlas',
            onOpenFile: () => {},
        });
        // COUNTED, not a boolean: two files must give two controls. A single `toContain`
        // would pass on a component that made one row clickable and left the other inert.
        expect(html.match(/<button/g) ?? []).toHaveLength(2);
        expect(html).toContain('type="button"');
    });

    it('leaves the row INERT when there is nowhere to open it', () => {
        // Not a div with an onClick, and not a button that does nothing: a control that
        // cannot act is worse than no control, because it only fails once someone trusts it.
        const html = render({
            sessions: [session('atlas', [edit('/w/a.ts', NOW)])],
            agentId: 'atlas',
        });
        expect(html.match(/<button/g) ?? []).toHaveLength(0);
        // POSITIVE CONTROL: the row itself is still there, so the zero above is the control
        // being absent and not the whole list failing to render.
        expect(html).toContain('a.ts');
    });

    it('renders NOTHING where a line count is unknown — no zero, no dash', () => {
        const html = render({
            sessions: [
                // NON-ZERO on both sides deliberately. A measured zero is a legitimate thing
                // to render — the point of this test is that an UNKNOWN count renders nothing,
                // so the fixture leaves no honest `+0`/`−0` for the assertions to trip over.
                session('atlas', [
                    editWithDiff('/w/counted.ts', NOW, 'x\ny\n', 'x\nz\nw\n'),
                    edit('/w/nocount.ts', NOW - 1),
                ]),
            ],
            agentId: 'atlas',
        });
        // POSITIVE CONTROL first: the file that HAS counts shows them, in the same markup.
        expect(html).toContain('+2');
        expect(html).toContain('−1');
        expect(html).toContain('nocount.ts');
        // A zero says the file changed nothing; a dash reads as a zero. Neither is true.
        expect(html).not.toContain('+0');
        expect(html).not.toContain('−0');
        expect(html).not.toContain('—');
    });

    it('says the total is PARTIAL when it could not count every file', () => {
        // A sum presented as the whole story, over files half of which were never counted,
        // is the number-on-screen-reads-as-measured failure this surface exists to avoid.
        const html = render({
            sessions: [
                session('atlas', [editWithDiff('/w/a.ts', NOW, 'x\n', 'x\ny\n'), edit('/w/b.ts', NOW - 1)]),
            ],
            agentId: 'atlas',
        });
        expect(html).toContain('1 not counted');
    });

    it('names nobody for an unclaimed disk change', () => {
        const html = render({
            sessions: [session('atlas', [edit('/w/a.ts', NOW - 1_000)])],
            agentId: 'atlas',
            observed: { 'vendor/autoload.php': NOW },
        });
        // POSITIVE CONTROL: the attributed group's author IS named in the same markup, so the
        // absences below are a decision about the unattributed group.
        expect(html).toContain('atlas');
        expect(html).toContain('vendor/autoload.php'.split('/').pop() as string);
        expect(html).not.toContain('unknown');
        expect(html).not.toContain('Unknown');
        expect(html).toContain('not attributed');
    });

    it('marks this agent’s own group, so the panel says whose it is', () => {
        const html = render({
            sessions: [session('atlas', [edit('/w/a.ts', NOW)]), session('moic', [edit('/w/b.ts', NOW + 1)])],
            agentId: 'atlas',
        });
        expect(html.match(/data-self=""/g) ?? []).toHaveLength(1);
        expect(html).toContain('moic');
    });

    it('states what happens to the work when an edit collides', () => {
        const html = render({
            sessions: [session('atlas', [edit('/w/a.ts', NOW), edit('/w/b.ts', NOW - 1)])],
            agentId: 'atlas',
            conflicts: ['a.ts'],
        });
        // ONE notice for one collision — the count is what proves it is attached to the file
        // that collided rather than printed once per row.
        expect(html.match(/Nothing is discarded/g) ?? []).toHaveLength(1);
        expect(html).toContain('data-conflicted');
    });

    it('shows no collision notice when Genie was never told', () => {
        const html = render({
            sessions: [session('atlas', [edit('/w/a.ts', NOW)])],
            agentId: 'atlas',
        });
        expect(html).not.toContain('Nothing is discarded');
        expect(html).not.toContain('data-conflicted');
        // POSITIVE CONTROL: the same fixture WITH a list does show it, so the absence above is
        // the null being respected and not the notice being unreachable.
        const told = render({
            sessions: [session('atlas', [edit('/w/a.ts', NOW)])],
            agentId: 'atlas',
            conflicts: ['a.ts'],
        });
        expect(told).toContain('Nothing is discarded');
    });

    it('is a SENTENCE when the agent has changed nothing', () => {
        // A blank panel reads as a broken tab. "It has changed nothing" is a fact about a new
        // agent, not a fault.
        const html = render({ sessions: [session('atlas', [])], agentId: 'atlas' });
        expect(html).toContain('No changes yet');
        expect(html.match(/<button/g) ?? []).toHaveLength(0);
    });
});
