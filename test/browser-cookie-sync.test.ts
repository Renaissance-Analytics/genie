import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BrowserService, type BrowserEvent, type SyncedCookie } from '../src/main/browser-service.js';
import { CookieSync, cookieToSet } from '../src/core/cookie-sync.js';
import { BrowserCookieBridge } from '../src/main/browser-cookie-bridge.js';

/**
 * A SITE'S LOGIN, IN THE PANEL AND THE BROWSER (the host split, P2b; the owner: "Logins: sync cookies"). Two processes can't
 * share a store (measured), so a workspace has one per process, and its `.gen` cookies cross the host between them.
 * The rules: `.gen` hosts only; the host relays and stores nothing, and never logs a value; only between one workspace's
 * two stores; what a store is told is not sent back.
 */

const cookie = (over: Partial<SyncedCookie> = {}): SyncedCookie => ({ name: 'sid', value: 'v1', domain: 'moic.gen', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 2_000_000_000, ...over });

function side() {
    const sent: unknown[] = [];
    const applied: unknown[] = [];
    const sync = new CookieSync({
        send: (message) => sent.push(message),
        set: vi.fn(async (c: SyncedCookie) => { applied.push(['set', c.name, c.value]); }),
        remove: vi.fn(async (c: SyncedCookie) => { applied.push(['remove', c.name]); }),
    });
    return { sync, sent, applied };
}

describe('CookieSync', () => {
    it('a login here is sent, with every flag, HttpOnly included', () => {
        const { sync, sent } = side();
        sync.changed(cookie(), 'inserted', false);
        expect(sent).toEqual([{ op: 'set', cookie: cookie() }]);
    });

    it('a cookie gone here is gone there', () => {
        const { sync, sent } = side();
        sync.changed(cookie(), 'explicit', true);
        expect(sent).toEqual([{ op: 'remove', cookie: cookie() }]);
    });

    it('expired counts as gone', () => {
        const { sync, sent } = side();
        sync.changed(cookie(), 'expired', true);
        expect(sent).toHaveLength(1);
    });

    it('a logout (the site sets it again, already expired) is a remove: no insert follows it', () => {
        // Batch SS on omarchy-test: `sid=; Max-Age=0` in the panel left the browser signed in. Chromium reports it as expired-overwrite.
        const { sync, sent } = side();
        sync.changed(cookie(), 'expired-overwrite', true);
        expect(sent).toEqual([{ op: 'remove', cookie: cookie() }]);
    });

    it('an overwrite’s removal half says nothing: its insert follows, and a remove would race it', () => {
        const { sync, sent } = side();
        sync.changed(cookie(), 'overwrite', true);
        expect(sent).toEqual([]);
    });

    it.each(['example.com', '.example.com', 'moic.gen.example.com', 'gen', ''])('a cookie of %j never crosses', (domain) => {
        const { sync, sent } = side();
        sync.changed(cookie({ domain }), 'inserted', false);
        expect(sent).toEqual([]);
    });

    it('a parent domain cookie of a .gen site crosses', () => {
        const { sync, sent } = side();
        sync.changed(cookie({ domain: '.moic.gen', hostOnly: false }), 'inserted', false);
        expect(sent).toHaveLength(1);
    });

    it('what it was told is applied, and not sent back', async () => {
        const { sync, sent, applied } = side();
        await sync.receive({ op: 'set', cookie: cookie() });
        expect(applied).toEqual([['set', 'sid', 'v1']]);
        sync.changed(cookie(), 'inserted', false);
        expect(sent).toEqual([]);
    });

    it('CONTROL: a later change of its own is sent', async () => {
        const { sync, sent } = side();
        await sync.receive({ op: 'set', cookie: cookie() });
        sync.changed(cookie(), 'inserted', false);
        sync.changed(cookie({ value: 'v2' }), 'inserted', false);
        expect(sent).toEqual([{ op: 'set', cookie: cookie({ value: 'v2' }) }]);
    });

    it('a remove it was told is not sent back', async () => {
        const { sync, sent, applied } = side();
        await sync.receive({ op: 'remove', cookie: cookie() });
        expect(applied).toEqual([['remove', 'sid']]);
        sync.changed(cookie(), 'explicit', true);
        expect(sent).toEqual([]);
    });

    it('it refuses to apply one that is not .gen, whoever says so', async () => {
        const { sync, applied } = side();
        await sync.receive({ op: 'set', cookie: cookie({ domain: 'example.com' }) });
        expect(applied).toEqual([]);
    });

    it('a failed set leaves nothing waiting to be swallowed', async () => {
        const sent: unknown[] = [];
        const sync = new CookieSync({ send: (m) => sent.push(m), set: async () => { throw new Error('refused'); }, remove: async () => {} });
        await expect(sync.receive({ op: 'set', cookie: cookie() })).resolves.toBeUndefined();
        sync.changed(cookie(), 'inserted', false);
        expect(sent).toHaveLength(1);
    });
});

