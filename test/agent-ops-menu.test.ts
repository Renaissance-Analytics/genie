import { describe, expect, it } from 'vitest';
import { agentOpsMenu } from '../src/core/agent-ops-menu.js';

/**
 * THE AGENT'S OPERATIONS MENU (§6.2) — one table of what the header's overflow offers, so the
 * component maps over it and a test reads it without opening a dropdown: two named restarts, a
 * switch to each OTHER provider, diagnose, and the two named deletes (delete-for-real is the one
 * danger item). An Observed (Take Over) agent gets none of these: Genie does not manage it.
 */

describe('agentOpsMenu', () => {
    it('for a declared claude agent: graceful + fresh restart, switch to codex, diagnose, unmount, delete (danger)', () => {
        expect(agentOpsMenu({ provider: 'claude', fidelity: 'declared' })).toEqual([
            { id: 'restart-graceful', label: 'Restart gracefully', hint: 'same conversation; refuses if it cannot resume' },
            { id: 'restart-fresh', label: 'Restart fresh', hint: 'discards the conversation on purpose' },
            { id: 'switch:codex', label: 'Switch driver to codex', hint: 'identity, inbox, history and prompt carry across' },
            { id: 'diagnose', label: 'Diagnose', hint: 'names a cause and the repair that fits' },
            { id: 'delete-unmount', label: 'Unmount from Genie…', hint: 'keeps every .agents/* file' },
            { id: 'delete-delete', label: 'Delete…', hint: 'removes the persona folder too', danger: true },
        ]);
    });

    it('a codex agent is offered the switch to claude; an observed agent is offered nothing', () => {
        expect(agentOpsMenu({ provider: 'codex', fidelity: 'declared' }).map((i) => i.id)).toContain('switch:claude');
        expect(agentOpsMenu({ provider: 'codex', fidelity: 'declared' }).map((i) => i.id)).not.toContain('switch:codex');
        expect(agentOpsMenu({ provider: 'claude', fidelity: 'observed' })).toEqual([]);
    });

    it('a RUNNING agent leads with Stop agent (it ends the session; the turn’s Stop only stops the turn) — once; a stopped one has none', () => {
        const running = agentOpsMenu({ provider: 'claude', fidelity: 'declared' }, undefined, { running: true });
        expect(running[0]).toEqual({ id: 'stop-agent', label: 'Stop agent', hint: 'ends its session; identity, inbox and history kept' });
        expect(running.filter((i) => i.id === 'stop-agent')).toHaveLength(1);
        // Control: the same agent not running is offered no Stop agent — nothing to end; the rest of the menu is unchanged.
        const idle = agentOpsMenu({ provider: 'claude', fidelity: 'declared' }, undefined, { running: false });
        expect(idle.map((i) => i.id)).not.toContain('stop-agent');
        expect(running.slice(1)).toEqual(idle);
        expect(agentOpsMenu({ provider: 'claude', fidelity: 'observed' }, undefined, { running: true })).toEqual([]);
    });
});
