import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { chatThreadFrom } from '../src/core/chat-view.js';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';

/**
 * WAITING, AND WHY (Tynn #1089). A message sent to an agent held on a spent account that is about to move (or already moving)
 * waits, and the chat says so — "Waiting · moving to <account>" — never "Not delivered. Kept for you to send again.".
 */

const T0 = 1_795_800_000_000;
const detail = (session: Record<string, unknown>, delivery?: string): AgentDetail => ({
    agent: { id: 'a1', name: 'tynn', provider: 'claude', fidelity: 'declared', cwd: '/w' },
    session: { running: true, turnState: 'idle', inTurn: false, cancelTurn: true, failure: null, ...session } as never,
    turns: 1, cost: null, refusal: null,
    rows: [
        { id: 'r1', event: { kind: 'message', speaker: 'agent', peerName: null, text: "You've hit your weekly limit" }, at: T0 },
        { id: 'r2', event: { kind: 'message', speaker: 'you', peerName: null, text: 'why do I keep getting this?', pending: { id: 'p1', content: null } }, at: T0 + 1 },
        ...(delivery ? [{ id: 'r3', event: { kind: 'prompt_delivery', id: 'p1', status: delivery }, at: T0 + 2 }] : []),
    ],
} as unknown as AgentDetail);
const held = { limit: { state: 'paused', window: '7d', resetsAtMs: T0 + 6 * 86_400_000, resumeAtMs: T0 + 6 * 86_400_000, message: null } };
const moving = { account: { id: 'acct_a', label: 'Account 1', movesTo: { id: 'acct_b', label: 'Account 2' } } };

describe('a message held for a move', () => {
    it('queued on the held run about to move: "Waiting · moving to Account 2"', () => {
        const thread = chatThreadFrom(detail({ ...held, ...moving }), 'a1', [], () => T0);
        const m = thread.messages.find((x) => x.promptId === 'p1');
        expect(m).toMatchObject({ queued: true, movingTo: 'Account 2' });
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} onRestartAndSend={() => {}} />);
        expect(html).toContain('Waiting · moving to Account 2');
        expect(html).not.toContain('Not delivered');
    });

    it('carried across the move into the new run: waiting, never "Not delivered"', () => {
        const thread = chatThreadFrom(detail({ turnState: 'working', inTurn: true }, 'carried'), 'a1', [], () => T0);
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} onRestartAndSend={() => {}} />);
        expect(thread.messages.find((x) => x.promptId === 'p1')).toMatchObject({ queued: true });
        expect(html).not.toContain('Not delivered');
    });

    it('CONTROL: held with nowhere to move, it waits for the provider as before', () => {
        const thread = chatThreadFrom(detail(held), 'a1', [], () => T0);
        const m = thread.messages.find((x) => x.promptId === 'p1');
        expect(m).toMatchObject({ queued: true });
        expect(m?.movingTo).toBeUndefined();
    });
});

describe('carried while no run is up (the moment of a move, or a restart starting)', () => {
    it('waits, "sent when tynn is back" — never "Not delivered"', () => {
        const d = { ...detail({}, 'carried'), session: null } as unknown as AgentDetail;
        const thread = chatThreadFrom(d, 'a1', [], () => T0);
        expect(thread.messages.find((x) => x.promptId === 'p1')).toMatchObject({ queued: true, delivered: false });
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} onRestartAndSend={() => {}} />);
        expect(html).toContain('Waiting · sent when tynn is back');
        expect(html).not.toContain('Not delivered');
    });

    it('CONTROL: undelivered with no run up is still "Not delivered", with Send all now', () => {
        const d = { ...detail({}, 'undelivered'), session: null } as unknown as AgentDetail;
        const html = renderToStaticMarkup(<ChatFlyout thread={chatThreadFrom(d, 'a1', [], () => T0)} onSend={() => {}} onClose={() => {}} onRestartAndSend={() => {}} />);
        expect(html).toContain('Not delivered');
    });
});
