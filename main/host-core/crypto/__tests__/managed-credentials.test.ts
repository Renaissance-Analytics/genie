import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateEncryptionKeypair, seal, sodiumReady, type EncryptionKeypair } from '../sealed-box';
import {
    ANTHROPIC_API_KEY,
    CLAUDE_SUBSCRIPTION,
    GITHUB_TOKEN,
    OPENAI_API_KEY,
    openEscrowKeypair,
    wrapEscrowForPeer,
    type CredentialBundle,
} from '../escrow';
import type { MaterializerFs } from '../credential-materializer';
import {
    applyCredentialRevoke,
    bootstrapEscrowForPeers,
    managedCredentialEnv,
    managedEscrowPublicKey,
    refreshManagedCredentials,
    resetManagedCredentials,
    type ManagedCredentialClient,
} from '../managed-credentials';

/**
 * SYNTHETIC KEYS + FAKE VALUES ONLY. Every keypair is generated in-process;
 * every "credential" is a `fake-…` literal this test invented. Assertions compare
 * against those literals, and several assertions exist specifically to prove that
 * NO value reaches a summary, a log line, or the environment when it shouldn't.
 */

const FAKE = {
    anthropic: 'fake-anthropic-0000',
    openai: 'fake-openai-0000',
    github: 'fake-gh-token-0000',
    claude: '{"fake":true,"refresh":"fake-refresh-0000"}',
};
const ALL_FAKE_VALUES = Object.values(FAKE);

beforeAll(async () => {
    await sodiumReady();
});

afterEach(() => resetManagedCredentials());

async function buildBundle(
    escrow: EncryptionKeypair,
    host: EncryptionKeypair | null,
): Promise<CredentialBundle> {
    return {
        escrow: {
            publicKeyB64: escrow.publicKeyB64,
            wrappedPrivateKeyB64: host ? await wrapEscrowForPeer(escrow, host.publicKeyB64) : null,
        },
        credentials: [
            { provider: ANTHROPIC_API_KEY, ciphertext: await seal(FAKE.anthropic, escrow.publicKeyB64) },
            { provider: OPENAI_API_KEY, ciphertext: await seal(FAKE.openai, escrow.publicKeyB64) },
            { provider: GITHUB_TOKEN, ciphertext: await seal(FAKE.github, escrow.publicKeyB64) },
            { provider: CLAUDE_SUBSCRIPTION, ciphertext: await seal(FAKE.claude, escrow.publicKeyB64) },
        ],
    };
}

function fakeClient(bundle: CredentialBundle): ManagedCredentialClient & { puts: unknown[]; wraps: unknown[] } {
    const puts: unknown[] = [];
    const wraps: unknown[] = [];
    return {
        puts,
        wraps,
        fetchBundle: vi.fn(async () => bundle),
        putCredential: vi.fn(async (provider: string, ciphertext: string) => {
            puts.push({ provider, ciphertext });
        }),
        listEscrowPending: vi.fn(async () => []),
        wrapEscrowForHost: vi.fn(async (input) => {
            wraps.push(input);
        }),
    };
}

/** An in-memory fs so materialization is observable without touching disk. */
function memoryFs() {
    const files = new Map<string, { data: string; mode: number }>();
    const impl: MaterializerFs = {
        mkdirSync: vi.fn(),
        writeFileSync: (file, data, opts) => void files.set(file, { data, mode: opts.mode }),
        chmodSync: (file, mode) => {
            const entry = files.get(file);
            if (entry) entry.mode = mode;
        },
        existsSync: (file) => files.has(file),
        rmSync: (file) => void files.delete(file),
    };
    return { files, impl };
}

function materializeDeps() {
    const fsx = memoryFs();
    const ghCalls: string[] = [];
    return {
        files: fsx.files,
        ghCalls,
        deps: {
            homeDir: '/fake-home',
            fs: fsx.impl,
            runner: {
                run: async (_c: string, _a: string[], o: { input: string }) => {
                    ghCalls.push(o.input);
                    return { code: 0, stderr: '' };
                },
            },
        },
    };
}

