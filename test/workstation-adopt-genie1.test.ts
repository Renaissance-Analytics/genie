import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    ensureWorkstation,
    generateHostKeypair,
    readGenie1Identity,
    workstationKeyStore,
    type IdentityCipher,
    type StoredIdentity,
} from '../src/main/workstation-identity.js';

/**
 * GENIE 2 TAKES OVER THE GENIE 1 RECORD ON SIGN-IN (genie#1278 "Agent: adopt on sign-in"; the owner approved 2026-10-29,
 * q_d50d850f: "other users will have this problem too").
 *
 * Genie 1 kept this machine's Tynn record in its genie.db (`settings.workstation_id`, its key encrypted as
 * `workstation_key_enc`) under the userData Genie 2 shares. Genie 2 registered the machine again, so the owner's AlphaR
 * is two records. Now Genie 2 names Genie 1's record when it registers, with a proof made by Genie 1's key when it can
 * decrypt it (the same userData: the same OS key, measured for the GitHub carry-over), and Tynn takes over that record
 * or retires the duplicate (tynn.ai `AdoptLegacyWorkstation`). Once it is settled, it is never sent again.
 */

const HOST = 'https://tynn.example.com';
const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

type Call = { path: string; method: string; body?: Record<string, unknown> };

/** Tynn as the adopt path answers it: `register` decides what self-register hands back. */
function fakeTynn(register: (body: Record<string, unknown>) => { status: number; body: unknown }, me: { id: string | null } = { id: null }) {
    const calls: Call[] = [];
    const request = async (path: string, init: { method: 'GET' | 'POST'; body?: unknown }) => {
        calls.push({ path, method: init.method, body: init.body as Record<string, unknown> });
        if (path === '/api/v1/workstations/me') return respond(200, { workstation: me.id ? { id: me.id, role: 'pilot' } : null, role: me.id ? 'pilot' : null });
        if (path === '/api/v1/workstations/self-register') { const r = register(init.body as Record<string, unknown>); return respond(r.status, r.body); }
        if (path.endsWith('/enroll')) return respond(200, { workstation: { id: path.split('/')[4], status: 'active' } });
        return respond(404, null);
    };
    return { calls, request };
}

const armed = (id: string) => ({ status: 201, body: { workstation: { id, name: 'AlphaR', status: 'provisioning' }, enrollment: { workstation_id: id, secret: 'one-time', expires_at: null } } });

function memoryStore(initial: Record<string, StoredIdentity> = {}, done: Record<string, string> = {}) {
    const byHost = new Map(Object.entries(initial));
    const legacy = new Map(Object.entries(done));
    const writes: string[] = [];
    return {
        writes,
        byHost,
        legacy,
        canWrite: () => true,
        read: async (host: string) => byHost.get(host) ?? null,
        write: async (host: string, identity: StoredIdentity) => { writes.push(host); byHost.set(host, identity); },
        legacyDone: async (host: string) => legacy.get(host) ?? null,
        markLegacyDone: async (host: string, id: string) => { legacy.set(host, id); },
    };
}

const reattachVerifies = (pem: string, id: string, proof: { ts: number; sig: string }) =>
    verify(null, Buffer.from(`workstation-reattach\n${id}\n${proof.ts}`), createPublicKey(pem), Buffer.from(proof.sig, 'base64'));

