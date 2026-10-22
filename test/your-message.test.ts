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
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-yours-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const prompts: string[] = [];
    const factory: SessionDriverFactory = (o) => { events = o.events; return { start: () => {}, prompt: (t: string) => { prompts.push(t); }, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } }; };
    const rows: StreamEvent[] = [];
    const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: tree, onEvent: (e, meta) => { if (meta?.replacesLast) rows.pop(); rows.push(e); } });
    session.start();
    return {
        session,
        rows,
        prompts,
        emit: (u: Record<string, unknown>) => events.onUpdate?.(u),
        endTurn: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }),
    };
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

/**
 * CODEX ECHOES LATE (the owner, 2026-10-22: with a Codex agent every message he sends appears TWICE). His ledger,
 * after one prompt: `turn`, `message you` (Genie's own record), two debug notices (`thread/status/changed has no other
 * ACP mapping`, `completed Codex item had an unknown status`), THEN the echo (`message you`, 5 s later), then the
 * reply. The watch ended at the first notice, so the echo was recorded as a second message. Claude never echoes, which
 * is why only Codex showed it. Now only a MESSAGE ends the watch — the agent's or a peer's, or a `you` that is not the
 * echo — or the turn ending; everything else (notices of any level, usage, tools, plans, thoughts) passes through.
 */
describe('a provider that echoes the prompt AFTER other frames (Codex)', () => {
    const notice = (message: string) => ({ sessionUpdate: 'notice', notice: { level: 'debug', message } });

    it("the owner's ledger order — notice, notice, echo, reply — records your message ONCE", () => {
        const { session, rows, emit } = open();
        session.prompt('are you functional?');
        emit(notice('thread/status/changed has no other ACP mapping'));
        emit(notice('completed Codex item had an unknown status'));
        emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'are you functional?' } });
        emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "Yes—I'm here and ready to work." } });
        expect(said(rows)).toEqual(['you:are you functional?', "agent:Yes—I'm here and ready to work."]);
        // The notices themselves still reach the thread, in their place.
        expect(rows.map((r) => r.kind)).toEqual(['turn', 'message', 'notice', 'notice', 'message']);
    });

    it('a chunked echo split by a notice is still one echo; a thought and usage pass through too', () => {
        const { session, rows, emit } = open();
        session.prompt('hello');
        emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'reading' } });
        emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hel' } });
        emit(notice('thread/status/changed has no other ACP mapping'));
        emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'lo' } });
        emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
        expect(said(rows)).toEqual(['you:hello', 'agent:hi']);
    });

    it("the agent's reply ends the watch: a `you` equal to the prompt AFTER it is kept (positive control)", () => {
        const { session, rows, emit } = open();
        session.prompt('hello');
        emit(notice('thread/status/changed has no other ACP mapping'));
        emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
        emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } });
        expect(said(rows)).toEqual(['you:hello', 'agent:hi', 'you:hello']);
    });

    it('the turn ending ends the watch: a replayed `you` equal to the last prompt, after it, is kept (positive control)', () => {
        const { session, rows, emit, endTurn } = open();
        session.prompt('hello');
        emit(notice('thread/status/changed has no other ACP mapping'));
        endTurn();
        emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } });
        expect(said(rows)).toEqual(['you:hello', 'you:hello']);
    });
});

describe('the chat subscribes by the agent\'s id', () => {
    it('the resolved detail\'s id, whatever the route named it by; nothing until it resolves', () => {
        expect(chatSubscriptionId('moic', { agent: { id: 'agent_7f3a' } })).toBe('agent_7f3a');
        expect(chatSubscriptionId('agent_7f3a', { agent: { id: 'agent_7f3a' } })).toBe('agent_7f3a');
        expect(chatSubscriptionId('moic', null)).toBeNull();
    });
});
