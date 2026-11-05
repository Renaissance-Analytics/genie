import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessTree } from '../src/core/process-tree.js';
import { memoryPair } from '../src/core/line-transport.js';
import { ELEVATION_WAITING_DECK_ID } from '../src/core/elevation-waiting.js';
import type { PrivilegedStep } from '../src/main/elevate.js';
import { composeHosting, type HostingStack } from '../src/main/hosting-compose.js';
import { HostingService, WindowElevation } from '../src/main/hosting-host.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import type { PtyOpened, PtyPort } from '../src/main/terminal-host.js';

/**
 * GENIE'S HOSTING IS GENIE-HOST'S (the host split, P5a): the front door, the service engines and the site routes are built
 * in the host (hosting-compose.ts) and served by `HostingService`; a window reads them through `HostingReplica` —
 * synchronously, from the dump it is sent before `engine.ready` and the events after — and every write it makes is the
 * host's to do. The contract:
 *  1. the replica answers the same reads as the host's own stack (the front door's port and CA included, at connect);
 *  2. a write through the replica lands in the host's stack, and the replica reads it back;
 *  3. an elevation the host needs with NO window connected is NOT attempted: it is queued, answered "waiting for a
 *     window", and surfaced to the next window that connects — whose elevation handler is not called by the connect.
 */

const TOKEN = 'hosting-token';
const CADDY = '/opt/genie/runtime/caddy';
const tick = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 2)); };