describe('no Genie 2 record yet: the first registration names Genie 1\'s record', () => {
    it('sends Genie 1\'s id with a proof made by Genie 1\'s key; Tynn hands that record back; settled once', async () => {
        const v1 = generateHostKeypair();
        const tynn = fakeTynn(() => armed('01kxw523'));
        const store = memoryStore();
        const result = await ensureWorkstation({
            host: () => HOST, hostname: () => 'AlphaR', request: tynn.request, store,
            machineKey: async () => 'a'.repeat(64), now: () => 1_700_000_000_000,
            legacy: async () => ({ workstationId: '01kxw523', privateKeyPem: v1.privateKeyPem }),
        });

        expect(result).toEqual({ ok: true, status: 'enrolled', workstationId: '01kxw523' });
        const body = tynn.calls.find((c) => c.path.endsWith('/self-register'))!.body!;
        expect(body.machine_key).toBe('a'.repeat(64));
        const legacy = body.legacy as { workstation_id: string; proof: { ts: number; sig: string } };
        expect(legacy.workstation_id).toBe('01kxw523');
        expect(legacy.proof.ts).toBe(1_700_000_000);
        expect(reattachVerifies(v1.privateKeyPem, '01kxw523', legacy.proof)).toBe(true);
        // CONTROL: the proof is for THAT record only.
        expect(reattachVerifies(v1.privateKeyPem, '01other', legacy.proof)).toBe(false);
        expect(store.byHost.get(HOST)!.workstationId).toBe('01kxw523');
        expect(store.legacy.get(HOST)).toBe('01kxw523');
    });

    it('Genie 1\'s key cannot be decrypted: sends the id without a proof (Tynn decides, never above Drone)', async () => {
        const tynn = fakeTynn(() => armed('01kxw523'));
        await ensureWorkstation({
            host: () => HOST, hostname: () => 'AlphaR', request: tynn.request, store: memoryStore(),
            legacy: async () => ({ workstationId: '01kxw523', privateKeyPem: null }),
        });
        expect(tynn.calls.find((c) => c.path.endsWith('/self-register'))!.body).toEqual({ name: 'AlphaR', legacy: { workstation_id: '01kxw523' } });
    });

    it('no Genie 1 record on this machine: registers as before, nothing about legacy', async () => {
        const tynn = fakeTynn(() => armed('ws_new'));
        await ensureWorkstation({ host: () => HOST, hostname: () => 'box', request: tynn.request, store: memoryStore(), legacy: async () => null });
        expect(tynn.calls.find((c) => c.path.endsWith('/self-register'))!.body).toEqual({ name: 'box' });
    });

    it('reading Genie 1 fails: registers as before (never blocks registration)', async () => {
        const tynn = fakeTynn(() => armed('ws_new'));
        const result = await ensureWorkstation({ host: () => HOST, hostname: () => 'box', request: tynn.request, store: memoryStore(), legacy: async () => { throw new Error('locked'); } });
        expect(result.ok).toBe(true);
        expect(tynn.calls.find((c) => c.path.endsWith('/self-register'))!.body).toEqual({ name: 'box' });
    });
});

