import { describe, expect, it } from 'vitest';
import { emptyAgentSession, type AgentSession, type ToolCall } from '../../../main/agentsession/model';
import { agentChangesView, CONFLICT_NOTICE } from '../agent-changes-view';

/**
 * THE CHANGES TAB — §5.3's Changed filter, scoped to one agent.
 *
 * The board's requirement is that the filter *"groups files by who changed them, you
 * included"*. So the projection's job is attribution: every changed file sits under the agent
 * that claimed it, and a change nobody claimed sits under NOBODY — never quietly under the
 * agent whose tab happens to be open.
 *
 * ## What these tests are guarding against
 *
 * Three fabrications, each of which would read as measured on screen:
 *
 *  1. **An unclaimed write attributed to this agent.** The watcher sees a file move on disk
 *     with no tool call behind it. Folding that into the open agent's group would put somebody
 *     else's edit — or the human's own — under its name.
 *  2. **A `+0 −0` for a file whose line counts are not on the wire.** Most providers send a
 *     text confirmation for a write, not a diff, so the counts genuinely are unknown. A zero
 *     says "it changed nothing", which is the opposite of the truth.
 *  3. **A silently complete-looking total.** When only some files carry counts, the sum is
 *     real but PARTIAL, so the view reports how many files it could not count.
 *
 * Every negative assertion below is paired with a positive control in the same fixture — a
 * `null` that passes because the projection returned nothing at all is not evidence.
 */

const NOW = 1_000_000;

function session(
    agentId: string,
    tools: ToolCall[],
    over: { cwd?: string; workspaceId?: string | null; name?: string } = {},
): AgentSession {
    const base = emptyAgentSession(
        {
            agentId,
            specId: `spec-${agentId}`,
            provider: 'claude',
            name: over.name ?? agentId,
            cwd: over.cwd ?? '/w',
            workspaceId: over.workspaceId === undefined ? 'tynn' : over.workspaceId,
        },
        NOW,
    );
    return { ...base, tools };
}

/** A write the agent reported, with NO diff on the wire — the measured common case. */
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

/** The same write, WITH ACP's `diff` content variant — where line counts come from. */
const editWithDiff = (path: string, at: number, before: string, after: string): ToolCall =>
    edit(path, at, {
        result: [{ type: 'diff', path, oldText: before, newText: after }],
    });

