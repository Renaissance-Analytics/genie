import { describe, expect, it } from 'vitest';
import { knownFacts, sessionFidelity } from '../model';
import { projectFloorSession, type FloorInputs } from '../project-floor';

/**
 * The FLOOR is what Genie can say about an agent using only what it already owns:
 * the pulse, its own ForceTheQuestion queue, its own AgentInbox, the last `imDone`
 * handoff, and a triage verdict. No provider cooperation, so it works for all
 * twenty-one of them — which is the point. It is the honest baseline the declared
 * producers raise, not a stand-in for them.
 *
 * Every assertion below is about restraint. The floor's job is to be USEFUL
 * without claiming anything it cannot see, and the two ways to fail are symmetric:
 * state too little and the Deck is empty, state too much and it lies.
 */

const IDENT = { agentId: 'a1', specId: 's1', provider: 'aider', name: 'rook', cwd: '/w', workspaceId: 'w1' };
const NOW = 1_700_000_000_000;

const inputs = (over: Partial<FloorInputs> = {}): FloorInputs => ({
    identity: IDENT,
    working: false,

    questions: [],
    handoff: null,
    mail: [],
    ailment: null,
    now: NOW,
    ...over,
});

describe('turn state', () => {
    it('is idle when nothing is happening', () => {
        expect(projectFloorSession(inputs()).turn.state).toBe('idle');
    });

    it('is thinking when the agent declared itself mid-turn', () => {
        expect(projectFloorSession(inputs({ working: true })).turn.state).toBe('thinking');
    });

    it('NEVER claims tool, even mid-turn', () => {
        // Telling a tool call apart from thinking needs the agent to say so — which
        // is exactly why TurnState separates them, and exactly what silence
        // heuristics get wrong when a test suite runs quietly for minutes. The floor
        // has one turn signal and it is not "a tool is running".
        expect(projectFloorSession(inputs({ working: true })).turn.state).not.toBe('tool');
    });

    it('is thinking ONLY because of the per-agent working flag', () => {
        // The positive control, then the thing that matters: nothing else in the
        // inputs can make this agent look busy. Genie's byte activity is counted
        // PER WORKSPACE (`agentPulse.note(workspaceId, bytes)` — feedTerminalData
        // has the terminal id and does not pass it), so any byte-derived signal
        // here would report a SIBLING agent's output as this one thinking. There is
        // deliberately no input to carry it.
        expect(projectFloorSession(inputs({ working: true })).turn.state).toBe('thinking');
        expect(projectFloorSession(inputs({ working: false })).turn.state).toBe('idle');
    });

    it('ignores a workspace-level activity hint even if one is smuggled in', () => {
        // Removing `byteActive` from FloorInputs is a TYPE guarantee, and typecheck
        // is not a CI gate here — so on its own it would not stop someone re-adding
        // the field and wiring it to the only available source, which is
        // workspace-scoped. This is the test that goes red if they do.
        const smuggled = { ...inputs({ working: false }), byteActive: true } as FloorInputs;
        expect(projectFloorSession(smuggled).turn.state).toBe('idle');
    });

    it('is awaiting-input when a question is pending, even mid-turn', () => {
        // A pending ForceTheQuestion means the agent is parked on a human. That
        // outranks activity: an agent that is "working" on waiting is still blocked.
        const s = projectFloorSession(
            inputs({ working: true, questions: [{ id: 'q1', createdAt: NOW - 60_000 }] }),
        );
        expect(s.turn.state).toBe('awaiting-input');
    });

    it('dates awaiting-input from the OLDEST question, not from now', () => {
        // So the surface can say "waiting 5 minutes" rather than "waiting 0s" every
        // time it re-reads the state. `since` means when the state BEGAN.
        const s = projectFloorSession(
            inputs({
                questions: [
                    { id: 'new', createdAt: NOW - 10_000 },
                    { id: 'old', createdAt: NOW - 300_000 },
                ],
            }),
        );
        expect(s.turn.since).toBe(NOW - 300_000);
    });

    it('dates every other state from now', () => {
        expect(projectFloorSession(inputs({ working: true })).turn.since).toBe(NOW);
    });
});

describe('what the floor refuses to claim', () => {
    it('leaves the composer, plan, usage and commands unseen', () => {
        const s = projectFloorSession(inputs({ working: true }));
        expect(s.composer).toBeNull();
        expect(s.plan).toBeNull();
        expect(s.usage).toBeNull();
        expect(s.commands).toBeNull();
        expect(knownFacts(s)).toMatchObject({ composer: false, plan: false, usage: false, commands: false });
    });

    it('stays OBSERVED fidelity however much it knows', () => {
        // Including with a full transcript and a pending question. The floor is
        // never declared, because nothing here came from the agent stating its own
        // state.
        const s = projectFloorSession(
            inputs({
                questions: [{ id: 'q1', createdAt: NOW }],
                handoff: { text: 'landed #770', at: NOW - 1000 },
                mail: [{ id: 'm1', from: 'human', author: null, body: 'ping', at: NOW - 2000 }],
            }),
        );
        expect(sessionFidelity(s)).toBe('observed');
    });

    it('keeps approvals EMPTY — a question is not a tool approval', () => {
        // PendingApproval is {id,name,args}: a tool approval, the thing ACP's
        // session/request_permission carries. A ForceTheQuestion has options, a
        // priority, DND deferral, an age and a host. Squeezing one into the other
        // throws all of that away and then renders it as if it were a tool call.
        // The question's own surface is the attention queue; here it shows up as
        // turn.state === 'awaiting-input' and nothing more.
        const s = projectFloorSession(inputs({ questions: [{ id: 'q1', createdAt: NOW }] }));
        expect(s.approvals).toEqual([]);
        expect(s.turn.state).toBe('awaiting-input');
    });

    it('reports an unresolvable provider as unknown rather than guessing', () => {
        const s = projectFloorSession(inputs({ identity: { ...IDENT, provider: null } }));
        expect(sessionFidelity(s)).toBe('unknown');
    });
});

