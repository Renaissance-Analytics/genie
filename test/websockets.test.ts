import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDotEnv } from '../src/core/dotenv.js';
import { mintAgentId } from '../src/core/identity.js';
import { deleteDataVerdict, soleHolderOf } from '../src/core/service-tenancy.js';
import { DotEnvSync } from '../src/main/dotenv-sync.js';
import type { HostingServices } from '../src/main/hosting-actions.js';
import { hostingTools } from '../src/main/mcp-tools-hosting.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';
import { ServiceRegistry, type ConfigFiles } from '../src/main/service-registry.js';

/**
 * WEBSOCKETS PER WORKSPACE (hosting ship line H8) — Genie 1's model: ONE Sockudo server for the machine, and an APP
 * (id, key, secret) per workspace that uses it, in the server's app list (repos/genie main/dev-server/services/
 * catalog.ts `WEBSOCKETS`, host-websocket.ts, env-wiring.ts `case 'websockets'`, host-core/hosting.ts
 * `browserWebSocketEnv`). Here the server is a container reading a config file Genie writes.
 *
 * Docker is a fake that RECORDS every argv, and the config file is an in-memory port, so what Genie asked of Docker
 * and what it told the server are both counted. What Sockudo does with them — a Laravel app broadcasting with one
 * workspace's keys, refused with another's — is proven against the real image in genie-test-ubuntu.
 *
 * Nothing here imports the new module: on a Genie without the engine every test fails at `add` — "websockets is not
 * an engine Genie manages" — rather than at an import.
 */

function fakeDocker() {
    const calls: (readonly string[])[] = [];
    const containers = new Map<string, 'created' | 'running' | 'exited'>();
    const run: DockerRunner = async (args) => {
        calls.push(args);
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return { stdout: '[{}]', exitCode: 0 };
        if (cmd === 'container' && sub === 'inspect') {
            const st = containers.get(args[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'create') { containers.set(args[2]!, 'created'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'stop') { containers.set(args[1]!, 'exited'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'rm') { containers.delete(args[2]!); return { stdout: '', exitCode: 0 }; }
        return { stdout: '', exitCode: 0 };
    };
    const count = (verb: string) => calls.filter((c) => c[0] === verb).length;
    return { run, calls, containers, count };
}

function memFiles() {
    const files = new Map<string, string>();
    const port: ConfigFiles = {
        readText: async (p) => files.get(p) ?? null,
        writeText: async (p, t) => { files.set(p, t); },
        remove: async (p) => { files.delete(p); },
    };
    return { files, port };
}

const A = 'example-a';
const B = 'example-b';
const SHARED = { kind: 'shared' } as const;
const ENGINE = 'genie-shared-websockets-4.7.0';

/** Genie 1's names, written out here rather than imported: this list IS the contract a hosted Laravel app reads. */
const EXPECTED_KEYS = [
    'BROADCAST_CONNECTION',
    'GENIE_WS_APP_ID', 'GENIE_WS_APP_KEY', 'GENIE_WS_APP_SECRET', 'GENIE_WS_HOST', 'GENIE_WS_PORT', 'GENIE_WS_SCHEME',
    'REVERB_APP_ID', 'REVERB_APP_KEY', 'REVERB_APP_SECRET', 'REVERB_HOST', 'REVERB_PORT', 'REVERB_SCHEME',
    'VITE_GENIE_WS_APP_KEY', 'VITE_GENIE_WS_HOST', 'VITE_GENIE_WS_PORT', 'VITE_GENIE_WS_SCHEME',
    'VITE_REVERB_APP_KEY', 'VITE_REVERB_HOST', 'VITE_REVERB_PORT', 'VITE_REVERB_SCHEME',
].sort();

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let mem: ReturnType<typeof memFiles>;
let registry: ServiceRegistry;
let port: number;
let pw: number;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-websockets-'));
    port = 4100;
    pw = 0;
    docker = fakeDocker();
    mem = memFiles();
    registry = await ServiceRegistry.open(dir, new ServiceDriver(docker.run), {
        allocatePort: () => ++port,
        // Distinct, generated-alphabet secrets, so "whose secret is this" is answerable.
        randomPassword: () => `genpw-${String(++pw).padStart(4, '0')}`,
        files: mem.port,
    });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const configPath = () => join(dir, 'runtime', 'engine-config', `${ENGINE}.toml`);
const config = () => mem.files.get(configPath()) ?? '';
const appCount = (text: string) => text.split('[[app_manager.array.apps]]').length - 1;
const ws = () => registry.list().find((i) => i.engine === 'websockets')!;
const both = async () => {
    await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true, workspaceId: A });
    await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true, workspaceId: B });
};

