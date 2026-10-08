import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyAgentSession, type AgentSession } from '../../agentsession/model';
import { HANDLED_UPDATE_KINDS, applySessionUpdate, type AcpSessionUpdate } from '../update-to-session';

/**
 * ACP `session/update` → `AgentSession`.
 *
 * This is the translation layer, and the thing it must not do is lose a kind
 * quietly. The protocol gains variants between versions; a mapper with a `default:
 * break` would absorb a new one and the surface would simply stop showing something
 * nobody noticed it had — a cost figure, a plan, a tool call.
 *
 * That used to be guarded by reading the SHIPPED SCHEMA and asserting every variant in it
 * is handled by name. **It no longer is** — the owner ruled NO THIRD PARTY and the vendored
 * protocol package is gone; the note further down records the removal and refuses to replace
 * it with a list declared here and compared against itself.
 *
 * What stands in its place is `fixtures/real-tool-calls.json`: `session/update` frames
 * RECORDED from a real claude child. It cannot prove completeness the way a schema could,
 * but it cannot pass by construction either — and it is what caught the mapper discarding
 * three fields the agent was sending all along.
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
        /**
         * STILL EXACT, and updated to the grown contract rather than relaxed to an
         * `objectContaining`. A whole-object `toEqual` is the right assertion here — it is
         * what fails when a field is added without a decision about its honest empty value,
         * which is exactly what it did when genie#843 gave `ToolCall` four more.
         *
         * Every new field is NULL here because this frame declares none of them: no `kind`
         * (so not `'other'`), no `rawInput`, no result. `at` is Genie's stamp, which is the
         * one thing it can always know.
         */
        expect(s.tools).toEqual([
            { id: 'tc1', name: 'npm test', status: 'pending', kind: null, rawInput: null, result: null, at: NOW },
        ]);
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


/**
 * A TOOL CALL KEEPS WHAT THE AGENT ACTUALLY SENT — genie#843.
 *
 * `ToolCall` was `{id, name, status}`. Measured against a real child, a real `tool_call`
 * carries `kind`, its update carries `rawInput` with the real arguments, and the closing
 * update carries `content` with the result. All three arrived and were thrown away —
 * `rawInput` was read only to sniff for plan tools, and `kind` was not even in the
 * `AcpSessionUpdate` interface.
 *
 * That poverty is what blocked two designed surfaces: the Workflow Dashboard's "latest
 * delivery" (which needs to say *which file*) and the Agent view's "every edit as a diff".
 * Both were written as though the protocol could not supply it. It could.
 *
 * The frames below are RECORDED, not composed — see the fixture's `_provenance`.
 */
const REAL = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'real-tool-calls.json'), 'utf8'),
) as {
    // Typed as the real parameter so the mapper is called the way production calls it. The
    // cast is a CLAIM about recorded JSON, so the control case below checks it at runtime —
    // every frame really does carry a `sessionUpdate` — rather than letting `as` assert it.
    editLifecycle: AcpSessionUpdate[];
    unclassifiedCall: AcpSessionUpdate[];
};

