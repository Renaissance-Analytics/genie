import { describe, expect, it } from 'vitest';
import { adoptableAgentSpec, decideAgentStart, savedAgentsOf, type SavedAgent } from '../saved';

/**
 * The `runAgent start` decision (Tynn #254) — reattach, create, or refuse.
 *
 * The tool-level acceptance test lives in
 * `main/mcp/__tests__/run-agent-saved.test.ts`, where the world after the call is
 * what gets asserted. THIS file pins the branches that are hard to reach from
 * there: an ambiguity that needs two providers, a refusal's wording, and the
 * tui-inheritance rule.
 */

const AGENT = (over: Partial<SavedAgent> = {}): SavedAgent => ({
    specId: 'spec-1',
    tui: 'claude',
    name: 'tynn',
    agentId: 'agent-1',
    chatSessionId: 'chat-1',
    live: true,
    ...over,
});

const REQ = { workstationTui: 'claude' as const };

describe('reading saved agents off terminal specs', () => {
    it('takes every spec carrying meta.agent — a saved agent IS a terminal spec', () => {
        const saved = savedAgentsOf(
            [
                {
                    id: 's1',
                    workspace_id: 'ws',
                    meta: {
                        agent: 'claude',
                        agent_id: 'a1',
                        whisper_purpose: 'tynn',
                        chat_session_id: 'c1',
                    },
                },
                // A plain shell. Not an agent, and never was.
                { id: 's2', workspace_id: 'ws', meta: { created_by: 'agent' } },
                // Another workspace's agent — a saved agent belongs to ONE workspace.
                { id: 's3', workspace_id: 'other', meta: { agent: 'codex' } },
            ],
            'ws',
            (id) => id === 's1',
        );

        expect(saved).toEqual([
            {
                specId: 's1',
                tui: 'claude',
                name: 'tynn',
                agentId: 'a1',
                chatSessionId: 'c1',
                live: true,
            },
        ]);
    });

    it('reports a Codex agent with no chat-id yet as a saved agent, not as broken', () => {
        // The state every Codex agent is in between spawn and SessionStart. If
        // this were filtered out, a start during that window would create a
        // SECOND agent — the exact bug, with a race attached.
        const saved = savedAgentsOf(
            [{ id: 's1', workspace_id: 'ws', meta: { agent: 'codex', agent_id: 'a1', whisper_purpose: 'slave' } }],
            'ws',
            () => true,
        );
        expect(saved).toHaveLength(1);
        expect(saved[0]!.chatSessionId).toBeNull();
        expect(saved[0]!.name).toBe('slave');
    });

    it('ignores a spec whose tui is not one Genie runs', () => {
        const saved = savedAgentsOf(
            [{ id: 's1', workspace_id: 'ws', meta: { agent: 'gemini' } }],
            'ws',
            () => true,
        );
        expect(saved).toEqual([]);
    });

    it('names an agent `general` when nothing named it', () => {
        // Which is what every agent started before saved agents existed is
        // called, so those reattach instead of reading as absent.
        const saved = savedAgentsOf(
            [{ id: 's1', workspace_id: 'ws', meta: { agent: 'claude', agent_id: 'a1' } }],
            'ws',
            () => true,
        );
        expect(saved[0]!.name).toBe('general');
    });
});

describe('starting a saved agent', () => {
    it('REATTACHES warm when it is running', () => {
        const agent = AGENT({ live: true });
        expect(decideAgentStart([agent], { ...REQ, name: 'tynn' })).toEqual({
            kind: 'reattach',
            agent,
            how: 'warm',
        });
    });

    it('REATTACHES by REVIVING when the spec outlived its pty', () => {
        const agent = AGENT({ live: false });
        expect(decideAgentStart([agent], { ...REQ, name: 'tynn' })).toEqual({
            kind: 'reattach',
            agent,
            how: 'revive',
        });
    });

    it('reattaches a Codex agent that has not bound its chat-id yet', () => {
        const agent = AGENT({ tui: 'codex', chatSessionId: null });
        const d = decideAgentStart([agent], { ...REQ, name: 'tynn' });
        expect(d.kind).toBe('reattach');
    });

    it('takes the tui from the RECORD, not from the workstation', () => {
        // `codex:tynn-slave` is a specific agent holding a specific Codex
        // conversation. Re-resolving the tui on reattach would hand back a
        // different agent that happens to share a name.
        const agent = AGENT({ tui: 'codex', name: 'tynn-slave' });
        const d = decideAgentStart([agent], {
            name: 'tynn-slave',
            workstationTui: 'claude',
        });
        expect(d.kind === 'reattach' && d.agent.tui).toBe('codex');
    });
});

describe('an ambiguous name', () => {
    it('REFUSES rather than picking one, and names both refs', () => {
        const d = decideAgentStart(
            [AGENT({ specId: 's1', tui: 'claude' }), AGENT({ specId: 's2', tui: 'codex' })],
            { ...REQ, name: 'tynn' },
        );
        expect(d.kind).toBe('refuse');
        expect(d.kind === 'refuse' && d.error).toContain('tynn (claude)');
        expect(d.kind === 'refuse' && d.error).toContain('tynn (codex)');
    });

    it('resolves once the tui is given', () => {
        const claude = AGENT({ specId: 's1', tui: 'claude' });
        const codex = AGENT({ specId: 's2', tui: 'codex' });
        const d = decideAgentStart([claude, codex], { ...REQ, name: 'tynn', tui: 'codex' });
        expect(d.kind === 'reattach' && d.agent.specId).toBe('s2');
    });
});

