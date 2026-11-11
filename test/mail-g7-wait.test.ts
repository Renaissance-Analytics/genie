import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@particle-academy/prism-mcp';
import type { Inbox } from '../src/core/mail.js';
import { mailTools, type MailPort } from '../src/main/mcp-tools-mail.js';
import type { MailpitReader, MailpitSummary } from '../src/main/mailpit-reader.js';
import { MailpitEvents, type EventSocket } from '../src/main/mailpit-events.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * GENIE MAIL G7: `mail wait` (Tynn story #493; spec .ai/plans/specs/genie-mail.md). An agent testing a signup or a
 * password reset waits for the mail: `wait {inbox?, match?, timeoutSeconds?}` answers the first matching message of the
 * caller's own inboxes, from the host's subscription to Mailpit's websocket — never by polling. With nothing matching it
 * answers "timed out", which is not an error. A message to another workspace's inbox never satisfies it.
 * The real Mailpit and its websocket: test/mailpit-measure/mail-g7-wait.accept.ts.
 */
const callers: Record<string, Caller> = {
    'term-a': { agentId: 'agent-a', workspaceId: 'ws-a', workspacePath: '/w/a' } as Caller,
    'term-b': { agentId: 'agent-b', workspaceId: 'ws-b', workspacePath: '/w/b' } as Caller,
};
const inbox = (id: string, workspaceId: string, name: string, slug: string): Inbox => ({ id, workspaceId, name, address: `${name}@${slug}.mail.gen`, smtpUser: `${name}@${slug}.mail.gen`, createdAt: 0 });
const who = (address: string) => ({ Address: address, Name: '' });
function summary(id: string, over: Partial<MailpitSummary>): MailpitSummary {
    return {
        ID: id, MessageID: `${id}@x`, Read: false, From: who('noreply@shop.test'), To: [], Cc: [], Bcc: [], ReplyTo: [], Subject: `subject ${id}`,
        Created: '2026-11-08T10:00:00Z', Size: 100, Attachments: 0, Snippet: `snippet ${id}`, Tags: [], ...over,
    };
}

function fixture(existing: MailpitSummary[] = []) {
    const inboxes: Inbox[] = [inbox('in-a-app', 'ws-a', 'app', 'ws-a'), inbox('in-a-signup', 'ws-a', 'signup', 'ws-a'), inbox('in-b-app', 'ws-b', 'app', 'ws-b')];
    const listeners = new Set<(s: MailpitSummary) => void>();
    let pages = 0;
    const reader: MailpitReader = {
        source: { id: 'shared', sendApiClosed: true },
        page: async ({ start, limit }) => { pages++; return { messages: existing.slice(start, start + limit), total: existing.length }; },
        message: async () => { throw new Error('wait never fetches a whole message'); },
        headers: async () => ({}),
        remove: async () => {},
    };
    const port: MailPort = {
        inboxes: (ws) => inboxes.filter((i) => i.workspaceId === ws),
        create: async () => { throw new Error('x'); },
        rotate: async () => { throw new Error('x'); },
        remove: async () => { throw new Error('x'); },
        smtp: () => ({ host: 'mail.gen', port: 4101 }),
        reader: () => reader,
        events: () => ({ subscribe: (fn) => { listeners.add(fn); return { ready: Promise.resolve(), close: () => { listeners.delete(fn); } }; } }),
    };
    const [tool] = mailTools({ resolveCaller: (id) => callers[id] ?? null, mail: port });
    const call = async (terminalId: string, args: JsonObject, signal?: AbortSignal) => {
        const r = await tool!.handler({ ...args, terminalId }, { server: 'genie', tool: 'mail', headers: {}, ...(signal ? { signal } : {}) });
        return { isError: r.isError === true, body: JSON.parse(r.text) as Record<string, any> };
    };
    const emit = (s: MailpitSummary) => { for (const l of [...listeners]) l(s); };
    return { call, emit, listeners, pages: () => pages };
}
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