function fakePty(): PtyPort {
    let n = 0;
    return {
        open(o) { n += 1; return { id: `term_${n}`, pid: 4000 + n, shell: o.command ?? '', scrollback: '' } satisfies PtyOpened; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {}, onExit: () => () => {},
    };
}

const dirs: string[] = [];
const stacks: HostingStack[] = [];
afterEach(async () => {
    for (const s of stacks.splice(0)) await s.shutdown();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function rig() {
    const home = mkdtempSync(join(tmpdir(), 'hosting-contract-'));
    const ws = mkdtempSync(join(tmpdir(), 'hosting-contract-ws-'));
    dirs.push(home, ws);
    writeFileSync(join(ws, 'project.json'), `${JSON.stringify({ name: 'shop' }, null, 2)}\n`);
    const supervisor = new ProcessSupervisor(fakePty(), { now: () => 1_000, schedule: () => () => {} });
    let server: SessionEngineServer | null = null;
    const elevation = new WindowElevation({ connected: () => server?.windowConnected() ?? false, ask: (steps) => server!.elevate(steps), now: () => 7 });
    const stack = await composeHosting({
        userData: home,
        supervisor,
        settings: { onChange: () => () => {} },
        appEnv: () => ({}),
        caddyBin: CADDY,
        frontDoorPort: 0,
        docker: async () => ({ stdout: '', exitCode: 1 }),
        hostsIo: { read: async () => '', write: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, stage: async () => ({ command: 'cp', args: [] }) },
        elevate: (steps) => elevation.run(steps),
        hostsDebounceMs: 1,
        frontDoorPorts: { probe: async () => 'free', holder: async () => null },
        trustStore: { has: async () => false },
        gitIgnored: async () => true,
        workspaces: () => [{ id: 'ws', path: ws }],
    });
    stacks.push(stack);
    const service = new HostingService(stack, { workspaces: () => ['ws'], elevation });
    server = new SessionEngineServer({ token: TOKEN, build: 't', hosting: service });
    const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
    server.attach(new SessionHost({ userData: home, driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() }));
    const elevationsAsked: Array<readonly PrivilegedStep[]> = [];
    const window = async () => {
        const [h, w] = memoryPair();
        server!.accept(h);
        const client = new SessionEngineClient({ elevate: async (steps) => { elevationsAsked.push(steps); return { ok: true }; } });
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        return { replica: client.hosting(), close: () => w.close() };
    };
    return { stack, ws, window, elevationsAsked };
}

describe('Genie’s hosting in genie-host, read and driven from a window', () => {
    it('the replica answers the same reads as the host’s stack — the front door’s port and CA there at connect', async () => {
        const r = await rig();
        await tick();
        const w = await r.window();
        expect(w.replica.frontDoorPort).toBeGreaterThan(0);
        expect(w.replica.frontDoorPort).toBe(r.stack.frontDoorPort);
        const trust = r.stack.browserTrust();
        expect(trust.caPem).toContain('BEGIN CERTIFICATE');
        expect(w.replica.browserTrust()).toEqual(trust);
        expect(w.replica.routes()).toEqual(r.stack.routes());
        expect(w.replica.configuredHosts()).toEqual(r.stack.configuredHosts());
        expect(w.replica.externalFrontDoor).toEqual(r.stack.externalFrontDoor);
        expect(w.replica.sites.list()).toEqual(r.stack.sites.list());
        expect(w.replica.engines.list()).toEqual(r.stack.engines.list());
        expect(w.replica.engines.envFor('ws')).toEqual(r.stack.engines.envFor('ws'));
        expect(w.replica.engines.choices('ws')).toEqual(r.stack.engines.choices('ws'));
    });

    it('a write through the replica lands in the host’s stack, and the replica reads it back', async () => {
        const r = await rig();
        const w = await r.window();
        let changed = 0;
        w.replica.sites.onChange(() => { changed += 1; });
        const site = await w.replica.envelopeSites.create({ name: 'docs', workspaceId: 'ws', repoPath: r.ws, serve: { mode: 'proxy' }, hostPort: 5173 });
        expect(r.stack.sites.get(site.id)).not.toBeNull();
        await tick();
        expect(changed).toBeGreaterThan(0);
        expect(w.replica.sites.get(site.id)).toEqual(r.stack.sites.get(site.id));
        expect(w.replica.sites.list()).toEqual(r.stack.sites.list());
        expect(w.replica.envelopeSites.declaredIn(site.id)).toEqual(r.stack.envelopeSites.declaredIn(site.id));
        expect(w.replica.configuredHosts()).toContain('docs.gen');
        expect(w.replica.configuredHosts()).toEqual(r.stack.configuredHosts());
    });

    it('with NO window, an elevation is not attempted: queued, answered “waiting for a window”, surfaced to the next window', async () => {
        const r = await rig();
        // No window has connected: a site is added in the host (as an agent's tool or a declared site would), so the hosts
        // block is due — and writing it needs the OS prompt.
        await r.stack.envelopeSites.create({ name: 'shop', workspaceId: 'ws', repoPath: r.ws, serve: { mode: 'proxy' }, hostPort: 5174 });
        await tick();
        await r.stack.frontDoorSettled();
        expect(r.elevationsAsked).toEqual([]);
        const hosts = r.stack.externalFrontDoor.running ? r.stack.externalFrontDoor.hosts : null;
        expect(hosts && 'error' in hosts ? hosts.error : '').toMatch(/waiting for a window/);
        // The next window to connect is TOLD (a Deck item), and connecting is not an approval: nothing is elevated by it.
        const w = await r.window();
        await tick();
        expect(r.elevationsAsked).toEqual([]);
        expect(w.replica.trustDeckItems().map((i) => i.id)).toContain(ELEVATION_WAITING_DECK_ID);
    });

    it('CONTROL: with a window connected, the same elevation is asked of that window, and nothing waits', async () => {
        const r = await rig();
        const w = await r.window();
        await r.stack.envelopeSites.create({ name: 'shop', workspaceId: 'ws', repoPath: r.ws, serve: { mode: 'proxy' }, hostPort: 5174 });
        await tick();
        await r.stack.frontDoorSettled();
        await tick();
        expect(r.elevationsAsked.length).toBe(1);
        expect(w.replica.trustDeckItems().map((i) => i.id)).not.toContain(ELEVATION_WAITING_DECK_ID);
    });
});