describe('creating a new agent', () => {
    it('is REFUSED without `create` — the roster does not fill by accident', () => {
        const d = decideAgentStart([AGENT({ name: 'other' })], { ...REQ, name: 'tynn' });
        expect(d.kind).toBe('refuse');
        expect(d.kind === 'refuse' && d.error).toMatch(/create/);
        // The refusal teaches: it lists what the workspace HAS, because a caller
        // reaching for a near-miss name is the common case.
        expect(d.kind === 'refuse' && d.error).toContain('other (claude)');
    });

    it('says so plainly when the workspace has no agents at all', () => {
        const d = decideAgentStart([], { ...REQ, name: 'tynn' });
        expect(d.kind === 'refuse' && d.error).toContain('no saved agents yet');
    });

    it('creates with `create`, taking the WORKSTATION tui when none is named', () => {
        // The person paying for the subscription picks the TUI — the same rule
        // GApp agents follow. It is pinned onto the record from here.
        expect(
            decideAgentStart([], { name: 'tynn', create: true, workstationTui: 'codex' }),
        ).toEqual({ kind: 'create', tui: 'codex', name: 'tynn' });
    });

    it('honours an explicitly named tui over the workstation default', () => {
        expect(
            decideAgentStart([], {
                name: 'tynn-slave',
                tui: 'codex',
                create: true,
                workstationTui: 'claude',
            }),
        ).toEqual({ kind: 'create', tui: 'codex', name: 'tynn-slave' });
    });

    it('normalises the name it creates under', () => {
        const d = decideAgentStart([], { ...REQ, name: 'Tynn Slave', create: true });
        expect(d.kind === 'create' && d.name).toBe('tynn-slave');
    });

    it('REFUSES `create` on a name the workspace already has', () => {
        // Not "quietly reattach": a create that became a reattach would hide from
        // the caller that its brand-new agent is carrying somebody else's history.
        const d = decideAgentStart([AGENT()], { ...REQ, name: 'tynn', create: true });
        expect(d.kind).toBe('refuse');
        expect(d.kind === 'refuse' && d.error).toContain('"tynn"');
        expect(d.kind === 'refuse' && d.error).toMatch(/reattach/);
    });

    it('lets the same name exist under a DIFFERENT tui', () => {
        const d = decideAgentStart([AGENT({ tui: 'claude' })], {
            ...REQ,
            name: 'tynn',
            tui: 'codex',
            create: true,
        });
        expect(d).toEqual({ kind: 'create', tui: 'codex', name: 'tynn' });
    });
});

describe('a start that names nothing', () => {
    it('resolves to the workspace default agent rather than minting one', () => {
        // The owner's complaint in one assertion: calling the tool with no
        // arguments used to mean "spawn another".
        const agent = AGENT({ name: 'general' });
        expect(decideAgentStart([agent], REQ)).toEqual({
            kind: 'reattach',
            agent,
            how: 'warm',
        });
    });

    it('still refuses to create one implicitly', () => {
        const d = decideAgentStart([], REQ);
        expect(d.kind).toBe('refuse');
    });
});

/**
 * A registered agent has ONE terminal. `runAgent start` binds the terminal it
 * creates onto the `workspace_agents` row, and a bind REPLACES whatever was
 * there — so a start that reaches the create path while the agent's previous
 * terminal is still alive leaves that terminal behind, still carrying
 * `meta.agent` and the same `whisper_purpose`.
 *
 * Nothing reaps it, and the AMS grid draws a square per agent-stamped spec, so
 * the abandoned terminal keeps rendering as a second agent under the same name.
 * Observed in the wild: the Tynn workspace held ONE registered `claude:tynn` and
 * THREE specs rendering "tynn", two of them bound to nothing.
 *
 * So before creating, look for a terminal that already IS this agent. Matching
 * on tui AND name is the same identity the grid renders and the registry
 * keys on, which is what makes adopting it correct rather than a guess.
 */
describe('adopting an agent terminal that is already there', () => {
    const spec = (id: string, agent: string, purpose: string) => ({
        id,
        workspace_id: 'ws',
        meta: { agent, whisper_purpose: purpose },
    });

    it('adopts the live terminal instead of minting a second one', () => {
        const saved = savedAgentsOf(
            [spec('t1', 'claude', 'tynn')],
            'ws',
            () => true,
        );
        expect(adoptableAgentSpec(saved, 'claude', 'tynn')?.specId).toBe('t1');
    });

    it('adopts a terminal that is saved but not running', () => {
        // "Not live" is not "not there" — reviving it is the whole point of a
        // saved agent, and creating instead would strand its conversation.
        const saved = savedAgentsOf([spec('t1', 'claude', 'tynn')], 'ws', () => false);
        expect(adoptableAgentSpec(saved, 'claude', 'tynn')?.specId).toBe('t1');
    });

    it('does not adopt the same name under a DIFFERENT tui', () => {
        // `codex:tynn` and `claude:tynn` are two agents. The registry's unique
        // key is (workspace, tui, name), and this must agree with it.
        const saved = savedAgentsOf([spec('t1', 'codex', 'tynn')], 'ws', () => true);
        expect(adoptableAgentSpec(saved, 'claude', 'tynn')).toBeUndefined();
    });

    it('does not adopt a different agent of the same tui', () => {
        const saved = savedAgentsOf([spec('t1', 'claude', 'other')], 'ws', () => true);
        expect(adoptableAgentSpec(saved, 'claude', 'tynn')).toBeUndefined();
    });

    it('has nothing to adopt in an empty workspace', () => {
        expect(adoptableAgentSpec([], 'claude', 'tynn')).toBeUndefined();
    });
});
