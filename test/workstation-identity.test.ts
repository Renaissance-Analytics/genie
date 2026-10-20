import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildWorkstationAuthHeader,
    ensureWorkstation,
    fingerprintSpki,
    generateHostKeypair,
    identityFrom,
    workstationKeyStore,
    type IdentityCipher,
    type StoredIdentity,
} from '../src/main/workstation-identity.js';

/** Tynn #836: Genie 1's Tynn workstation registration (`v1:main/tynn/workstation-identity.ts`), in Genie 2. */

const HOST = 'https://tynn.example.com';

function respond(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeTynn(answers: { register?: number; enroll?: number } = {}) {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const request = async (path: string, init: { method: 'GET' | 'POST'; body?: unknown }) => {
        calls.push({ path, method: init.method, body: init.body });
        if (path === '/api/v1/workstations/self-register') {
            const status = answers.register ?? 201;
            return respond(status, status === 201
                ? { workstation: { id: 'ws_1', name: 'desk', status: 'provisioning' }, enrollment: { workstation_id: 'ws_1', secret: 'one-time', expires_at: null } }
                : { message: 'no' });
        }
        if (path === '/api/v1/workstations/ws_1/enroll') {
            const status = answers.enroll ?? 200;
            return respond(status, status === 200 ? { workstation: { id: 'ws_1', name: 'desk', status: 'active' } } : { message: 'gone' });
        }
        return respond(404, null);
    };
    return { calls, request };
}

function memoryStore(initial: Record<string, StoredIdentity> = {}) {
    const byHost = new Map(Object.entries(initial));
    const writes: string[] = [];
    return {
        writes,
        byHost,
        canWrite: () => true,
        read: async (host: string) => byHost.get(host) ?? null,
        write: async (host: string, identity: StoredIdentity) => { writes.push(host); byHost.set(host, identity); },
    };
}

describe('the Workstation auth header (byte for byte what Tynn verifies)', () => {
    it('signs "workstation-auth\\n{id}\\n{ts}" with the host key, as "Workstation <ts>:<sig>"', () => {
        const pair = generateHostKeypair();
        const header = buildWorkstationAuthHeader(pair.privateKeyPem, 'ws_1', 1_700_000_000_123);
        const match = /^Workstation (\d+):(.+)$/.exec(header);
        expect(match?.[1]).toBe('1700000000');
        const key = createPublicKey({ key: Buffer.from(pair.publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' });
        expect(verify(null, Buffer.from('workstation-auth\nws_1\n1700000000'), key, Buffer.from(match![2]!, 'base64'))).toBe(true);
        // CONTROL: another id does not verify, so the check above can fail.
        expect(verify(null, Buffer.from('workstation-auth\nws_2\n1700000000'), key, Buffer.from(match![2]!, 'base64'))).toBe(false);
    });
});

describe('ensureWorkstation — this machine registers with Tynn once', () => {
    it('not registered: self-registers by name, enrolls the public key with the one-time secret, then stores it', async () => {
        const tynn = fakeTynn();
        const store = memoryStore();
        const result = await ensureWorkstation({ host: () => HOST, hostname: () => 'desk', request: tynn.request, store });

        expect(result).toEqual({ ok: true, status: 'enrolled', workstationId: 'ws_1' });
        expect(tynn.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/v1/workstations/self-register', 'POST /api/v1/workstations/ws_1/enroll']);
        expect(tynn.calls[0]!.body).toEqual({ name: 'desk' });
        const stored = store.byHost.get(HOST)!;
        const enroll = tynn.calls[1]!.body as { enrollment_secret: string; host_public_key: string; host_fingerprint: string };
        expect(enroll.enrollment_secret).toBe('one-time');
        // The enrolled public key IS the stored private key's.
        const spki = (createPublicKey(stored.privateKeyPem).export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
        expect(enroll.host_public_key).toBe(spki);
        expect(enroll.host_fingerprint).toBe(fingerprintSpki(spki));
        expect(stored.workstationId).toBe('ws_1');
    });

    it('already registered with THIS Tynn: asks Tynn nothing', async () => {
        const tynn = fakeTynn();
        const pair = generateHostKeypair();
        const store = memoryStore({ [HOST]: { workstationId: 'ws_9', privateKeyPem: pair.privateKeyPem } });
        expect(await ensureWorkstation({ host: () => HOST, hostname: () => 'desk', request: tynn.request, store })).toEqual({ ok: true, status: 'exists', workstationId: 'ws_9' });
        expect(tynn.calls).toEqual([]);
        expect(store.writes).toEqual([]);
    });

    it('registered with ANOTHER Tynn only: registers with this one, and keeps the other', async () => {
        const tynn = fakeTynn();
        const pair = generateHostKeypair();
        const store = memoryStore({ 'https://other.example.com': { workstationId: 'ws_other', privateKeyPem: pair.privateKeyPem } });
        expect(await ensureWorkstation({ host: () => HOST, hostname: () => 'desk', request: tynn.request, store })).toMatchObject({ ok: true, status: 'enrolled' });
        expect(store.byHost.get('https://other.example.com')?.workstationId).toBe('ws_other');
        expect(store.byHost.get(HOST)?.workstationId).toBe('ws_1');
    });

    it('enroll refused: nothing is stored, and it says so', async () => {
        const tynn = fakeTynn({ enroll: 410 });
        const store = memoryStore();
        const result = await ensureWorkstation({ host: () => HOST, hostname: () => 'desk', request: tynn.request, store });
        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.reason).toContain('410');
        expect(store.writes).toEqual([]);
    });

    // Tynn answers an unauthenticated session route 404 since tynn.ai#303 (AuthFailureIsNotFound); 401/419 before it.
    it.each([401, 404, 419])('signed out (%i): no enroll is attempted, nothing stored', async (status) => {
        const tynn = fakeTynn({ register: status });
        const store = memoryStore();
        const result = await ensureWorkstation({ host: () => HOST, hostname: () => 'desk', request: tynn.request, store });
        expect(result).toEqual({ ok: false, reason: 'sign in to Tynn to register this machine' });
        expect(tynn.calls).toHaveLength(1);
        expect(store.writes).toEqual([]);
    });

    it('any other refusal says what Tynn said', async () => {
        const tynn = fakeTynn({ register: 422 });
        const result = await ensureWorkstation({ host: () => HOST, hostname: () => 'desk', request: tynn.request, store: memoryStore() });
        expect(result).toEqual({ ok: false, reason: 'Tynn refused to register this machine (422: no)' });
    });
});

describe('no OS encryption: Tynn is never asked (Tynn #847)', () => {
    // The two-VM proof (2026-10-20): Genie registered and ENROLLED the machine, then could not store the key — an
    // enrolled, keyless workstation left in Tynn on every attempt. Ask the store first.
    it('a store that cannot write: nothing is registered, and it says why', async () => {
        const tynn = fakeTynn();
        const store = { ...memoryStore(), canWrite: () => false };
        const result = await ensureWorkstation({ host: () => HOST, hostname: () => 'desk', request: tynn.request, store });
        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.reason).toMatch(/encrypt/);
        expect(tynn.calls).toEqual([]);
    });
});

describe('identityFrom — the stored key, closed over', () => {
    it('signs with the enrolled key and carries its fingerprint', () => {
        const pair = generateHostKeypair();
        const id = identityFrom({ workstationId: 'ws_1', privateKeyPem: pair.privateKeyPem });
        const key = createPublicKey({ key: Buffer.from(pair.publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' });
        expect(verify(null, Buffer.from('hello'), key, id.sign(Buffer.from('hello')))).toBe(true);
        expect(id.fingerprint).toBe(fingerprintSpki(pair.publicKeySpkiB64));
        expect(id.authHeader(1_700_000_000_000)).toMatch(/^Workstation 1700000000:/);
    });
});

describe('workstationKeyStore — the private key is never on disk in the clear', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const dir = () => { const d = mkdtempSync(join(tmpdir(), 'ws-id-')); dirs.push(d); return d; };
    // A reversible stand-in for safeStorage: the file must hold ITS output, not the PEM.
    const cipher: IdentityCipher = {
        isAvailable: () => true,
        encrypt: (text) => Buffer.from([...Buffer.from(text, 'utf8')].map((b) => b ^ 0x5a)),
        decrypt: (bytes) => Buffer.from([...bytes].map((b) => b ^ 0x5a)).toString('utf8'),
    };

    it('round-trips per Tynn host, and the file holds no PEM', async () => {
        const d = dir();
        const pair = generateHostKeypair();
        const store = workstationKeyStore(join(d, 'workstation.json'), cipher);
        await store.write(HOST, { workstationId: 'ws_1', privateKeyPem: pair.privateKeyPem });
        expect(await store.read(HOST)).toEqual({ workstationId: 'ws_1', privateKeyPem: pair.privateKeyPem });
        expect(await store.read('https://other.example.com')).toBeNull();
        const onDisk = readFileSync(join(d, 'workstation.json'), 'utf8');
        expect(onDisk).toContain('ws_1');
        expect(onDisk).not.toContain('PRIVATE KEY');
    });

    it('no OS encryption: refuses to write (fail closed)', async () => {
        const d = dir();
        const store = workstationKeyStore(join(d, 'workstation.json'), { ...cipher, isAvailable: () => false });
        await expect(store.write(HOST, { workstationId: 'ws_1', privateKeyPem: generateHostKeypair().privateKeyPem })).rejects.toThrow(/encryption/);
    });

    it('a key that cannot be decrypted reads as not registered', async () => {
        const d = dir();
        const pair = generateHostKeypair();
        await workstationKeyStore(join(d, 'workstation.json'), cipher).write(HOST, { workstationId: 'ws_1', privateKeyPem: pair.privateKeyPem });
        const broken = workstationKeyStore(join(d, 'workstation.json'), { ...cipher, decrypt: () => { throw new Error('other keychain'); } });
        expect(await broken.read(HOST)).toBeNull();
    });
});