describe('the transcript', () => {
    it('is empty when Genie has seen nothing', () => {
        const s = projectFloorSession(inputs());
        expect(s.transcript).toEqual([]);
        expect(knownFacts(s).transcript).toBe(false);
    });

    it('names an external sender, so a peer is not mistaken for the agent', () => {
        // The lifted Message carries only a role, which is enough for a single-agent
        // harness. Genie's mail is multi-party, so `author` says who — and encoding
        // it into the body as a prefix would be munging somebody's text.
        const s = projectFloorSession(
            inputs({
                mail: [
                    { id: 'm1', from: 'human', author: null, body: 'ship it', at: NOW - 3000 },
                    { id: 'm2', from: 'peer', author: 'vale', body: 'rebased', at: NOW - 2000 },
                    { id: 'm3', from: 'agent', author: null, body: 'on it', at: NOW - 1000 },
                ],
            }),
        );
        expect(s.transcript).toEqual([
            { id: 'm1', role: 'user', author: null, content: 'ship it' },
            { id: 'm2', role: 'user', author: 'vale', content: 'rebased' },
            { id: 'm3', role: 'agent', author: null, content: 'on it' },
        ]);
    });

    it('orders by time regardless of the order it was handed', () => {
        const s = projectFloorSession(
            inputs({
                mail: [
                    { id: 'late', from: 'human', author: null, body: 'b', at: NOW - 1000 },
                    { id: 'early', from: 'human', author: null, body: 'a', at: NOW - 9000 },
                ],
            }),
        );
        expect(s.transcript.map((m) => m.id)).toEqual(['early', 'late']);
    });

    it('ends with the handoff, because that is what you came to read', () => {
        const s = projectFloorSession(
            inputs({
                handoff: { text: 'Landed #770. The win32 test still fails.', at: NOW - 500 },
                mail: [{ id: 'm1', from: 'human', author: null, body: 'ping', at: NOW - 5000 }],
            }),
        );
        expect(s.transcript.at(-1)).toEqual({
            id: 'handoff:a1',
            role: 'agent',
            author: null,
            content: 'Landed #770. The win32 test still fails.',
        });
    });

    it('places the handoff by its own timestamp, not blindly last', () => {
        // Mail that arrived AFTER the agent finished is newer than the handoff, and
        // pretending otherwise would hide a reply the human is waiting on.
        const s = projectFloorSession(
            inputs({
                handoff: { text: 'done', at: NOW - 9000 },
                mail: [{ id: 'after', from: 'human', author: null, body: 'and this?', at: NOW - 100 }],
            }),
        );
        expect(s.transcript.map((m) => m.id)).toEqual(['handoff:a1', 'after']);
    });

    it('ignores an empty handoff rather than adding a blank message', () => {
        expect(projectFloorSession(inputs({ handoff: { text: '   ', at: NOW } })).transcript).toEqual([]);
    });
});

describe('error', () => {
    it('carries a triage ailment through', () => {
        expect(projectFloorSession(inputs({ ailment: 'pty-exited' })).error).toBe('pty-exited');
    });

    it('is null when triage found nothing', () => {
        expect(projectFloorSession(inputs()).error).toBeNull();
    });
});

describe('identity', () => {
    it('carries the spec id and workspace through unchanged', () => {
        const s = projectFloorSession(inputs());
        expect(s.agentId).toBe('a1');
        expect(s.specId).toBe('s1');
        expect(s.session).toEqual({
            provider: 'aider',
            name: 'rook',
            cwd: '/w',
            workspaceId: 'w1',
            sessionId: null,
        });
    });
});

describe('a DORMANT agent', () => {
    it('still gets a session, with no terminal', () => {
        // This is the bug the AMS grid already fixed once and wrote down: "a
        // registered agent that was not running was INVISIBLE, so every
        // role: 'workspace' agent seeded since v50 has never been shown to anyone."
        // Keying a session by its terminal would reintroduce it here, because a
        // dormant agent has no terminal to key on.
        const s = projectFloorSession(inputs({ identity: { ...IDENT, specId: null } }));
        expect(s.agentId).toBe('a1');
        expect(s.specId).toBeNull();
        expect(s.turn.state).toBe('idle');
    });

    it('still shows its last handoff, which is the whole point of a dormant row', () => {
        // The agent finished and went away. What it LEFT is the reason to look at it.
        const s = projectFloorSession(
            inputs({
                identity: { ...IDENT, specId: null },
                handoff: { text: 'Landed #770.', at: NOW - 1000 },
            }),
        );
        expect(s.transcript).toEqual([
            { id: 'handoff:a1', role: 'agent', author: null, content: 'Landed #770.' },
        ]);
    });

    it('keys the handoff message on the AGENT, so it survives a restart', () => {
        // A terminal spec id is reused across restarts but is absent while dormant,
        // so `handoff:<specId>` would be `handoff:null` for exactly the agent whose
        // handoff matters most — and would change identity if the spec ever did.
        const live = projectFloorSession(inputs({ handoff: { text: 'x', at: NOW } }));
        const dormant = projectFloorSession(
            inputs({ identity: { ...IDENT, specId: null }, handoff: { text: 'x', at: NOW } }),
        );
        expect(live.transcript[0]!.id).toBe('handoff:a1');
        expect(dormant.transcript[0]!.id).toBe('handoff:a1');
    });
});
