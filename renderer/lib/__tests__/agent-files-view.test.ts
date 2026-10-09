import { describe, expect, it } from 'vitest';
import { emptyAgentSession, type AgentSession, type ToolCall } from '../../../main/agentsession/model';
import { agentFileGroups, agentFilesView } from '../agent-files-view';
import type { GitStatusMap } from '../genie';

/**
 * THE AGENT'S FILES — §5.3's workspace panel, filtered to one agent.
 *
 * Every assertion here is about ATTRIBUTION, because attribution is the only thing this
 * surface sells. A list of changed files is available from git; a list of files *this agent*
 * changed, with the ones it cannot honestly claim marked as such, is not.
 */

const ROOT = 'C:/ws';

function call(over: Partial<ToolCall> & { id: string }): ToolCall {
    return { name: 'Edit', status: 'success', kind: 'edit', rawInput: {}, result: null, at: 1_000, ...over };
}

/** An edit of `path`, reported the way a real agent reports one: absolute, in `rawInput`. */
function edit(id: string, path: string, at: number): ToolCall {
    return call({ id, at, rawInput: { file_path: `${ROOT}/${path}` } });
}

function session(
    id: string,
    name: string,
    tools: ToolCall[],
    workspaceId: string | null = 'w',
): AgentSession {
    const s = emptyAgentSession(
        { agentId: id, specId: null, provider: 'claude', name, cwd: ROOT, workspaceId },
        0,
    );
    s.tools = tools;
    return s;
}

const view = (input: {
    session: AgentSession;
    sessions?: AgentSession[];
    gitStatus?: GitStatusMap;
    observed?: Record<string, number>;
}) =>
    agentFilesView({
        session: input.session,
        sessions: input.sessions ?? [input.session],
        gitStatus: input.gitStatus ?? {},
        observed: input.observed ?? {},
    });

