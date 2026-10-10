import { describe, expect, it } from 'vitest';
import { toStreamEvent, type StreamEvent } from '../src/core/stream-event.js';

/**
 * ACP UPDATES → THE STREAM LEDGER.
 *
 * The Agent view is an EVENT LEDGER — one line per event — not a chat transcript. That
 * distinction is the single biggest divergence in the build this replaces, which rendered a
 * chat feed and so looked nothing like the approved design.
 *
 * Every shape asserted here was read out of `prism-acp`'s own `ClaudeToAcp` mapper
 * (`dist/claude/to-acp.js`, 0.6.1) rather than guessed, because a mapper written against
 * imagined field names is a mapper that compiles, passes its own tests and drops real
 * events in production.
 *
 * The discipline under test is §5: **what the wire does not carry renders as NOTHING.**
 * A cost that was not reported is `null`, never `0` — codex reports no cost at all, and a
 * zero there would be a confident claim that a turn was free.
 */
describe('toStreamEvent', () => {
    it('maps an agent message chunk to a message from the agent', () => {
        const e = toStreamEvent({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'ChallengeStore is committed.' },
        });

        expect(e).toMatchObject({ kind: 'message', speaker: 'agent', text: 'ChallengeStore is committed.' });
    });

    it('maps a user message chunk to a message from you', () => {
        const e = toStreamEvent({
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'keep the controller thin' },
        });

        expect(e).toMatchObject({ kind: 'message', speaker: 'you' });
    });

    it('maps a thought to ONE line with no token count — it is not on the wire', () => {
        /**
         * The design shows `· thinking  842 tok`, but per-thought tokens are NOT a field ACP
         * sends. The honest value is `null`, and the UI derives a `Δ+0.9k` from the change in
         * context across the thought's span instead. Inventing a number here — from character
         * count, say — would be a confident figure about someone's spend.
         */
        const e = toStreamEvent({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Controller should only validate and delegate…' },
        });

        expect(e).toMatchObject({ kind: 'think', text: 'Controller should only validate and delegate…' });
        expect((e as Extract<StreamEvent, { kind: 'think' }>).tokens).toBeNull();
    });

    it('maps a tool call, keeping `name` as the lookup key and `title` as chrome', () => {
        const e = toStreamEvent({
            sessionUpdate: 'tool_call',
            toolCallId: 'tool_3',
            name: 'Bash',
            title: 'npm test -- terminal',
            rawInput: { command: 'npm test -- terminal' },
        });

        expect(e).toMatchObject({
            kind: 'tool', toolCallId: 'tool_3', name: 'Bash', title: 'npm test -- terminal', status: null,
        });
    });

    it('carries a tool status through an update, and NO status when none was sent', () => {
        const running = toStreamEvent({ sessionUpdate: 'tool_call_update', toolCallId: 'tool_3', status: 'in_progress' });
        expect(running).toMatchObject({ kind: 'tool', status: 'in_progress' });

        // `null` = the agent did not say. Not 'pending', which would be an assumed shape.
        const silent = toStreamEvent({ sessionUpdate: 'tool_call_update', toolCallId: 'tool_3' });
        expect(silent).toMatchObject({ kind: 'tool', status: null });
    });

    it('reports usage, and a cost of NULL when the provider sent none', () => {
        const withCost = toStreamEvent({
            sessionUpdate: 'usage_update', used: 182_000, size: 200_000, cost: { amount: 0.61, currency: 'USD' },
        });
        expect(withCost).toMatchObject({ kind: 'usage', used: 182_000, size: 200_000, cost: 0.61 });

        // codex reports no cost. A `0` here would claim the turn was free.
        const noCost = toStreamEvent({ sessionUpdate: 'usage_update', used: 74_000, size: 200_000 });
        expect((noCost as Extract<StreamEvent, { kind: 'usage' }>).cost).toBeNull();
    });

    it('turns a compaction into a divider, because silent amnesia needs a visible cause', () => {
        const e = toStreamEvent({ sessionUpdate: 'compaction_update', before: 189_000, after: 46_000 });

        expect(e).toMatchObject({ kind: 'divider', variant: 'compaction', before: 189_000, after: 46_000 });
    });

    it('keeps a notice as a notice rather than inventing a row kind for it', () => {
        const e = toStreamEvent({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'turn complete' } });

        expect(e).toMatchObject({ kind: 'notice', level: 'debug', message: 'turn complete' });
    });

    it('returns null for an update kind the ledger does not render', () => {
        // `available_commands_update` populates the composer's slash menu, not the stream.
        // Dropping it is correct; rendering it as an unknown row would be noise.
        expect(toStreamEvent({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toBeNull();
    });

    it('UNRECOGNISED kinds are kept as unknown — never silently dropped', () => {
        /**
         * A kind we do not map is a gap in Genie, not an absence of events. prism-acp makes
         * the same choice with `unmapped`: it RETAINS frames it does not recognise. Dropping
         * them would make a protocol change look like an agent that went quiet, which is the
         * failure mode this product is least able to detect.
         */
        const e = toStreamEvent({ sessionUpdate: 'subagent_update', subagent: { id: 'sub_1' } });

        expect(e).toMatchObject({ kind: 'unknown', sessionUpdate: 'subagent_update' });
    });

    it('COUNT, not a boolean: no mapped kind loses its payload', () => {
        // A single spot-check passes while another kind quietly maps to an empty row.
        const updates = [
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } },
            { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'b' } },
            { sessionUpdate: 'tool_call', toolCallId: 't', name: 'Bash', title: 'x' },
            { sessionUpdate: 'usage_update', used: 1, size: 2 },
            { sessionUpdate: 'notice', notice: { level: 'debug', message: 'm' } },
        ];

        const empties = updates
            .map((u) => toStreamEvent(u))
            .filter((e) => e === null || Object.keys(e).length <= 1);

        expect(empties).toEqual([]);
    });
});