describe('two workspaces get different apps on ONE engine', () => {
    it('one container (Sockudo 4.7.0, its config mounted read-only, no data volume) and two apps — counted', async () => {
        await both();
        expect(docker.count('create')).toBe(1);
        expect(registry.list()).toHaveLength(1);
        const create = docker.calls.find((c) => c[0] === 'create')!;
        expect(create.slice(-4)).toEqual(['sockudo/sockudo:4.7.0', 'sockudo', '--config', '/app/config/genie.toml']);
        expect(create.filter((a) => a.startsWith('type=bind,'))).toEqual([`type=bind,source=${configPath()},target=/app/config/genie.toml,readonly`]);
        expect(create).not.toContain('-v');
        expect(create).toContain('127.0.0.1:4101:6001');

        const slices = ws().slices!;
        expect(Object.entries(slices).map(([w, s]) => [w, s.identifier])).toEqual([[A, 'ws_example_a'], [B, 'ws_example_b']]);
        expect(slices[A]!.password).not.toBe(slices[B]!.password);
        // The server is told both apps, each with its own secret.
        expect(appCount(config())).toBe(2);
        for (const s of Object.values(slices)) expect(config()).toContain(`id = "${s.identifier}"\nkey = "${s.identifier}"\nsecret = "${s.password}"`);
    });

    it('each workspace’s env names ITS app and never the other’s secret — B’s own env is the control', async () => {
        await both();
        const slices = ws().slices!;
        const envA = registry.envFor(A);
        const envB = registry.envFor(B);
        expect(envA.REVERB_APP_ID).toBe('ws_example_a');
        expect(envB.REVERB_APP_ID).toBe('ws_example_b');
        expect(JSON.stringify(envA)).not.toContain(slices[B]!.password);
        expect(JSON.stringify(envB)).toContain(slices[B]!.password);
        // A workspace that never used it gets nothing from it.
        expect(registry.envFor('example-c')).toEqual({});
    });

    it('adding the second app restarts the RUNNING engine once, so it serves the new list; asking again changes nothing', async () => {
        await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true, workspaceId: A });
        expect([docker.count('start'), docker.count('stop')]).toEqual([1, 0]);
        await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true, workspaceId: B });
        expect([docker.count('start'), docker.count('stop')]).toEqual([2, 1]);
        const before = config();
        const again = await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true, workspaceId: B });
        expect(again.kind).toBe('exists');
        expect([docker.count('start'), docker.count('stop')]).toEqual([2, 1]);
        expect(config()).toBe(before);
    });

    it('a dedicated WebSockets engine is refused — one per workstation', async () => {
        await expect(registry.add({ engine: 'websockets', major: '4.7.0', scope: { kind: 'dedicated', workspaceId: A }, consent: true })).rejects.toThrow(/shared/);
        expect(docker.count('create')).toBe(0);
    });
});

describe('the env a workspace gets — Genie 1’s keys, exactly', () => {
    it('21 keys, host form: backend and browser both at the one secure address, websockets.gen:443 (websockets-front-door.test.ts); the secret under the two SECRET names only', async () => {
        await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true, workspaceId: A });
        const env = registry.envFor(A);
        const secret = ws().slices![A]!.password;
        expect(Object.keys(env).sort()).toEqual(EXPECTED_KEYS);
        expect(Object.keys(env)).toHaveLength(21);
        expect(env).toMatchObject({
            BROADCAST_CONNECTION: 'reverb',
            REVERB_APP_ID: 'ws_example_a', REVERB_APP_KEY: 'ws_example_a', REVERB_APP_SECRET: secret,
            // ONE secure address for the server side too (websockets-front-door.test.ts): nothing plain, not even on loopback.
            REVERB_HOST: 'websockets.gen', REVERB_PORT: '443', REVERB_SCHEME: 'https',
            GENIE_WS_APP_ID: 'ws_example_a', GENIE_WS_APP_KEY: 'ws_example_a', GENIE_WS_APP_SECRET: secret,
            // The browser cannot use loopback from an https page (pusher-js forces TLS there): it gets Genie 1's front-door name.
            VITE_REVERB_APP_KEY: 'ws_example_a', VITE_REVERB_HOST: 'websockets.gen', VITE_REVERB_PORT: '443', VITE_REVERB_SCHEME: 'https',
        });
        // A VITE_ value is shipped to every browser: the secret is never one — counted, against the two that DO carry it.
        expect(Object.entries(env).filter(([, v]) => v === secret).map(([k]) => k).sort()).toEqual(['GENIE_WS_APP_SECRET', 'REVERB_APP_SECRET']);
    });

    it('the site repo’s .env gets all 21, written exactly (counted), beside the person’s own lines', async () => {
        await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true, workspaceId: A });
        const disk = new Map<string, string>([[join('/repo/a', '.env'), 'APP_NAME=Example\n']]);
        const sync = new DotEnvSync({
            envFor: (w) => registry.envFor(w),
            sites: () => [{ workspaceId: A, repoPath: '/repo/a' }],
            fs: { readText: async (p) => disk.get(p) ?? null, writeTextAtomic: async (p, t) => { disk.set(p, t); } },
            gitIgnored: async () => 'ignored',
        });
        const [outcome] = await sync.syncAll();
        expect(outcome).toMatchObject({ outcome: 'written' });
        expect([...(outcome as { keys: readonly string[] }).keys].sort()).toEqual(EXPECTED_KEYS);
        const file = parseDotEnv(disk.get(join('/repo/a', '.env'))!);
        expect([...file.keys()].filter((k) => k !== 'APP_NAME').sort()).toEqual(EXPECTED_KEYS);
        expect(file.get('APP_NAME')).toBe('Example');
        expect(file.get('REVERB_APP_SECRET')).toBe(ws().slices![A]!.password);
    });
});

