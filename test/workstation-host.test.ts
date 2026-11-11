import { createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { migrateSecrets, type HostVault, type MigrationBook, type MigrationState } from '../src/main/keychain-migration.js';
import { buildTicketHostHello, hostHelloSigningString } from '../src/main/relay-wire.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { ensureWorkstation, generateHostKeypair, workstationKeyStore, workstationSealedSources } from '../src/main/workstation-identity.js';
import { WorkstationService } from '../src/main/workstation-service.js';
import { fakeKeychain } from './helpers/tynn-storage.js';

/**
 * THIS MACHINE'S PRIVATE KEY IS THE HOST'S (P3.4; plan §13). It is in the keychain as `workstation/<tynn host>`, and the file says which workstation this is. The relay lives in the
 * window until P5, so a window asks the host to sign: no call returns the key.
 *
 * AND A KEY THAT CANNOT BE READ IS NOT A MACHINE WITH NO IDENTITY. "Not registered" makes Genie enroll a new workstation, so a locked keychain, or a seal that has not moved yet,
 * must never read that way: the machine would lose the identity it has with Tynn.
 */

const HOST = 'https://tynn.test';
const ENTRY = `workstation/${HOST}`;
const TOKEN = 'a'.repeat(64);
let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ws-host-')); file = join(dir, 'workstation.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

type Lockable = ReturnType<typeof fakeKeychain> & { locked: boolean };
function keychain(seed: Record<string, string> = {}): Lockable {
    const base = fakeKeychain(seed);
    const k: Lockable = {
        ...base, locked: false,
        probe: async () => (k.locked ? { ok: false as const, reason: 'locked' } : { ok: true as const }) as never,
        get: async (name: string) => (k.locked ? { kind: 'unavailable' as const, reason: 'locked' } : base.get(name)) as never,
        set: async (name: string, value: string) => (k.locked ? { ok: false as const, reason: 'locked' } : base.set(name, value)) as never,
    };
    return k;
}
const rows = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;

/** Tynn's workstation endpoints, counting what would enroll a new one. */
function tynnFake(me: string | null = null) {
    const t = {
        registers: 0, enrolls: 0,
        request: (async (path: string, init: { method: string; body?: unknown }) => {
            const answer = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
            if (path === '/api/v1/workstations/me') return answer(200, { workstation: me ? { id: me } : null });
            if (path === '/api/v1/workstations/self-register') { t.registers += 1; return answer(201, { workstation: { id: 'ws_new' }, enrollment: { workstation_id: 'ws_new', secret: 's3cret' } }); }
            if (path.endsWith('/enroll')) { t.enrolls += 1; return answer(200, { enrolled: true }); }
            void init;
            return answer(404, {});
        }) as never,
    };
    return t;
}
const ports = (store: ReturnType<typeof workstationKeyStore>, tynn: ReturnType<typeof tynnFake>) => ({ host: () => HOST, hostname: () => 'box', request: tynn.request, store });

describe('the key is in the keychain', () => {
    it('round-trips per Tynn host, and the file holds which workstation and no key, sealed or not', async () => {
        const k = keychain();
        const pair = generateHostKeypair();
        const store = workstationKeyStore(file, k);
        await store.write(HOST, { workstationId: 'ws_1', privateKeyPem: pair.privateKeyPem });
        expect(k.held.get(ENTRY)).toBe(pair.privateKeyPem);
        expect(await store.read(HOST)).toEqual({ workstationId: 'ws_1', privateKeyPem: pair.privateKeyPem });
        expect(await store.read('https://other.example')).toBeNull();
        expect(rows()[HOST]).toEqual({ workstationId: 'ws_1' });
        expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE KEY');
    });

    it('no keychain: canWrite says so, and a write refuses', async () => {
        const k = keychain();
        k.locked = true;
        const store = workstationKeyStore(file, k);
        expect(await store.canWrite()).toBe(false);
        await expect(store.write(HOST, { workstationId: 'ws_1', privateKeyPem: generateHostKeypair().privateKeyPem })).rejects.toThrow(/keyring|keychain/i);
    });

    it('what else a row says is kept: the Genie 1 record stays settled', async () => {
        const store = workstationKeyStore(file, keychain());
        await store.markLegacyDone?.(HOST, 'ws_old');
        await store.write(HOST, { workstationId: 'ws_1', privateKeyPem: generateHostKeypair().privateKeyPem });
        expect(await store.legacyDone?.(HOST)).toBe('ws_old');
    });
});

describe('A KEY THAT CANNOT BE READ IS NOT A MACHINE WITH NO IDENTITY', () => {
    it('a locked keychain REFUSES to read, and Tynn is not asked to enroll anything', async () => {
        const pair = generateHostKeypair();
        const k = keychain({ [ENTRY]: pair.privateKeyPem });
        writeFileSync(file, JSON.stringify({ [HOST]: { workstationId: 'ws_1' } }));
        k.locked = true;
        const store = workstationKeyStore(file, k);
        await expect(store.read(HOST)).rejects.toThrow(/keyring|keychain/i);
        const tynn = tynnFake();
        await expect(ensureWorkstation(ports(store, tynn))).rejects.toThrow();
        expect([tynn.registers, tynn.enrolls]).toEqual([0, 0]);
        expect(rows()[HOST]).toEqual({ workstationId: 'ws_1' });
    });

    it('A SEAL THAT HAS NOT MOVED YET is the same: an upgrade must not enroll a second workstation', async () => {
        writeFileSync(file, JSON.stringify({ [HOST]: { workstationId: 'ws_1', keyEnc: 'c2VhbGVk' } }));
        const store = workstationKeyStore(file, keychain());
        await expect(store.read(HOST)).rejects.toThrow(/moved|not yet/i);
        const tynn = tynnFake();
        await expect(ensureWorkstation(ports(store, tynn))).rejects.toThrow();
        expect([tynn.registers, tynn.enrolls]).toEqual([0, 0]);
    });

    it('CONTROL: a key really gone, with nothing sealed, is not registered, and a new one is enrolled', async () => {
        writeFileSync(file, JSON.stringify({ [HOST]: { workstationId: 'ws_1' } }));
        const store = workstationKeyStore(file, keychain());
        expect(await store.read(HOST)).toBeNull();
        const tynn = tynnFake();
        expect(await ensureWorkstation(ports(store, tynn))).toMatchObject({ ok: true, status: 'enrolled', workstationId: 'ws_new' });
        expect(tynn.enrolls).toBe(1);
    });

    it('what is in the keychain and is not a key reads as not registered, as a damaged file did', async () => {
        writeFileSync(file, JSON.stringify({ [HOST]: { workstationId: 'ws_1' } }));
        expect(await workstationKeyStore(file, keychain({ [ENTRY]: 'not a key' })).read(HOST)).toBeNull();
    });
});

describe('a window asks the host to sign, and never holds the key', () => {
    async function linked(k = keychain(), tynn = tynnFake()) {
        const store = workstationKeyStore(file, k);
        const service = new WorkstationService({ store, request: tynn.request, host: () => HOST, hostname: () => 'box', machineKey: async () => null });
        const server = new SessionEngineServer({ token: TOKEN, build: 'test', workstation: service });
        const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const seen: string[] = [];
        windowSide.onMessage((line: string) => seen.push(line));
        const client = new SessionEngineClient();
        await client.connect(windowSide, TOKEN);
        return { client, replica: client.workstation(), seen, tynn, store };
    }
    async function enrolled() {
        const pair = generateHostKeypair();
        writeFileSync(file, JSON.stringify({ [HOST]: { workstationId: 'ws_1' } }));
        return { pair, k: keychain({ [ENTRY]: pair.privateKeyPem }) };
    }

    it('who it is: the id and the fingerprint, and no key', async () => {
        const { k } = await enrolled();
        const { replica } = await linked(k);
        const identity = await replica.identity(HOST);
        expect(identity).toMatchObject({ workstationId: 'ws_1', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(JSON.stringify(identity)).not.toContain('PRIVATE KEY');
    });

    it('not registered: null', async () => {
        const { replica } = await linked();
        expect(await replica.identity(HOST)).toBeNull();
    });

    it('a signature made in the host verifies against the enrolled key', async () => {
        const { k, pair } = await enrolled();
        const { replica } = await linked(k);
        const signature = await replica.sign(HOST, Buffer.from('hello'));
        expect(verify(null, Buffer.from('hello'), createPublicKey(pair.privateKeyPem), signature)).toBe(true);
    });

    it('the auth header is the Workstation form, made in the host', async () => {
        const { k } = await enrolled();
        const { replica } = await linked(k);
        expect(await replica.authHeader(HOST)).toMatch(/^Workstation \d+:/);
    });

    it('registering runs in the host, on its account, and answers the outcome', async () => {
        const tynn = tynnFake();
        const k = keychain();
        const { replica } = await linked(k, tynn);
        expect(await replica.ensure({ host: HOST })).toMatchObject({ ok: true, status: 'enrolled', workstationId: 'ws_new' });
        expect(tynn.enrolls).toBe(1);
        expect(k.held.get(ENTRY)).toContain('PRIVATE KEY');
    });

    it('Genie 1’s record is told to the host, and only until it is settled', async () => {
        const { replica, store } = await linked();
        expect(await replica.legacyDone(HOST)).toBeNull();
        await store.markLegacyDone?.(HOST, 'ws_old');
        expect(await replica.legacyDone(HOST)).toBe('ws_old');
    });

    it('NOTHING THE LINK CARRIES HOLDS THE KEY: and CONTROL, the gauge reads the wire', async () => {
        const { k } = await enrolled();
        const { replica, seen } = await linked(k);
        await replica.identity(HOST);
        await replica.sign(HOST, Buffer.from('hello'));
        await replica.authHeader(HOST);
        const wire = seen.join('\n');
        expect(wire).toContain('ws_1');
        expect(wire).not.toContain('PRIVATE KEY');
        expect(wire).not.toContain('privateKeyPem');
    });

    it.each(['read', 'privateKey', 'store', 'write'])('no method hands out the key: %s', async (method) => {
        const { k } = await enrolled();
        const { client } = await linked(k);
        const asked = await client.call('engine.workstation', [method, [HOST]]);
        expect(asked.ok).toBe(false);
        expect(JSON.stringify(asked)).not.toContain('PRIVATE KEY');
    });

    it('over the keychain link too: a window can hand a key over in the move, and cannot read one back', async () => {
        const { k } = await enrolled();
        const server = new SessionEngineServer({ token: TOKEN, build: 'test', keychain: k });
        const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        await client.connect(windowSide, TOKEN);
        expect(await client.call('engine.secretCompare', [ENTRY, 'nope'])).toMatchObject({ ok: true, value: 'different' });
        expect((await client.call('engine.secretRead', [ENTRY])).ok).toBe(false);
    });

    it('with no link it refuses, and never reads as not registered', async () => {
        const replica = new SessionEngineClient().workstation();
        await expect(replica.identity(HOST)).rejects.toThrow();
    });
});

describe('the relay signs through it', () => {
    it('a hello can wait for a signature that comes from another process', async () => {
        const pair = generateHostKeypair();
        const hello = await buildTicketHostHello({
            ticket: 't', workstationId: 'ws_1', fingerprint: 'fp',
            sign: async (data) => { const { sign } = await import('node:crypto'); return sign(null, data, pair.privateKeyPem); },
        });
        const signed = hostHelloSigningString({ workstationId: hello.workstationId, fingerprint: hello.fingerprint, nonce: hello.nonce, ts: hello.ts });
        expect(verify(null, Buffer.from(signed), createPublicKey(pair.privateKeyPem), Buffer.from(hello.sig, 'base64url'))).toBe(true);
    });
});

describe('what an older Genie sealed moves to the keychain', () => {
    const cipher = { decrypt: (bytes: Buffer) => { const text = bytes.toString(); if (!text.startsWith('sealed:')) throw new Error('another OS user'); return text.slice('sealed:'.length); } };
    const seal = (text: string) => Buffer.from(`sealed:${text}`).toString('base64');
    const memoryBook = (): MigrationBook => { const states: Record<string, MigrationState> = {}; return { read: async () => ({ ...states }), write: async (name, state) => { states[name] = state; } }; };
    const vaultOver = (k: Lockable): HostVault => ({ store: (name, value) => k.set(name, value) as never, compare: async (name, value) => (k.held.get(name) === value ? 'same' : 'different') });

    it('each host’s key moves; the row keeps its id and what is settled; and the store reads it with no enrolling', async () => {
        const pair = generateHostKeypair();
        writeFileSync(file, JSON.stringify({ [HOST]: { workstationId: 'ws_1', keyEnc: seal(pair.privateKeyPem), legacyDone: 'ws_old' } }));
        const k = keychain();
        const moved = await migrateSecrets(await workstationSealedSources({ file, cipher }), vaultOver(k), memoryBook());
        expect(moved).toEqual([{ name: ENTRY, status: 'moved' }]);
        expect(rows()[HOST]).toEqual({ workstationId: 'ws_1', legacyDone: 'ws_old' });
        const store = workstationKeyStore(file, k);
        expect(await store.read(HOST)).toEqual({ workstationId: 'ws_1', privateKeyPem: pair.privateKeyPem });
        const tynn = tynnFake('ws_1');
        expect(await ensureWorkstation(ports(store, tynn))).toMatchObject({ ok: true, status: 'exists', workstationId: 'ws_1' });
        expect(tynn.registers).toBe(0);
    });

    it('a seal that will not open, or opens to something that is not a key, is not moved and not deleted', async () => {
        writeFileSync(file, JSON.stringify({ [HOST]: { workstationId: 'ws_1', keyEnc: Buffer.from('other:x').toString('base64') }, 'https://b.example': { workstationId: 'ws_2', keyEnc: seal('not a key') } }));
        const sources = await workstationSealedSources({ file, cipher });
        for (const source of sources) expect((await source.old.read()).kind).toBe('unreadable');
        expect(rows()[HOST]?.keyEnc).toBeDefined();
    });

    it('nothing sealed, or no file: nothing to move', async () => {
        expect(await workstationSealedSources({ file, cipher })).toEqual([]);
        writeFileSync(file, JSON.stringify({ [HOST]: { workstationId: 'ws_1' } }));
        expect(await workstationSealedSources({ file, cipher })).toEqual([]);
    });
});

describe('where it is wired', () => {
    const strip = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('with a host, main asks it; only its own engine holds a key here', () => {
        const main = strip(readFileSync('src/main/main.ts', 'utf8'));
        expect(main).toMatch(/crashReportMachine = agentEngineLink\.client\.workstation\(\)/);
        expect(main).toMatch(/sources: \(\) => workstationSealedSources\(/);
        expect(strip(readFileSync('src/main/genie-host.ts', 'utf8'))).toMatch(/new WorkstationService\(/);
        expect(strip(readFileSync('src/main/workstation-replica.ts', 'utf8'))).not.toMatch(/privateKeyPem/);
    });
});
