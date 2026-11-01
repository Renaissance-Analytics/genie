import { describe, expect, it } from 'vitest';
import { pairKey, searchThread, threadWindow, type ThreadMail } from '../src/core/inbox-threads.js';
import { highlightParts, inViewOrder, mergeWindow, questionRef, scrollAfterInsert, searchSnippet, shortQuestionId, THREAD_BUFFER } from '../src/core/inbox-view.js';

/**
 * THE AGENTINBOX THREAD: SORT, PAGING AND SEARCH (the owner, 2026-11-01: "msgs in the inbox should be sortable and
 * searchable, sort newest on top by default." and "for FTQ responses in the inbox, the id should be a link that expands
 * to show the questions asked.").
 *
 * The rules held here, pure:
 *  - a thread's window is served by the host in seq order: the newest page, a page BEFORE a seq (Load older), or
 *    everything FROM a seq (a live refresh of what is on screen), bounded;
 *  - the renderer keeps a bounded buffer (THREAD_BUFFER) and MERGES each answer into it — an unchanged message keeps
 *    its object, so nothing is rebuilt per update (the live-view rule, owner 2026-10-22);
 *  - newest-first is the default view order; older mail pages in at the end of the list in that order;
 *  - new mail at the top must not move what the person is reading when they have scrolled down;
 *  - search runs over the thread's STORED mail, not the loaded window: message text, the sender's name, question ids.
 */
let seq = 0;
const T = Date.UTC(2026, 10, 1, 12, 0, 0);
const m = (from: string, to: string, text: string, readAt: string | null = null): ThreadMail =>
    ({ seq: ++seq, id: `msg_${seq}`, from, to, text, attachments: [], sentAt: new Date(T + seq * 1000).toISOString(), readAt });
const names: Record<string, string> = { human: 'you', a1: 'moic', a2: 'wren' };
const name = (p: string): string => names[p] ?? p;
const key = pairKey('human', 'a1');

/** 120 messages in the person's thread with moic, with other threads' mail interleaved (seqs are global). */
function history(): ThreadMail[] {
    seq = 0;
    const out: ThreadMail[] = [];
    for (let i = 0; i < 120; i++) {
        out.push(m(i % 2 ? 'a1' : 'human', i % 2 ? 'human' : 'a1', `#${i}${i === 3 ? ' the cache driver is ready' : ''}`));
        if (i % 10 === 0) out.push(m('a1', 'a2', `aside ${i} cache`));
    }
    return out;
}

describe('the host serves a window of a thread', () => {
    it('no seq: the newest `limit`, oldest first in the answer, with `more` and no `newer`', () => {
        const mail = history();
        const w = threadWindow(mail, key, { limit: 50 });
        expect(w.messages.map((x) => x.text)).toEqual(Array.from({ length: 50 }, (_, i) => `#${70 + i}`));
        expect([w.more, w.newer]).toEqual([true, false]);
    });

    it('`beforeSeq`: the `limit` just older than that seq (Load older); `more` says whether older still exist', () => {
        const mail = history();
        const first = threadWindow(mail, key, { limit: 50 });
        const older = threadWindow(mail, key, { limit: 50, beforeSeq: first.messages[0]!.seq });
        expect(older.messages.map((x) => x.text)).toEqual(Array.from({ length: 50 }, (_, i) => `#${20 + i}`));
        expect([older.more, older.newer]).toEqual([true, true]);
        const last = threadWindow(mail, key, { limit: 50, beforeSeq: older.messages[0]!.seq });
        expect(last.messages.map((x) => x.text)).toEqual(Array.from({ length: 20 }, (_, i) => `#${i}`));
        expect(last.more).toBe(false);
    });

    it('`fromSeq`: everything from that seq on, up to `limit` (a live refresh of the loaded window); `newer` when cut', () => {
        const mail = history();
        const from = mail.find((x) => x.text === '#100')!.seq;
        const w = threadWindow(mail, key, { limit: 500, fromSeq: from });
        expect(w.messages.map((x) => x.text)).toEqual(Array.from({ length: 20 }, (_, i) => `#${100 + i}`));
        expect([w.more, w.newer]).toEqual([true, false]);
        const cut = threadWindow(mail, key, { limit: 5, fromSeq: from });
        expect(cut.messages.map((x) => x.text)).toEqual(['#100', '#101', '#102', '#103', '#104']);
        expect(cut.newer).toBe(true);
    });
});

