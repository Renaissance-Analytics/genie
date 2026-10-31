import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_LIMITS, appMailNote } from '../src/core/app-inbox.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { AppInboxKeys } from '../src/main/app-inbox-keys.js';
import { AppInboxService, startAppInboxServer, type AppInboxRequest } from '../src/main/app-inbox-service.js';
import { InboxStore } from '../src/main/inbox-store.js';

/**
 * THE APP DOOR (genie#1345): a loopback HTTP endpoint a site, a kept process or a script posts to. Every rule that makes
 * it safe is asserted here, each with the positive control beside it: an unknown credential gets 404 (the same answer as
 * a route that does not exist), a browser is refused, the sender is the credential's and never the body's, an app
 * reaches its own workspace only, and a flood is cut off before anything is stored.
 */

let dir: string;
let inbox: InboxStore;
let keys: AppInboxKeys;
let service: AppInboxService;
let now = 1_000_000;
let enabled = true;
const clerk = agentRecord({ id: mintAgentId(), workspaceId: 'fancy', provider: 'claude', name: 'clerk', mode: 'automated' });
const scribe = agentRecord({ id: mintAgentId(), workspaceId: 'fancy', provider: 'codex', name: 'scribe' });
const other = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'keeper', accessScope: 'all' });
const roster: AgentRecord[] = [clerk, scribe, other];
const site = { kind: 'site' as const, id: 'site_flabs', name: 'flabs', workspaceId: 'fancy' };
let token: string;