describe('the agent files view', () => {
    it('cannot be filtered at all when the agent has no workspace, and SAYS SO with null', () => {
        const tools = [edit('t1', 'src/a.ts', 10)];
        // POSITIVE CONTROL: the identical agent WITH a workspace produces a row, so the null
        // below is the missing workspace and not a projection that never worked.
        expect(view({ session: session('a', 'kora', tools, 'w') }).rows).toHaveLength(1);
        expect(view({ session: session('a', 'kora', tools, null) }).rows).toBeNull();
    });

    it('lists this agent and counts the others, newest first', () => {
        const mine = session('a', 'kora', [edit('t1', 'src/a.ts', 10), edit('t2', 'src/z.ts', 40)]);
        const theirs = session('b', 'wren', [edit('t3', 'docs/b.md', 20), edit('t4', 'docs/c.md', 30)]);
        const result = view({ session: mine, sessions: [mine, theirs] });
        expect(result.rows?.map((row) => row.path)).toEqual(['src/z.ts', 'src/a.ts']);
        // COUNTED, not hidden: the filter is hiding two files, and a human who cannot see
        // that number cannot tell a quiet workspace from a tight filter.
        expect(result.others).toEqual([{ who: 'wren', agentId: 'b', count: 2 }]);
        expect(result.unattributed).toBe(0);
    });

    it('sorts the other agents by how much they changed, then by name', () => {
        const mine = session('a', 'kora', []);
        const wren = session('b', 'wren', [edit('t1', 'one.ts', 10)]);
        const atlas = session('c', 'atlas', [edit('t2', 'two.ts', 20), edit('t3', 'three.ts', 30)]);
        const zoe = session('d', 'zoe', [edit('t4', 'four.ts', 40)]);
        expect(
            view({ session: mine, sessions: [mine, wren, atlas, zoe] }).others.map((o) => o.who),
        ).toEqual(['atlas', 'wren', 'zoe']);
    });

    it('keeps a file this agent changed even after someone else wrote it last, and NAMES them', () => {
        const mine = session('a', 'kora', [edit('t1', 'src/shared.ts', 10), edit('t2', 'src/own.ts', 10)]);
        const theirs = session('b', 'wren', [edit('t3', 'src/shared.ts', 50)]);
        const rows = view({ session: mine, sessions: [mine, theirs] }).rows ?? [];
        // The agent DID edit it, so dropping the row would hide its work; the later writer is
        // named so the row does not read as "kora's current version".
        expect(rows.map((row) => [row.path, row.supersededBy])).toEqual([
            ['src/shared.ts', 'wren'],
            ['src/own.ts', null],
        ]);
        // COUNT, not a boolean: exactly one of the two rows carries a later writer.
        expect(rows.filter((row) => row.supersededBy !== null)).toHaveLength(1);
    });

    it('flags a file whose newest write nobody claimed, and never re-attributes it', () => {
        const mine = session('a', 'kora', [edit('t1', 'src/a.ts', 100), edit('t2', 'src/b.ts', 100)]);
        const rows = view({
            session: mine,
            // `a.ts` moved on disk AFTER kora's write; `b.ts` moved at the same moment, which
            // is kora's own write being observed by the watcher.
            observed: { 'src/a.ts': 200, 'src/b.ts': 100 },
        }).rows ?? [];
        const flagged = rows.filter((row) => row.touchedOnDisk).map((row) => row.path);
        // POSITIVE CONTROL in the same sample: both files are present, one flagged, one not.
        expect(rows).toHaveLength(2);
        expect(flagged).toEqual(['src/a.ts']);
    });

    it('counts changed files no agent reported instead of guessing an author', () => {
        const mine = session('a', 'kora', [edit('t1', 'src/a.ts', 10)]);
        const result = view({
            session: mine,
            gitStatus: { 'vendor/x.ts': 'modified', 'build/out.js': 'ignored' },
            observed: { 'tmp/y.ts': 500 },
        });
        // Still only the agent's own file in the list — an unclaimed change is NOT this
        // agent's, however convenient it would be to show it under its name.
        expect(result.rows?.map((row) => row.path)).toEqual(['src/a.ts']);
        // `vendor/x.ts` + `tmp/y.ts`. `build/out.js` is ignored by git and is not a change.
        expect(result.unattributed).toBe(2);
        expect(result.others).toEqual([]);
    });

    it('carries git status when there is one and renders no word when there is not', () => {
        const mine = session('a', 'kora', [edit('t1', 'src/a.ts', 20), edit('t2', 'src/b.ts', 10)]);
        const rows = view({ session: mine, gitStatus: { 'src/a.ts': 'modified' } }).rows ?? [];
        expect(rows.map((row) => [row.path, row.status])).toEqual([
            ['src/a.ts', 'modified'],
            // null is "git said nothing about this path" — the UI renders nothing at all,
            // never a dash, which would read as a state git reported.
            ['src/b.ts', null],
        ]);
    });

    it('keeps a changed file git ignores, because the agent still changed it', () => {
        const mine = session('a', 'kora', [edit('t1', 'logs/run.log', 10)]);
        const rows = view({ session: mine, gitStatus: { 'logs/run.log': 'ignored' } }).rows ?? [];
        expect(rows.map((row) => [row.path, row.status])).toEqual([['logs/run.log', 'ignored']]);
    });

    it('says the agent changed nothing with an EMPTY list, which is not the same as null', () => {
        const mine = session('a', 'kora', []);
        const theirs = session('b', 'wren', [edit('t1', 'docs/b.md', 20)]);
        const result = view({ session: mine, sessions: [mine, theirs] });
        expect(result.rows).toEqual([]);
        expect(result.others).toHaveLength(1);
    });

    it('reports the agent name so a surface need not re-derive it', () => {
        expect(view({ session: session('a', 'kora', []) }).who).toBe('kora');
    });

    it('ignores a failed edit and an edit with no path', () => {
        const mine = session('a', 'kora', [
            edit('t1', 'src/a.ts', 10),
            call({ id: 't2', at: 20, status: 'failure', rawInput: { file_path: `${ROOT}/src/failed.ts` } }),
            call({ id: 't3', at: 30, rawInput: { command: 'npm test' } }),
        ]);
        expect(view({ session: mine }).rows?.map((row) => row.path)).toEqual(['src/a.ts']);
    });

    it('splits a path into the folder and the part that differs', () => {
        const mine = session('a', 'kora', [edit('t1', 'src/deep/a.ts', 20), edit('t2', 'root.md', 10)]);
        const rows = view({ session: mine }).rows ?? [];
        expect(rows.map((row) => [row.dir, row.name])).toEqual([
            ['src/deep', 'a.ts'],
            // null, not '' or '.': a file at the workspace root has no folder to show.
            [null, 'root.md'],
        ]);
    });
});

describe('grouping the agent files by folder', () => {
    const row = (path: string, at: number) => ({
        path,
        name: path.split('/').pop()!,
        dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null,
        at,
        status: null,
        supersededBy: null,
        touchedOnDisk: false,
    });

    it('keeps the newest-first order of the folders and of the files inside them', () => {
        const groups = agentFileGroups([
            row('src/z.ts', 50),
            row('docs/a.md', 40),
            row('src/a.ts', 30),
            row('top.md', 20),
        ]);
        expect(groups.map((group) => [group.dir, group.rows.map((r) => r.name)])).toEqual([
            // `src` leads because its newest file is the newest file overall — the folder's
            // position follows the rows, so re-grouping cannot reorder the list.
            ['src', ['z.ts', 'a.ts']],
            ['docs', ['a.md']],
            [null, ['top.md']],
        ]);
    });

    it('POSITIVE CONTROL: it returns nothing for nothing', () => {
        expect(agentFileGroups([])).toEqual([]);
    });
});