describe('whose change it is', () => {
    it('POSITIVE CONTROL: puts the open agent’s file in its own named group', () => {
        const v = agentChangesView({
            sessions: [session('atlas', [edit('/w/src/Auth/Store.php', NOW - 1_000)])],
            agentId: 'atlas',
        });
        expect(v.groups).toHaveLength(1);
        expect(v.groups[0]!.self).toBe(true);
        expect(v.groups[0]!.who).toBe('atlas');
        expect(v.groups[0]!.files).toHaveLength(1);
        expect(v.groups[0]!.files[0]!.path).toBe('src/Auth/Store.php');
        expect(v.fileCount).toBe(1);
    });

    it('leads with this agent even when a sibling wrote more recently', () => {
        // The tab belongs to one agent. A sibling that happened to write a second later must
        // not displace it from the top of its own panel.
        const v = agentChangesView({
            sessions: [
                session('atlas', [edit('/w/a.ts', NOW - 60_000)]),
                session('moic', [edit('/w/b.ts', NOW)]),
            ],
            agentId: 'atlas',
        });
        expect(v.groups).toHaveLength(2);
        expect(v.groups[0]!.who).toBe('atlas');
        expect(v.groups[0]!.self).toBe(true);
        expect(v.groups[1]!.who).toBe('moic');
        expect(v.groups[1]!.self).toBe(false);
        // And the sibling's file is in the sibling's group, not merged into the total of one.
        expect(v.groups[0]!.files.map((f) => f.path)).toEqual(['a.ts']);
        expect(v.groups[1]!.files.map((f) => f.path)).toEqual(['b.ts']);
    });

    it('gives an unclaimed disk change its OWN group, named by nobody, last', () => {
        const v = agentChangesView({
            sessions: [session('atlas', [edit('/w/a.ts', NOW - 1_000)])],
            agentId: 'atlas',
            observed: { 'vendor/autoload.php': NOW },
        });
        expect(v.groups).toHaveLength(2);
        // POSITIVE CONTROL for the null: an attributed group is present in the SAME view, so
        // `who === null` cannot be passing because the projection produced nothing.
        expect(v.groups[0]!.who).toBe('atlas');
        const last = v.groups[1]!;
        expect(last.who).toBeNull();
        expect(last.agentId).toBeNull();
        expect(last.self).toBe(false);
        expect(last.files.map((f) => f.path)).toEqual(['vendor/autoload.php']);
    });

    it('never puts another workspace’s agent in the view', () => {
        const v = agentChangesView({
            sessions: [
                session('atlas', [edit('/w/a.ts', NOW)]),
                session('sibling', [edit('/w/b.ts', NOW)]),
                session('elsewhere', [edit('/other/c.ts', NOW)], { cwd: '/other', workspaceId: 'fancy' }),
            ],
            agentId: 'atlas',
        });
        // Two groups, not three: the same-workspace sibling is the positive control that the
        // filter admits anyone at all.
        expect(v.groups.map((g) => g.who)).toEqual(['atlas', 'sibling']);
    });

    it('still shows a workspace-less agent its own changes', () => {
        // A dormant or system agent has `workspaceId: null`. Scoping on a null id must not
        // scope the agent out of its own panel.
        const v = agentChangesView({
            sessions: [session('atlas', [edit('/w/a.ts', NOW)], { workspaceId: null })],
            agentId: 'atlas',
        });
        expect(v.groups).toHaveLength(1);
        expect(v.groups[0]!.files).toHaveLength(1);
    });

    it('is empty — not null, not a group with nothing in it — for an agent that has changed nothing', () => {
        const v = agentChangesView({ sessions: [session('atlas', [])], agentId: 'atlas' });
        expect(v.groups).toEqual([]);
        expect(v.fileCount).toBe(0);
    });

    it('splits the row into its folder and its name, and says null for a file at the root', () => {
        const v = agentChangesView({
            sessions: [session('atlas', [edit('/w/src/Auth/Store.php', NOW), edit('/w/README.md', NOW - 1)])],
            agentId: 'atlas',
        });
        const byPath = new Map(v.groups[0]!.files.map((f) => [f.path, f]));
        expect(byPath.get('src/Auth/Store.php')!.name).toBe('Store.php');
        expect(byPath.get('src/Auth/Store.php')!.dir).toBe('src/Auth');
        expect(byPath.get('README.md')!.name).toBe('README.md');
        // A root file has no folder. Not `''`, not `'.'` — the row renders nothing there.
        expect(byPath.get('README.md')!.dir).toBeNull();
    });

    it('orders a group’s files newest first', () => {
        const v = agentChangesView({
            sessions: [
                session('atlas', [edit('/w/old.ts', NOW - 60_000), edit('/w/new.ts', NOW)]),
            ],
            agentId: 'atlas',
        });
        expect(v.groups[0]!.files.map((f) => f.path)).toEqual(['new.ts', 'old.ts']);
    });
});