const PORT = 47999;
function req(over: Omit<Partial<AppInboxRequest>, 'body'> & { body?: unknown; auth?: string | null }): AppInboxRequest {
    const { body, auth, ...rest } = over;
    return {
        method: 'POST',
        path: '/v1/inbox',
        port: PORT,
        headers: {
            host: `127.0.0.1:${PORT}`,
            'content-type': 'application/json',
            ...(auth === null ? {} : { authorization: `Bearer ${auth ?? token}` }),
        },
        body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
        ...rest,
    };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-app-http-'));
    inbox = await InboxStore.open(dir);
    keys = await AppInboxKeys.open(dir);
    token = keys.tokenFor(site)!;
    enabled = true;
    now = 1_000_000;
    service = new AppInboxService({
        keys, inbox, roster: () => roster,
        slugs: () => new Map([['fancy', 'fancy'], ['tynn', 'tynn']]),
        defaultAgentOf: (ws) => (ws === 'fancy' ? clerk.id : null),
        enabled: () => enabled,
        siteHosts: (ws) => (ws === 'fancy' ? ['flabs.gen'] : []),
        now: () => now,
    });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('send', () => {
    it('stores ONE message to the default agent, from the credential’s source, and answers its id (positive control)', async () => {
        const r = await service.handle(req({ body: { subject: '3 petitions queued', body: 'Change #42 approved' } }));
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ ok: true, to: 'clerk@fancy', delivery: 'push' });
        const page = await inbox.receive({ participant: clerk.id });
        expect(page.messages).toHaveLength(1);
        expect(page.messages[0]).toMatchObject({ id: r.body.messageId, from: 'app:site:site_flabs', text: 'Change #42 approved', app: { label: 'site:flabs@fancy', subject: '3 petitions queued', level: 'info', source: site } });
    });

    it('targets a named agent of its own workspace, and says a manual one is told but never started by an app', async () => {
        const r = await service.handle(req({ body: { to: 'scribe', subject: 's', body: 'b' } }));
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ to: 'scribe@fancy', delivery: 'push-no-wake' });
        expect(inbox.unread(scribe.id)).toHaveLength(1);
    });

    it('the body cannot choose the sender: `from`, `fromLabel`, `source` in it change nothing', async () => {
        await service.handle(req({ body: { subject: 's', body: 'b', from: HUMAN, fromLabel: 'You', source: { kind: 'site', id: 'site_other' }, app: { label: 'you' } } }));
        const [m] = inbox.unread(clerk.id);
        expect(m!.from).toBe('app:site:site_flabs');
        expect(m!.app!.label).toBe('site:flabs@fancy');
    });

    it('another workspace’s agent is NOT FOUND — by name, address or id — and nothing is stored', async () => {
        for (const to of ['keeper', 'keeper@tynn', other.id as string]) {
            const r = await service.handle(req({ body: { to, subject: 's', body: 'b' } }));
            expect(r.status).toBe(404);
        }
        expect(inbox.unread(other.id)).toHaveLength(0);
        expect(inbox.all()).toHaveLength(0);
    });

    it('an unknown, missing or revoked credential gets 404 — the same answer as a route that is not there', async () => {
        const unknown = await service.handle(req({ auth: 'gik_not_a_real_one', body: { subject: 's', body: 'b' } }));
        const missing = await service.handle(req({ auth: null, body: { subject: 's', body: 'b' } }));
        const nowhere = await service.handle(req({ path: '/v1/elsewhere', body: { subject: 's', body: 'b' } }));
        expect(unknown.status).toBe(404);
        expect(missing.status).toBe(404);
        expect(nowhere.status).toBe(404);
        expect(unknown.body).toEqual(nowhere.body);
        await keys.revokeSource(site);
        expect((await service.handle(req({ body: { subject: 's', body: 'b' } }))).status).toBe(404);
        expect(inbox.all()).toHaveLength(0);
    });

    it('a BROWSER is refused: any Origin header, a foreign Host, or a non-JSON body', async () => {
        expect((await service.handle(req({ headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', authorization: `Bearer ${token}`, origin: 'https://flabs.gen' }, body: { subject: 's', body: 'b' } }))).status).toBe(403);
        expect((await service.handle(req({ headers: { host: `evil.example:${PORT}`, 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: { subject: 's', body: 'b' } }))).status).toBe(403);
        expect((await service.handle(req({ headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'text/plain', authorization: `Bearer ${token}` }, body: JSON.stringify({ subject: 's', body: 'b' }) }))).status).toBe(415);
        expect(inbox.all()).toHaveLength(0);
        // Positive control: the same request with `localhost` and no Origin goes through.
        expect((await service.handle(req({ headers: { host: `localhost:${PORT}`, 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` }, body: { subject: 's', body: 'b' } }))).status).toBe(201);
    });

    it('switched off in the workspace: refused (403), nothing stored', async () => {
        enabled = false;
        const r = await service.handle(req({ body: { subject: 's', body: 'b' } }));
        expect(r.status).toBe(403);
        expect(inbox.all()).toHaveLength(0);
    });

    it('a flood is cut off: 429 with when to retry, nothing stored past the burst', async () => {
        const codes: number[] = [];
        for (let i = 0; i < APP_LIMITS.burst + 2; i++) codes.push((await service.handle(req({ body: { subject: `s${i}`, body: 'b' } }))).status);
        expect(codes.filter((c) => c === 201)).toHaveLength(APP_LIMITS.burst);
        const last = await service.handle(req({ body: { subject: 'again', body: 'b' } }));
        expect(last.status).toBe(429);
        expect(Number(last.headers?.['retry-after'])).toBeGreaterThan(0);
        expect(inbox.all()).toHaveLength(APP_LIMITS.burst);
    });

    it('an agent’s backlog of uncollected app mail is capped (409), and collecting frees it', async () => {
        for (let i = 0; i < APP_LIMITS.backlog; i++) {
            await inbox.send({ from: 'app:site:site_flabs', to: clerk.id, text: 'b', app: { source: site, label: 'site:flabs@fancy', subject: 's', level: 'info' } });
        }
        const r = await service.handle(req({ body: { subject: 's', body: 'b' } }));
        expect(r.status).toBe(429);
        expect(r.body.error).toMatch(/uncollected/);
        await inbox.receive({ participant: clerk.id });
        expect((await service.handle(req({ body: { subject: 's', body: 'b' } }))).status).toBe(201);
    });

    it('a repeated dedupeKey answers the first message and stores nothing', async () => {
        const a = await service.handle(req({ body: { subject: 's', body: 'b', dedupeKey: 'council:42' } }));
        const b = await service.handle(req({ body: { subject: 's', body: 'b', dedupeKey: 'council:42' } }));
        expect(b.status).toBe(200);
        expect(b.body).toMatchObject({ messageId: a.body.messageId, deduplicated: true });
        expect(inbox.all()).toHaveLength(1);
        now += APP_LIMITS.dedupeMs + 1;
        expect((await service.handle(req({ body: { subject: 's', body: 'b', dedupeKey: 'council:42' } }))).status).toBe(201);
    });

    it('bad JSON and oversized requests are refused before anything is stored', async () => {
        expect((await service.handle(req({ body: '{nope' }))).status).toBe(400);
        expect((await service.handle(req({ body: 'x'.repeat(APP_LIMITS.requestBytes + 1) }))).status).toBe(413);
        expect(inbox.all()).toHaveLength(0);
    });

    it('a script key sends as the script and records its use', async () => {
        const made = await keys.createScriptKey('fancy', 'nightly');
        const r = await service.handle(req({ auth: made.token, body: { subject: 'nightly check red', body: '3 failures', level: 'failure' } }));
        expect(r.status).toBe(201);
        expect(inbox.unread(clerk.id)[0]).toMatchObject({ from: `app:script:${made.id}`, app: { label: 'script:nightly@fancy', level: 'failure' } });
        expect(keys.scriptKeys('fancy')[0]!.lastUsedAt).not.toBeNull();
    });
});

describe('receipts and agents', () => {
    it('the sender reads its own receipt — unread, then read — and gets 404 for another source’s message', async () => {
        const sent = await service.handle(req({ body: { subject: 's', body: 'b' } }));
        const id = sent.body.messageId as string;
        const before = await service.handle(req({ method: 'GET', path: `/v1/inbox/${id}`, body: '' }));
        expect(before).toMatchObject({ status: 200, body: { ok: true, messageId: id, to: 'clerk@fancy', readAt: null } });
        await inbox.receive({ participant: clerk.id });
        const after = await service.handle(req({ method: 'GET', path: `/v1/inbox/${id}`, body: '' }));
        expect(after.body.readAt).not.toBeNull();
        const otherToken = keys.tokenFor({ kind: 'process', id: 'proc_1', name: 'queue', workspaceId: 'fancy' })!;
        expect((await service.handle(req({ method: 'GET', path: `/v1/inbox/${id}`, auth: otherToken, body: '' }))).status).toBe(404);
    });

    it('lists the addresses it may write to: its own workspace, no OS agent, nothing else', async () => {
        const r = await service.handle(req({ method: 'GET', path: '/v1/agents', body: '' }));
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true, agents: [{ address: 'clerk@fancy', name: 'clerk', default: true }, { address: 'scribe@fancy', name: 'scribe', default: false }] });
    });
});

describe('the real listener', () => {
    it('binds 127.0.0.1 only, and a real POST lands as the site’s message', async () => {
        const server = await startAppInboxServer({ service, port: 0 });
        try {
            expect(server.address).toBe('127.0.0.1');
            expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
            const res = await fetch(`${server.url}/v1/inbox`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'over the wire', body: 'real http' }) });
            expect(res.status).toBe(201);
            expect(inbox.unread(clerk.id)[0]).toMatchObject({ from: 'app:site:site_flabs', text: 'real http' });
            // An unknown credential over the wire: 404.
            const bad = await fetch(`${server.url}/v1/inbox`, { method: 'POST', headers: { authorization: 'Bearer gik_nope', 'content-type': 'application/json' }, body: '{}' });
            expect(bad.status).toBe(404);
            // A body past the cap is cut off by the listener itself.
            const big = await new Promise<number>((resolve) => {
                const r = request(`${server.url}/v1/inbox`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res2) => { res2.resume(); resolve(res2.statusCode ?? 0); });
                r.on('error', () => resolve(413));
                r.end('x'.repeat(APP_LIMITS.requestBytes * 4));
            });
            expect(big).toBe(413);
        } finally {
            await server.close();
        }
    });
});

it('the note an agent reads says what it is', () => {
    expect(appMailNote('site:flabs@fancy')).toMatch(/not a person or an agent/);
});
