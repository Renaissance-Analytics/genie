import { describe, expect, it } from 'vitest';
import { chatMessages, type ChatDetail } from '../src/core/chat-view.js';
import { toStreamEvent } from '../src/core/stream-event.js';

/**
 * /COMPACT SHOWS WHAT IT DID (the owner, 2026-10-19: /compact in a chat showed "The turn did not finish, and the provider
 * gave no reason." — the compaction had WORKED). prism-acp 0.19.0 (claude:prism, measured against the real CLI): a
 * built-in command's success ends `end_turn`, and the CLI's compact_boundary arrives as a notice carrying
 * `_meta["particle.academy/compaction"] = { trigger, preTokens, postTokens, … }`. Genie draws it as the ledger's
 * compaction divider, and the chat says it in one line — a compaction nobody is told about is amnesia with no notice.
 */
const compactNotice = {
    sessionUpdate: 'notice',
    notice: { level: 'info', message: 'Compacted the context from 40,341 to 3,942 tokens.' },
    _meta: { 'particle.academy/compaction': { trigger: 'manual', preTokens: 40341, postTokens: 3942, durationMs: 6125 } },
};

describe('the compaction notice', () => {
    it('is the ledger’s compaction divider, with the tokens before and after', () => {
        expect(toStreamEvent(compactNotice)).toEqual({ kind: 'divider', variant: 'compaction', before: 40341, after: 3942 });
    });

    it('CONTROL: a notice without the compaction meta stays a notice', () => {
        expect(toStreamEvent({ sessionUpdate: 'notice', notice: { level: 'info', message: 'turn complete' } })).toMatchObject({ kind: 'notice', message: 'turn complete' });
    });
});

describe('the chat', () => {
    const detail = (rows: ChatDetail['rows']): ChatDetail => ({
        agent: { id: 'a1', name: 'impactium', provider: 'claude', fidelity: 'declared' },
        session: null,
        rows,
    } as unknown as ChatDetail);

    it('says the compaction in one system line, in its place among the messages', () => {
        const messages = chatMessages(detail([
            { id: 'r1', event: { kind: 'message', speaker: 'you', peerName: null, text: '/compact' }, at: 1 },
            { id: 'r2', event: { kind: 'divider', variant: 'compaction', before: 40341, after: 3942 }, at: 2 },
            { id: 'r3', event: { kind: 'message', speaker: 'agent', peerName: null, text: 'Compacted' }, at: 3 },
        ]));
        expect(messages.map((m) => [m.who, m.text])).toEqual([
            ['you', '/compact'],
            ['system', 'Compacted the context from 40,341 to 3,942 tokens'],
            ['agent', 'Compacted'],
        ]);
    });

    it('a compaction whose sizes were not reported still says it happened — no invented numbers', () => {
        const [m] = chatMessages(detail([{ id: 'r', event: { kind: 'divider', variant: 'compaction', before: null, after: null }, at: 1 }]));
        expect(m).toMatchObject({ who: 'system', text: 'Compacted the context' });
    });
});
