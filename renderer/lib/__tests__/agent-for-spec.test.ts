import { describe, expect, it } from 'vitest';
import { agentForSpec } from '../agent-for-spec';
import type { AgentRecordSpec, AgentRuntimeSpec } from '../ams-grid';

/**
 * Which AGENT is this terminal panel showing?
 *
 * The panel's driver control — switch TUI, see sidecars — is keyed on the agent
 * RECORD, not the terminal. It was built, wired into the panel header and then
 * never rendered once, because nothing computed the record id: `AgentPanel`
 * declares `agentId` optional and both of its call sites omit it, so the
 * `{agentId && …}` guard was false everywhere and the control the owner asked
 * for in the panel controls has never been on screen.
 *
 * A terminal belongs to an agent through its RUNTIME — `terminalSpecId` — and
 * through nothing else. Not through `meta.agent` (that names a TUI, and the
 * whole point is an agent outlives its TUI) and not through the label.
 */

const agent = (id: string, over: Partial<AgentRecordSpec> = {}): AgentRecordSpec => ({
    id,
    name: id,
    purpose: '',
    avatar: null,
    role: 'specialized',
    collisionGroup: null,
    ...over,
});

const runtime = (
    id: string,
    agentId: string,
    over: Partial<AgentRuntimeSpec> = {},
): AgentRuntimeSpec => ({
    id,
    agentId,
    provider: 'claude',
    terminalSpecId: null,
    fronted: false,
    ...over,
});

describe('agentForSpec', () => {
    it('finds the agent whose runtime holds this terminal', () => {
        const found = agentForSpec({
            agents: [agent('a1'), agent('a2')],
            runtimes: [
                runtime('r1', 'a1', { terminalSpecId: 't-other' }),
                runtime('r2', 'a2', { terminalSpecId: 't-here', fronted: true }),
            ],
            specId: 't-here',
        });
        expect(found?.id).toBe('a2');
    });

    it('finds it through a SIDECAR too, not only the fronted TUI', () => {
        // The panel you are looking at may be the parked driver. It is still
        // this agent's terminal, and the switcher has to open on the right
        // agent from either side.
        const found = agentForSpec({
            agents: [agent('a1')],
            runtimes: [
                runtime('r1', 'a1', { terminalSpecId: 't-front', fronted: true }),
                runtime('r2', 'a1', { terminalSpecId: 't-side', provider: 'codex' }),
            ],
            specId: 't-side',
        });
        expect(found?.id).toBe('a1');
    });

    it('returns null for a terminal no runtime claims', () => {
        // An ORPHAN — an agent-stamped spec with no runtime row. Handing the
        // switcher a guessed agent would let a click re-front a terminal that
        // belongs to something else.
        expect(
            agentForSpec({
                agents: [agent('a1')],
                runtimes: [runtime('r1', 'a1', { terminalSpecId: 't-1' })],
                specId: 't-orphan',
            }),
        ).toBeNull();
    });

    it('returns null when the runtime points at an agent that is gone', () => {
        expect(
            agentForSpec({
                agents: [],
                runtimes: [runtime('r1', 'ghost', { terminalSpecId: 't-1' })],
                specId: 't-1',
            }),
        ).toBeNull();
    });

    it('ignores runtimes bound to no terminal at all', () => {
        // A dormant runtime has `terminalSpecId: null`. Matching null against a
        // missing spec id would hand every panel the first dormant agent.
        expect(
            agentForSpec({
                agents: [agent('a1')],
                runtimes: [runtime('r1', 'a1')],
                specId: '',
            }),
        ).toBeNull();
    });
});