describe('refreshManagedCredentials', () => {
    it('opens the bundle and materializes each credential to its own destination', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const client = fakeClient(await buildBundle(escrow, host));
        const m = materializeDeps();

        const summary = await refreshManagedCredentials(client, host, m.deps);

        expect(summary.status).toBe('ok');
        expect(summary.providers.sort()).toEqual(
            [ANTHROPIC_API_KEY, CLAUDE_SUBSCRIPTION, GITHUB_TOKEN, OPENAI_API_KEY].sort(),
        );
        // API keys → env
        expect(managedCredentialEnv()).toEqual({
            ANTHROPIC_API_KEY: FAKE.anthropic,
            OPENAI_API_KEY: FAKE.openai,
        });
        // Claude subscription → 0600 file
        const claudeFile = [...m.files.entries()].find(([f]) => f.includes('.credentials.json'));
        expect(claudeFile?.[1]).toEqual({ data: FAKE.claude, mode: 0o600 });
        // GitHub token → gh stdin
        expect(m.ghCalls).toEqual([FAKE.github]);
        // The escrow public key is retained for rotation write-back.
        expect(managedEscrowPublicKey()).toBe(escrow.publicKeyB64);
    });

    it('returns a summary that contains NO credential value at all', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const client = fakeClient(await buildBundle(escrow, host));
        const m = materializeDeps();

        const summary = await refreshManagedCredentials(client, host, m.deps);

        const serialized = JSON.stringify(summary);
        for (const value of ALL_FAKE_VALUES) expect(serialized).not.toContain(value);
        expect(serialized).not.toContain('fake-refresh-0000');
        // …and neither does the escrow PRIVATE key.
        expect(serialized).not.toContain(escrow.privateKeyB64);
        expect(serialized).not.toContain(host.privateKeyB64);
    });

    it('injects NOTHING when this host has no escrow key yet (bootstrap pending)', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const client = fakeClient(await buildBundle(escrow, null));
        const m = materializeDeps();

        const summary = await refreshManagedCredentials(client, host, m.deps);

        expect(summary.status).toBe('no-escrow-key');
        expect(summary.providers).toEqual([]);
        expect(managedCredentialEnv()).toEqual({});
        expect(m.files.size).toBe(0);
        expect(m.ghCalls).toEqual([]);
    });

    it('injects NOTHING when the escrow key belongs to a different host (wrong key)', async () => {
        const escrow = await generateEncryptionKeypair();
        const otherHost = await generateEncryptionKeypair();
        const thisHost = await generateEncryptionKeypair();
        const client = fakeClient(await buildBundle(escrow, otherHost));
        const m = materializeDeps();

        const summary = await refreshManagedCredentials(client, thisHost, m.deps);

        expect(summary.status).toBe('no-escrow-key');
        expect(managedCredentialEnv()).toEqual({});
        expect(m.files.size).toBe(0);
    });

    it('reports a provider that failed to open by NAME and still materializes the rest', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const stranger = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);
        bundle.credentials = [
            bundle.credentials[0],
            { provider: CLAUDE_SUBSCRIPTION, ciphertext: await seal(FAKE.claude, stranger.publicKeyB64) },
        ];
        const m = materializeDeps();

        const summary = await refreshManagedCredentials(fakeClient(bundle), host, m.deps);

        expect(summary.failed).toEqual([CLAUDE_SUBSCRIPTION]);
        expect(summary.providers).toEqual([ANTHROPIC_API_KEY]);
        expect(managedCredentialEnv()).toEqual({ ANTHROPIC_API_KEY: FAKE.anthropic });
        expect(m.files.size).toBe(0);
    });

    it('leaves the previous injection untouched when the fetch fails', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const m = materializeDeps();
        await refreshManagedCredentials(fakeClient(await buildBundle(escrow, host)), host, m.deps);

        const failing: ManagedCredentialClient = {
            fetchBundle: vi.fn(async () => {
                throw new Error('tynn unreachable');
            }),
            putCredential: vi.fn(),
            listEscrowPending: vi.fn(async () => []),
            wrapEscrowForHost: vi.fn(),
        };
        const summary = await refreshManagedCredentials(failing, host, m.deps);

        expect(summary.status).toBe('unavailable');
        expect(managedCredentialEnv()).toEqual({
            ANTHROPIC_API_KEY: FAKE.anthropic,
            OPENAI_API_KEY: FAKE.openai,
        });
    });

    it('records a gh/file materialization failure without leaking the value', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const m = materializeDeps();

        const summary = await refreshManagedCredentials(fakeClient(await buildBundle(escrow, host)), host, {
            ...m.deps,
            runner: {
                run: async () => ({ code: 1, stderr: `invalid token ${FAKE.github}` }),
            },
        });

        expect(summary.github?.ok).toBe(false);
        expect(JSON.stringify(summary)).not.toContain(FAKE.github);
    });
});