describe('the renderer merges each answer into a bounded buffer', () => {
    it('a refresh that changes nothing keeps every message OBJECT — nothing on screen is rebuilt', () => {
        const mail = history();
        const buffer = threadWindow(mail, key, { limit: 50 }).messages;
        const again = threadWindow(mail.map((x) => ({ ...x })), key, { limit: 500, fromSeq: buffer[0]!.seq }).messages;
        const merged = mergeWindow(buffer, again, { from: buffer[0]!.seq, to: Infinity }, 'newest', THREAD_BUFFER);
        expect(merged.messages).toHaveLength(50);
        merged.messages.forEach((x, i) => expect(x).toBe(buffer[i]));
        expect(merged.trimmed).toBe(false);
    });

    it('a refresh: new mail appended, a changed read state patched (new object for that one only)', () => {
        const mail = history();
        const buffer = threadWindow(mail, key, { limit: 50 }).messages;
        const read = buffer[10]!;
        const next = mail.map((x) => (x.id === read.id ? { ...x, readAt: new Date(T).toISOString() } : x));
        next.push(m('a1', 'human', 'fresh'));
        const merged = mergeWindow(buffer, threadWindow(next, key, { limit: 500, fromSeq: buffer[0]!.seq }).messages, { from: buffer[0]!.seq, to: Infinity }, 'newest', THREAD_BUFFER);
        expect(merged.messages).toHaveLength(51);
        expect(merged.messages.at(-1)!.text).toBe('fresh');
        expect(merged.messages[10]).not.toBe(read);
        expect(merged.messages[10]!.readAt).not.toBeNull();
        expect(merged.messages[9]).toBe(buffer[9]);
    });

    it('a refresh drops what the host no longer holds inside the range it answered (a deleted message)', () => {
        const mail = history();
        const buffer = threadWindow(mail, key, { limit: 50 }).messages;
        const gone = buffer[5]!.id;
        const merged = mergeWindow(buffer, threadWindow(mail.filter((x) => x.id !== gone), key, { limit: 500, fromSeq: buffer[0]!.seq }).messages, { from: buffer[0]!.seq, to: Infinity }, 'newest', THREAD_BUFFER);
        expect(merged.messages.map((x) => x.id)).not.toContain(gone);
        expect(merged.messages).toHaveLength(49);
    });

    it('Load older adds the older page; past the cap the NEWEST end is trimmed (and says so) — the buffer stays bounded', () => {
        const mail = history();
        const buffer = threadWindow(mail, key, { limit: 50 }).messages;
        const older = threadWindow(mail, key, { limit: 50, beforeSeq: buffer[0]!.seq }).messages;
        const merged = mergeWindow(buffer, older, { from: older[0]!.seq, to: buffer[0]!.seq - 1 }, 'oldest', 60);
        expect(merged.messages).toHaveLength(60);
        expect(merged.messages[0]!.text).toBe('#20');
        expect(merged.messages.at(-1)!.text).toBe('#79');
        expect(merged.trimmed).toBe(true);
        // Kept objects are kept.
        expect(merged.messages[50]).toBe(buffer[0]);
    });
});

describe('the view order', () => {
    it('newest-first is the default and reverses the buffer; oldest-first keeps it', () => {
        const mail = history();
        const buffer = threadWindow(mail, key, { limit: 3 }).messages;
        expect(inViewOrder(buffer).map((x) => x.text)).toEqual(['#119', '#118', '#117']);
        expect(inViewOrder(buffer, 'newest').map((x) => x.text)).toEqual(['#119', '#118', '#117']);
        expect(inViewOrder(buffer, 'oldest').map((x) => x.text)).toEqual(['#117', '#118', '#119']);
    });
});