describe('both exist (the owner\'s AlphaR): the next sign-in settles it through Tynn', () => {
    it('even when Tynn says this pairing IS the Genie 2 record, it asks once more with both proofs', async () => {
        const v1 = generateHostKeypair();
        const v2 = generateHostKeypair();
        const tynn = fakeTynn(() => ({ status: 200, body: { workstation: { id: '01m5epvk', role: 'pilot' }, enrollment: null } }), { id: '01m5epvk' });
        const store = memoryStore({ [HOST]: { workstationId: '01m5epvk', privateKeyPem: v2.privateKeyPem } });

        const result = await ensureWorkstation({
            host: () => HOST, hostname: () => 'AlphaR', request: tynn.request, store, machineKey: async () => 'a'.repeat(64),
            legacy: async () => ({ workstationId: '01kxw523', privateKeyPem: v1.privateKeyPem }),
        });

        // Tynn kept Genie 2's record (it held the shares, or neither did): nothing re-enrolls.
        expect(result).toEqual({ ok: true, status: 'exists', workstationId: '01m5epvk' });
        const body = tynn.calls.find((c) => c.path.endsWith('/self-register'))!.body as { proof: { workstation_id: string; ts: number; sig: string }; legacy: { workstation_id: string; proof: { ts: number; sig: string } } };
        expect(body.proof.workstation_id).toBe('01m5epvk');
        expect(reattachVerifies(v2.privateKeyPem, '01m5epvk', body.proof)).toBe(true);
        expect(body.legacy.workstation_id).toBe('01kxw523');
        expect(reattachVerifies(v1.privateKeyPem, '01kxw523', body.legacy.proof)).toBe(true);
        expect(store.writes).toEqual([]);
        expect(store.legacy.get(HOST)).toBe('01kxw523');
    });

    it('Tynn keeps the Genie 1 record (it held the shares): enrolls this Genie\'s key on it and stores it', async () => {
        const v2 = generateHostKeypair();
        const tynn = fakeTynn(() => armed('01kxw523'), { id: '01m5epvk' });
        const store = memoryStore({ [HOST]: { workstationId: '01m5epvk', privateKeyPem: v2.privateKeyPem } });

        const result = await ensureWorkstation({
            host: () => HOST, hostname: () => 'AlphaR', request: tynn.request, store,
            legacy: async () => ({ workstationId: '01kxw523', privateKeyPem: null }),
        });

        expect(result).toEqual({ ok: true, status: 'enrolled', workstationId: '01kxw523' });
        expect(tynn.calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /api/v1/workstations/01kxw523/enroll');
        expect(store.byHost.get(HOST)!.workstationId).toBe('01kxw523');
        expect(store.byHost.get(HOST)!.privateKeyPem).not.toBe(v2.privateKeyPem);
        expect(store.legacy.get(HOST)).toBe('01kxw523');
    });

    it('settled already: never sent again; only "who am I?"', async () => {
        const tynn = fakeTynn(() => armed('x'), { id: '01m5epvk' });
        const store = memoryStore({ [HOST]: { workstationId: '01m5epvk', privateKeyPem: generateHostKeypair().privateKeyPem } }, { [HOST]: '01kxw523' });
        await ensureWorkstation({ host: () => HOST, hostname: () => 'AlphaR', request: tynn.request, store, legacy: async () => ({ workstationId: '01kxw523', privateKeyPem: null }) });
        expect(tynn.calls.map((c) => c.path)).toEqual(['/api/v1/workstations/me']);
    });

    it('Genie 2 already IS the Genie 1 record: nothing to settle', async () => {
        const tynn = fakeTynn(() => armed('x'), { id: '01kxw523' });
        const store = memoryStore({ [HOST]: { workstationId: '01kxw523', privateKeyPem: generateHostKeypair().privateKeyPem } });
        await ensureWorkstation({ host: () => HOST, hostname: () => 'AlphaR', request: tynn.request, store, legacy: async () => ({ workstationId: '01kxw523', privateKeyPem: null }) });
        expect(tynn.calls.map((c) => c.path)).toEqual(['/api/v1/workstations/me']);
    });

    it.each([[404], [500]])('Tynn refuses or fails (%i): keeps this machine\'s identity and tries again next sign-in', async (status) => {
        const tynn = fakeTynn(() => ({ status, body: { message: 'no' } }), { id: '01m5epvk' });
        const store = memoryStore({ [HOST]: { workstationId: '01m5epvk', privateKeyPem: generateHostKeypair().privateKeyPem } });
        const result = await ensureWorkstation({ host: () => HOST, hostname: () => 'AlphaR', request: tynn.request, store, legacy: async () => ({ workstationId: '01kxw523', privateKeyPem: null }) });
        expect(result).toEqual({ ok: true, status: 'exists', workstationId: '01m5epvk' });
        expect(store.writes).toEqual([]);
        expect(store.legacy.get(HOST)).toBeUndefined();
    });
});

describe('readGenie1Identity: Genie 1\'s record and key, from its genie.db settings', () => {
    const cipher: IdentityCipher = {
        isAvailable: () => true,
        encrypt: (text) => Buffer.from([...Buffer.from(text, 'utf8')].map((b) => b ^ 0x5a)),
        decrypt: (bytes) => Buffer.from([...bytes].map((b) => b ^ 0x5a)).toString('utf8'),
    };
    const pem = generateHostKeypair().privateKeyPem;
    const enc = cipher.encrypt(pem).toString('base64');

    it('the id and the decrypted key', () => {
        expect(readGenie1Identity({ workstation_id: '01kxw523', workstation_key_enc: enc }, cipher)).toEqual({ workstationId: '01kxw523', privateKeyPem: pem });
    });

    it('a key it cannot decrypt, or none: the id alone', () => {
        expect(readGenie1Identity({ workstation_id: '01kxw523', workstation_key_enc: enc }, { ...cipher, decrypt: () => { throw new Error('other keychain'); } })).toEqual({ workstationId: '01kxw523', privateKeyPem: null });
        expect(readGenie1Identity({ workstation_id: '01kxw523', workstation_key_enc: Buffer.from('not a key').toString('base64') }, cipher)).toEqual({ workstationId: '01kxw523', privateKeyPem: null });
        expect(readGenie1Identity({ workstation_id: '01kxw523' }, { ...cipher, isAvailable: () => false })).toEqual({ workstationId: '01kxw523', privateKeyPem: null });
    });

    it('no Genie 1, or no record in it: nothing', () => {
        expect(readGenie1Identity(null, cipher)).toBeNull();
        expect(readGenie1Identity({ workstation_id: '' }, cipher)).toBeNull();
        expect(readGenie1Identity({ other: 'x' }, cipher)).toBeNull();
    });
});

describe('workstationKeyStore: "settled" survives a new key', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const cipher: IdentityCipher = { isAvailable: () => true, encrypt: (t) => Buffer.from(t, 'utf8'), decrypt: (b) => b.toString('utf8') };

    it('round-trips, per Tynn host, and a later write keeps it', async () => {
        const d = mkdtempSync(join(tmpdir(), 'ws-adopt-')); dirs.push(d);
        const store = workstationKeyStore(join(d, 'workstation.json'), cipher);
        await store.write(HOST, { workstationId: 'ws_1', privateKeyPem: generateHostKeypair().privateKeyPem });
        expect(await store.legacyDone!(HOST)).toBeNull();
        await store.markLegacyDone!(HOST, '01kxw523');
        await store.write(HOST, { workstationId: 'ws_2', privateKeyPem: generateHostKeypair().privateKeyPem });
        expect(await store.legacyDone!(HOST)).toBe('01kxw523');
        expect(await store.legacyDone!('https://other.example.com')).toBeNull();
        expect((await store.read(HOST))!.workstationId).toBe('ws_2');
    });
});