describe('applyCredentialRevoke (immediate push-to-revoke)', () => {
    it('wipes the materialized Claude file AND drops it from the next spawn', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const m = materializeDeps();
        await refreshManagedCredentials(fakeClient(await buildBundle(escrow, host)), host, m.deps);
        expect(m.files.size).toBe(1);

        const result = applyCredentialRevoke({ provider: CLAUDE_SUBSCRIPTION }, m.deps);

        expect(result.revoked).toEqual([CLAUDE_SUBSCRIPTION]);
        expect(m.files.size).toBe(0);
        // The API keys are untouched — only the revoked provider goes.
        expect(managedCredentialEnv()).toEqual({
            ANTHROPIC_API_KEY: FAKE.anthropic,
            OPENAI_API_KEY: FAKE.openai,
        });
    });

    it('unsets a revoked API key so the NEXT terminal spawn no longer sees it', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const m = materializeDeps();
        await refreshManagedCredentials(fakeClient(await buildBundle(escrow, host)), host, m.deps);

        applyCredentialRevoke({ provider: ANTHROPIC_API_KEY }, m.deps);

        expect(managedCredentialEnv()).toEqual({ OPENAI_API_KEY: FAKE.openai });
    });

    it('revokes EVERYTHING on an all-revoke: env cleared, file wiped, escrow dropped', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const m = materializeDeps();
        await refreshManagedCredentials(fakeClient(await buildBundle(escrow, host)), host, m.deps);

        const result = applyCredentialRevoke({ all: true }, m.deps);

        expect(result.revoked).toContain(CLAUDE_SUBSCRIPTION);
        expect(managedCredentialEnv()).toEqual({});
        expect(managedEscrowPublicKey()).toBeNull();
        expect(m.files.size).toBe(0);
    });

    it('is safe when nothing was ever injected', () => {
        const m = materializeDeps();
        expect(applyCredentialRevoke({ all: true }, m.deps).revoked).toEqual([]);
    });
});

describe('bootstrapEscrowForPeers (new-host bootstrap from a live peer)', () => {
    it('wraps the escrow key for each pending host so a re-provisioned host self-heals', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const newHost = await generateEncryptionKeypair();
        const client = fakeClient(await buildBundle(escrow, host));
        client.listEscrowPending = vi.fn(async () => [
            { workstationId: 'ws-new', encryptionPublicKeyB64: newHost.publicKeyB64 },
        ]);
        const m = materializeDeps();
        await refreshManagedCredentials(client, host, m.deps);

        const summary = await bootstrapEscrowForPeers(client);

        expect(summary.wrapped).toEqual(['ws-new']);
        expect(client.wraps).toHaveLength(1);
        const wrap = client.wraps[0] as { targetWorkstationId: string; wrappedPrivateKeyB64: string };
        expect(wrap.targetWorkstationId).toBe('ws-new');
        // The wrapped copy is openable by the NEW host and by nobody else.
        expect(
            await openEscrowKeypair(
                { publicKeyB64: escrow.publicKeyB64, wrappedPrivateKeyB64: wrap.wrappedPrivateKeyB64 },
                newHost,
            ),
        ).toMatchObject({ publicKeyB64: escrow.publicKeyB64 });
        expect(
            await openEscrowKeypair(
                { publicKeyB64: escrow.publicKeyB64, wrappedPrivateKeyB64: wrap.wrappedPrivateKeyB64 },
                await generateEncryptionKeypair(),
            ),
        ).toBeNull();
        // The escrow PRIVATE key never appears in the summary.
        expect(JSON.stringify(summary)).not.toContain(escrow.privateKeyB64);
    });

    it('does nothing when this host holds no escrow key (it cannot vouch for anyone)', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const client = fakeClient(await buildBundle(escrow, null));
        client.listEscrowPending = vi.fn(async () => [
            { workstationId: 'ws-new', encryptionPublicKeyB64: (await generateEncryptionKeypair()).publicKeyB64 },
        ]);
        const m = materializeDeps();
        await refreshManagedCredentials(client, host, m.deps);

        const summary = await bootstrapEscrowForPeers(client);

        expect(summary.status).toBe('no-escrow-key');
        expect(client.wraps).toEqual([]);
    });

    it('skips a pending host whose published public key is malformed', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const client = fakeClient(await buildBundle(escrow, host));
        client.listEscrowPending = vi.fn(async () => [
            { workstationId: 'ws-bad', encryptionPublicKeyB64: 'not-a-key' },
        ]);
        const m = materializeDeps();
        await refreshManagedCredentials(client, host, m.deps);

        const summary = await bootstrapEscrowForPeers(client);

        expect(summary.wrapped).toEqual([]);
        expect(summary.skipped).toEqual(['ws-bad']);
        expect(client.wraps).toEqual([]);
    });
});
