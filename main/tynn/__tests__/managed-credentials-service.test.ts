import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setSecretEncryptor } from '../../secrets/store';
import {
    ANTHROPIC,
    API_KEY,
    GITHUB,
    OPENAI,
    SUBSCRIPTION,
    openEscrowKeypair,
} from '../../host-core/crypto/escrow';
import {
    generateEncryptionKeypair,
    seal,
    sealOpenText,
    sodiumReady,
    type EncryptionKeypair,
} from '../../host-core/crypto/sealed-box';
import {
    managedCredentialEnv,
    resetManagedCredentials,
} from '../../host-core/crypto/managed-credentials';
import { resetClaudeRotation } from '../../host-core/crypto/claude-rotation';
import {
    ENC_KEY_ENC_SETTING,
    ENC_PUBLIC_KEY_SETTING,
} from '../../host-core/crypto/host-encryption-key';
import { startManagedCredentials } from '../managed-credentials-service';

/**
 * End-to-end proof of the W2 host flow with SYNTHETIC keys only: the host
 * generates its own X25519 pair, the fake Tynn captures the PUBLISHED public key,
 * seals a synthetic escrow key to it, and serves credentials sealed to that
 * escrow key. Every "credential" is a `fake-…` literal this test invented — no
 * real provider secret is used, and nothing decrypted is printed.
 */

const FAKE = {
    anthropic: 'fake-anthropic-0000',
    openai: 'fake-openai-0000',
    github: 'fake-gh-token-0000',
    claude: '{"fake":true,"refresh":"fake-refresh-0000"}',
};

const BASE = 'https://tynn.test';
const WS_ID = 'ws-42';
const identity = { workstationId: WS_ID, authHeader: () => 'Workstation 1:sig==' };

beforeAll(async () => {
    await sodiumReady();
});

afterEach(() => {
    resetManagedCredentials();
    resetClaudeRotation();
    setSecretEncryptor(null);
});

function fakeEncryptor() {
    return {
        isAvailable: () => true,
        encrypt: (b: Buffer) => Buffer.concat([Buffer.from('ENC:'), b]),
        decrypt: (b: Buffer) => b.subarray(4),
    };
}

function memoryKeyStore() {
    const rows: Record<string, string> = {};
    return {
        rows,
        read: () => ({
            publicKeyB64: rows[ENC_PUBLIC_KEY_SETTING] || undefined,
            privateKeyEnc: rows[ENC_KEY_ENC_SETTING] || undefined,
        }),
        write: (patch: Record<string, string>) => Object.assign(rows, patch),
    };
}

function memoryFsDeps() {
    const files = new Map<string, { data: string; mode: number }>();
    const ghCalls: string[] = [];
    return {
        files,
        ghCalls,
        deps: {
            homeDir: '/fake-home',
            fs: {
                mkdirSync: vi.fn(),
                writeFileSync: (f: string, d: string, o: { mode: number }) =>
                    void files.set(f, { data: d, mode: o.mode }),
                chmodSync: (f: string, m: number) => {
                    const e = files.get(f);
                    if (e) e.mode = m;
                },
                existsSync: (f: string) => files.has(f),
                rmSync: (f: string) => void files.delete(f),
                readFileSync: (f: string) => {
                    const e = files.get(f);
                    if (!e) throw new Error('ENOENT');
                    return e.data;
                },
            },
            runner: {
                run: async (_c: string, _a: string[], o: { input: string }) => {
                    ghCalls.push(o.input);
                    return { code: 0, stderr: '' };
                },
            },
        },
    };
}

/**
 * A fake Tynn that behaves like the real zero-knowledge store: it learns the
 * host's PUBLIC key from the publish call, wraps the escrow key to it, and only
 * ever holds ciphertext.
 */
