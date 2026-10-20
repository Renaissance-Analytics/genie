import { describe, expect, it } from 'vitest';
import { ago, filterCounts, filterThreads, inboxThreads, pairKey, threadKeyOfMessage, threadOf, uncollected, type ThreadMail } from '../src/core/inbox-threads.js';

/**
 * THE AGENTINBOX AS THREADS (beta.33 item 19). Genie 1's model from its code (review-g1 `main/agentinbox/broker.ts:151`
 * `pairKey`, `AgentInboxFlyout.tsx`): a thread is a pair — the person with an agent, or two agents — newest activity
 * first; All / Unread / Stale chips; the agents' uncollected mail as "waiting". Improved where Genie 1 fell short: search
 * reads every message (Genie 1 matched only names and a 140-character preview), history pages back (Genie 1 stopped at
 * 100), and waiting is read from the mail, so it survives a reload.
 */
const T = Date.UTC(2026, 9, 20, 12, 0, 0);
let seq = 0;
const m = (from: string, to: string, text: string, at: number, readAt: string | null = null, attachments: ThreadMail['attachments'] = []): ThreadMail =>
    ({ seq: ++seq, id: `msg_${seq}`, from, to, text, attachments, sentAt: new Date(at).toISOString(), readAt });
const names: Record<string, string> = { human: 'you', a1: 'atlas', a2: 'wren', a3: 'vesper' };
const name = (p: string): string => names[p] ?? p;

describe('threads', () => {
    it('one thread per PAIR, either direction; the person’s and agent-to-agent alike; newest activity first', () => {
        seq = 0;
        const mail = [
            m('human', 'a1', 'Ship the cache driver?', T, null),
            m('a1', 'human', 'Shipped.', T + 60_000, null),
            m('a1', 'a2', 'drop the challenges table', T + 120_000, T.toString()),
            m('a2', 'a1', 'done', T + 180_000, null),
            m('a3', 'human', 'review ready', T + 30_000, new Date(T + 40_000).toISOString()),
        ];
        const threads = inboxThreads(mail, name);
        expect(threads.map((t) => [t.key, t.aName, t.bName, t.withHuman, t.count, t.lastFrom, t.lastPreview])).toEqual([
            [pairKey('a1', 'a2'), 'atlas', 'wren', false, 2, 'wren', 'done'],
            [pairKey('a1', 'human'), 'atlas', 'you', true, 2, 'atlas', 'Shipped.'],
            [pairKey('a3', 'human'), 'vesper', 'you', true, 1, 'vesper', 'review ready'],
        ]);
        // The person's unread is mail TO the person not read; the agents' waiting is mail TO an agent not collected.
        const byKey = Object.fromEntries(threads.map((t) => [t.key, t]));
        expect(byKey[pairKey('a1', 'human')]!.unread).toBe(1);
        expect(byKey[pairKey('a1', 'human')]!.waiting).toEqual({ agent: 'atlas', count: 1, since: T });
        expect(byKey[pairKey('a3', 'human')]!.unread).toBe(0);
        expect(byKey[pairKey('a3', 'human')]!.waiting).toBeNull();
        expect(byKey[pairKey('a1', 'a2')]!.waiting).toEqual({ agent: 'atlas', count: 1, since: T + 180_000 });
        expect(uncollected(mail)).toBe(2);
    });

    it('a preview is one line, cut at 140; attachments are counted', () => {
        seq = 0;
        const [t] = inboxThreads([m('a1', 'human', `line one\nline two ${'x'.repeat(200)}`, T, null, [{ id: 'att_1', name: 'a.png', size: 10 }])], name);
        expect(t!.lastPreview.startsWith('line one line two')).toBe(true);
        expect(t!.lastPreview).toHaveLength(140);
        expect(t!.attachments).toBe(1);
    });
});

describe('search and filters', () => {
    seq = 0;
    const mail = [
        m('human', 'a1', 'the migration plan is ready', T - 3 * 24 * 3600_000, new Date(T).toISOString()),
        m('a1', 'human', 'ok, starting', T - 3 * 24 * 3600_000 + 1000, new Date(T).toISOString()),
        m('a2', 'human', 'need a decision on the ports', T - 60_000, null),
        m('a2', 'a3', 'handing over the cache work', T - 30_000, null),
    ];
    const threads = inboxThreads(mail, name);

    it('search reads EVERY message’s text and the names — not just the last preview', () => {
        // "migration" is only in the FIRST message of atlas's thread; its last message says "ok, starting".
        expect(filterThreads(threads, { filter: 'all', query: 'MIGRATION', now: T }).map((t) => t.key)).toEqual([pairKey('a1', 'human')]);
        expect(filterThreads(threads, { filter: 'all', query: 'vesper', now: T }).map((t) => t.key)).toEqual([pairKey('a2', 'a3')]);
        expect(filterThreads(threads, { filter: 'all', query: '', now: T })).toHaveLength(3);
        expect(filterThreads(threads, { filter: 'all', query: 'nothing says this', now: T })).toHaveLength(0);
    });

    it('Unread: the person has mail to read; Waiting: an agent has mail to collect; Stale: nothing for a day — with counts', () => {
        expect(filterThreads(threads, { filter: 'unread', query: '', now: T }).map((t) => t.key)).toEqual([pairKey('a2', 'human')]);
        expect(filterThreads(threads, { filter: 'waiting', query: '', now: T }).map((t) => t.key)).toEqual([pairKey('a2', 'a3')]);
        expect(filterThreads(threads, { filter: 'stale', query: '', now: T }).map((t) => t.key)).toEqual([pairKey('a1', 'human')]);
        expect(filterCounts(threads, T)).toEqual({ all: 3, unread: 1, waiting: 1, stale: 1 });
    });
});

describe('a thread’s history', () => {
    it('the newest `limit`, oldest first, and whether older ones exist — paging back is a bigger limit', () => {
        seq = 0;
        const mail = Array.from({ length: 5 }, (_, i) => m(i % 2 ? 'a1' : 'human', i % 2 ? 'human' : 'a1', `#${i}`, T + i));
        mail.push(m('a2', 'human', 'other thread', T + 99));
        const key = pairKey('human', 'a1');
        expect(threadOf(mail, key, 3)).toEqual({ key, messages: mail.slice(2, 5), more: true });
        expect(threadOf(mail, key, 50)).toEqual({ key, messages: mail.slice(0, 5), more: false });
        expect(threadKeyOfMessage(mail, mail[1]!.id)).toBe(key);
        expect(threadKeyOfMessage(mail, 'msg_nope')).toBeNull();
    });
});

describe('ago', () => {
    it('Genie 1’s relative time', () => {
        expect(ago(T - 5_000, T)).toBe('5s');
        expect(ago(T - 3 * 60_000, T)).toBe('3m');
        expect(ago(T - 5 * 3600_000, T)).toBe('5h');
        expect(ago(T - 4 * 24 * 3600_000, T)).toBe('4d');
    });
});