describe('a tool call keeps what the agent actually sent', () => {
    it('the fixture is real traffic, not a sketch', () => {
        // The control for every case below: if the fixture were trimmed to the fields the
        // assertions want, those assertions would prove nothing about the wire.
        const [open, args, done] = REAL.editLifecycle;
        expect(REAL.editLifecycle).toHaveLength(3);
        expect(open!.sessionUpdate).toBe('tool_call');
        expect(open!.kind).toBe('edit');
        expect(args!.rawInput).toBeTruthy();
        expect(done!.content).toBeTruthy();
        // One call, three frames — so the id is what ties them together.
        expect(new Set(REAL.editLifecycle.map((f) => f.toolCallId)).size).toBe(1);

        // VALIDATES THE CAST above, for both fixtures: a recorded frame missing its
        // discriminator would be silently accepted by `as` and then take a `default:` branch.
        for (const frame of [...REAL.editLifecycle, ...REAL.unclassifiedCall]) {
            expect(typeof frame.sessionUpdate).toBe('string');
            expect(HANDLED_UPDATE_KINDS).toContain(frame.sessionUpdate);
        }
    });

    it('stores the kind the agent declared', () => {
        const s = applySessionUpdate(base(), REAL.editLifecycle[0]!, NOW);
        expect(s.tools[0]!.kind).toBe('edit');
    });

    it('stores NULL, not a guess, when the agent declared no kind', () => {
        /**
         * `kind` is OPTIONAL on the wire and really is absent in practice — measured, present
         * on `Write` and missing on `PowerShell` in the same session. So the honest value is
         * `null`, never `'other'`: a design that renders a classification Genie was not given
         * is the `null`-is-not-zero mistake applied to a string.
         */
        const s = applySessionUpdate(base(), REAL.unclassifiedCall[0]!, NOW);
        expect(s.tools[0]!.name).toBe('PowerShell');
        expect(s.tools[0]!.kind).toBeNull();
    });

    it('keeps rawInput off the UPDATE, which is the frame that carries it', () => {
        // The arguments do not arrive with the call — they arrive on the `in_progress` update,
        // which is the branch that read `title`, `name` and `status` and dropped everything
        // else. So the field was being discarded on the only frame that had it.
        let s = applySessionUpdate(base(), REAL.editLifecycle[0]!, NOW);
        s = applySessionUpdate(s, REAL.editLifecycle[1]!, NOW + 10);
        expect((s.tools[0]!.rawInput as { file_path?: string } | null)?.file_path).toMatch(
            /hello\.txt$/,
        );
    });

    it('keeps the result, and keeps it in the shape it arrived in', () => {
        /**
         * Stored as `unknown`, faithfully, rather than flattened to a string. ACP's tool
         * content is structured and a `diff` variant carries `path`/`oldText`/`newText` —
         * flattening would destroy exactly what "every edit as a diff" needs, to save a
         * consumer one parse. Same reasoning as `rawInput`: faithful and untrusted.
         */
        let s = applySessionUpdate(base(), REAL.editLifecycle[0]!, NOW);
        s = applySessionUpdate(s, REAL.editLifecycle[2]!, NOW + 20);
        expect(Array.isArray(s.tools[0]!.result)).toBe(true);
        expect(JSON.stringify(s.tools[0]!.result)).toContain('File created successfully');
    });

    it('stamps when the call last changed, so a board can sort by it', () => {
        // The Dashboard's Muster sorts by delivery recency, which needs a per-call time. Genie's
        // clock, like `Message.at` — the agent does not timestamp these.
        let s = applySessionUpdate(base(), REAL.editLifecycle[0]!, NOW);
        expect(s.tools[0]!.at).toBe(NOW);
        s = applySessionUpdate(s, REAL.editLifecycle[2]!, NOW + 20);
        expect(s.tools[0]!.at).toBe(NOW + 20);
    });

    it('replays the whole recorded lifecycle into ONE finished call that names its file', () => {
        // The end-to-end claim, in the agent's own frames: after three updates there is one
        // tool call, it succeeded, it is an edit, and it says what it wrote.
        const s = REAL.editLifecycle.reduce(
            (acc, frame, i) => applySessionUpdate(acc, frame, NOW + i * 10),
            base(),
        );
        expect(s.tools).toHaveLength(1);
        const call = s.tools[0]!;
        expect(call.status).toBe('success');
        expect(call.kind).toBe('edit');
        expect((call.rawInput as { file_path?: string }).file_path).toMatch(/hello\.txt$/);
        expect(call.result).toBeTruthy();
    });
});

/**
 * THOUGHTS ARE KEPT — "oversight on every edit, every THOUGHT" (§5.2), genie#848.
 *
 * `agent_thought_chunk` was handled and discarded, and the reason recorded for discarding it
 * was correct: *"appending it to `live` would splice the agent's private thinking into what it
 * actually said."* Right conclusion, wrong remedy — the answer is a field of its own, not the
 * bin. The board's Stream shows a thought as its own row kind, one line, never expanded.
 *
 * ## What is deliberately NOT here
 *
 * A per-thought TOKEN COUNT. The board's mockup shows `842 tok`, and that number is not on the
 * wire — nothing in a thought chunk carries it. The surfaces designer reached the same place
 * independently and refused to estimate it from character count, which is right: an estimate
 * dressed as a measurement is the defect this repo keeps paying for. So `Thought` has no token
 * field, and the closed key-set assertion below is what stops one appearing by guesswork.
 */
