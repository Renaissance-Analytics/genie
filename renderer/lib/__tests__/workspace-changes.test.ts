import { describe, expect, it } from 'vitest';
import { emptyAgentSession, type AgentSession, type ToolCall } from '../../../main/agentsession/model';
import { workspaceChanges } from '../workspace-changes';

/**
 * CHANGES THIS SESSION, and WHO MADE THEM — the part of §5.3 that real data can answer.
 *
 * The board's file panel wants three things per changed file: when, who, and how much. Two of
 * those were impossible until genie#843 kept `rawInput` (which file) and `at` (when); the
 * third has always been available, because the agent that reported the call IS the author.
 *
 * ## What this deliberately cannot do
 *
 * The board also shows `+42 −8` per file, a per-line "atlas is writing lines 23–26" presence,
 * and an `on disk · not attributed` row for a write no agent claimed. None of those are
 * derivable from tool calls: they report no line counts or line ranges. The panel composes
 * unattributed writes separately from the existing file watcher. A `+42` guessed from nothing
 * is worse than no number, because a number on screen reads as measured.
 */

const NOW = 1_000_000;

function session(agentId: string, tools: ToolCall[], over: Partial<AgentSession> = {}): AgentSession {
    const base = emptyAgentSession(
        { agentId, specId: `spec-${agentId}`, provider: 'claude', name: agentId, cwd: '/w', workspaceId: 'tynn' },
        NOW,
    );
    return { ...base, ...over, tools, session: { ...base.session, ...(over.session ?? {}) } };
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

describe('what changed, and who changed it', () => {
    it('names the file, the agent and when', () => {
        const v = workspaceChanges([session('atlas', [edit('/w/src/Auth/ChallengeStore.php', NOW - 60_000)])], {
            workspaceId: 'tynn',
        });
        expect(v).toHaveLength(1);
        expect(v[0]!.path).toBe('src/Auth/ChallengeStore.php');
        expect(v[0]!.who).toBe('atlas');
        expect(v[0]!.at).toBe(NOW - 60_000);
    });

    it('keeps the path RELATIVE to the workspace, because the tree is', () => {
        // An absolute path is noise in a panel rooted at the workspace, and it is what the
        // agent reports. The cwd is the root, so the prefix comes off.
        const v = workspaceChanges(
            [session('atlas', [edit('/w/routes/api.php', NOW)])],
            { workspaceId: 'tynn' },
        );
        expect(v[0]!.path).toBe('routes/api.php');
    });

    it('newest first, because that is the question the panel answers', () => {
        const v = workspaceChanges(
            [
                session('atlas', [
                    edit('/w/old.php', NOW - 600_000),
                    edit('/w/new.php', NOW - 1_000),
                    edit('/w/mid.php', NOW - 300_000),
                ]),
            ],
            { workspaceId: 'tynn' },
        );
        expect(v.map((c) => c.path)).toEqual(['new.php', 'mid.php', 'old.php']);
    });

    it('collects across EVERY agent in the workspace', () => {
        // The panel belongs to the workspace, not to an agent — the owner's requirement is
        // "go into a single workspace and see what is being done there".
        const v = workspaceChanges(
            [
                session('atlas', [edit('/w/a.php', NOW - 10)]),
                session('wren', [edit('/w/b.php', NOW - 5)]),
            ],
            { workspaceId: 'tynn' },
        );
        expect(v.map((c) => `${c.who}:${c.path}`)).toEqual(['wren:b.php', 'atlas:a.php']);
    });

    it('ignores agents in OTHER workspaces', () => {
        const other = session('ledger', [edit('/w/elsewhere.php', NOW)], {
            session: { workspaceId: 'fancy' } as AgentSession['session'],
        });
        expect(workspaceChanges([other], { workspaceId: 'tynn' })).toEqual([]);
    });

    it('shows only the LATEST change per file, not one row per edit', () => {
        /**
         * The board lists files, not events: `src/Auth/ChallengeStore.php · atlas · 14:08`. An
         * agent editing one file four times is one changed file, and four rows would bury the
         * other three files under it.
         */
        const v = workspaceChanges(
            [
                session('atlas', [
                    edit('/w/same.php', NOW - 300_000),
                    edit('/w/same.php', NOW - 1_000),
                    edit('/w/other.php', NOW - 200_000),
                ]),
            ],
            { workspaceId: 'tynn' },
        );
        expect(v).toHaveLength(2);
        expect(v[0]!.path).toBe('same.php');
        expect(v[0]!.at).toBe(NOW - 1_000);
    });

    it('prefers the newer edit even when the OLDER one arrives later in the array', () => {
        /**
         * THE CASE THAT ACTUALLY TESTS THE DEDUPE, and it is here because a probe proved the
         * other two did not.
         *
         * Disabling the `existing.at >= at` guard left all ten tests green: every fixture
         * happened to list its edits in ascending time order, so "last write wins" produced the
         * right answer by luck of iteration rather than by the comparison. The guard only earns
         * its keep when the array order and the time order DISAGREE — which is precisely the
         * case `ToolCall.at` exists for, since two concurrent calls can finish out of order.
         */
        const v = workspaceChanges(
            [
                session('atlas', [
                    edit('/w/same.php', NOW - 1_000),
                    // Older, and SECOND. Without the comparison this would win.
                    edit('/w/same.php', NOW - 500_000),
                ]),
            ],
            { workspaceId: 'tynn' },
        );
        expect(v).toHaveLength(1);
        expect(v[0]!.at).toBe(NOW - 1_000);
    });

    it('attributes a file to whoever touched it LAST when two agents did', () => {
        // Not a merge and not a list: the question "who changed this" has one current answer,
        // and it is the most recent writer. The earlier one is in the Stream.
        // The NEWER writer's session is listed FIRST, so iteration order and time order
        // disagree here too — same reason as the case above.
        const v = workspaceChanges(
            [
                session('wren', [edit('/w/shared.php', NOW - 10)]),
                session('atlas', [edit('/w/shared.php', NOW - 100_000)]),
            ],
            { workspaceId: 'tynn' },
        );
        expect(v).toHaveLength(1);
        expect(v[0]!.who).toBe('wren');
    });

    it('ignores a read, and a failed write', () => {
        const v = workspaceChanges(
            [
                session('atlas', [
                    edit('/w/read.php', NOW, { kind: 'read', name: 'Read' }),
                    edit('/w/failed.php', NOW, { status: 'failure' }),
                    edit('/w/real.php', NOW),
                ]),
            ],
            { workspaceId: 'tynn' },
        );
        expect(v.map((c) => c.path)).toEqual(['real.php']);
    });

    it('fabricates no line counts', () => {
        /**
         * The board shows `+42 −8`. A tool call carries no line counts, and deriving them would
         * mean diffing the file against something — which this projection has no access to and
         * no business guessing at. So the field does not exist, and the closed key set is what
         * keeps it that way.
         */
        const v = workspaceChanges([session('atlas', [edit('/w/a.php', NOW)])], { workspaceId: 'tynn' });
        expect(Object.keys(v[0]!).sort()).toEqual(['agentId', 'at', 'path', 'who']);
    });

    it('is empty — not a placeholder row — when nothing has changed', () => {
        expect(workspaceChanges([session('atlas', [])], { workspaceId: 'tynn' })).toEqual([]);
    });
});
