import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateEncryptionKeypair, seal, sodiumReady, type EncryptionKeypair } from '../sealed-box';
import {
    ANTHROPIC,
    API_KEY,
    GITHUB,
    OPENAI,
    SUBSCRIPTION,
    openEscrowKeypair,
    wrapEscrowForPeer,
    type CredentialBundle,
    type SealedCredential,
} from '../escrow';
import type { CredentialFs } from '../credential-materializer';
import { resetClaudeRotation, syncClaudeCredentialRotation } from '../claude-rotation';
import {
    applyCredentialChange,
    bootstrapEscrowForPeers,
    managedCredentialEnv,
    managedEscrowPublicKey,
    managedSubscriptionCredentialId,
    refreshManagedCredentials,
    resetManagedCredentials,
    type ManagedCredentialClient,
} from '../managed-credentials';

/**
 * SYNTHETIC KEYS + FAKE VALUES ONLY. Every keypair is generated in-process;
 * every "credential" is a `fake-…` literal this test invented. Assertions compare
 * against those literals, and several exist specifically to prove that NO value
 * reaches a summary, a log line, or the environment when it shouldn't.
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

afterEach(() => {
    resetManagedCredentials();
    resetClaudeRotation();
});

async function credential(
    id: string,
    provider: string,
    kind: string,
    value: string,
    escrowPublicKeyB64: string,
    extra: Partial<SealedCredential> = {},
): Promise<SealedCredential> {
    return {
        id,
        provider,
        kind,
        scope: 'account',
        projectId: null,
        sealedTo: 'escrow',
        ciphertext: await seal(value, escrowPublicKeyB64),
        ...extra,
    };
}

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
            await credential('c1', ANTHROPIC, API_KEY, FAKE.anthropic, escrow.publicKeyB64),
            await credential('c2', OPENAI, API_KEY, FAKE.openai, escrow.publicKeyB64),
            await credential('c3', GITHUB, API_KEY, FAKE.github, escrow.publicKeyB64),
            await credential('c4', ANTHROPIC, SUBSCRIPTION, FAKE.claude, escrow.publicKeyB64),
        ],
    };
}

function fakeClient(
    bundle: CredentialBundle,
): ManagedCredentialClient & { puts: Array<{ credentialId: string; ciphertext: string }>; wraps: unknown[] } {
    const puts: Array<{ credentialId: string; ciphertext: string }> = [];
    const wraps: unknown[] = [];
    return {
        puts,
        wraps,
        fetchBundle: vi.fn(async () => bundle),
        putCredential: vi.fn(async (credentialId: string, ciphertext: string) => {
            puts.push({ credentialId, ciphertext });
        }),
        listEscrowPending: vi.fn(async () => []),
        wrapEscrowForHost: vi.fn(async (input) => {
            wraps.push(input);
        }),
    };
}

function memoryFs() {
    const files = new Map<string, { data: string; mode: number }>();
    const impl: CredentialFs = {
        mkdirSync: vi.fn(),
        writeFileSync: (file, data, opts) => void files.set(file, { data, mode: opts.mode }),
        chmodSync: (file, mode) => {
            const entry = files.get(file);
            if (entry) entry.mode = mode;
        },
        existsSync: (file) => files.has(file),
        rmSync: (file) => void files.delete(file),
        readFileSync: (file) => {
            const entry = files.get(file);
            if (!entry) throw new Error('ENOENT');
            return entry.data;
        },
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
    it('opens the bundle and materializes each kind to its own destination', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const client = fakeClient(await buildBundle(escrow, host));
        const m = materializeDeps();

        const summary = await refreshManagedCredentials(client, host, m.deps);

        expect(summary.status).toBe('ok');
        expect(summary.credentialIds.sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
        // api_key → env
        expect(managedCredentialEnv()).toEqual({
            ANTHROPIC_API_KEY: FAKE.anthropic,
            OPENAI_API_KEY: FAKE.openai,
        });
        // anthropic/subscription → 0600 file
        expect([...m.files.values()][0]).toEqual({ data: FAKE.claude, mode: 0o600 });
        // github/api_key → gh stdin
        expect(m.ghCalls).toEqual([FAKE.github]);
        // Retained for rotation write-back.
        expect(managedEscrowPublicKey()).toBe(escrow.publicKeyB64);
        expect(managedSubscriptionCredentialId()).toBe('c4');
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
        expect(summary.credentialIds).toEqual([]);
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

    it('resolves a project-scoped api_key per workspace at spawn time', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);
        bundle.credentials.push(
            await credential('cp', ANTHROPIC, API_KEY, 'fake-anthropic-proj', escrow.publicKeyB64, {
                scope: 'project',
                projectId: 'p-42',
            }),
        );
        const m = materializeDeps();

        await refreshManagedCredentials(fakeClient(bundle), host, m.deps);

        expect(managedCredentialEnv('p-42').ANTHROPIC_API_KEY).toBe('fake-anthropic-proj');
        expect(managedCredentialEnv('p-99').ANTHROPIC_API_KEY).toBe(FAKE.anthropic);
        expect(managedCredentialEnv().ANTHROPIC_API_KEY).toBe(FAKE.anthropic);
    });

    it('REFUSES to materialize a host-global credential when project scope is ambiguous', async () => {
        // Two project-scoped GitHub tokens; `gh auth login` is one per host, so
        // picking either would authenticate every agent as one workspace.
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);
        bundle.credentials = [
            await credential('g1', GITHUB, API_KEY, 'fake-gh-1', escrow.publicKeyB64, {
                scope: 'project',
                projectId: 'p-1',
            }),
            await credential('g2', GITHUB, API_KEY, 'fake-gh-2', escrow.publicKeyB64, {
                scope: 'project',
                projectId: 'p-2',
            }),
        ];
        const m = materializeDeps();

        const summary = await refreshManagedCredentials(fakeClient(bundle), host, m.deps);

        expect(m.ghCalls).toEqual([]);
        expect(summary.github?.ok).toBe(false);
        expect(summary.conflicts).toEqual([{ target: 'github', credentialIds: ['g1', 'g2'] }]);
        expect(JSON.stringify(summary)).not.toContain('fake-gh-1');
    });

    it('reports a credential that failed to open by ID and still materializes the rest', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const stranger = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);
        bundle.credentials = [
            bundle.credentials[0],
            await credential('bad', ANTHROPIC, SUBSCRIPTION, FAKE.claude, stranger.publicKeyB64),
        ];
        const m = materializeDeps();

        const summary = await refreshManagedCredentials(fakeClient(bundle), host, m.deps);

        expect(summary.failed).toEqual(['bad']);
        expect(summary.credentialIds).toEqual(['c1']);
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

    it('records a gh failure without leaking the value', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const m = materializeDeps();

        const summary = await refreshManagedCredentials(fakeClient(await buildBundle(escrow, host)), host, {
            ...m.deps,
            runner: { run: async () => ({ code: 1, stderr: `invalid token ${FAKE.github}` }) },
        });

        expect(summary.github?.ok).toBe(false);
        expect(JSON.stringify(summary)).not.toContain(FAKE.github);
    });
});

describe('rotation baseline', () => {
    it('records OUR OWN write as the baseline so it is not mistaken for a CLI rotation', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const client = fakeClient(await buildBundle(escrow, host));
        const m = materializeDeps();

        await refreshManagedCredentials(client, host, m.deps);

        const result = await syncClaudeCredentialRotation(client, {
            homeDir: m.deps.homeDir,
            fs: m.deps.fs,
            escrowPublicKey: escrow.publicKeyB64,
            credentialId: 'c4',
        });

        expect(result.status).toBe('unchanged');
        expect(client.puts).toEqual([]);
    });
});

describe('applyCredentialChange (provider-credential.changed)', () => {
    it('revokes ONE credential: wipes the file and drops it from the next spawn', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const m = materializeDeps();
        await refreshManagedCredentials(fakeClient(await buildBundle(escrow, host)), host, m.deps);
        expect(m.files.size).toBe(1);

        const result = applyCredentialChange({ action: 'revoked', credentialId: 'c4' }, m.deps);

        expect(result.revoked).toEqual(['c4']);
        expect(m.files.size).toBe(0);
        expect(managedSubscriptionCredentialId()).toBeNull();
        // The api keys are untouched — only the revoked credential goes.
        expect(managedCredentialEnv()).toEqual({
            ANTHROPIC_API_KEY: FAKE.anthropic,
            OPENAI_API_KEY: FAKE.openai,
        });
    });

    it('unsets a revoked api_key so the NEXT terminal spawn no longer sees it', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const m = materializeDeps();
        await refreshManagedCredentials(fakeClient(await buildBundle(escrow, host)), host, m.deps);

        applyCredentialChange({ action: 'revoked', credentialId: 'c1' }, m.deps);

        expect(managedCredentialEnv()).toEqual({ OPENAI_API_KEY: FAKE.openai });
    });

    it('does NOT wipe the file when some OTHER credential is revoked', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const m = materializeDeps();
        await refreshManagedCredentials(fakeClient(await buildBundle(escrow, host)), host, m.deps);

        applyCredentialChange({ action: 'revoked', credentialId: 'c2' }, m.deps);

        expect(m.files.size).toBe(1);
        expect(managedSubscriptionCredentialId()).toBe('c4');
    });

    it('reports set/rotated as needing a re-fetch rather than revoking anything', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const m = materializeDeps();
        await refreshManagedCredentials(fakeClient(await buildBundle(escrow, host)), host, m.deps);

        for (const action of ['set', 'rotated'] as const) {
            const result = applyCredentialChange({ action, credentialId: 'c1' }, m.deps);
            expect(result.refetch).toBe(true);
            expect(result.revoked).toEqual([]);
        }
        // Nothing was torn down while we wait for the re-fetch.
        expect(managedCredentialEnv().ANTHROPIC_API_KEY).toBe(FAKE.anthropic);
        expect(m.files.size).toBe(1);
    });

    it('is safe when nothing was ever injected', () => {
        const m = materializeDeps();
        expect(applyCredentialChange({ action: 'revoked', credentialId: 'nope' }, m.deps)).toEqual({
            revoked: [],
            refetch: false,
        });
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
        const wrap = client.wraps[0] as { targetWorkstationId: string; ciphertext: string };
        expect(wrap.targetWorkstationId).toBe('ws-new');
        expect(
            await openEscrowKeypair(
                { publicKeyB64: escrow.publicKeyB64, wrappedPrivateKeyB64: wrap.ciphertext },
                newHost,
            ),
        ).toMatchObject({ publicKeyB64: escrow.publicKeyB64 });
        expect(
            await openEscrowKeypair(
                { publicKeyB64: escrow.publicKeyB64, wrappedPrivateKeyB64: wrap.ciphertext },
                await generateEncryptionKeypair(),
            ),
        ).toBeNull();
        expect(JSON.stringify(summary)).not.toContain(escrow.privateKeyB64);
    });

    it('does NOT call the endpoint at all when this host holds no escrow key', async () => {
        // Tynn 403s a caller that holds no escrow key, so don't ask.
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const client = fakeClient(await buildBundle(escrow, null));
        const m = materializeDeps();
        await refreshManagedCredentials(client, host, m.deps);

        const summary = await bootstrapEscrowForPeers(client);

        expect(summary.status).toBe('no-escrow-key');
        expect(client.listEscrowPending).not.toHaveBeenCalled();
        expect(client.wraps).toEqual([]);
    });

    it('treats a 403/404 from escrow/pending as a STATE, not an error', async () => {
        // 403 = this host holds no escrow key; 404 = the owner has no escrow key
        // at all. Both are normal points in the bootstrap lifecycle — skip quietly
        // and retry next boot rather than surfacing a failure.
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const m = materializeDeps();

        for (const status of [403, 404]) {
            resetManagedCredentials();
            const client = fakeClient(await buildBundle(escrow, host));
            client.listEscrowPending = vi.fn(async () => {
                throw Object.assign(new Error(`HTTP ${status}`), { status });
            });
            await refreshManagedCredentials(client, host, m.deps);

            const summary = await bootstrapEscrowForPeers(client);

            expect(summary.status).toBe('not-applicable');
            expect(summary.wrapped).toEqual([]);
            expect(client.wraps).toEqual([]);
        }
    });

    it('still reports a genuine transport failure as unavailable', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const client = fakeClient(await buildBundle(escrow, host));
        client.listEscrowPending = vi.fn(async () => {
            throw Object.assign(new Error('HTTP 500'), { status: 500 });
        });
        const m = materializeDeps();
        await refreshManagedCredentials(client, host, m.deps);

        expect((await bootstrapEscrowForPeers(client)).status).toBe('unavailable');
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
