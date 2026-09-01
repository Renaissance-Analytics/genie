import { describe, expect, it } from 'vitest';
import { agentStackStats, agentStackStatus } from '../agent-stack-stats';
import type { AgentStackEntry } from '../agent-stack';

/**
 * The avatar popover shows STATUS **and STATS**, and carries the CONTROLS.
 *
 * What shipped was one status line per agent — `codex · running · name
 * conflict` — and nothing else: no stats, and nothing to click. The owner asked
 * twice: "I said STATUS AND STATS", and "I should be able to access the
 * controls for these agents same as if I had the workspace sidebar expanded".
 *
 * So the popover is not a tooltip. It is the collapsed sidebar's equivalent of
 * the expanded agent grid, and has to carry the same information and the same
 * actions.
 *
 * STATS ARE REAL OR ABSENT. Per-agent throughput does not exist in the renderer
 * — AgentPulse is keyed by WORKSPACE — so this reports what the record actually
 * holds: how many drivers, how many are live, whether it is the workspace
 * default, whether a name conflict is blocking it. Inventing a number would be
 * worse than showing fewer.
 */

const entry = (over: Partial<AgentStackEntry> = {}): AgentStackEntry => ({
    id: 'a1',
    name: 'moic',
    provider: 'claude',
    avatar: null,
    running: true,
    sidecars: [],
    collisionGroup: null,
    role: 'specialized',
    ...over,
});

describe('agentStackStatus', () => {
    it('names the driver and whether it is running', () => {
        expect(agentStackStatus(entry())).toBe('claude · running');
    });

    it('says an agent that has never started has no driver yet', () => {
        expect(agentStackStatus(entry({ provider: null, running: false }))).toBe('no driver yet');
    });

    it('says stopped rather than going quiet', () => {
        expect(agentStackStatus(entry({ running: false }))).toBe('claude · stopped');
    });
});

describe('agentStackStats', () => {
    it('counts DRIVERS, including the fronted one', () => {
        // The fronted TUI is a driver too. Reporting "1 sidecar" for an agent
        // holding two drivers describes the wrong thing.
        const stats = agentStackStats(
            entry({ sidecars: [{ provider: 'codex', running: true }] }),
        );
        expect(stats).toContain('2 drivers · 2 live');
    });

    it('reports a single driver without pluralising', () => {
        expect(agentStackStats(entry())).toContain('1 driver · 1 live');
    });

    it('counts only the LIVE ones as live', () => {
        const stats = agentStackStats(
            entry({
                running: false,
                sidecars: [
                    { provider: 'codex', running: false },
                    { provider: 'genie', running: false },
                ],
            }),
        );
        expect(stats).toContain('3 drivers · 0 live');
    });

    it('marks the workspace default, because that is why it boots from the root', () => {
        expect(agentStackStats(entry({ role: 'workspace' }))).toContain('workspace default');
        expect(agentStackStats(entry({ role: 'specialized' }))).not.toContain('workspace default');
    });

    it('surfaces a name conflict as a stat, not as decoration', () => {
        // It BLOCKS starting the agent, so it belongs where the numbers are.
        expect(agentStackStats(entry({ collisionGroup: 'g1' }))).toContain('name conflict');
    });

    it('never returns an empty list', () => {
        // The popover renders these; an empty stats line is a blank row that
        // reads as a rendering fault.
        for (const running of [true, false]) {
            for (const provider of ['claude', null]) {
                expect(agentStackStats(entry({ running, provider })).length).toBeGreaterThan(0);
            }
        }
    });
});
