import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../../../main/agentsession/model';
import { deckView, rosterRow } from '../deck-view';

/**
 * What the Deck PUTS ON SCREEN, as a value.
 *
 * The rules that matter are all about honesty under absence, because this is the
 * surface a person trusts to tell them whether anything needs them:
 *
 *  - a cost or context we cannot see renders as ABSENT, never as a dash and never
 *    as zero — a dash reads as "nothing spent";
 *  - an agent that believes it is working but has not moved for five minutes is a
 *    THIRD state, not "active" and not "idle", because that is the one the current
 *    product cannot see at all and the one that wastes the most human time;
 *  - the figures in the band header count what is true, not what is displayable.
 */

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
    agentId: 'a1',
    specId: 's1',
    session: { provider: 'claude', name: 'kai', cwd: '/w', workspaceId: 'w1', sessionId: null },
    turn: { state: 'idle', since: 1_000 },
    thoughts: [],
    liveThought: null,
    rateLimit: null,
    rateLimitUnavailable: null,
    composer: null,
    transcript: [],
    live: null,
    tools: [],
    approvals: [],
    plan: null,
    usage: null,
    commands: null,
    error: null,
    ...over,
});

const NOW = 10_000_000;

describe('rosterRow — state', () => {
    it('says idle plainly', () => {
        expect(rosterRow(session(), NOW).state).toBe('idle');
    });

    it('says awaiting you, and that it is BLOCKING', () => {
        const r = rosterRow(session({ turn: { state: 'awaiting-input', since: NOW - 120_000 } }), NOW);
        expect(r.state).toBe('awaiting-you');
        expect(r.blocking).toBe(true);
    });

    it('treats an approval the same way — a human is the bottleneck either way', () => {
        const r = rosterRow(session({ turn: { state: 'awaiting-approval', since: NOW } }), NOW);
        expect(r.state).toBe('awaiting-you');
        expect(r.blocking).toBe(true);
    });

    it('says working while it is still inside the work window', () => {
        const r = rosterRow(session({ turn: { state: 'thinking', since: NOW - 60_000 } }), NOW);
        expect(r.state).toBe('working');
        expect(r.blocking).toBe(false);
    });

    it('says STALLED once it has not moved for the whole work window', () => {
        // The state the product cannot currently see: the agent believes it is
        // working. Rendered as a fact, not a verdict — a long test suite is
        // legitimate and only the human can judge.
        const r = rosterRow(session({ turn: { state: 'thinking', since: NOW - 6 * 60_000 } }), NOW);
        expect(r.state).toBe('stalled');
    });

    it('reuses the EXISTING five-minute threshold rather than inventing one', () => {
        // AGENT_WORK_WINDOW_MS exists for exactly this decay. A second number would
        // drift from the one the rail glow already uses.
        const justInside = rosterRow(session({ turn: { state: 'thinking', since: NOW - 5 * 60_000 + 1 } }), NOW);
        const justOutside = rosterRow(session({ turn: { state: 'thinking', since: NOW - 5 * 60_000 - 1 } }), NOW);
        expect(justInside.state).toBe('working');
        expect(justOutside.state).toBe('stalled');
    });

    it('never calls a BLOCKED agent stalled, however long it has waited', () => {
        // It is not stuck; it is waiting on a person, and saying "stalled" would send
        // somebody to debug an agent that is behaving perfectly.
        const r = rosterRow(session({ turn: { state: 'awaiting-input', since: NOW - 60 * 60_000 } }), NOW);
        expect(r.state).toBe('awaiting-you');
    });
});