describe('removing a workspace’s slice removes ITS app, and only its app', () => {
    it('A’s app leaves the config and A’s env; B’s app, env and the engine stay — counted', async () => {
        await both();
        const { [A]: a, [B]: b } = ws().slices!;
        const envB = registry.envFor(B);
        const stopsBefore = docker.count('stop');
        await registry.releaseSlice(ws().id, A);

        expect(Object.keys(ws().slices!)).toEqual([B]);
        expect(appCount(config())).toBe(1);
        expect(config()).not.toContain(a!.password);
        expect(config()).toContain(b!.password);
        expect(registry.envFor(A)).toEqual({});
        expect(registry.envFor(B)).toEqual(envB);
        // The engine is still registered and running, restarted once on the new list; nothing was removed.
        expect(registry.list()).toHaveLength(1);
        expect(docker.containers.get(ENGINE)).toBe('running');
        expect(docker.count('stop') - stopsBefore).toBe(1);
        expect(docker.count('rm')).toBe(0);
    });

    it('the secret is REVOKED: using the engine again mints a new one', async () => {
        await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true, workspaceId: A });
        const first = ws().slices![A]!.password;
        await registry.releaseSlice(ws().id, A);
        await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true, workspaceId: A });
        const second = ws().slices![A]!.password;
        expect(second).not.toBe(first);
        expect(config()).toContain(second);
        expect(config()).not.toContain(first);
    });

    it('a database slice is NEVER dropped this way — it holds the workspace’s data; the WebSocket app beside it is (the control)', async () => {
        await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: A });
        await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true, workspaceId: A });
        const pg = registry.list().find((i) => i.engine === 'postgres')!;
        await expect(registry.releaseSlice(pg.id, A)).rejects.toThrow('postgres 17: a workspace\'s slice holds its data, and Genie does not drop it; nothing was done');
        expect(Object.keys(registry.list().find((i) => i.engine === 'postgres')!.slices!)).toEqual([A]);
        await registry.releaseSlice(ws().id, A);
        expect(ws().slices).toEqual({});
    });

    it('removing the ENGINE takes the apps’ secrets off the disk with it — the file was there first (the control)', async () => {
        await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true, workspaceId: A });
        expect(mem.files.has(configPath())).toBe(true);
        await registry.remove(ws().id, { deleteData: false });
        expect(mem.files.has(configPath())).toBe(false);
    });
});

