import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chipRow } from '../src/core/session-timeline.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { activityRows, ledgerRow, type TimedEvent } from '../src/core/stream-view.js';
import { StreamRow } from '../src/renderer/components/StreamRow.js';

/**
 * THE STREAM IS WHAT THE AGENT IS DOING (the owner, using beta.19: the reply "showed up in the middle content area that
 * is an activity stream of what the agent is doing, not the place for a chat response. I should see the thinking and
 * tool calls there though and I should be able to click the thinking line item to expand and see the agent's
 * reasoning content"). So: replies and your messages live in the chat, not the Stream; prism-acp's debug notices
 * ("thinking", "session started", "turn complete") are not rows — the "thinking" one's token estimate goes onto its
 * thought; a thought EXPANDS on click to its full text (the owner's word over the spec's "never expands"); a thought
 * whose text the provider did not send (Claude's API redacts reasoning by default) says so; the rate-limit notice
 * reads as the headroom line, not a raw ISO date.
 */
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1 });
const KEY = 'particle.academy/thinking_tokens_estimate';

describe('activityRows', () => {
    it('drops messages and debug notices; a debug thinking estimate lands on the thought before it', () => {
        const rows = activityRows([
            t('n1', { kind: 'notice', level: 'debug', message: 'session started' }),
            t('m1', { kind: 'message', speaker: 'you', peerName: null, text: 'hi' }),
            t('k1', { kind: 'think', text: '', tokens: null, estimate: null }),
            t('n2', { kind: 'notice', level: 'debug', message: 'thinking', estimate: 642 } as StreamEvent),
            t('x1', { kind: 'tool', toolCallId: 'c', name: 'Bash', title: 'ls', status: 'completed', toolKind: 'execute', rawInput: null }),
            t('m2', { kind: 'message', speaker: 'agent', peerName: null, text: 'done' }),
            t('n3', { kind: 'notice', level: 'warning', message: 'Rate limit' }),
        ]);
        expect(rows.map((r) => r.id)).toEqual(['k1', 'x1', 'n3']);
        expect(rows[0]!.event).toMatchObject({ kind: 'think', estimate: 642 });
    });
});

describe('a thought expands', () => {
    it('is expandable and carries its whole text; clicked open, the text is drawn whole', () => {
        const row = ledgerRow(t('k', { kind: 'think', text: 'First I read the failing test.\nThen the controller.', tokens: null, estimate: 120 }));
        expect(row).toMatchObject({ expandable: true, full: 'First I read the failing test.\nThen the controller.' });
        const closed = renderToStaticMarkup(<StreamRow row={row} selected={false} onSelect={() => {}} />);
        const open = renderToStaticMarkup(<StreamRow row={row} selected={false} expanded onSelect={() => {}} />);
        expect(closed).toMatch(/data-expandable="true"/);
        expect(closed).not.toContain('data-thought-full');
        expect(open).toMatch(/data-thought-full[^>]*>First I read the failing test\.\nThen the controller\.</);
    });

    it('a thought with no text says the provider did not send it, and keeps its estimate', () => {
        const row = ledgerRow(t('k', { kind: 'think', text: '', tokens: null, estimate: 642 }));
        expect(row.main).toBe('Reasoning not sent by the provider');
        expect(row.meta).toBe('~642 tok');
        expect(row.expandable).toBe(false);
    });
});

describe('the notices that stay', () => {
    it('a rate-limit notice reads as its headroom line', () => {
        const at = new Date(2026, 9, 18, 11, 0).getTime();
        const row = ledgerRow(t('n', { kind: 'notice', level: 'warning', message: 'Rate limit: seven_day window at 61% used, resets 2026-10-18T11:00:00.000Z', headroom: { plan: null, window: '7d', leftPct: 39, resetsAtMs: at, over: false } }));
        expect(row.main).toBe('39% of 7d window left · resets 11:00');
    });
});

describe('the lane chips', () => {
    it('Thoughts, Tools and Edits — no Messages chip on an activity stream', () => {
        const chips = chipRow([t('k', { kind: 'think', text: 'x', tokens: null })], null).map((c) => c.id);
        expect(chips).not.toContain('messages');
        expect(chips).toEqual(expect.arrayContaining(['thoughts', 'tools', 'edits']));
    });
});
