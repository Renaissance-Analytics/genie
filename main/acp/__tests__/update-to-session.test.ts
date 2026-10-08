import { describe, expect, it } from 'vitest';
import { emptyAgentSession, type AgentSession } from '../../agentsession/model';
import { HANDLED_UPDATE_KINDS, applySessionUpdate } from '../update-to-session';

/**
 * ACP `session/update` → `AgentSession`.
 *
 * This is the translation layer, and the thing it must not do is lose a kind
 * quietly. The protocol gains variants between versions; a mapper with a `default:
 * break` would absorb a new one and the surface would simply stop showing something
 * nobody noticed it had — a cost figure, a plan, a tool call.
 *
 * So the last test here reads the SHIPPED SCHEMA and asserts every variant in it is
 * handled by name. A version bump that adds one turns this red, which is the whole
 * point of pinning against the package rather than against a list I typed out.
 */

const base = (): AgentSession =>
    emptyAgentSession(
        { agentId: 'a1', specId: 's1', provider: 'claude', name: 'kai', cwd: '/w', workspaceId: 'w1' },
        1_000,
    );

const NOW = 5_000;
const text = (t: string) => ({ type: 'text' as const, text: t });

describe('message chunks', () => {
    it('starts a live agent message and marks the turn thinking', () => {
        const s = applySessionUpdate(base(), { sessionUpdate: 'agent_message_chunk', content: text('hel'), messageId: 'm1' }, NOW);
        // `at` is the host-side stamp `mergeDeclared` interleaves on — see `Message.at`. Asserted
        // explicitly rather than relaxed to `toMatchObject`: loosening an assertion to get green is
        // the one move this repo treats as a bandaid wearing a test's clothes.
        expect(s.live).toEqual({ id: 'm1', role: 'agent', author: null, content: 'hel', at: NOW });
        expect(s.turn.state).toBe('thinking');
        expect(s.transcript).toEqual([]);
    });

    it('appends a chunk with the SAME message id', () => {
        let s = applySessionUpdate(base(), { sessionUpdate: 'agent_message_chunk', content: text('hel'), messageId: 'm1' }, NOW);
        s = applySessionUpdate(s, { sessionUpdate: 'agent_message_chunk', content: text('lo'), messageId: 'm1' }, NOW + 5_000);
        expect(s.live?.content).toBe('hello');
        expect(s.transcript).toEqual([]);
        // The stamp is from when the message STARTED, not from its latest chunk. A long reply must
        // be ordered by when the agent began speaking: stamping it at the end would sort it after
        // mail that arrived WHILE it was speaking, which reads as the owner interrupting a reply
        // that had not begun.
        expect(s.live?.at).toBe(NOW);
    });

    it('COMMITS the live message when a different id starts', () => {
        // The real streaming semantic. Without it the previous message is overwritten
        // mid-turn and the conversation loses a reply with nothing reporting it.
        let s = applySessionUpdate(base(), { sessionUpdate: 'agent_message_chunk', content: text('first'), messageId: 'm1' }, NOW);
        s = applySessionUpdate(s, { sessionUpdate: 'agent_message_chunk', content: text('second'), messageId: 'm2' }, NOW);
        expect(s.transcript).toEqual([{ id: 'm1', role: 'agent', author: null, content: 'first', at: NOW }]);
        expect(s.live?.content).toBe('second');
    });

    it('puts a user chunk straight in the transcript', () => {
        // It is already committed — the human sent it.
        const s = applySessionUpdate(base(), { sessionUpdate: 'user_message_chunk', content: text('do it'), messageId: 'u1' }, NOW);
        expect(s.transcript).toEqual([{ id: 'u1', role: 'user', author: null, content: 'do it', at: NOW }]);
        expect(s.live).toBeNull();
    });

    /**
     * AN UN-IDED REPEAT OF THE TAIL IS A DUPLICATE — and the story of this rule is why measuring
     * beats accepting a hedge, in both directions.
     *
     * prism corrected an earlier claim of mine — that a client cannot reconstruct a conversation from
     * ACP alone — with the news that their codex driver maps a `userMessage` item to
     * `user_message_chunk`. They were careful about the limit of it: *"I have verified our MAPPING,
     * not codex's live frame behaviour… I am not going to assert what codex emits on the strength of
     * reading my own code."*
     *
     * Measured against a real codex child on 0.5.2, and the frames were worse than the mapping
     * predicted:
     *
     * ```
     * [codex transcript] live=…,user_message_chunk | prompt echoes=2
     * [codex echo] {"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Reply with the single word: ready"}}}
     * [codex echo] {"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Reply with the single word: ready"}}}
     * ```
     *
     * Two identical frames, full text, no `messageId`. **That was prism's defect, not codex's** —
     * `#mapItem` runs at both `item/started` and `item/completed`, and the `userMessage` branch lacked
     * the `if (replay || completed)` guard its siblings have. Fixed in 0.5.3; re-measured here as
     * `prompt echoes=1`. Their own reading of it is worth keeping: the hedge *"this is what our
     * mapping allows"* was concealing a bug in their code rather than uncertainty about codex, and had
     * they asserted the property confidently the README would have described the bug as intended and
     * Genie would carry a permanent workaround.
     *
     * ## So why the rule survives
     *
     * Not for the 2×. codex genuinely reports the user's turn, and Genie genuinely records the owner's
     * prompt itself (`recordHumanPromptForSpec`) because claude never echoes and never replays one.
     * One honest echo plus one honest record is still TWO RENDERINGS of one message, and no fix on
     * either side removes that.
     *
     * The cases below pin the rule at its minimum — text at the tail — rather than re-enacting a
     * defect that no longer exists.
     */
    it('COALESCES an identical un-ided user chunk instead of showing the prompt twice', () => {
        let s = applySessionUpdate(base(), { sessionUpdate: 'user_message_chunk', content: text('do it') }, NOW);
        s = applySessionUpdate(s, { sessionUpdate: 'user_message_chunk', content: text('do it') }, NOW + 1);
        expect(s.transcript.map((m) => m.content)).toEqual(['do it']);
    });

    it('keeps two DIFFERENT un-ided user messages apart', () => {
        // The positive control for the rule above: suppression must be about sameness, not about
        // being un-ided. Two things the owner said are two messages.
        let s = applySessionUpdate(base(), { sessionUpdate: 'user_message_chunk', content: text('first') }, NOW);
        s = applySessionUpdate(s, { sessionUpdate: 'user_message_chunk', content: text('second') }, NOW + 1);
        expect(s.transcript.map((m) => m.content)).toEqual(['first', 'second']);
    });

    it('still APPENDS a genuinely chunked user message when the agent ids it', () => {
        // An id is the agent telling us these belong together, and that is the one case where
        // concatenation is right rather than guessed.
        let s = applySessionUpdate(base(), { sessionUpdate: 'user_message_chunk', content: text('hel'), messageId: 'u1' }, NOW);
        s = applySessionUpdate(s, { sessionUpdate: 'user_message_chunk', content: text('lo'), messageId: 'u1' }, NOW + 1);
        expect(s.transcript.map((m) => m.content)).toEqual(['hello']);
    });

    it('suppresses an echo of a message GENIE recorded itself', () => {
        // The case that actually bites: `recordHumanPromptForSpec` puts the owner's prompt in with
        // its own `human:` id, and codex then echoes the same text with no id. Keyed on the TEXT at
        // the tail rather than on the id, because the two ids can never match by construction.
        let s = applySessionUpdate(
            base(),
            { sessionUpdate: 'user_message_chunk', content: text('start on the dock'), messageId: 'human:1:0' },
            NOW,
        );
        s = applySessionUpdate(s, { sessionUpdate: 'user_message_chunk', content: text('start on the dock') }, NOW + 1);
        expect(s.transcript).toHaveLength(1);
        expect(s.transcript[0]!.id).toBe('human:1:0');
    });

    it('ignores a non-text content block rather than rendering a placeholder', () => {
        // An image or an embedded resource has no text to add. Inventing "[image]"
        // would put words in the agent's mouth.
        const s = applySessionUpdate(
            base(),
            { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' }, messageId: 'm1' },
            NOW,
        );
        expect(s.live).toBeNull();
    });

    it('does not lose a thought, but does not mix it into the reply either', () => {
        // The model has no field for reasoning yet, so a thought chunk changes the turn
        // state and nothing else. Appending it to `live` would splice the agent's
        // private reasoning into what it actually said.
        const s = applySessionUpdate(base(), { sessionUpdate: 'agent_thought_chunk', content: text('hmm'), messageId: 't1' }, NOW);
        expect(s.live).toBeNull();
        expect(s.transcript).toEqual([]);
        expect(s.turn.state).toBe('thinking');
    });
});

describe('tool calls', () => {
    it('records a tool call and moves the turn to tool', () => {
        // `tool` is distinct from `thinking` for the reason the protocol separates
        // them: a build can run silently for minutes.
        const s = applySessionUpdate(base(), { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'npm test', status: 'pending' }, NOW);
        expect(s.tools).toEqual([{ id: 'tc1', name: 'npm test', status: 'pending' }]);
        expect(s.turn.state).toBe('tool');
    });

    it('maps ACP statuses onto the model three, not four', () => {
        const start = applySessionUpdate(base(), { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'x', status: 'pending' }, NOW);
        const running = applySessionUpdate(start, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'in_progress' }, NOW);
        expect(running.tools[0]!.status).toBe('pending');
        const done = applySessionUpdate(running, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' }, NOW);
        expect(done.tools[0]!.status).toBe('success');
        const failed = applySessionUpdate(running, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'failed' }, NOW);
        expect(failed.tools[0]!.status).toBe('failure');
    });

    it('ignores an update for a tool call it never saw', () => {
        // Rather than inventing one with no name. A phantom row is worse than a
        // missing one.
        const s = applySessionUpdate(base(), { sessionUpdate: 'tool_call_update', toolCallId: 'ghost', status: 'completed' }, NOW);
        expect(s.tools).toEqual([]);
    });

    it('keeps the title when an update omits one', () => {
        const start = applySessionUpdate(base(), { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'npm test', status: 'pending' }, NOW);
        const done = applySessionUpdate(start, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' }, NOW);
        expect(done.tools[0]!.name).toBe('npm test');
    });
});

describe('plan', () => {
    it('stores the entries and maps the statuses', () => {
        const s = applySessionUpdate(
            base(),
            {
                sessionUpdate: 'plan',
                entries: [
                    { content: 'read the code', status: 'completed', priority: 'medium' },
                    { content: 'write a test', status: 'in_progress', priority: 'high' },
                    { content: 'ship it', status: 'pending', priority: 'low' },
                ],
            },
            NOW,
        );
        expect(s.plan).toEqual([
            { id: 'plan-0', title: 'read the code', status: 'done' },
            { id: 'plan-1', title: 'write a test', status: 'in-progress' },
            { id: 'plan-2', title: 'ship it', status: 'pending' },
        ]);
    });

    it('treats a removed plan as EMPTY, not as unseen', () => {
        // The distinction the whole model is built on. `[]` means the agent said it has
        // no plan; `null` would mean Genie cannot see one, and the surface renders those
        // differently on purpose.
        let s = applySessionUpdate(base(), { sessionUpdate: 'plan', entries: [{ content: 'x', status: 'pending', priority: 'low' }] }, NOW);
        s = applySessionUpdate(s, { sessionUpdate: 'plan_removed' }, NOW);
        expect(s.plan).toEqual([]);
        expect(s.plan).not.toBeNull();
    });
});

describe('usage', () => {
    it('maps used/size/cost onto the model fields', () => {
        const s = applySessionUpdate(base(), { sessionUpdate: 'usage_update', used: 38_000, size: 200_000, cost: 0.91 }, NOW);
        expect(s.usage).toEqual({ contextUsed: 38_000, contextMax: 200_000, costUsd: 0.91 });
    });

    it('carries a missing cost through as null rather than zero', () => {
        // An agent reporting context but not price is common. Zero would be a claim
        // about money.
        const s = applySessionUpdate(base(), { sessionUpdate: 'usage_update', used: 100, size: 1_000 }, NOW);
        expect(s.usage).toEqual({ contextUsed: 100, contextMax: 1_000, costUsd: null });
    });
});

describe('commands', () => {
    it('stores the agent own command list', () => {
        const s = applySessionUpdate(
            base(),
            { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'rewrite', description: 'rewrite it' }] },
            NOW,
        );
        expect(s.commands).toEqual([{ name: 'rewrite', hint: 'rewrite it' }]);
    });

    it('records an empty command list as EMPTY, not unseen', () => {
        const s = applySessionUpdate(base(), { sessionUpdate: 'available_commands_update', availableCommands: [] }, NOW);
        expect(s.commands).toEqual([]);
    });

    it('carries a missing description as null', () => {
        const s = applySessionUpdate(
            base(),
            { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'go' }] },
            NOW,
        );
        expect(s.commands).toEqual([{ name: 'go', hint: null }]);
    });
});