describe('thoughts are stored, separately from speech', () => {
    const thought = (text: string) => ({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text },
    });

    it('starts a LIVE thought rather than a live message', () => {
        const s = applySessionUpdate(base(), thought('Controller should only validate…'), NOW);
        expect(s.liveThought?.text).toBe('Controller should only validate…');
        // The whole point of the original refusal: it must not reach what the agent SAID.
        expect(s.live).toBeNull();
        expect(s.transcript).toEqual([]);
    });

    it('accumulates across chunks, like a message does', () => {
        let s = applySessionUpdate(base(), thought('No sign-count column. '), NOW);
        s = applySessionUpdate(s, thought('Either add a migration or ask wren…'), NOW + 10);
        expect(s.liveThought?.text).toBe('No sign-count column. Either add a migration or ask wren…');
        // Stamped when the thought STARTED, not when it last grew — the same rule as
        // `Message.at`, so the stream orders by when the agent began thinking.
        expect(s.liveThought?.at).toBe(NOW);
    });

    it('SETTLES into `thoughts` when something else happens', () => {
        /**
         * A thought ends when the agent does something — a tool call, a reply. There is no
         * "thought finished" update, so the boundary is the next event, which is also exactly
         * how the board draws it: a thought row followed by the tool row it led to.
         */
        let s = applySessionUpdate(base(), thought('webauthn-lib is not in composer.json yet…'), NOW);
        s = applySessionUpdate(
            s,
            { sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Read', title: 'Read', status: 'pending' },
            NOW + 20,
        );
        expect(s.liveThought).toBeNull();
        expect(s.thoughts).toHaveLength(1);
        expect(s.thoughts[0]!.text).toBe('webauthn-lib is not in composer.json yet…');
        expect(s.thoughts[0]!.at).toBe(NOW);
    });

    it('settles when the agent SPEAKS, and the thought stays out of the speech', () => {
        let s = applySessionUpdate(base(), thought('Keep the controller thin…'), NOW);
        s = applySessionUpdate(
            s,
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' }, messageId: 'm1' },
            NOW + 20,
        );
        expect(s.thoughts).toHaveLength(1);
        expect(s.live?.content).toBe('Done.');
        // The assertion the original comment was protecting. Still true, now by separation
        // rather than by deletion.
        expect(s.live?.content).not.toContain('controller thin');
    });

    it('keeps several thoughts in the order they were thought', () => {
        let s = base();
        for (const [i, text] of ['first', 'second', 'third'].entries()) {
            s = applySessionUpdate(s, thought(text), NOW + i * 100);
            s = applySessionUpdate(
                s,
                { sessionUpdate: 'tool_call', toolCallId: `t${i}`, name: 'Read', title: 'Read', status: 'pending' },
                NOW + i * 100 + 10,
            );
        }
        expect(s.thoughts.map((t) => t.text)).toEqual(['first', 'second', 'third']);
    });

    it('still moves the turn to thinking, which is what it did before', () => {
        // The one behaviour the old handler had. Keeping it asserted means the rewrite cannot
        // quietly drop it while adding storage.
        const s = applySessionUpdate(base(), thought('…'), NOW);
        expect(s.turn.state).toBe('thinking');
    });

    it('fabricates NO token count — a closed key set is what enforces that', () => {
        /**
         * The board shows `842 tok` on a thought row. That number is not on the wire, and the
         * only way to produce one here would be to estimate it from the text — an estimate
         * dressed as a measurement. A `Δctx` delta between two real `usage_update`s is the
         * honest version and belongs to the stream projection, not to this type.
         *
         * So the shape is pinned: a field named anything like `tokens` cannot be added without
         * this line changing, in a diff a human reads.
         */
        let s = applySessionUpdate(base(), thought('x'), NOW);
        s = applySessionUpdate(
            s,
            { sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Read', title: 'Read', status: 'pending' },
            NOW + 10,
        );
        expect(Object.keys(s.thoughts[0]!).sort()).toEqual(['at', 'id', 'text']);
    });

    it('is `[]` and not null, because Genie owns this list', () => {
        // `[]` is "the agent has thought nothing yet", which is a FACT. `null` would mean
        // "cannot see", and that is never true here: a declaring agent's thoughts arrive or
        // they do not exist. Same distinction as `approvals`.
        expect(base().thoughts).toEqual([]);
        expect(base().liveThought).toBeNull();
    });
});