function fakeTynn(escrow: EncryptionKeypair) {
    const state = {
        publishedPublicKey: null as string | null,
        published: [] as Array<Record<string, unknown>>,
        puts: [] as Array<{ credentialId: string; body: Record<string, unknown> }>,
        wraps: [] as Array<{ target: string; ciphertext: string }>,
        pending: [] as Array<{ workstationId: string; encryptionPublicKey: string }>,
        requests: [] as string[],
    };

    const row = async (id: string, provider: string, kind: string, value: string) => ({
        id,
        provider,
        kind,
        scope: 'account',
        projectId: null,
        sealedTo: 'escrow',
        ciphertext: await seal(value, escrow.publicKeyB64),
    });

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        state.requests.push(`${method} ${url}`);
        const body = init?.body ? JSON.parse(init.body as string) : undefined;

        if (url.endsWith('/encryption-key')) {
            state.publishedPublicKey = body.publicKey;
            state.published.push(body);
            return { ok: true, status: 200, json: async () => ({ fingerprint: 'srv' }) } as Response;
        }
        if (url.endsWith('/provider-credentials')) {
            const wrapped = state.publishedPublicKey
                ? await seal(Buffer.from(escrow.privateKeyB64, 'base64'), state.publishedPublicKey)
                : null;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    workstationId: WS_ID,
                    escrow: { publicKey: escrow.publicKeyB64, wrappedPrivateKey: wrapped },
                    credentials: [
                        await row('c1', ANTHROPIC, API_KEY, FAKE.anthropic),
                        await row('c2', OPENAI, API_KEY, FAKE.openai),
                        await row('c3', GITHUB, API_KEY, FAKE.github),
                        await row('c4', ANTHROPIC, SUBSCRIPTION, FAKE.claude),
                    ],
                }),
            } as Response;
        }
        if (url.endsWith('/escrow/pending')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    escrow: { publicKey: escrow.publicKeyB64 },
                    hosts: state.pending,
                }),
            } as Response;
        }
        if (url.endsWith('/escrow/wrapped-keys')) {
            state.wraps.push({ target: body.targetWorkstationId, ciphertext: body.ciphertext });
            return { ok: true, status: 200, json: async () => ({}) } as Response;
        }
        if (method === 'PUT' && url.includes('/provider-credentials/')) {
            state.puts.push({ credentialId: url.split('/provider-credentials/')[1], body });
            return { ok: true, status: 200, json: async () => ({}) } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
    });

    return { state, fetchImpl: fetchImpl as unknown as typeof fetch };
}

async function start(overrides: Record<string, unknown> = {}) {
    const escrow = await generateEncryptionKeypair();
    const tynn = fakeTynn(escrow);
    const keys = memoryKeyStore();
    const mat = memoryFsDeps();
    setSecretEncryptor(fakeEncryptor());

    const handle = await startManagedCredentials({
        enabled: true,
        identity,
        tynnApiBaseUrl: BASE,
        fetchImpl: tynn.fetchImpl,
        encryptionKey: { read: keys.read, write: keys.write },
        materialize: mat.deps,
        rotation: { watch: () => ({ close: vi.fn() }) },
        ...overrides,
    });

    return { escrow, tynn, keys, mat, handle };
}

