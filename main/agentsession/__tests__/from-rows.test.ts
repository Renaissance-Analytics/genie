import { describe, expect, it } from 'vitest';
import { gatherAgentFromRow, type AgentRowish } from '../from-rows';

/**
 * Mapping Genie's agent record into the gatherer's input.
 *
 * Small, but it is the join where the "terminal-is-the-agent" assumption would
 * creep back in, and where a missing field quietly becomes a wrong one. Every
 * assertion is about carrying absence through rather than filling it in.
 */

const row = (over: Partial<AgentRowish> = {}): AgentRowish => ({
    id: 'a1',
    workspace_id: 'w1',
    name: 'kai',
    tui: 'claude',
    boot_cwd: '/repo',
    terminal_spec_id: 's1',
    ...over,
});

describe('gatherAgentFromRow', () => {
    it('carries the record straight through', () => {
        expect(gatherAgentFromRow(row(), '/ws')).toEqual({
            agentId: 'a1',
            name: 'kai',
            specId: 's1',
            provider: 'claude',
            cwd: '/repo',
            workspaceId: 'w1',
        });
    });

    it('keeps a DORMANT agent dormant instead of inventing a terminal', () => {
        expect(gatherAgentFromRow(row({ terminal_spec_id: null }), '/ws').specId).toBeNull();
    });

    it('falls back to the workspace root when the agent has no boot cwd', () => {
        // boot_cwd is null for an agent that runs at the workspace root, which is
        // the common case — not a missing value.
        expect(gatherAgentFromRow(row({ boot_cwd: null }), '/ws').cwd).toBe('/ws');
    });

    it('reports an unknown provider as null rather than guessing a default', () => {
        // `tui` is nullable in the record. Defaulting it to 'claude' would brand an
        // agent with a provider it does not run and give it a fidelity it has not
        // earned — the session model reads a null provider as 'unknown' on purpose.
        expect(gatherAgentFromRow(row({ tui: null }), '/ws').provider).toBeNull();
    });

    it('does not treat an empty provider string as a provider', () => {
        expect(gatherAgentFromRow(row({ tui: '   ' }), '/ws').provider).toBeNull();
    });

    it('does not treat an empty boot cwd as a cwd', () => {
        expect(gatherAgentFromRow(row({ boot_cwd: '' }), '/ws').cwd).toBe('/ws');
    });
});
