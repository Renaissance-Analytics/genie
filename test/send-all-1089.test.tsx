import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sendAll, sendAllWords, type SendAllState } from '../src/core/send-all.js';
import { ChatQueueBar } from '../src/renderer/components/ChatQueueBar.js';
import { control } from './helpers/control-markup.js';

/**
 * "SEND ALL NOW" SENDS, AND SAYS SO (Tynn #1089; the owner, 2026-11-27: "clicking the send all now button does nothing at
 * all"). The host refused his kept message as "already queued for the current turn", and the refusal was drawn under the
 * message, far above the button; the button itself changed nothing. Now: each kept message is sent in the order written, one
 * at a time; the bar says how far it is ("Sending 1 of 2…") and then what became of each — sent, waiting behind the turn (a
 * message already queued is waiting, not refused), or not sent and why. A failure does not stop the rest.
 */

const items = [{ id: 'm1', text: 'why do I keep getting this?' }, { id: 'm2', text: 'and this one' }, { id: 'm3', text: 'third' }];

describe('sendAll: each kept message, in order, with a result each', () => {
    it('sends one at a time in the order written, reporting progress before and after each', async () => {
        const order: string[] = [];
        const states: SendAllState[] = [];
        const final = await sendAll(items, async (m) => { order.push(m.id); return { ok: true }; }, (s) => states.push(s));
        expect(order).toEqual(['m1', 'm2', 'm3']);
        expect(states.map((s) => [s.done, s.of, s.running])).toEqual([[0, 3, true], [1, 3, true], [2, 3, true], [3, 3, false]]);
        expect(final.results.map((r) => r.outcome)).toEqual(['sent', 'sent', 'sent']);
    });

    it('a message the agent already holds is WAITING, never a failure; a refusal says why; a throw is a failure too; the rest still go', async () => {
        const final = await sendAll(items, async (m) => {
            if (m.id === 'm1') return { ok: true, waiting: true };
            if (m.id === 'm2') return { ok: false, reason: 'Restart the agent before sending this draft.' };
            throw new Error('Genie is not connected.');
        }, () => {});
        expect(final.results).toEqual([
            { id: 'm1', text: 'why do I keep getting this?', outcome: 'waiting' },
            { id: 'm2', text: 'and this one', outcome: 'failed', reason: 'Restart the agent before sending this draft.' },
            { id: 'm3', text: 'third', outcome: 'failed', reason: 'Genie is not connected.' },
        ]);
    });

    it('in words', () => {
        expect(sendAllWords({ done: 1, of: 3, running: true, results: [] })).toBe('Sending 2 of 3…');
        expect(sendAllWords({ done: 2, of: 2, running: false, results: [{ id: 'a', text: 'a', outcome: 'sent' }, { id: 'b', text: 'b', outcome: 'sent' }] })).toBe('Sent 2 of 2.');
        expect(sendAllWords({ done: 3, of: 3, running: false, results: [
            { id: 'a', text: 'a', outcome: 'sent' }, { id: 'b', text: 'b', outcome: 'waiting' }, { id: 'c', text: 'c', outcome: 'failed', reason: 'x' },
        ] })).toBe('Sent 1 of 3 · 1 waiting behind the current turn · 1 not sent.');
    });
});

describe('the queue bar while and after it sends', () => {
    it('while sending: the progress, and the button cannot be pressed twice', () => {
        const html = renderToStaticMarkup(<ChatQueueBar agentName="atlas" waiting={0} undelivered={2} onSendAll={() => {}} sending={{ done: 0, of: 2, running: true, results: [] }} />);
        expect(html).toContain('data-send-all-progress');
        expect(html).toContain('Sending 1 of 2…');
        // The button's own opening tag, in whatever order its attributes come.
        expect(control(html, 'data-action="send-all"')?.open).toMatch(/\sdisabled(=|\s|>)/);
    });

    it('after: the result of EACH message, at the bar — even once nothing is left "not delivered"', () => {
        const html = renderToStaticMarkup(<ChatQueueBar agentName="atlas" waiting={0} undelivered={0} sending={{ done: 2, of: 2, running: false, results: [
            { id: 'm1', text: 'why do I keep getting this?', outcome: 'waiting' },
            { id: 'm2', text: 'and this one', outcome: 'failed', reason: 'Restart the agent before sending this draft.' },
        ] }} />);
        expect(html).toContain('Sent 0 of 2 · 1 waiting behind the current turn · 1 not sent.');
        expect(html).toMatch(/data-send-all-result="m1"[^>]*>[\s\S]*why do I keep getting this\?[\s\S]*Waiting behind the current turn/);
        expect(html).toMatch(/data-send-all-result="m2"[^>]*>[\s\S]*Not sent: Restart the agent before sending this draft\./);
    });

    it('CONTROL: nothing sent, nothing waiting — nothing drawn', () => {
        expect(renderToStaticMarkup(<ChatQueueBar agentName="atlas" waiting={0} undelivered={0} />)).toBe('');
    });
});

describe('the results say what the chat says now', () => {
    it('a message reported sent but waiting in the run (held on the limit) reads Waiting; one delivered reads Sent', async () => {
        const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
        const thread = { agentId: 'a1', name: 'atlas', fidelity: 'declared' as const, unread: null, messages: [
            { id: 'm1', who: 'you' as const, from: 'you', text: 'first kept', delivered: false, queued: true, promptId: 'p1', at: 1 },
            { id: 'm2', who: 'you' as const, from: 'you', text: 'second kept', delivered: true, promptId: 'p2', at: 2 },
        ] };
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} sending={{ done: 2, of: 2, running: false, results: [
            { id: 'm1', text: 'first kept', outcome: 'sent' }, { id: 'm2', text: 'second kept', outcome: 'sent' },
        ] }} />);
        expect(html).toMatch(/data-send-all-result="m1" data-outcome="waiting"/);
        expect(html).toMatch(/data-send-all-result="m2" data-outcome="sent"/);
    });
});