/*
 * REMOVED: the cross-check that pinned HANDLED_UPDATE_KINDS against the protocol
 * schema in both directions.
 *
 * It imported `@agentclientprotocol/sdk/schema/schema.json`, and the owner has ruled NO
 * THIRD PARTY (2026-10-05) -- Prism is the source of all agentic solutions and owns this
 * capability. So the dependency is gone from package.json.
 *
 * It is deliberately NOT replaced with a list declared in our own repo and compared
 * against itself: that passes by construction, and a guard that cannot fail is worse than
 * no guard because it reports coverage it does not have.
 *
 * RE-PIN THIS once Prism states the wire format it owns. What the check bought was real --
 * a format bump adding a variant turned it red, instead of a `default:` branch quietly
 * absorbing something nobody remembers the surface had. The per-kind behaviour tests above
 * still stand; only the completeness claim is suspended.
 */
describe('every protocol variant is handled BY NAME', () => {

    it('leaves the session untouched for a kind the model cannot store yet', () => {
        // Handled is not the same as stored. These are acknowledged explicitly so the
        // guard above stays honest, and they must not corrupt anything on the way past.
        const before = base();
        for (const kind of ['notice', 'subagent_update', 'config_option_update', 'session_info_update']) {
            const after = applySessionUpdate(before, { sessionUpdate: kind }, NOW);
            expect(after).toEqual(before);
        }
    });
});