describe('cookieToSet', () => {
    it('host-only: no domain, so it stays host-only', () => {
        expect(cookieToSet(cookie())).toEqual({ url: 'https://moic.gen/', name: 'sid', value: 'v1', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 2_000_000_000 });
    });

    it('a domain cookie keeps its domain', () => {
        expect(cookieToSet(cookie({ domain: '.moic.gen', hostOnly: false }))).toMatchObject({ url: 'https://moic.gen/', domain: '.moic.gen' });
    });

    it('a session cookie stays one', () => {
        const { expirationDate, ...session } = cookie();
        void expirationDate;
        expect(cookieToSet(session)).not.toHaveProperty('expirationDate');
    });
});

describe('a side linking again', () => {
    it('asks again for every store it has: one opened before the link asked into nothing', async () => {
        const calls: unknown[] = [];
        const bridge = new BrowserCookieBridge({ call: async (m, a) => { calls.push([m, ...a]); return null; }, me: () => 'me', openStore: () => { throw new Error('unused'); } });
        const ses = { cookies: { get: async () => [] } } as never;
        bridge.attach('ws-a', ses);
        bridge.attach('ws-b', ses);
        calls.length = 0;
        bridge.relinked();
        expect(calls).toEqual([['cookiesWanted', 'ws-a'], ['cookiesWanted', 'ws-b']]);
    });
});

describe('the host', () => {
    const setup = () => {
        const service = new BrowserService();
        const events: BrowserEvent[] = [];
        service.onEvent((e) => events.push(e));
        return { service, events };
    };
    const message = (over: Partial<SyncedCookie> = {}) => ({ op: 'set', cookie: cookie(over) });

    it('relays to the other side, naming the workspace and who sent it', async () => {
        const { service, events } = setup();
        await service.call('cookies', ['ws', message()], 'window');
        expect(events.at(-1)).toEqual({ kind: 'cookies', from: 'window', workspaceId: 'ws', message: message() });
    });

    it('refuses what is not a .gen cookie, so a bad client cannot use it as a channel', async () => {
        const { service, events } = setup();
        await expect(service.call('cookies', ['ws', message({ domain: 'example.com' })], 'window')).rejects.toThrow(/\.gen/);
        expect(events).toEqual([]);
    });

    it('says which connection asked, so a side can ignore what it sent itself', async () => {
        await expect(setup().service.call('whoami', [], 'window')).resolves.toBe('window');
    });

    it('stores nothing: a browser that links later hears none of it', async () => {
        const { service, events } = setup();
        await service.call('cookies', ['ws', message()], 'window');
        const cookies = () => events.filter((e) => e.kind === 'cookies').length;
        const before = cookies();
        await service.call('register', [], 'browser');
        expect(cookies()).toBe(before);
    });

    it('never puts a value in its own words', async () => {
        const { service } = setup();
        const failed = await service.call('cookies', ['ws', message({ domain: 'example.com', value: 'SECRETVALUE' })], 'window').catch((e: Error) => e.message);
        expect(failed).not.toContain('SECRETVALUE');
    });
});

describe('the wires', () => {
    const strip = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

    it('every workspace store, on both sides, is watched', () => {
        const src = strip('src/main/genie-browser-electron.ts');
        expect(src).toMatch(/ses\.cookies\.on\('changed'/);
    });

    it('a side ignores what it sent itself, and hands the rest to that workspace’s sync', () => {
        const main = strip('src/main/main.ts');
        const browser = strip('src/main/browser-process.ts');
        for (const src of [main, browser]) expect(src).toMatch(/kind === 'cookies'/);
    });

    it('no log line carries a cookie: the relay is not in any log call', () => {
        const server = strip('src/main/session-engine-server.ts');
        expect(server).not.toMatch(/log[^\n]*browser\.event/);
        expect(strip('src/main/browser-service.ts')).not.toMatch(/console\.|log\(/);
    });
});