describe('rosterRow — honesty under absence', () => {
    it('reports cost and context as ABSENT when the session cannot see them', () => {
        const r = rosterRow(session(), NOW);
        expect(r.context).toBeNull();
        expect(r.costUsd).toBeNull();
    });

    it('distinguishes a real zero from absent', () => {
        // $0.00 spent is a fact an ACP session can state. It must not render the same
        // as "we cannot see what this cost".
        const r = rosterRow(
            session({ usage: { contextUsed: 0, contextMax: 200_000, costUsd: 0 } }),
            NOW,
        );
        expect(r.costUsd).toBe(0);
        expect(r.context).toEqual({ used: 0, max: 200_000 });
    });

    it('reports context as absent when only the cost is known', () => {
        const r = rosterRow(session({ usage: { contextUsed: null, contextMax: null, costUsd: 1.5 } }), NOW);
        expect(r.context).toBeNull();
        expect(r.costUsd).toBe(1.5);
    });

    it('reports the fidelity so the row can say what it cannot show', () => {
        expect(rosterRow(session(), NOW).fidelity).toBe('observed');
        expect(
            rosterRow(session({ composer: { text: '', cursor: 0, busy: false } }), NOW).fidelity,
        ).toBe('declared');
        expect(
            rosterRow(session({ session: { ...session().session, provider: null } }), NOW).fidelity,
        ).toBe('unknown');
    });

    it('carries the error through so a broken agent is not shown as merely idle', () => {
        const r = rosterRow(session({ error: 'pty-exited' }), NOW);
        expect(r.error).toBe('pty-exited');
    });
});

describe('deckView — order', () => {
    it('puts agents that need you first', () => {
        const v = deckView(
            [
                session({ agentId: 'busy', turn: { state: 'thinking', since: NOW } }),
                session({ agentId: 'blocked', turn: { state: 'awaiting-input', since: NOW - 1000 } }),
            ],
            NOW,
        );
        expect(v.roster.map((r) => r.agentId)).toEqual(['blocked', 'busy']);
    });

    it('then most-recently-changed first, not alphabetical', () => {
        // Alphabetical is stable and therefore dead: the thing that just changed is
        // the thing nobody has seen.
        const v = deckView(
            [
                session({ agentId: 'alice', turn: { state: 'thinking', since: NOW - 60_000 } }),
                session({ agentId: 'zed', turn: { state: 'thinking', since: NOW - 1_000 } }),
            ],
            NOW,
        );
        expect(v.roster.map((r) => r.agentId)).toEqual(['zed', 'alice']);
    });
});

describe('deckView — the band figures', () => {
    it('counts live, blocked, context and spend', () => {
        const v = deckView(
            [
                session({
                    agentId: 'a',
                    turn: { state: 'thinking', since: NOW },
                    usage: { contextUsed: 10_000, contextMax: 200_000, costUsd: 1.25 },
                }),
                session({ agentId: 'b', turn: { state: 'awaiting-input', since: NOW } }),
                session({ agentId: 'c', turn: { state: 'idle', since: NOW } }),
            ],
            NOW,
        );
        expect(v.figures).toEqual({ live: 1, needingYou: 1, contextUsed: 10_000, costUsd: 1.25 });
    });

    it('counts a STALLED agent as live, because its turn has not ended', () => {
        const v = deckView([session({ turn: { state: 'thinking', since: NOW - 60 * 60_000 } })], NOW);
        expect(v.figures.live).toBe(1);
    });

    it('reports spend as null when NOTHING can see a cost', () => {
        // Not 0. A board that says "$0.00 today" when it simply cannot see any cost
        // is making a claim about money, which is the worst place to guess.
        const v = deckView([session(), session({ agentId: 'b' })], NOW);
        expect(v.figures.costUsd).toBeNull();
        expect(v.figures.contextUsed).toBeNull();
    });

    it('sums only what is known, and still reports it', () => {
        // One declared agent among several observed ones: the total is real for the
        // ones that can report, and the surface says so rather than suppressing it.
        const v = deckView(
            [
                session({ agentId: 'seen', usage: { contextUsed: 5_000, contextMax: 200_000, costUsd: 2 } }),
                session({ agentId: 'unseen' }),
            ],
            NOW,
        );
        expect(v.figures).toMatchObject({ contextUsed: 5_000, costUsd: 2 });
    });

    it('is empty and says so for no agents at all', () => {
        const v = deckView([], NOW);
        expect(v.roster).toEqual([]);
        expect(v.figures).toEqual({ live: 0, needingYou: 0, contextUsed: null, costUsd: null });
    });
});
