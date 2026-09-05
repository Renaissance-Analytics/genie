import { describe, expect, it, vi } from 'vitest';
import { resolveAgentMode } from '../agent-mode-source';
import type { AgentMode } from '../agent-mode';

/**
 * WHICH row's `AGENT.md` a nudge surface should read — and why the AgentInbox
 * id is not enough on its own (genie#408).
 *
 * ## The trap
 *
 * There are two ids in play and they are NOT the same one:
 *
 *  - `workspace_agents.id` — stable, minted by `registerAgent`, what
 *    `persona_path` hangs off.
 *  - the AgentInbox `agentId` — `terminal_specs.meta.agent_id`, minted fresh by
 *    `spawnTerminal` on every launch. `ipc.ts` says so outright: *"a relaunch (a
 *    new terminal + a new agent id)"*.
 *
 * Migration v54 renamed the AMS row to ADOPT the inbox id, which makes them
 * agree — until the next relaunch mints another one and they diverge again.
 *
 * That matters because the broker and the upgrade announcement both address
 * agents by the INBOX id. A lookup keyed on it alone finds no row for a
 * relaunched agent and answers with the default — so an agent a human
 * deliberately declared **Automated** would quietly be spoken to as Manual, and
 * nothing anywhere would report it. A silent wrong answer, which is the failure
 * mode this whole issue is about.
 *
 * So the TERMINAL is tried first: `workspace_agents.terminal_spec_id` is the
 * binding Genie maintains across relaunches, and it is what
 * `markWorkspaceAgentReadyByTerminal` already keys on.
 */

const AUTOMATED: AgentMode = 'automated';
const MANUAL: AgentMode = 'manual';

/** A row, reduced to the one field this decision reads. */
const row = (personaPath: string | null) => ({ persona_path: personaPath });

/** `modeOf`, faked: a path maps to whatever the file at it would say. */
const files = (map: Record<string, AgentMode>) => (p: string | null): AgentMode =>
    (p && map[p]) || MANUAL;

describe('resolving an agent’s mode from what a nudge surface holds', () => {
    it('prefers the TERMINAL binding over the inbox id', () => {
        // The case that breaks a naive lookup: a relaunched agent whose inbox id
        // no longer matches any row. The terminal still does.
        const byId = vi.fn().mockReturnValue(undefined);
        const byTerminal = vi.fn().mockReturnValue(row('/ws/.agents/moic/AGENT.md'));

        expect(
            resolveAgentMode(
                { agentId: 'inbox-uuid-from-this-launch', terminalId: 'term-1' },
                {
                    byId,
                    byTerminal,
                    modeOf: files({ '/ws/.agents/moic/AGENT.md': AUTOMATED }),
                },
            ),
        ).toBe(AUTOMATED);
        expect(byTerminal).toHaveBeenCalledWith('term-1');
    });

    it('falls back to the id when there is no terminal to go on', () => {
        // The upgrade announcement can hold an agent the broker has no live
        // terminal for. Its id is all there is, and after migration v54 that is
        // frequently the right key.
        expect(
            resolveAgentMode(
                { agentId: 'a-moic', terminalId: null },
                {
                    byId: (id) => (id === 'a-moic' ? row('/p/AGENT.md') : undefined),
                    byTerminal: () => undefined,
                    modeOf: files({ '/p/AGENT.md': AUTOMATED }),
                },
            ),
        ).toBe(AUTOMATED);
    });

    it('falls back to the id when the terminal matches no row', () => {
        expect(
            resolveAgentMode(
                { agentId: 'a-moic', terminalId: 'term-nobody-owns' },
                {
                    byId: () => row('/p/AGENT.md'),
                    byTerminal: () => undefined,
                    modeOf: files({ '/p/AGENT.md': AUTOMATED }),
                },
            ),
        ).toBe(AUTOMATED);
    });

    it('is MANUAL when neither coordinate finds an agent', () => {
        // The workstation operator is exactly this: deliberately not a workspace
        // agent, so it has no row and no AGENT.md at all.
        expect(
            resolveAgentMode(
                { agentId: 'genie:workstation', terminalId: 'genie-workstation-agent' },
                { byId: () => undefined, byTerminal: () => undefined, modeOf: () => AUTOMATED },
            ),
        ).toBe(MANUAL);
    });

    it('is MANUAL when a lookup throws', () => {
        // Reading a mode means a database and a file. Neither may be able to
        // cost an agent its notice, and neither may be able to promote it.
        for (const lookups of [
            {
                byId: () => row('/p/AGENT.md'),
                byTerminal: () => {
                    throw new Error('db closed');
                },
                modeOf: files({ '/p/AGENT.md': AUTOMATED }),
            },
            {
                byId: () => row('/p/AGENT.md'),
                byTerminal: () => undefined,
                modeOf: () => {
                    throw new Error('unreadable');
                },
            },
        ]) {
            expect(resolveAgentMode({ agentId: 'a', terminalId: 't' }, lookups)).toBe(MANUAL);
        }
    });

    it('POSITIVE CONTROL: it really can answer automated', () => {
        // Every assertion above that expects `manual` would also pass against a
        // function that returned `manual` unconditionally.
        expect(
            resolveAgentMode(
                { agentId: 'a', terminalId: 't' },
                {
                    byId: () => undefined,
                    byTerminal: () => row('/p/AGENT.md'),
                    modeOf: files({ '/p/AGENT.md': AUTOMATED }),
                },
            ),
        ).toBe(AUTOMATED);
    });
});
