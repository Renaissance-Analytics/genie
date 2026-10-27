import { describe, expect, it } from 'vitest';
import type { AgentDetail } from '../src/renderer/bridge.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { chatThreadFrom } from '../src/core/chat-view.js';

/**
 * THE CHAT FLYOUT SHOWS THE CONVERSATION. The board audit of 2026-10-12 found `messages: []` hard-coded in the
 * renderer with "AgentInbox lands with P4" beside it: the only place a human types to an agent showed nothing the
 * agent said back. The transcript is already on the wire — the agent's stream carries `message` events with a
 * speaker (`you`, the agent, a peer) — so the flyout derives its thread from the same detail the Agent view reads.
 * The board (`Chat Flyout.dc.html`): a context line under the chips (`Working · Plan 4/7 · <target>` / `Parked ·
 * waiting on you` amber / `Broken · <reason>` red / `Observed · <provider> runs in a terminal` / `Idle`), and the
 * message shapes: you, the agent (named), a peer as `atlas → wren`. No thought ever appears in chat.
 */

const session = (over: Partial<AgentDetail['session'] & object> = {}): NonNullable<AgentDetail['session']> => ({
    running: true, turnState: 'working', startedAt: 1_000, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null, ...over,
} as NonNullable<AgentDetail['session']>);
const detail = (rows: AgentDetail['rows'], s: AgentDetail['session'] = session()): AgentDetail => ({
    agent: { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' },
    session: s, rows, turns: 2, cost: null, refusal: null,
});
const ev = (id: string, event: AgentDetail['rows'][number]['event'], at: number | null = 1_700_000_000_000) => ({ id, event, at });
const rowOf = (over: Partial<AgentRow>): AgentRow => ({
    id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: null, ask: null, reason: null, fixes: [],
    step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over,
});

describe('chatThreadFrom — the transcript', () => {
    it('keeps the message events, in order, with who said them: you, the agent BY NAME, a peer as `peer → agent`', () => {
        const d = detail([
            ev('e1', { kind: 'message', speaker: 'you', peerName: null, text: 'Use the cache driver.' }),
            ev('e2', { kind: 'think', text: 'reasoning…', tokens: 42 } as never),
            ev('e3', { kind: 'message', speaker: 'agent', peerName: null, text: 'Moving challenges to the cache store.' }),
            ev('e4', { kind: 'message', speaker: 'peer', peerName: 'wren', text: 'drop the challenges table' }),
        ]);
        const thread = chatThreadFrom(d, 'a1', [], () => 0);
        // The thought is IN the chat, in its place, as the agent's thinking (the owner, 2026-10-20: "the thinking content
        // should be posting in the chat stream, not the work stream" — this used to assert no thought ever appeared).
        expect(thread.messages.map((m) => [m.id, m.who, m.from, m.text])).toEqual([
            ['e1', 'you', 'you', 'Use the cache driver.'],
            ['e2', 'thinking', 'atlas', 'reasoning…'],
            ['e3', 'agent', 'atlas', 'Moving challenges to the cache store.'],
            ['e4', 'peer', 'wren → atlas', 'drop the challenges table'],
        ]);
        expect(thread.messages).toHaveLength(4);
        // The time rides along when the event had one; absent otherwise — never synthesised.
        expect(thread.messages[0]!.at).toBe(1_700_000_000_000);
        expect(chatThreadFrom(detail([ev('e9', { kind: 'message', speaker: 'you', peerName: null, text: 'x' }, null)]), 'a1', [], () => 0).messages[0]!.at).toBeNull();
    });

    it('a message on the wire was delivered; the renderer marks its own undelivered drafts separately', () => {
        const d = detail([ev('e1', { kind: 'message', speaker: 'you', peerName: null, text: 'hi' })]);
        expect(chatThreadFrom(d, 'a1', [], () => 0).messages[0]!.delivered).toBe(true);
    });

    it('the context line says what the agent is doing, in the board\'s words and tones', () => {
        const at = (s: AgentDetail['session'], fidelity: 'declared' | 'observed' = 'declared') =>
            chatThreadFrom({ ...detail([], s), agent: { ...detail([]).agent, fidelity, provider: fidelity === 'observed' ? 'aider' : 'claude' } }, 'a1', [], () => 0).context;
        expect(at(session({ plan: { step: 4, of: 7, doing: 'Passkey enrolment endpoint' } }))).toEqual({ text: 'Working · Plan 4/7 · Passkey enrolment endpoint', tone: 'ok' });
        expect(at(session())).toEqual({ text: 'Working', tone: 'ok' });
        expect(at(session({ pendingApproval: { id: 'p', question: 'Allow php artisan migrate --force?', options: [] } as never }))).toEqual({ text: 'Parked · waiting on you', tone: 'warn' });
        expect(at(session({ failure: { reason: 'ACP stream closed at 14:31', fixes: [] } }))).toEqual({ text: 'Broken · ACP stream closed at 14:31', tone: 'bad' });
        expect(at(session({ running: false, turnState: 'idle' }))).toEqual({ text: 'Idle', tone: 'muted' });
        expect(at(session(), 'observed')).toEqual({ text: 'Observed · aider runs in a terminal', tone: 'muted' });
        // Not started: said as such — not "Idle", which would claim a session exists.
        expect(at(null)).toEqual({ text: 'Not started', tone: 'muted' });
    });

    // No chips (the owner, 2026-10-18: no chat tabs): a thread is one conversation, and the view picks whose.
    it('one conversation, no chips; never an unread count Genie has not read', () => {
        const rows = [rowOf({ id: 'a1', name: 'atlas', state: 'working' }), rowOf({ id: 'a2', name: 'wren', state: 'waiting' })];
        const thread = chatThreadFrom(detail([]), 'a1', rows, () => 0);
        expect(thread).not.toHaveProperty('chips');
        expect(thread.name).toBe('atlas');
        expect(thread.unread).toBeNull();
    });

    it('no detail yet: a thread with the id, no messages, no context — not an error, not "Idle"', () => {
        const thread = chatThreadFrom(null, 'a1', [rowOf({})], () => 0);
        expect(thread).toMatchObject({ agentId: 'a1', name: 'atlas', messages: [], context: null });
    });
});

describe('chatThreadFrom — the reply STILL ARRIVING (react-fancy 5.68 `streaming="progressive"`)', () => {
    /*
     * react-fancy draws a reply that is still arriving progressively (an open <result> as its card with the body so far,
     * an open fence as code with no copy button) and a finished one whole: `streaming={done ? false : "progressive"}`.
     * So the chat must know WHICH reply is still arriving: the agent's last words while its turn is working and nothing
     * has happened since (a tool call, a turn boundary, your message). Everything else is finished.
     */
    const reply = (id: string, text = 'Here is the <result>\nbody so') => ev(id, { kind: 'message', speaker: 'agent', peerName: null, text });

    it('the agent’s last message while its turn works is the one arriving', () => {
        const d = detail([ev('e1', { kind: 'message', speaker: 'you', peerName: null, text: 'go' }), reply('e2')]);
        expect(chatThreadFrom(d, 'a1', [], () => 0).arriving).toBe('e2');
    });

    it('rows that say nothing new (usage, a debug notice) do not end it', () => {
        const d = detail([reply('e2'), ev('u1', { kind: 'usage' } as never), ev('n1', { kind: 'notice', level: 'debug', message: 'x' } as never)]);
        expect(chatThreadFrom(d, 'a1', [], () => 0).arriving).toBe('e2');
    });

    it('a thought still arriving is the thinking row', () => {
        const d = detail([reply('e2'), ev('t1', { kind: 'think', text: 'hmm', tokens: null } as never)]);
        expect(chatThreadFrom(d, 'a1', [], () => 0).arriving).toBe('t1');
    });

    it('FINISHED: a tool call after it, the turn not working, no session, or your message last: nothing is arriving', () => {
        const tool = ev('x1', { kind: 'tool', toolCallId: 'c1', title: 'ls', toolKind: 'execute', status: 'pending', rawInput: {} } as never);
        expect(chatThreadFrom(detail([reply('e2'), tool]), 'a1', [], () => 0).arriving).toBeNull();
        expect(chatThreadFrom(detail([reply('e2')], session({ turnState: 'idle' } as never)), 'a1', [], () => 0).arriving).toBeNull();
        expect(chatThreadFrom(detail([reply('e2')], session({ running: false })), 'a1', [], () => 0).arriving).toBeNull();
        expect(chatThreadFrom(detail([reply('e2')], null), 'a1', [], () => 0).arriving).toBeNull();
        expect(chatThreadFrom(detail([reply('e2'), ev('e3', { kind: 'message', speaker: 'you', peerName: null, text: 'hm' })]), 'a1', [], () => 0).arriving).toBeNull();
        expect(chatThreadFrom(null, 'a1', [rowOf({})], () => 0).arriving).toBeNull();
    });

    it('a PEER’s message is delivered whole: never arriving', () => {
        const d = detail([ev('e4', { kind: 'message', speaker: 'peer', peerName: 'wren', text: 'drop the <resul' })]);
        expect(chatThreadFrom(d, 'a1', [], () => 0).arriving).toBeNull();
    });
});