describe('how much changed', () => {
    it('counts added and removed lines when the provider sent a diff', () => {
        const v = agentChangesView({
            sessions: [session('atlas', [editWithDiff('/w/a.ts', NOW, 'one\ntwo\n', 'one\nTWO\nthree\n')])],
            agentId: 'atlas',
        });
        const file = v.groups[0]!.files[0]!;
        expect(file.added).toBe(2);
        expect(file.removed).toBe(1);
        expect(v.added).toBe(2);
        expect(v.removed).toBe(1);
        expect(v.uncounted).toBe(0);
    });

    it('says NOTHING rather than zero when no diff was sent', () => {
        /**
         * FIXED SAMPLES IN BOTH STATES, one call apart.
         *
         * Measured: a real `tool_call_update` for a `Write` carries a text confirmation, not a
         * diff — so this is the normal case, not an edge. `null` here and `2` in the sibling
         * assertion is what proves the null is a decision rather than the projection failing
         * to count at all.
         */
        const uncounted = agentChangesView({
            sessions: [session('atlas', [edit('/w/a.ts', NOW)])],
            agentId: 'atlas',
        });
        expect(uncounted.groups[0]!.files[0]!.added).toBeNull();
        expect(uncounted.groups[0]!.files[0]!.removed).toBeNull();
        expect(uncounted.groups[0]!.added).toBeNull();
        expect(uncounted.added).toBeNull();
        expect(uncounted.removed).toBeNull();
        expect(uncounted.uncounted).toBe(1);

        const counted = agentChangesView({
            sessions: [session('atlas', [editWithDiff('/w/a.ts', NOW, 'x\n', 'x\ny\n')])],
            agentId: 'atlas',
        });
        expect(counted.groups[0]!.files[0]!.added).toBe(1);
    });

    it('reports a PARTIAL total as partial', () => {
        // A sum over the files that carry counts is real; presenting it as the whole story
        // when half the files could not be counted is not. The count of uncounted files is
        // what lets the header say so.
        const v = agentChangesView({
            sessions: [
                session('atlas', [
                    editWithDiff('/w/a.ts', NOW, 'x\n', 'x\ny\n'),
                    edit('/w/b.ts', NOW - 1),
                ]),
            ],
            agentId: 'atlas',
        });
        expect(v.fileCount).toBe(2);
        expect(v.added).toBe(1);
        expect(v.uncounted).toBe(1);
    });

    it('sums an agent’s repeated edits to one file into one row', () => {
        // The panel lists FILES, not events — four edits to one file is one changed file. The
        // counts are the churn across those edits, which is what "how much did this agent
        // change here" means; a net diff against the file's original state is not on the wire.
        const v = agentChangesView({
            sessions: [
                session('atlas', [
                    editWithDiff('/w/a.ts', NOW - 1_000, 'one\n', 'one\ntwo\n'),
                    editWithDiff('/w/a.ts', NOW, 'one\ntwo\n', 'one\ntwo\nthree\n'),
                ]),
            ],
            agentId: 'atlas',
        });
        expect(v.groups[0]!.files).toHaveLength(1);
        expect(v.groups[0]!.files[0]!.added).toBe(2);
        expect(v.groups[0]!.files[0]!.removed).toBe(0);
    });

    it('does not count a failed call', () => {
        // POSITIVE CONTROL in the same fixture: the successful edit beside it IS counted, so
        // the zero below is the failure being excluded and not the counter being broken.
        const v = agentChangesView({
            sessions: [
                session('atlas', [
                    { ...editWithDiff('/w/bad.ts', NOW - 1, 'x\n', 'x\ny\n'), status: 'failure' },
                    editWithDiff('/w/good.ts', NOW, 'x\n', 'x\ny\n'),
                ]),
            ],
            agentId: 'atlas',
        });
        const byPath = new Map(v.groups[0]!.files.map((f) => [f.path, f]));
        expect(byPath.get('good.ts')!.added).toBe(1);
        // A failed write is not a change, so it is not a row at all.
        expect(byPath.has('bad.ts')).toBe(false);
    });

    it('counts a deletion as removed lines', () => {
        const v = agentChangesView({
            sessions: [session('atlas', [editWithDiff('/w/gone.ts', NOW, 'one\ntwo\n', '')])],
            agentId: 'atlas',
        });
        expect(v.groups[0]!.files[0]!.removed).toBe(2);
        expect(v.groups[0]!.files[0]!.added).toBe(0);
    });
});

describe('the collision state', () => {
    it('marks only the file the human’s unsaved edit collides on', () => {
        const v = agentChangesView({
            sessions: [session('atlas', [edit('/w/a.ts', NOW), edit('/w/b.ts', NOW - 1)])],
            agentId: 'atlas',
            conflicts: ['a.ts'],
        });
        const byPath = new Map(v.groups[0]!.files.map((f) => [f.path, f]));
        expect(byPath.get('a.ts')!.conflicted).toBe(true);
        // `false`, not `null`: with a conflict list in hand Genie KNOWS this file is clear.
        expect(byPath.get('b.ts')!.conflicted).toBe(false);
        expect(v.conflictCount).toBe(1);
    });

    it('says it cannot see collisions rather than claiming there are none', () => {
        // No editor buffer to compare against ⇒ `null`. `false` would assert the human has no
        // unsaved edit anywhere, which is a claim about a surface this projection cannot read.
        const blind = agentChangesView({
            sessions: [session('atlas', [edit('/w/a.ts', NOW)])],
            agentId: 'atlas',
        });
        expect(blind.groups[0]!.files[0]!.conflicted).toBeNull();
        expect(blind.conflictCount).toBeNull();

        // POSITIVE CONTROL: an EMPTY list is a different statement — looked, found none.
        const looked = agentChangesView({
            sessions: [session('atlas', [edit('/w/a.ts', NOW)])],
            agentId: 'atlas',
            conflicts: [],
        });
        expect(looked.groups[0]!.files[0]!.conflicted).toBe(false);
        expect(looked.conflictCount).toBe(0);
    });

    it('states what happens to the work, because that is the reassurance', () => {
        // The board's words. "Nothing is discarded" is the half of the message a person
        // actually needs when two writers hit the same lines.
        expect(CONFLICT_NOTICE).toContain('Nothing is discarded');
        expect(CONFLICT_NOTICE).toContain('pauses');
    });
});
