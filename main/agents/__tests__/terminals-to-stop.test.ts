import { describe, expect, it } from 'vitest';
import { terminalsToStopFor } from '../deletion';

/**
 * WHICH terminals a stop is about to kill.
 *
 * Extracted because two callers need the same answer and must not compute it
 * differently: `deleteRegisteredAgent` kills them, and the handoff request
 * asks them — asking a terminal that is not about to be killed wastes an
 * agent's turn, and killing one that was never asked loses the note the human
 * ticked the box for.
 *
 * Deps are injected with real defaults, the same split `resolveAgentDeletion`
 * uses in this module, so the rule is testable without a database.
 */

const roster = [
    { id: 'a1', name: 'tynn', terminal_spec_id: 'spec-tynn' },
    { id: 'a2', name: 'tynn-slave', terminal_spec_id: 'spec-tynn-slave' },
    { id: 'a3', name: 'moic-slave', terminal_spec_id: 'spec-moic-slave' },
    { id: 'a4', name: 'tynnbuilder', terminal_spec_id: 'spec-tynnbuilder' },
];

const deps = {
    runtimes: (agentId: string) =>
        agentId === 'a1' ? [{ terminal_spec_id: 'spec-tynn-codex' }] : [],
    roster: () => roster,
};

describe('terminalsToStopFor', () => {
    const agent = { id: 'a1', name: 'tynn', workspace_id: 'ws', terminal_spec_id: 'spec-tynn' };

    it('includes the agent’s own terminal and every runtime it fronts', () => {
        expect(terminalsToStopFor(agent, deps)).toEqual(
            expect.arrayContaining(['spec-tynn', 'spec-tynn-codex']),
        );
    });

    it('includes its sidecar’s terminal', () => {
        expect(terminalsToStopFor(agent, deps)).toContain('spec-tynn-slave');
    });

    it('never includes another agent’s terminal', () => {
        // POSITIVE CONTROL for the two above: over-matching here would kill
        // terminals the human never asked about.
        const ids = terminalsToStopFor(agent, deps);
        expect(ids).not.toContain('spec-moic-slave');
        expect(ids).not.toContain('spec-tynnbuilder');
    });

    it('de-duplicates a terminal reached both ways', () => {
        // `workspace_agents.terminal_spec_id` and an `agent_runtimes` binding
        // can be the SAME terminal; killing it twice is noise, and asking it
        // twice would send the agent two handoff requests.
        const ids = terminalsToStopFor(agent, {
            runtimes: () => [{ terminal_spec_id: 'spec-tynn' }],
            roster: () => [],
        });
        expect(ids).toEqual(['spec-tynn']);
    });

    it('returns nothing for a dormant agent with no sidecar', () => {
        expect(
            terminalsToStopFor(
                { id: 'z', name: 'dormant', workspace_id: 'ws', terminal_spec_id: null },
                { runtimes: () => [], roster: () => [] },
            ),
        ).toEqual([]);
    });
});
