import { describe, expect, it } from 'vitest';
import { mergeDeclared } from '../merge-declared';
import { emptyAgentSession, sessionFidelity, type AgentSession } from '../model';

/**
 * Declared data over the floor projection — P3's reducer, finally written.
 *
 * The plan states the rule in one line: *"declared fields win, floor fields survive where a
 * report is silent."* It was never built, which is why the whole declared path was
 * disconnected: `applySessionUpdate` mapped ACP's twenty update kinds into an `AgentSession`
 * and nothing merged the result with what Genie already knew.
 *
 * ## The rule, and why "silent" is the hard part
 *
 * A declared field is authoritative when the agent SAID something — including when it said
 * "nothing". `plan: []` is a declaration that there is no plan; `plan: null` is the agent
 * not having mentioned plans. The first must win over the floor, the second must not erase
 * it. Every case below is that distinction.
 */

const NOW = 1_700_000_000_000;
const identity = {
    agentId: 'ag-1',
    specId: 'spec-1',
    name: 'kai',
    provider: 'claude',
    cwd: '/repo',
    workspaceId: 'ws-1',
};

/** What the floor projector produces: turn, transcript, approvals, error — nothing else. */
const floor = (over: Partial<AgentSession> = {}): AgentSession => ({
    ...emptyAgentSession(identity, NOW),
    turn: { state: 'thinking', since: NOW - 5_000 },
    transcript: [{ id: 'm1', role: 'agent', content: 'from the inbox' }],
    error: 'host lost',
    ...over,
});

/** What the ACP mapper produces. */
const declared = (over: Partial<AgentSession> = {}): AgentSession => ({
    ...emptyAgentSession(identity, NOW),
    ...over,
});

describe('mergeDeclared — a declared field wins', () => {
    it('takes the declared turn state over the inferred one', () => {
        // The whole point of the exercise: the agent says what it is doing instead of Genie
        // guessing from byte activity.
        const m = mergeDeclared(floor(), declared({ turn: { state: 'tool', since: NOW } }));
        expect(m.turn).toEqual({ state: 'tool', since: NOW });
    });

    it('takes a declared transcript over the projected mail', () => {
        // The floor fills `transcript` from the AgentInbox thread and the last handoff. Once
        // a real conversation arrives, showing mail instead would be showing the wrong thing.
        const m = mergeDeclared(
            floor(),
            declared({ transcript: [{ id: 'd1', role: 'user', content: 'the real turn' }] }),
        );
        expect(m.transcript).toEqual([{ id: 'd1', role: 'user', content: 'the real turn' }]);
    });

    it('takes declared usage, plan and commands, which the floor never has', () => {
        const m = mergeDeclared(
            floor(),
            declared({
                usage: { contextUsed: 38_000, contextMax: 200_000, costUsd: 0.91 },
                plan: [{ id: 'p1', title: 'read ipc.ts', status: 'done' }],
                commands: [{ name: 'compact', hint: null }],
            }),
        );
        expect(m.usage).toMatchObject({ costUsd: 0.91 });
        expect(m.plan).toHaveLength(1);
        expect(m.commands).toHaveLength(1);
    });

    it('makes the merged session DECLARED, so the right surface renders', () => {
        // The payoff. Floor-only is `observed` (Terminal-first tabs); once anything is
        // declared the Agent view shows the Conversation tab instead.
        expect(sessionFidelity(floor())).toBe('observed');
        expect(sessionFidelity(mergeDeclared(floor(), declared({ plan: [] })))).toBe('declared');
    });
});

describe('mergeDeclared — the floor survives silence', () => {
    it('keeps the projected transcript when the agent has said nothing yet', () => {
        // A session that has connected but not spoken must not go blank. Its mail and last
        // handoff are the most useful thing on screen at that moment.
        const m = mergeDeclared(floor(), declared({ transcript: [] }));
        expect(m.transcript).toEqual([{ id: 'm1', role: 'agent', content: 'from the inbox' }]);
    });

    it('keeps the floor turn state when the declared one is still the default idle', () => {
        // `emptyAgentSession` starts at `idle`. Letting that overwrite a floor state of
        // `thinking` would report every freshly-connected working agent as idle — and
        // `agentinbox/wake.ts` treats idle as "safe to deliver mail into".
        const m = mergeDeclared(floor(), declared());
        expect(m.turn.state).toBe('thinking');
    });

    it('keeps a floor-reported error when the agent reports none', () => {
        // The ailment comes from `diagnoseAgent`, which sees things the agent cannot — a
        // lost host, a dead transport. An agent that is fine from the inside must not clear
        // an error observed from the outside.
        expect(mergeDeclared(floor(), declared()).error).toBe('host lost');
    });

    it('lets the agent CLEAR an error it has reported itself', () => {
        const withErr = mergeDeclared(floor(), declared({ error: 'rate limited' }));
        expect(withErr.error).toBe('rate limited');
    });

    it('keeps floor approvals when the declared list is empty', () => {
        // Floor approvals are pending ForceTheQuestions — a human is genuinely blocked on
        // them. An ACP session with no mid-turn permission request must not hide them.
        const m = mergeDeclared(
            floor({ approvals: [{ id: 'q1', name: 'Answer', args: {} }] }),
            declared({ approvals: [] }),
        );
        expect(m.approvals).toHaveLength(1);
    });

    it('UNIONS approvals when both have some', () => {
        // They come from different places and both block: a pending question and a
        // mid-turn tool permission are not alternatives.
        const m = mergeDeclared(
            floor({ approvals: [{ id: 'q1', name: 'Answer', args: {} }] }),
            declared({ approvals: [{ id: 'a1', name: 'Write ipc.ts', args: {} }] }),
        );
        expect(m.approvals.map((a) => a.id).sort()).toEqual(['a1', 'q1']);
    });
});

describe('mergeDeclared — identity', () => {
    it('keeps the floor identity, which owns the agent record', () => {
        // The declared side knows a provider and a cwd; the floor side knows the agent's
        // Genie identity — its record id and name. Those are not the agent's to rename.
        const m = mergeDeclared(floor(), declared({ session: { ...emptyAgentSession(identity, NOW).session, name: 'impostor' } }));
        expect(m.session.name).toBe('kai');
    });

    it('fills a session id from the declared side, which is the only one that has it', () => {
        const m = mergeDeclared(
            floor(),
            declared({ session: { ...emptyAgentSession(identity, NOW).session, sessionId: 'sess-7' } }),
        );
        expect(m.session.sessionId).toBe('sess-7');
    });
});

describe('mergeDeclared — no declared session at all', () => {
    it('returns the floor projection untouched', () => {
        // Every pty agent takes this path, which is most of them.
        const f = floor();
        expect(mergeDeclared(f, null)).toEqual(f);
        expect(sessionFidelity(mergeDeclared(f, null))).toBe('observed');
    });
});
