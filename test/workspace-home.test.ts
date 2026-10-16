import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { workspaceHome } from '../src/core/workspace-home.js';

/**
 * THE WORKSPACE'S HOME IS ITS AGENTS. The owner, 2026-10-12, on beta.8: "when I select a workspace, I should not
 * see the workspace settings, I should see the agent lanes and all of the agents. This is still not built to the
 * design doc spec." The board's workspace surface (`Genie v2 Spec Board` → `Workspace Files`) is a header with an
 * agents strip, the file panel, and a 320px rail "AGENTS IN <workspace>" — one card per agent (fidelity dot, name,
 * provider, state word, a second "doing" line) — then "CHANGES THIS SESSION". No terminals, no settings on this
 * route. This module is the rail's decisions with no React in sight; the null discipline (§5) applies to every
 * line: a fact Genie cannot see is `null`, never a dash, a zero, or a made-up time.
 */

const base: AgentRow = {
    id: 'a', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working',
    duration: '12m', ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
};
const row = (over: Partial<AgentRow>): AgentRow => ({ ...base, ...over });

describe('workspaceHome — the agents rail', () => {
    it("lists only this workspace's agents, in the board's order: waiting → broken → working → idle → remote", () => {
        const rows = [
            row({ id: 'idle', state: 'idle' }),
            row({ id: 'elsewhere', workspaceId: 'fancy', state: 'waiting' }),
            row({ id: 'work', state: 'working' }),
            row({ id: 'far', state: 'remote', fidelity: 'remote' }),
            row({ id: 'ask', state: 'waiting', ask: 'Merge now?' }),
            row({ id: 'dead', state: 'broken', reason: 'kimi signed out' }),
        ];
        const view = workspaceHome(rows, 'tynn', null);
        expect(view.agents.map((a) => a.id)).toEqual(['ask', 'dead', 'work', 'idle', 'far']);
        expect(view.noAgents).toBe(false);
    });

    it('speaks the Dashboard vocabulary: Working for a declared agent, Active for an observed one, and names the pty', () => {
        const view = workspaceHome([
            row({ id: 'd', state: 'working' }),
            row({ id: 'o', state: 'working', fidelity: 'observed', provider: 'aider', activity: [0, 3, 1] }),
            row({ id: 'q', state: 'idle', fidelity: 'observed', provider: 'aider', activity: [0, 0] }),
        ], 'tynn', null);
        const by = Object.fromEntries(view.agents.map((a) => [a.id, a]));
        expect(by.d).toMatchObject({ word: 'Working', tone: 'ok', provider: 'claude' });
        expect(by.o).toMatchObject({ word: 'Active', tone: 'ok', provider: 'aider · pty', doing: 'Terminal output' });
        // Bars that are all zero are not output; the line is ABSENT, not "Terminal output 0 B".
        expect(by.q).toMatchObject({ word: 'Quiet', doing: null });
    });

    it('the second line is the one fact worth reading: the question, the failure, the target, else the last delivery', () => {
        const view = workspaceHome([
            row({ id: 'ask', state: 'waiting', ask: 'Merge PR #96 now?', target: 'ignored while waiting' }),
            row({ id: 'dead', state: 'broken', reason: 'kimi signed out', fixes: ['Sign in to kimi'] }),
            row({ id: 'step', state: 'working', step: '4/7', target: 'Wire the rail' }),
            row({ id: 'plain', state: 'working', target: 'Wire the rail' }),
            row({ id: 'last', state: 'idle', delivery: { kind: 'commit', main: 'a1b2c3d', sub: null, plus: 88, minus: 3, age: '42m' } }),
            row({ id: 'far', state: 'remote', fidelity: 'remote', reason: 'studio offline 4m' }),
            row({ id: 'nothing', state: 'idle' }),
        ], 'tynn', null);
        const doing = Object.fromEntries(view.agents.map((a) => [a.id, a.doing]));
        expect(doing).toEqual({
            ask: 'Asks: Merge PR #96 now?',
            dead: 'kimi signed out',
            step: '4/7 · Wire the rail',
            plain: 'Wire the rail',
            last: 'Last: a1b2c3d · 42m',
            far: 'studio offline 4m',
            nothing: null,
        });
        // The null discipline, as a COUNT: nothing in the whole view is a dash or a zero standing in for "unknown".
        expect(JSON.stringify(view)).not.toMatch(/[—–]|"doing":"0"|"doing":"-"/);
    });

    it('an empty workspace says so (the rail offers + Add agent), rather than drawing an empty list', () => {
        const view = workspaceHome([row({ workspaceId: 'fancy' })], 'tynn', null);
        expect(view.agents).toEqual([]);
        expect(view.noAgents).toBe(true);
    });

    it('CHANGES THIS SESSION comes from the file host — one row per file, in group order — and is ABSENT when there is none', () => {
        const files = {
            files: [], activity: [], unreported: ['notes.md'],
            changed: [
                { who: 'you', files: ['src/a.ts', 'src/b.ts'] },
                { who: 'kai', files: ['src/c.ts'] },
                { who: '?', files: ['notes.md'] },
            ],
        };
        const view = workspaceHome([row({})], 'tynn', files);
        expect(view.changes).toEqual([
            { who: 'you', file: 'src/a.ts' },
            { who: 'you', file: 'src/b.ts' },
            { who: 'kai', file: 'src/c.ts' },
            { who: '?', file: 'notes.md' },
        ]);
        // No time and no +/− on a row: the host reports neither, so the view carries neither (never faked, §4.3).
        for (const c of view.changes!) expect(Object.keys(c).sort()).toEqual(['file', 'who']);
        // Absent, not empty: no file state at all, and a state that says nothing changed, both give null.
        expect(workspaceHome([row({})], 'tynn', null).changes).toBeNull();
        expect(workspaceHome([row({})], 'tynn', { ...files, changed: null }).changes).toBeNull();
        expect(workspaceHome([row({})], 'tynn', { ...files, changed: [] }).changes).toBeNull();
    });
});
