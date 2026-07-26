import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setSecretEncryptor } from '../../secrets/store';
import {
    ANTHROPIC_API_KEY,
    CLAUDE_SUBSCRIPTION,
    GITHUB_TOKEN,
    OPENAI_API_KEY,
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
const identity = { workstationId: 'ws-42', authHeader: () => 'Workstation 1:sig==' };

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
        published: [] as Array<{ publicKeyB64: string; fingerprint: string }>,
        puts: [] as Array<{ provider: string; ciphertext: string }>,
        wraps: [] as Array<{ target: string; wrapped: string }>,
        pending: [] as Array<{ workstation_id: string; encryption_public_key: string }>,
        requests: [] as string[],
    };

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        state.requests.push(`${method} ${url}`);
        const body = init?.body ? JSON.parse(init.body as string) : undefined;

        if (url.endsWith('/encryption-key')) {
            state.publishedPublicKey = body.encryption_public_key;
            state.published.push({
                publicKeyB64: body.encryption_public_key,
                fingerprint: body.fingerprint,
            });
            return { ok: true, status: 200, json: async () => ({}) } as Response;
        }
        if (url.endsWith('/credentials')) {
            const wrapped = state.publishedPublicKey
                ? await seal(Buffer.from(escrow.privateKeyB64, 'base64'), state.publishedPublicKey)
                : null;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    escrow: { public_key: escrow.publicKeyB64, wrapped_private_key: wrapped },
                    credentials: [
                        { provider: ANTHROPIC_API_KEY, ciphertext: await seal(FAKE.anthropic, escrow.publicKeyB64) },
                        { provider: OPENAI_API_KEY, ciphertext: await seal(FAKE.openai, escrow.publicKeyB64) },
                        { provider: GITHUB_TOKEN, ciphertext: await seal(FAKE.github, escrow.publicKeyB64) },
                        { provider: CLAUDE_SUBSCRIPTION, ciphertext: await seal(FAKE.claude, escrow.publicKeyB64) },
                    ],
                }),
            } as Response;
        }
        if (url.endsWith('/escrow/pending')) {
            return { ok: true, status: 200, json: async () => ({ hosts: state.pending }) } as Response;
        }
        if (url.endsWith('/escrow/wrap')) {
            state.wraps.push({
                target: body.target_workstation_id,
                wrapped: body.wrapped_private_key,
            });
            return { ok: true, status: 200, json: async () => ({}) } as Response;
        }
        if (method === 'PUT' && url.includes('/credentials/')) {
            state.puts.push({ provider: url.split('/credentials/')[1], ciphertext: body.ciphertext });
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
    it('runs the whole flow: keygen -> publish -> fetch -> open -> materialize', async () => {
        const { escrow, tynn, keys, mat, handle } = await start();

        expect(handle).not.toBeNull();

        // 1. A host keypair was generated and persisted ENCRYPTED.
        expect(keys.rows[ENC_PUBLIC_KEY_SETTING]).toBeTruthy();
        expect(keys.rows[ENC_KEY_ENC_SETTING]).toMatch(/^/);
        expect(Buffer.from(keys.rows[ENC_PUBLIC_KEY_SETTING], 'base64')).toHaveLength(32);

        // 2. Only the PUBLIC half was published.
        expect(tynn.state.published).toHaveLength(1);
        expect(tynn.state.published[0].publicKeyB64).toBe(keys.rows[ENC_PUBLIC_KEY_SETTING]);
        expect(JSON.stringify(tynn.state.requests)).not.toContain(escrow.privateKeyB64);

        // 3. The credentials opened and landed in their three destinations.
        expect(managedCredentialEnv()).toEqual({
            ANTHROPIC_API_KEY: FAKE.anthropic,
            OPENAI_API_KEY: FAKE.openai,
        });
        const claudeFile = [...mat.files.values()][0];
        expect(claudeFile).toEqual({ data: FAKE.claude, mode: 0o600 });
        expect(mat.ghCalls).toEqual([FAKE.github]);
    });

    it('returns null and touches nothing when this machine is not enrolled', async () => {
        const fetchImpl = vi.fn();
        const handle = await startManagedCredentials({
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
        setSecretEncryptor({ isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => Buffer.alloc(0) });
        const logs: string[] = [];

        const handle = await startManagedCredentials({
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
            { workstation_id: 'ws-new', encryption_public_key: newHost.publicKeyB64 },
        ];
        setSecretEncryptor(fakeEncryptor());

        await startManagedCredentials({
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
            wrappedPrivateKeyB64: tynn.state.wraps[0].wrapped,
        };
        expect(await openEscrowKeypair(escrowBundle, newHost)).toMatchObject({
            publicKeyB64: escrow.publicKeyB64,
        });
        expect(await openEscrowKeypair(escrowBundle, await generateEncryptionKeypair())).toBeNull();
    });

    it('applies a pushed revoke immediately: file wiped, env dropped', async () => {
        const { mat, handle } = await start();
        expect(mat.files.size).toBe(1);

        handle!.onRevoke({ all: true });

        expect(mat.files.size).toBe(0);
        expect(managedCredentialEnv()).toEqual({});
    });

    it('writes a CLI rotation back to Tynn, sealed to the ESCROW key', async () => {
        const { escrow, tynn, mat, handle } = await start();
        const file = [...mat.files.keys()][0];
        const rotated = '{"fake":true,"refresh":"fake-refresh-rotated"}';
        mat.files.set(file, { data: rotated, mode: 0o600 });

        const result = await handle!.syncRotation();

        expect(result.status).toBe('written');
        expect(tynn.state.puts).toHaveLength(1);
        expect(tynn.state.puts[0].provider).toBe(CLAUDE_SUBSCRIPTION);
        expect(await sealOpenText(tynn.state.puts[0].ciphertext, escrow)).toBe(rotated);
    });

    it('stops the rotation watch cleanly', async () => {
        const close = vi.fn();
        const { handle } = await start({ rotation: { watch: () => ({ close }) } });

        handle!.stop();

        expect(close).toHaveBeenCalled();
    });
});