describe('startManagedCredentials', () => {
    it('stays completely dark when the feature is off — no keygen, no request', async () => {
        const keys = memoryKeyStore();
        const tynn = fakeTynn(await generateEncryptionKeypair());
        setSecretEncryptor(fakeEncryptor());

        const handle = await startManagedCredentials({
            enabled: false,
            identity,
            tynnApiBaseUrl: BASE,
            fetchImpl: tynn.fetchImpl,
            encryptionKey: { read: keys.read, write: keys.write },
            materialize: memoryFsDeps().deps,
        });

        expect(handle).toBeNull();
        expect(tynn.state.requests).toEqual([]);
        expect(keys.rows).toEqual({});
        expect(managedCredentialEnv()).toEqual({});
    });

    it('runs the whole flow: keygen -> publish -> fetch -> open -> materialize', async () => {
        const { escrow, tynn, keys, mat, handle } = await start();

        expect(handle).not.toBeNull();

        // 1. A host keypair was generated and persisted ENCRYPTED.
        expect(Buffer.from(keys.rows[ENC_PUBLIC_KEY_SETTING], 'base64')).toHaveLength(32);
        expect(keys.rows[ENC_KEY_ENC_SETTING]).toBeTruthy();

        // 2. Only the PUBLIC half was published, with no client-sent fingerprint.
        expect(tynn.state.published).toEqual([{ publicKey: keys.rows[ENC_PUBLIC_KEY_SETTING] }]);
        expect(JSON.stringify(tynn.state.requests)).not.toContain(escrow.privateKeyB64);

        // 3. Each KIND landed in its own destination.
        expect(managedCredentialEnv()).toEqual({
            ANTHROPIC_API_KEY: FAKE.anthropic,
            OPENAI_API_KEY: FAKE.openai,
        });
        expect([...mat.files.values()][0]).toEqual({ data: FAKE.claude, mode: 0o600 });
        expect(mat.ghCalls).toEqual([FAKE.github]);
    });

    it('nests every request under /api/v1/workstations/{id}/ so the host proof verifies', async () => {
        const { tynn } = await start();

        expect(tynn.state.requests.length).toBeGreaterThan(0);
        for (const request of tynn.state.requests) {
            expect(request).toContain(`/api/v1/workstations/${WS_ID}/`);
        }
    });

    it('returns null and touches nothing when this machine is not enrolled', async () => {
        const fetchImpl = vi.fn();
        const handle = await startManagedCredentials({
            enabled: true,
            identity: null,
            tynnApiBaseUrl: BASE,
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        expect(handle).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(managedCredentialEnv()).toEqual({});
    });

    it('never breaks boot when Tynn is unreachable', async () => {
        const keys = memoryKeyStore();
        setSecretEncryptor(fakeEncryptor());

        const handle = await startManagedCredentials({
            enabled: true,
            identity,
            tynnApiBaseUrl: BASE,
            fetchImpl: (async () => {
                throw new Error('ECONNREFUSED');
            }) as unknown as typeof fetch,
            encryptionKey: { read: keys.read, write: keys.write },
            materialize: memoryFsDeps().deps,
            rotation: { watch: () => ({ close: vi.fn() }) },
        });

        expect(handle).not.toBeNull();
        expect(managedCredentialEnv()).toEqual({});
        // The keypair was still generated + persisted, so the next boot republishes.
        expect(keys.rows[ENC_PUBLIC_KEY_SETTING]).toBeTruthy();
    });

    it('never breaks boot when OS encryption is unavailable — and injects nothing', async () => {
        setSecretEncryptor({
            isAvailable: () => false,
            encrypt: () => Buffer.alloc(0),
            decrypt: () => Buffer.alloc(0),
        });
        const logs: string[] = [];

        const handle = await startManagedCredentials({
            enabled: true,
            identity,
            tynnApiBaseUrl: BASE,
            fetchImpl: fakeTynn(await generateEncryptionKeypair()).fetchImpl,
            encryptionKey: memoryKeyStore(),
            materialize: memoryFsDeps().deps,
            log: (m) => logs.push(m),
        });

        expect(handle).toBeNull();
        expect(managedCredentialEnv()).toEqual({});
        expect(logs.join(' ')).toMatch(/encryption is unavailable/i);
    });

    it('vouches for a re-provisioned peer host so it self-heals', async () => {
        const newHost = await generateEncryptionKeypair();
        const escrow = await generateEncryptionKeypair();
        const tynn = fakeTynn(escrow);
        tynn.state.pending = [
            { workstationId: 'ws-new', encryptionPublicKey: newHost.publicKeyB64 },
        ];
        setSecretEncryptor(fakeEncryptor());

        await startManagedCredentials({
            enabled: true,
            identity,
            tynnApiBaseUrl: BASE,
            fetchImpl: tynn.fetchImpl,
            encryptionKey: memoryKeyStore(),
            materialize: memoryFsDeps().deps,
            rotation: { watch: () => ({ close: vi.fn() }) },
        });

        expect(tynn.state.wraps).toHaveLength(1);
        expect(tynn.state.wraps[0].target).toBe('ws-new');
        // The wrapped copy opens for the NEW host and for nobody else.
        const escrowBundle = {
            publicKeyB64: escrow.publicKeyB64,
            wrappedPrivateKeyB64: tynn.state.wraps[0].ciphertext,
        };
        expect(await openEscrowKeypair(escrowBundle, newHost)).toMatchObject({
            publicKeyB64: escrow.publicKeyB64,
        });
        expect(await openEscrowKeypair(escrowBundle, await generateEncryptionKeypair())).toBeNull();
    });

    it('applies a pushed REVOKE immediately: file wiped, env dropped', async () => {
        const { mat, handle } = await start();
        expect(mat.files.size).toBe(1);

        handle!.onCredentialChange({ action: 'revoked', credentialId: 'c4' });
        expect(mat.files.size).toBe(0);

        handle!.onCredentialChange({ action: 'revoked', credentialId: 'c1' });
        expect(managedCredentialEnv()).toEqual({ OPENAI_API_KEY: FAKE.openai });
    });

    it('re-fetches on a SET push so a newly added credential reaches a running host', async () => {
        // Revoke-only would leave an added credential unseen until restart —
        // a poll in disguise.
        const { tynn, handle } = await start();
        const before = tynn.state.requests.filter((r) => r.endsWith('/provider-credentials')).length;

        const result = handle!.onCredentialChange({ action: 'set', credentialId: 'c9' });

        expect(result.refetch).toBe(true);
        await vi.waitFor(() =>
            expect(
                tynn.state.requests.filter((r) => r.endsWith('/provider-credentials')).length,
            ).toBe(before + 1),
        );
    });

    it('writes a CLI rotation back to Tynn keyed on the credential id, sealed to ESCROW', async () => {
        const { escrow, tynn, mat, handle } = await start();
        const file = [...mat.files.keys()][0];
        const rotated = '{"fake":true,"refresh":"fake-refresh-rotated"}';
        mat.files.set(file, { data: rotated, mode: 0o600 });

        const result = await handle!.syncRotation();

        expect(result.status).toBe('written');
        expect(tynn.state.puts).toHaveLength(1);
        expect(tynn.state.puts[0].credentialId).toBe('c4');
        expect(tynn.state.puts[0].body.sealedTo).toBe('escrow');
        expect(await sealOpenText(tynn.state.puts[0].body.ciphertext as string, escrow)).toBe(rotated);
    });

    it('stops the rotation watch cleanly', async () => {
        const close = vi.fn();
        const { handle } = await start({ rotation: { watch: () => ({ close }) } });

        handle!.stop();

        expect(close).toHaveBeenCalled();
    });
});
