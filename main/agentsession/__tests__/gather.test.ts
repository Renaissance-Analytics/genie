import { describe, expect, it } from 'vitest';
import { gatherFloorInputs, type GatherSources } from '../gather';

/**
 * The gatherer turns Genie's collections into one `FloorInputs` per agent. Its
 * whole job is ATTRIBUTION, and every test here is about one failure mode:
 * assigning a fact to the wrong agent, or to an agent that did not earn it.
 *
 * Getting this wrong is not cosmetic. "kai is blocked" when kai is fine sends a
 * person to the wrong terminal, and a workspace with four agents gives three
 * wrong answers for every right one.
 */

const agent = (over: Partial<GatherSources['agents'][number]> = {}) => ({
    agentId: 'a1',
    name: 'kai',
    specId: 's1',
    provider: 'claude',
    cwd: '/w',
    workspaceId: 'w1',
    ...over,
});

const sources = (over: Partial<GatherSources> = {}): GatherSources => ({
    agents: [agent()],
    workingTerminalIds: [],
    questions: [],
    handoffs: new Map(),
    mail: new Map(),
    ailments: new Map(),
    ...over,
});

describe('one entry per REGISTERED agent', () => {
    it('produces one set of inputs per agent, in order', () => {
        const got = gatherFloorInputs(
            sources({ agents: [agent({ agentId: 'a1' }), agent({ agentId: 'a2', specId: 's2' })] }),
        );
        expect(got.map((i) => i.identity.agentId)).toEqual(['a1', 'a2']);
    });

    it('includes a DORMANT agent', () => {
        // The grid's own lesson: a registered agent that was not running was
        // invisible. The gatherer is where that would happen again.
        const got = gatherFloorInputs(sources({ agents: [agent({ specId: null })] }));
        expect(got).toHaveLength(1);
        expect(got[0]!.identity.specId).toBeNull();
    });
});

describe('question attribution', () => {
    it('gives a question to the agent whose terminal asked it', () => {
        const got = gatherFloorInputs(
            sources({
                agents: [agent({ agentId: 'a1', specId: 's1' }), agent({ agentId: 'a2', specId: 's2' })],
                questions: [{ id: 'q1', createdAt: 100, askerTerminalId: 's2' }],
            }),
        );
        expect(got.find((i) => i.identity.agentId === 'a1')!.questions).toEqual([]);
        expect(got.find((i) => i.identity.agentId === 'a2')!.questions).toEqual([
            { id: 'q1', createdAt: 100 },
        ]);
    });

    it('gives a question NOBODY asked to nobody', () => {
        // An internal approval gate. Attributing it to the only agent in the
        // workspace would report a healthy agent as blocked.
        const got = gatherFloorInputs(sources({ questions: [{ id: 'q1', createdAt: 100 }] }));
        expect(got[0]!.questions).toEqual([]);
    });

    it('gives a question from an unknown terminal to nobody', () => {
        const got = gatherFloorInputs(
            sources({ questions: [{ id: 'q1', createdAt: 100, askerTerminalId: 's-gone' }] }),
        );
        expect(got[0]!.questions).toEqual([]);
    });

    it('does NOT match an unowned question to a DORMANT agent', () => {
        const got = gatherFloorInputs(
            sources({ agents: [agent({ specId: null })], questions: [{ id: 'q1', createdAt: 100 }] }),
        );
        expect(got[0]!.questions).toEqual([]);
    });

    it('does not match a NULL asker to a dormant agent either', () => {
        // The discriminating case, and the only one that is. `undefined === null` is
        // already false, so an OMITTED asker is safe for free — the test above passes
        // with or without the guard. What is not safe is a source yielding `null`:
        // `null === null` matches the dormant agent's own null terminal, and
        // absent-becomes-null is what a JSON/IPC round-trip and a database read both
        // produce. listPendingQuestions crosses IPC to reach the renderer, so this is
        // the shape that actually arrives, not a hypothetical.
        const got = gatherFloorInputs(
            sources({
                agents: [agent({ specId: null })],
                questions: [{ id: 'q1', createdAt: 100, askerTerminalId: null }],
            }),
        );
        expect(got[0]!.questions).toEqual([]);
    });

    it('gives each of several waiting agents only its own question', () => {
        const got = gatherFloorInputs(
            sources({
                agents: [agent({ agentId: 'a1', specId: 's1' }), agent({ agentId: 'a2', specId: 's2' })],
                questions: [
                    { id: 'q-for-1', createdAt: 100, askerTerminalId: 's1' },
                    { id: 'q-for-2', createdAt: 200, askerTerminalId: 's2' },
                ],
            }),
        );
        expect(got[0]!.questions.map((q) => q.id)).toEqual(['q-for-1']);
        expect(got[1]!.questions.map((q) => q.id)).toEqual(['q-for-2']);
    });

    it('passes an unknown arrival time through as null rather than epoch 0', () => {
        // The host says createdAt is absent for a question forwarded from an older
        // build and that consumers must "degrade (show nothing) rather than assume
        // epoch 0". Assuming 0 here would date the agent's wait to 1970 and render
        // "blocked for 56 years".
        const got = gatherFloorInputs(
            sources({ questions: [{ id: 'q1', askerTerminalId: 's1' }] }),
        );
        expect(got[0]!.questions).toEqual([{ id: 'q1', createdAt: null }]);
    });
});

describe('working', () => {
    it('is true only for an agent whose own terminal is mid-turn', () => {
        const got = gatherFloorInputs(
            sources({
                agents: [agent({ agentId: 'a1', specId: 's1' }), agent({ agentId: 'a2', specId: 's2' })],
                workingTerminalIds: ['s2'],
            }),
        );
        expect(got[0]!.working).toBe(false);
        expect(got[1]!.working).toBe(true);
    });

    it('is never true for a dormant agent', () => {
        // Same absence-matching trap: an empty working set and a null specId must
        // not agree with each other.
        const got = gatherFloorInputs(
            sources({ agents: [agent({ specId: null })], workingTerminalIds: [] }),
        );
        expect(got[0]!.working).toBe(false);
    });
});

describe('per-agent facts', () => {
    it('attaches the handoff, mail and ailment keyed by AGENT', () => {
        const got = gatherFloorInputs(
            sources({
                agents: [agent({ agentId: 'a1' }), agent({ agentId: 'a2', specId: 's2' })],
                handoffs: new Map([['a1', { text: 'mine', at: 500 }]]),
                mail: new Map([['a1', [{ id: 'm1', from: 'human', author: null, body: 'hi', at: 400 }]]]),
                ailments: new Map([['a2', 'pty-exited']]),
            }),
        );
        expect(got[0]!.handoff).toEqual({ text: 'mine', at: 500 });
        expect(got[0]!.mail).toHaveLength(1);
        expect(got[0]!.ailment).toBeNull();

        expect(got[1]!.handoff).toBeNull();
        expect(got[1]!.mail).toEqual([]);
        expect(got[1]!.ailment).toBe('pty-exited');
    });

    it('keys those on the agent, not the terminal, so a dormant agent keeps them', () => {
        const got = gatherFloorInputs(
            sources({
                agents: [agent({ specId: null })],
                handoffs: new Map([['a1', { text: 'left this', at: 500 }]]),
            }),
        );
        expect(got[0]!.handoff).toEqual({ text: 'left this', at: 500 });
    });
});
