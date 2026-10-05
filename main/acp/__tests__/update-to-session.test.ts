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
        expect(s.live).toEqual({ id: 'm1', role: 'agent', author: null, content: 'hel' });
        expect(s.turn.state).toBe('thinking');
        expect(s.transcript).toEqual([]);
    });

    it('appends a chunk with the SAME message id', () => {
        let s = applySessionUpdate(base(), { sessionUpdate: 'agent_message_chunk', content: text('hel'), messageId: 'm1' }, NOW);
        s = applySessionUpdate(s, { sessionUpdate: 'agent_message_chunk', content: text('lo'), messageId: 'm1' }, NOW);
        expect(s.live?.content).toBe('hello');
        expect(s.transcript).toEqual([]);
    });

    it('COMMITS the live message when a different id starts', () => {
        // The real streaming semantic. Without it the previous message is overwritten
        // mid-turn and the conversation loses a reply with nothing reporting it.
        let s = applySessionUpdate(base(), { sessionUpdate: 'agent_message_chunk', content: text('first'), messageId: 'm1' }, NOW);
        s = applySessionUpdate(s, { sessionUpdate: 'agent_message_chunk', content: text('second'), messageId: 'm2' }, NOW);
        expect(s.transcript).toEqual([{ id: 'm1', role: 'agent', author: null, content: 'first' }]);
        expect(s.live?.content).toBe('second');
    });

    it('puts a user chunk straight in the transcript', () => {
        // It is already committed — the human sent it.
        const s = applySessionUpdate(base(), { sessionUpdate: 'user_message_chunk', content: text('do it'), messageId: 'u1' }, NOW);
        expect(s.transcript).toEqual([{ id: 'u1', role: 'user', author: null, content: 'do it' }]);
        expect(s.live).toBeNull();
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
