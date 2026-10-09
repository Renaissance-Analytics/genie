import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentFiles } from '../Master/AgentFiles';
import type { AgentFileRow, AgentFilesView } from '../../lib/agent-files-view';

/**
 * That the FILES tab draws what the projection says.
 *
 * The attribution rules are tested in `agent-files-view.test.ts`; this asserts the render
 * carries them, because a distinction computed correctly and then dropped on the floor is
 * indistinguishable from one never computed — and this tab shipped as a placeholder that
 * rendered its own name for a release.
 *
 * The view is built as a LITERAL here rather than through `agentFilesView`, so a failure
 * names the render and not the projection.
 */

const NOW = 10_000_000;

const row = (over: Partial<AgentFileRow> & { path: string }): AgentFileRow => {
    const path = over.path;
    const cut = path.lastIndexOf('/');
    return {
        name: cut < 0 ? path : path.slice(cut + 1),
        dir: cut < 0 ? null : path.slice(0, cut),
        at: NOW - 60_000,
        status: null,
        supersededBy: null,
        touchedOnDisk: false,
        ...over,
    };
};

const view = (over: Partial<AgentFilesView> = {}): AgentFilesView => ({
    who: 'kora',
    rows: [],
    others: [],
    unattributed: 0,
    ...over,
});

const render = (
    v: AgentFilesView,
    props: { onOpenFile?: (path: string) => void; onOpenAgent?: (id: string) => void } = {},
): string => renderToStaticMarkup(React.createElement(AgentFiles, { view: v, now: NOW, ...props }));

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe('the agent files tab', () => {
    it('POSITIVE CONTROL: it renders every changed file and its folder', () => {
        const html = render(view({ rows: [row({ path: 'main/ipc.ts' }), row({ path: 'README.md' })] }));
        expect(html).toContain('ipc.ts');
        expect(html).toContain('main');
        expect(html).toContain('README.md');
        expect(count(html, 'agent-files-row')).toBe(2);
    });

    it('is a BUTTON only when there is something behind the row', () => {
        const rows = [row({ path: 'a.ts' }), row({ path: 'b.ts' })];
        // Never a div with an onClick: a row that answers Enter and announces itself is the
        // difference between a surface a keyboard reaches and one it does not.
        expect(count(render(view({ rows }), { onOpenFile: () => {} }), '<button')).toBe(2);
        // And a row with nothing behind it stays inert rather than becoming a control that
        // does nothing — absence of a control, not a dead one.
        expect(count(render(view({ rows })), '<button')).toBe(0);
    });

    it('says it cannot see the workspace rather than showing an empty list', () => {
        const blind = render(view({ rows: null }));
        expect(blind).toContain('cannot see which workspace');
        expect(count(blind, 'agent-files-row')).toBe(0);
        // POSITIVE CONTROL: the same component with rows draws them, so the sentence above is
        // the missing workspace and not a render that never worked.
        expect(count(render(view({ rows: [row({ path: 'a.ts' })] })), 'agent-files-row')).toBe(1);
    });

    it('distinguishes "changed nothing" from "cannot see"', () => {
        // Two different situations with two different remedies. One sentence for both would
        // tell a human whose agent is idle to go repair their workspace.
        const empty = render(view({ rows: [] }));
        expect(empty).toContain('No files changed by kora');
        expect(empty).not.toContain('cannot see which workspace');
        expect(render(view({ rows: null }))).not.toContain('No files changed by kora');
    });

    it('names the agent that wrote a file after this one', () => {
        const html = render(
            view({ rows: [row({ path: 'shared.ts', supersededBy: 'wren' }), row({ path: 'own.ts' })] }),
        );
        expect(html).toContain('wren');
        // COUNT, not a boolean: exactly one of the two rows carries the note, so a render that
        // put it on every row would fail here.
        expect(count(html, 'agent-files-since')).toBe(1);
    });

    it("marks an unclaimed newest write with the board's '?' and no name", () => {
        const html = render(
            view({ rows: [row({ path: 'a.ts', touchedOnDisk: true }), row({ path: 'b.ts' })] }),
        );
        expect(count(html, 'agent-files-unclaimed')).toBe(1);
        expect(count(html, 'data-disk'))
            // The flag is on the row too, so the stylesheet can grey the whole row — and the
            // positive control is the second row, which has neither.
            .toBe(1);
    });

    it('renders no status word for a file git said nothing about', () => {
        const html = render(
            view({ rows: [row({ path: 'a.ts', status: 'modified' }), row({ path: 'b.ts' })] }),
        );
        expect(html).toContain('modified');
        // Never a dash and never a blank badge for the second row: `data-status` is ABSENT, and
        // the presence of exactly one is what proves the attribute is not simply never set.
        expect(count(html, 'data-status')).toBe(1);
    });

    it('renders no age for an unstamped change', () => {
        const html = render(
            view({ rows: [row({ path: 'a.ts', at: NOW - 60_000 }), row({ path: 'b.ts', at: 0 })] }),
        );
        // `0` is `workspaceChanges` saying the provider never stamped the call. Formatting it
        // would print a date in 1970 under a file somebody edited a minute ago.
        expect(count(html, 'agent-files-age')).toBe(1);
        expect(html).toContain('1m ago');
    });

    it('counts the other agents and the changes nobody claimed', () => {
        const html = render(
            view({
                rows: [row({ path: 'a.ts' })],
                others: [{ who: 'wren', agentId: 'b', count: 2 }],
                unattributed: 3,
            }),
        );
        expect(html).toContain('wren');
        expect(html).toContain('2 files');
        expect(html).toContain('3 changed files');
        expect(count(html, 'agent-files-unattributed')).toBe(1);
    });

    it('offers no footer line for a count of zero', () => {
        // A line that is always there but only sometimes means anything trains people to
        // ignore it. POSITIVE CONTROL: the same assertion with a real count is above.
        const html = render(view({ rows: [row({ path: 'a.ts' })] }));
        expect(count(html, 'agent-files-unattributed')).toBe(0);
        expect(count(html, 'agent-files-other"')).toBe(0);
    });

    it("says 'file' for one and 'files' for more", () => {
        const one = render(view({ rows: [], others: [{ who: 'wren', agentId: 'b', count: 1 }] }));
        expect(one).toContain('1 file');
        expect(one).not.toContain('1 files');
    });

    it("opens the other agent only when it is given a way to", () => {
        const v = view({ rows: [], others: [{ who: 'wren', agentId: 'b', count: 1 }] });
        expect(count(render(v, { onOpenAgent: () => {} }), '<button')).toBe(1);
        expect(count(render(v), '<button')).toBe(0);
    });
});
