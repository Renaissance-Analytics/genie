import { describe, expect, it } from 'vitest';
import { agentOpsMenu } from '../src/core/agent-ops-menu.js';

/**
 * THE AGENT'S OPERATIONS MENU (§6.2) — one table of what the header's overflow offers, so the
 * component maps over it and a test reads it without opening a dropdown: Restart fresh (Restart itself
 * is the header's — one per surface, genie#1238), a switch to each OTHER provider, diagnose, and the two
 * named deletes (delete-for-real is the one danger item). An Observed (Take Over) agent gets none of these.
 */

describe('agentOpsMenu', () => {
    it('for a declared claude agent: fresh restart (no second Restart), switch to codex, diagnose, unmount, delete (danger)', () => {
        expect(agentOpsMenu({ provider: 'claude', fidelity: 'declared' })).toEqual([
            { id: 'restart-fresh', label: 'Restart fresh', hint: 'discards the conversation on purpose' },
            { id: 'switch:codex', label: 'Switch driver to codex', hint: 'starts a new conversation; identity, inbox, history and prompt carry across' },
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
