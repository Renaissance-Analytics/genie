import { describe, expect, it } from 'vitest';
import { decideAgentStart, savedAgentsOf, type SavedAgent } from '../saved';

/**
 * The `runAgent start` decision (Tynn #254) — reattach, create, or refuse.
 *
 * The tool-level acceptance test lives in
 * `main/mcp/__tests__/run-agent-saved.test.ts`, where the world after the call is
 * what gets asserted. THIS file pins the branches that are hard to reach from
 * there: an ambiguity that needs two providers, a refusal's wording, and the
 * provider-inheritance rule.
 */

const AGENT = (over: Partial<SavedAgent> = {}): SavedAgent => ({
    specId: 'spec-1',
    provider: 'claude',
    name: 'tynn',
    agentId: 'agent-1',
    chatSessionId: 'chat-1',
    live: true,
    ...over,
});

const REQ = { workstationProvider: 'claude' as const };

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
                provider: 'claude',
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

    it('ignores a spec whose provider is not one Genie runs', () => {
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
        const agent = AGENT({ provider: 'codex', chatSessionId: null });
        const d = decideAgentStart([agent], { ...REQ, name: 'tynn' });
        expect(d.kind).toBe('reattach');
    });

    it('takes the provider from the RECORD, not from the workstation', () => {
        // `codex:tynn-slave` is a specific agent holding a specific Codex
        // conversation. Re-resolving the provider on reattach would hand back a
        // different agent that happens to share a name.
        const agent = AGENT({ provider: 'codex', name: 'tynn-slave' });
        const d = decideAgentStart([agent], {
            name: 'tynn-slave',
            workstationProvider: 'claude',
        });
        expect(d.kind === 'reattach' && d.agent.provider).toBe('codex');
    });
});

describe('an ambiguous name', () => {
    it('REFUSES rather than picking one, and names both refs', () => {
        const d = decideAgentStart(
            [AGENT({ specId: 's1', provider: 'claude' }), AGENT({ specId: 's2', provider: 'codex' })],
            { ...REQ, name: 'tynn' },
        );
        expect(d.kind).toBe('refuse');
        expect(d.kind === 'refuse' && d.error).toContain('claude:tynn');
        expect(d.kind === 'refuse' && d.error).toContain('codex:tynn');
    });

    it('resolves once the provider is given', () => {
        const claude = AGENT({ specId: 's1', provider: 'claude' });
        const codex = AGENT({ specId: 's2', provider: 'codex' });
        const d = decideAgentStart([claude, codex], { ...REQ, name: 'tynn', provider: 'codex' });
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
        expect(d.kind === 'refuse' && d.error).toContain('claude:other');
    });

    it('says so plainly when the workspace has no agents at all', () => {
        const d = decideAgentStart([], { ...REQ, name: 'tynn' });
        expect(d.kind === 'refuse' && d.error).toContain('no saved agents yet');
    });

    it('creates with `create`, taking the WORKSTATION provider when none is named', () => {
        // The person paying for the subscription picks the TUI — the same rule
        // GApp agents follow. It is pinned onto the record from here.
        expect(
            decideAgentStart([], { name: 'tynn', create: true, workstationProvider: 'codex' }),
        ).toEqual({ kind: 'create', provider: 'codex', name: 'tynn' });
    });

    it('honours an explicitly named provider over the workstation default', () => {
        expect(
            decideAgentStart([], {
                name: 'tynn-slave',
                provider: 'codex',
                create: true,
                workstationProvider: 'claude',
            }),
        ).toEqual({ kind: 'create', provider: 'codex', name: 'tynn-slave' });
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
        expect(d.kind === 'refuse' && d.error).toContain('claude:tynn');
        expect(d.kind === 'refuse' && d.error).toMatch(/reattach/);
    });

    it('lets the same name exist under a DIFFERENT provider', () => {
        const d = decideAgentStart([AGENT({ provider: 'claude' })], {
            ...REQ,
            name: 'tynn',
            provider: 'codex',
            create: true,
        });
        expect(d).toEqual({ kind: 'create', provider: 'codex', name: 'tynn' });
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