describe('mail wait', () => {
    it('returns within a second of a matching message arriving', async () => {
        const f = fixture();
        const started = Date.now();
        let arrivedAt = 0;
        later(300, () => { arrivedAt = Date.now(); f.emit(summary('m1', { To: [who('signup@ws-a.mail.gen')], Subject: 'Confirm your email' })); });
        const r = await f.call('term-a', { action: 'wait', inbox: 'signup', match: 'confirm', timeoutSeconds: 10 });
        expect(r.isError).toBe(false);
        expect(r.body).toMatchObject({ ok: true, message: { id: 'm1', subject: 'Confirm your email', inboxes: ['signup'] } });
        expect(arrivedAt).toBeGreaterThan(0);
        expect(Date.now() - arrivedAt).toBeLessThan(1000);
        expect(Date.now() - started).toBeLessThan(5000);
    });

    it('with nothing matching it answers "timed out" at the timeout, which is not an error', async () => {
        const f = fixture();
        later(100, () => f.emit(summary('m1', { To: [who('signup@ws-a.mail.gen')], Subject: 'Your invoice' })));
        const started = Date.now();
        const r = await f.call('term-a', { action: 'wait', inbox: 'signup', match: 'confirm', timeoutSeconds: 1 });
        const took = Date.now() - started;
        expect(r.isError).toBe(false);
        expect(r.body).toMatchObject({ ok: true, timedOut: true });
        expect(r.body.note).toMatch(/timed out/);
        expect(took).toBeGreaterThanOrEqual(950);
        expect(took).toBeLessThan(3000);
    });

    it('a message to ANOTHER workspace\'s inbox never satisfies it, even matching, even carrying its tag', async () => {
        const f = fixture();
        later(100, () => f.emit(summary('m-b', { To: [who('app@ws-b.mail.gen')], Subject: 'Confirm your email', Tags: ['ws-a', 'signup'] })));
        const r = await f.call('term-a', { action: 'wait', match: 'confirm', timeoutSeconds: 1 });
        expect(r.body).toMatchObject({ ok: true, timedOut: true });
        expect(JSON.stringify(r.body)).not.toContain('m-b');
    });

    it('CONTROL: the same message to the caller\'s own inbox does satisfy it', async () => {
        const f = fixture();
        later(100, () => f.emit(summary('m-a', { To: [who('app@ws-a.mail.gen')], Subject: 'Confirm your email' })));
        const r = await f.call('term-a', { action: 'wait', match: 'confirm', timeoutSeconds: 5 });
        expect(r.body).toMatchObject({ ok: true, message: { id: 'm-a', inboxes: ['app'] } });
    });

    it('an UNREAD matching message already there answers at once; a read one is not waited for again', async () => {
        const f = fixture([
            summary('old-read', { To: [who('signup@ws-a.mail.gen')], Subject: 'Confirm your email', Read: true }),
            summary('fresh', { To: [who('signup@ws-a.mail.gen')], Subject: 'Confirm your email' }),
        ]);
        const started = Date.now();
        const r = await f.call('term-a', { action: 'wait', inbox: 'signup', match: 'confirm', timeoutSeconds: 10 });
        expect(r.body).toMatchObject({ ok: true, message: { id: 'fresh' } });
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('never polls: Mailpit\'s list is read once (what is already there), then only the websocket', async () => {
        const f = fixture();
        const r = await f.call('term-a', { action: 'wait', timeoutSeconds: 2 });
        expect(r.body.timedOut).toBe(true);
        expect(f.pages()).toBe(1);
    });

    it('leaves nothing subscribed when it answers, times out, or the call is cancelled', async () => {
        const f = fixture();
        later(50, () => f.emit(summary('m1', { To: [who('app@ws-a.mail.gen')] })));
        await f.call('term-a', { action: 'wait', timeoutSeconds: 5 });
        expect(f.listeners.size).toBe(0);
        await f.call('term-a', { action: 'wait', timeoutSeconds: 1 });
        expect(f.listeners.size).toBe(0);
        const abort = new AbortController();
        later(100, () => abort.abort());
        const cancelled = await f.call('term-a', { action: 'wait', timeoutSeconds: 30 }, abort.signal);
        expect(cancelled.body).toMatchObject({ ok: false });
        expect(f.listeners.size).toBe(0);
    });

    it('another workspace\'s inbox cannot be waited on: refused by name', async () => {
        const f = fixture();
        const r = await f.call('term-a', { action: 'wait', inbox: 'in-b-app', timeoutSeconds: 1 });
        expect(r.isError).toBe(true);
        expect(r.body.error).toMatch(/in-b-app is not one of this workspace.s inboxes/);
    });

    it('a timeout outside 1..300 seconds is refused', async () => {
        const f = fixture();
        expect((await f.call('term-a', { action: 'wait', timeoutSeconds: 0 })).body.error).toMatch(/timeoutSeconds/);
        expect((await f.call('term-a', { action: 'wait', timeoutSeconds: 301 })).body.error).toMatch(/timeoutSeconds/);
    });
});

describe('the host\'s subscription to Mailpit\'s websocket', () => {
    function fakeSockets() {
        const opened: Array<{ url: string; socket: EventSocket; fire: (type: string, event?: unknown) => void; closed: boolean }> = [];
        const connect = (url: string): EventSocket => {
            const handlers = new Map<string, Array<(e: any) => void>>();
            const entry = {
                url, closed: false,
                socket: {
                    addEventListener: (type: string, fn: (e: any) => void) => { handlers.set(type, [...(handlers.get(type) ?? []), fn]); },
                    close: () => { entry.closed = true; },
                } as EventSocket,
                fire: (type: string, event?: unknown) => { for (const fn of handlers.get(type) ?? []) fn(event); },
            };
            opened.push(entry);
            return entry.socket;
        };
        return { opened, connect };
    }

    it('opens one socket on the first listener, hands each "new" message to every listener, closes on the last', async () => {
        const s = fakeSockets();
        const events = new MailpitEvents({ url: () => 'http://127.0.0.1:4102', connect: s.connect });
        const a: string[] = [];
        const b: string[] = [];
        const one = events.subscribe((m) => a.push(m.ID));
        const two = events.subscribe((m) => b.push(m.ID));
        expect(s.opened.map((o) => o.url)).toEqual(['ws://127.0.0.1:4102/api/events']);
        s.opened[0]!.fire('open');
        await Promise.all([one.ready, two.ready]);
        s.opened[0]!.fire('message', { data: JSON.stringify({ Type: 'new', Data: summary('m1', {}) }) });
        s.opened[0]!.fire('message', { data: JSON.stringify({ Type: 'stats', Data: {} }) });
        expect(a).toEqual(['m1']);
        expect(b).toEqual(['m1']);
        one.close();
        expect(s.opened[0]!.closed).toBe(false);
        two.close();
        expect(s.opened[0]!.closed).toBe(true);
    });

    it('a socket that cannot open rejects `ready`, so the wait says so instead of waiting blind', async () => {
        const s = fakeSockets();
        const events = new MailpitEvents({ url: () => 'http://127.0.0.1:4102', connect: s.connect });
        const sub = events.subscribe(() => {});
        s.opened[0]!.fire('error');
        s.opened[0]!.fire('close');
        await expect(sub.ready).rejects.toThrow(/websocket/);
        sub.close();
    });

    it('with no shared Mailpit there is nothing to open', async () => {
        const s = fakeSockets();
        const events = new MailpitEvents({ url: () => null, connect: s.connect });
        const sub = events.subscribe(() => {});
        await expect(sub.ready).rejects.toThrow(/Mailpit/);
        expect(s.opened).toEqual([]);
        sub.close();
    });
});
