import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { chatSubscriptionId } from '../src/renderer/agent-detail.js';

/**
 * YOUR MESSAGE IS IN THE THREAD (the owner, using beta.19: "my user message never appeared in the chat"). The session
 * recorded a turn marker for a prompt and relied on the provider to echo the prompt back as `user_message_chunk` —
 * which Claude does not do. Now the prompt itself is the `you` message, recorded when it is sent; a provider that
 * DOES echo it back (an echo identical to what was just sent, before anything else arrives) is not recorded twice.
 * A user_message_chunk that is not that echo (a replayed history on resume) is still kept.
 *
 * And the chat heard nothing live: it subscribed by the route's `chat=` value — the agent's NAME (`chat=moic`) — while
 * main pushes on a channel keyed by the agent's ID, so the flyout read the thread once and never saw the reply.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-yours-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const prompts: string[] = [];
    const factory: SessionDriverFactory = (o) => { events = o.events; return { start: () => {}, prompt: (t: string) => { prompts.push(t); }, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } }; };
    const rows: StreamEvent[] = [];
    const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: tree, onEvent: (e, meta) => { if (meta?.replacesLast) rows.pop(); rows.push(e); } });
    session.start();
    return { session, rows, prompts, emit: (u: Record<string, unknown>) => events.onUpdate?.(u) };
}
const said = (rows: readonly StreamEvent[]) => rows.flatMap((r) => (r.kind === 'message' ? [`${r.speaker}:${r.text}`] : []));

describe('your prompt is a message in the thread', () => {
    it('is recorded when sent, after the turn marker, and the provider still gets the text', () => {
        const { session, rows, prompts, emit } = open();
        session.prompt('What are you working on?');
        emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Nothing yet.' } });
        expect(rows.map((r) => r.kind)).toEqual(['turn', 'message', 'message']);
        expect(said(rows)).toEqual(['you:What are you working on?', 'agent:Nothing yet.']);
        expect(prompts).toEqual(['What are you working on?']);
    });

    it('a provider echo of that same prompt is not recorded twice; a different user message is kept (positive control)', () => {
        const { session, rows, emit } = open();
        session.prompt('hello');
        emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hel' } });
        emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'lo' } });
        emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
        emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'an older message, replayed' } });
        expect(said(rows)).toEqual(['you:hello', 'agent:hi', 'you:an older message, replayed']);
    });
});

describe('the chat subscribes by the agent\'s id', () => {
    it('the resolved detail\'s id, whatever the route named it by; nothing until it resolves', () => {
        expect(chatSubscriptionId('moic', { agent: { id: 'agent_7f3a' } })).toBe('agent_7f3a');
        expect(chatSubscriptionId('agent_7f3a', { agent: { id: 'agent_7f3a' } })).toBe('agent_7f3a');
        expect(chatSubscriptionId('moic', null)).toBeNull();
    });
});
