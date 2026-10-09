import { describe, expect, it } from 'vitest';
import { emptyAgentSession, type AgentSession, type ToolCall } from '../../../main/agentsession/model';
import { liveWrites, workspaceChanges } from '../workspace-changes';

/**
 * WHICH FILES ARE BEING WRITTEN RIGHT NOW.
 *
 * §5.3's tree marks a live write differently from a finished one — the board's pulsing dot, and
 * the violet rather than emerald stripe. `workspaceChanges` cannot answer it: it reports
 * `status === 'success'` calls only, which is every write that has ALREADY LANDED.
 *
 * The signal is in the same place and read by the same rules: a PENDING call, of a kind the
 * agent itself classified as changing, whose `rawInput` names a file. `ToolCall.rawInput`'s own
 * doc says so — *"This is where 'it is editing ipc.ts right now' comes from"*.
 *
 * What every test here is about: a pulse is a claim that something is happening THIS INSTANT,
 * so it has to go away on its own. A live mark that outlives the write is worse than none,
 * because it makes a quiet workspace look busy.
 */

const NOW = 1_000_000;

function session(agentId: string, tools: ToolCall[], workspaceId: string | null = 'tynn'): AgentSession {
    const base = emptyAgentSession(
        { agentId, specId: `spec-${agentId}`, provider: 'claude', name: agentId, cwd: '/w', workspaceId },
        NOW,
    );
    return { ...base, tools };
}

const call = (over: Partial<ToolCall> = {}): ToolCall => ({
    id: 't1',
    name: 'Edit',
    status: 'pending',
    kind: 'edit',
    rawInput: { file_path: '/w/main/ipc.ts' },
    result: null,
    at: NOW,
    ...over,
});

describe('a write in flight', () => {
    it('names the file and the agent while the call is PENDING', () => {
        const live = liveWrites([session('atlas', [call()])], { workspaceId: 'tynn' });
        expect(live).toEqual([{ path: 'main/ipc.ts', who: 'atlas', agentId: 'atlas' }]);
    });

    it('stops being live the moment the call SETTLES', () => {
        // The pulse has to end by itself. Both outcomes end it: a write that succeeded is a
        // change (`workspaceChanges`' job) and one that failed never happened.
        expect(liveWrites([session('atlas', [call({ status: 'success' })])], { workspaceId: 'tynn' })).toEqual([]);
        expect(liveWrites([session('atlas', [call({ status: 'failure' })])], { workspaceId: 'tynn' })).toEqual([]);

        // POSITIVE CONTROL: the identical call still pending IS live, so the two empties above
        // are the status rule and not a reader that never matches.
        expect(liveWrites([session('atlas', [call()])], { workspaceId: 'tynn' })).toHaveLength(1);

        // And the settled one is exactly what the CHANGES list reports, so the two surfaces
        // divide the same calls between them rather than both claiming one.
        expect(workspaceChanges([session('atlas', [call({ status: 'success' })])], { workspaceId: 'tynn' }))
            .toHaveLength(1);
    });

    it('will not call an UNCLASSIFIED call a write', () => {
        // `ToolCall.kind` is null when the agent did not classify the call — measured against a
        // real child, present on `Write` and absent on `PowerShell` in one session. "This is an
        // edit" is exactly the claim a pulse would make on the strength of a missing field.
        expect(liveWrites([session('atlas', [call({ kind: null })])], { workspaceId: 'tynn' })).toEqual([]);
        // A read is traffic, not a write.
        expect(liveWrites([session('atlas', [call({ kind: 'read' })])], { workspaceId: 'tynn' })).toEqual([]);
        // POSITIVE CONTROL: the kinds that DO change a file are live.
        for (const kind of ['edit', 'write', 'create', 'delete', 'move']) {
            expect(liveWrites([session('atlas', [call({ kind })])], { workspaceId: 'tynn' })).toHaveLength(1);
        }
    });

    it('needs a path it can name — it will not pulse a file it cannot identify', () => {
        expect(liveWrites([session('atlas', [call({ rawInput: null })])], { workspaceId: 'tynn' })).toEqual([]);
        expect(liveWrites([session('atlas', [call({ rawInput: { pattern: '*.ts' } })])], { workspaceId: 'tynn' }))
            .toEqual([]);
        // The other key names providers really send, same list `workspaceChanges` reads.
        expect(liveWrites([session('atlas', [call({ rawInput: { path: '/w/a.ts' } })])], { workspaceId: 'tynn' }))
            .toEqual([{ path: 'a.ts', who: 'atlas', agentId: 'atlas' }]);
    });

    it('stays inside the workspace, and COUNTS one entry per live file', () => {
        const sessions = [
            session('atlas', [call({ id: 'a', rawInput: { file_path: '/w/a.ts' } })]),
            session('kora', [call({ id: 'b', rawInput: { file_path: '/w/b.ts' } })]),
            session('stranger', [call({ id: 'c', rawInput: { file_path: '/w/c.ts' } })], 'other'),
        ];
        const live = liveWrites(sessions, { workspaceId: 'tynn' });
        expect(live).toHaveLength(2);
        expect(live.map((entry) => entry.path).sort()).toEqual(['a.ts', 'b.ts']);

        // Two pending calls on ONE file is one file being written, not two.
        const twice = liveWrites(
            [session('atlas', [call({ id: 'x' }), call({ id: 'y' })])],
            { workspaceId: 'tynn' },
        );
        expect(twice).toHaveLength(1);
    });
});