describe('delete data and tenancy: an app is not data (H6 × H8)', () => {
    it('the engine has NO volume: "delete data" with another workspace’s app on it deletes nothing and is not refused — no `volume rm`, counted; a Postgres holding B’s data still refuses (the control)', async () => {
        await both();
        await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: A });
        await registry.add({ engine: 'postgres', major: '17', scope: SHARED, consent: true, workspaceId: B });
        const pg = registry.list().find((i) => i.engine === 'postgres')!;
        // The same guard, on an engine that DOES hold B's data: refused, naming it, nothing removed.
        await expect(registry.remove(pg.id, { deleteData: true, workspaceId: A })).rejects.toThrow('ws_example_b (workspace example-b)');
        expect(docker.count('rm')).toBe(0);

        // B's app is on the WebSocket engine too — and it is not data, so it does not block.
        expect(Object.keys(ws().slices!)).toEqual([A, B]);
        expect(deleteDataVerdict(ws(), A)).toEqual({ allowed: true, volume: null, deletes: 'nothing: websockets 4.7.0 is stateless (its apps are a config file, not data) and keeps no data volume' });
        expect(soleHolderOf(ws())).toBeUndefined();
        await registry.remove(ws().id, { deleteData: true, workspaceId: A });
        expect(docker.count('rm')).toBe(1);
        expect(docker.count('volume')).toBe(0);
        expect(mem.files.has(configPath())).toBe(false);
        expect(registry.list().map((i) => i.engine)).toEqual(['postgres']);
    });

    it('an engine no workspace has an app on yet is not "unknown, so in use" — a shared Mailpit with no records still is (the control)', async () => {
        await registry.add({ engine: 'websockets', major: '4.7.0', scope: SHARED, consent: true });
        await registry.add({ engine: 'mailpit', major: '1.30', scope: SHARED, consent: true });
        expect(ws().slices).toEqual({});
        expect(deleteDataVerdict(ws(), A)).toMatchObject({ allowed: true, volume: null });
        const mail = registry.list().find((i) => i.engine === 'mailpit')!;
        expect(deleteDataVerdict(mail, A)).toMatchObject({ allowed: false });
        expect((deleteDataVerdict(mail, A) as { reason: string }).reason).toMatch(/cannot tell whose data its volume genie-shared-mailpit-1\.30-data holds/);
    });
});

describe('a secret never reaches Docker’s argv, the MCP answer or the listing', () => {
    const caller: Caller = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: A, workspacePath: '/repo/a' };
    const tools = () => hostingTools({
        resolveCaller: (id) => (id === 't-a' ? caller : null),
        approve: async () => 'allowed',
        services: {
            engines: registry,
            engineStatuses: async () => registry.list().map((instance) => ({ instance, status: 'running' as const })),
        } as unknown as HostingServices,
    });
    const call = async (args: JsonObject) => {
        const reg = tools().find((t) => t.definition.name === 'services')!;
        const r = await reg.handler({ ...args, terminalId: 't-a' }, { server: 'genie', tool: 'services', headers: {} });
        return { ...r, json: JSON.parse(r.text) as Record<string, any> };
    };

    it('`env`: the SECRET names are there (the control) with their values masked; the secret itself is not in the answer', async () => {
        await both();
        const secret = ws().slices![A]!.password;
        // There IS a secret to leak: the process env carries it.
        expect(registry.envFor(A).REVERB_APP_SECRET).toBe(secret);
        const r = await call({ action: 'env' });
        expect(r.isError).toBe(false);
        expect(Object.keys(r.json.variables)).toContain('REVERB_APP_SECRET');
        expect(r.json.variables.REVERB_APP_SECRET).toBe('********');
        expect(r.json.variables.GENIE_WS_APP_SECRET).toBe('********');
        expect(r.json.variables.REVERB_APP_KEY).toBe('ws_example_a');
        expect([...r.json.masked].sort()).toEqual(['GENIE_WS_APP_SECRET', 'REVERB_APP_SECRET']);
        expect(r.text).not.toContain(secret);
        expect(r.text).not.toContain(ws().slices![B]!.password);
    });

    it('`list`: the workspace’s app id and public key are named (the control); no secret of any workspace is', async () => {
        await both();
        const r = await call({ action: 'list' });
        expect(r.isError).toBe(false);
        expect(r.json.services).toHaveLength(1);
        expect(r.json.services[0]).toMatchObject({ engine: 'websockets', scope: 'shared', app: { id: 'ws_example_a', key: 'ws_example_a' } });
        for (const s of Object.values(ws().slices!)) expect(r.text).not.toContain(s.password);
        expect(r.text).not.toContain('ws_example_b');
    });

    it('`remove` on the shared engine drops only THIS workspace’s app, and says so', async () => {
        await both();
        const r = await call({ action: 'remove', id: ws().id });
        expect(r.isError).toBe(false);
        expect(r.json).toEqual({ ok: true, removed: ws().id, appRemoved: true });
        expect(Object.keys(ws().slices!)).toEqual([B]);
        expect(docker.count('rm')).toBe(0);
    });

    it('Docker is never handed a secret: it travels in the mounted file — which DOES hold it (the control)', async () => {
        await both();
        const secrets = Object.values(ws().slices!).map((s) => s.password);
        expect(secrets).toHaveLength(2);
        const argv = docker.calls.map((c) => c.join(' ')).join('\n');
        for (const s of secrets) {
            expect(config()).toContain(s);
            expect(argv).not.toContain(s);
        }
    });
});