describe('the scroll position after the list grows', () => {
    const at = (over: Partial<Parameters<typeof scrollAfterInsert>[0]>) =>
        scrollAfterInsert({ order: 'newest', cause: 'live', prevTop: 0, prevHeight: 1000, newHeight: 1200, ...over });

    it('newest-first, new mail, scrolled down: the reading position holds (shifted by what was inserted above)', () => {
        expect(at({ prevTop: 300 })).toBe(500);
    });
    it('newest-first, new mail, at the top: stays at the top so the new mail is seen', () => {
        expect(at({ prevTop: 0 })).toBeNull();
    });
    it('newest-first, Load older: it lands at the bottom, nothing to adjust', () => {
        expect(at({ cause: 'older', prevTop: 800 })).toBeNull();
    });
    it('oldest-first, Load older: lands at the top, the reading position holds', () => {
        expect(at({ order: 'oldest', cause: 'older', prevTop: 0 })).toBe(200);
    });
    it('oldest-first, new mail: lands at the bottom, nothing to adjust; a fresh thread opens at its newest end', () => {
        expect(at({ order: 'oldest', cause: 'live', prevTop: 100 })).toBeNull();
        expect(at({ order: 'oldest', cause: 'reset' })).toBe(1200);
        expect(at({ order: 'newest', cause: 'reset', prevTop: 400 })).toBe(0);
    });
});

describe('search over the stored thread', () => {
    it('matches message text across the WHOLE history — not only a loaded window — and never another thread', () => {
        const mail = history();
        const r = searchThread(mail, key, 'cache driver', name, 200);
        expect(r.hits.map((x) => x.text)).toEqual(['#3 the cache driver is ready']);
        expect(r.total).toBe(1);
        // Positive control: "cache" is in the agent-to-agent thread too, which this thread's search never reads.
        expect(searchThread(mail, pairKey('a1', 'a2'), 'cache', name, 200).total).toBe(12);
        expect(searchThread(mail, key, 'cache', name, 200).total).toBe(1);
    });

    it('matches the sender’s name, case-insensitive, and question ids (full or shortened with …)', () => {
        seq = 0;
        const qid = 'q_e07a0573-1b2c-4d5e-8f90-123456789abc';
        const mail = [m('human', 'a1', `Answer to your question ${qid}:\n- **Deploy** — now?\n  → Yes`), m('a1', 'human', 'thanks')];
        expect(searchThread(mail, key, 'MOIC', name, 200).hits.map((x) => x.text)).toEqual(['thanks']);
        expect(searchThread(mail, key, qid, name, 200).total).toBe(1);
        expect(searchThread(mail, key, 'q_e07a0573…', name, 200).total).toBe(1);
        expect(searchThread(mail, key, '   ', name, 200).total).toBe(0);
    });

    it('newest hits first, capped, with the true total', () => {
        const mail = history();
        const r = searchThread(mail, key, '#1', name, 5);
        expect(r.hits).toHaveLength(5);
        expect(r.hits[0]!.text).toBe('#119');
        expect(r.total).toBe(31);
    });

    it('a hit is drawn with the match marked, around where it is', () => {
        expect(highlightParts('The Cache driver; cache', 'cache')).toEqual([
            { text: 'The ', hit: false }, { text: 'Cache', hit: true }, { text: ' driver; ', hit: false }, { text: 'cache', hit: true },
        ]);
        expect(highlightParts('nothing here', 'cache')).toEqual([{ text: 'nothing here', hit: false }]);
        const long = `${'a'.repeat(400)} needle ${'b'.repeat(400)}`;
        const s = searchSnippet(long, 'needle', 40);
        expect(s.startsWith('…')).toBe(true);
        expect(s.endsWith('…')).toBe(true);
        expect(s).toContain('needle');
        expect(s.length).toBeLessThan(100);
    });
});

describe('a question id in a message', () => {
    const qid = 'q_e07a0573-1b2c-4d5e-8f90-123456789abc';
    it('an FTQ answer: the id, shortened for show, and the rest of the text without the "Answer to…" line', () => {
        const r = questionRef(`Answer to your question ${qid}:\n- **Deploy** — now?\n  → Yes`);
        expect(r).toEqual({ id: qid, kind: 'answer', rest: '- **Deploy** — now?\n  → Yes' });
        expect(shortQuestionId(qid)).toBe('q_e07a0573…');
    });
    it('a dismissal names the id inside it: the text is kept whole', () => {
        const text = `Deploy: dismissed by the person, without an answer.\n(Your question ${qid}. Nothing was chosen.)`;
        expect(questionRef(text)).toEqual({ id: qid, kind: 'mention', rest: text });
    });
    it('no question id: nothing', () => {
        expect(questionRef('see q_ for details')).toBeNull();
    });
});
