import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppInboxHost } from '../src/main/app-inbox-host.js';
import { AppInboxKeys } from '../src/main/app-inbox-keys.js';
import { openAgentStores } from '../src/main/agent-stores-open.js';
import { hostingRig, tick, type HostingRig } from './helpers/hosting-rig.js';

/**
 * P5a.2, ruling 3: THE APP DOOR IS GENIE-HOST'S. The host runs the door and its keys (one writer of app-inbox.json), and
 * mints every site's and kept process's credential itself — a site started with no window open gets one, and the host's
 * door accepts it. A window drives the keys through a replica. The conditions:
 *  1. the door binds loopback only;
 *  2. a token's secret appears ONCE — in the answer to the window that created it — never in a dump, an event, a log
 *     line, or anything another window or a non-local link receives;
 *  3. migration: a key a window-era Genie made is accepted by the host's door; a revoked one stays refused.
 */

const doors: AppInboxHost[] = [];
const rigs: HostingRig[] = [];
afterEach(async () => {
    for (const d of doors.splice(0)) await d.close();
    for (const r of rigs.splice(0)) await r.close();
});

const agents = (url: string | null, token: string) => {
    if (url === null) throw new Error('the host’s door is not listening');
    return fetch(`${url}/v1/agents`, { headers: { authorization: `Bearer ${token}` } });
};

async function door(home: string, logs: string[] = []): Promise<AppInboxHost> {
    const stores = await openAgentStores(home, () => new Date().toISOString());
    const d = await AppInboxHost.start({
        home,
        inbox: stores.inbox,
        roster: () => [],
        enabled: () => true,
        siteHosts: () => [],
        workspaces: () => ['ws'],
        port: 0,
        log: (line) => logs.push(line),
    });
    doors.push(d);
    return d;
}

async function hostWithDoor(home = mkdtempSync(join(tmpdir(), 'app-door-host-'))) {
    const logs: string[] = [];
    const d = await door(home, logs);
    const r = await hostingRig({ home, appEnv: (source) => d.envFor(source), server: { appInbox: d } });
    rigs.push(r);
    return { door: d, rig: r, logs };
}

describe('the app door in genie-host', () => {
    it('binds loopback only', async () => {
        const { door: d } = await hostWithDoor();
        expect(d.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it('a site started in the host with NO window gets its credential, and the host’s door accepts it', async () => {
        const { door: d, rig: r } = await hostWithDoor();
        await r.stack.envelopeSites.create({ name: 'shop', workspaceId: 'ws', repoPath: r.ws, serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'node shop.mjs {port}' } });
        await tick();
        const started = r.opened.find((o) => /node shop\.mjs/.test(o.command ?? ''));
        expect(started).toBeDefined();
        expect(started?.env?.GENIE_INBOX_URL).toBe(d.url);
        const token = started?.env?.GENIE_INBOX_TOKEN ?? '';
        expect(token).toMatch(/^gik_/);
        expect((await agents(d.url, token)).status).toBe(200);
        // CONTROL: a token the door never issued is refused.
        expect((await agents(d.url, 'gik_not-a-real-token')).status).toBe(404);
    });

    it('a script key’s secret appears ONCE: in the answer to the window that made it — not in any dump, event or log', async () => {
        const { door: d, rig: r, logs } = await hostWithDoor();
        const a = await r.window();
        const b = await r.window();
        const c = await r.window({ local: false });
        const made = await a.client.appInbox().createScriptKey('ws', 'deploy');
        expect(made.token).toMatch(/^gik_/);
        await tick();
        // Used once at the door, so a log line and a "last used" change are made too.
        expect((await agents(d.url, made.token)).status).toBe(200);
        await tick();
        // Both windows SEE the key (its name, its id) — the second only by the dump and events.
        expect(b.client.appInbox().scriptKeys('ws').map((k) => k.name)).toEqual(['deploy']);
        expect(a.frames.filter((f) => f.includes(made.token))).toHaveLength(1);
        expect(b.frames.some((f) => f.includes(made.token))).toBe(false);
        expect(c.frames.some((f) => f.includes(made.token))).toBe(false);
        expect(logs.some((l) => l.includes(made.token))).toBe(false);
        // A non-local link gets no app-door state and cannot drive the keys.
        expect(c.client.appInbox().scriptKeys('ws')).toEqual([]);
        const refused = await c.client.call('engine.appInbox', ['scriptKeys', ['ws']]);
        expect(refused).toMatchObject({ ok: false });
    });

    it('migration: a key a window-era Genie made is accepted by the host’s door; a revoked key and a revoked site stay refused', async () => {
        const home = mkdtempSync(join(tmpdir(), 'app-door-migrate-'));
        const old = await AppInboxKeys.open(home);
        const kept = await old.createScriptKey('ws', 'deploy');
        const gone = await old.createScriptKey('ws', 'retired');
        await old.revokeScriptKey(gone.id);
        await old.revokeSource({ kind: 'site', id: 'site_shop', workspaceId: 'ws', name: 'shop' });
        const d = await door(home);
        expect((await agents(d.url, kept.token)).status).toBe(200);
        expect((await agents(d.url, gone.token)).status).toBe(404);
        expect(d.envFor({ kind: 'site', id: 'site_shop', name: 'shop', workspaceId: 'ws' })).toEqual({});
        // CONTROL: a site that was never revoked gets one.
        expect(d.envFor({ kind: 'site', id: 'site_docs', name: 'docs', workspaceId: 'ws' }).GENIE_INBOX_TOKEN).toMatch(/^gik_/);
    });
});
