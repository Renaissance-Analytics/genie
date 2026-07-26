import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';
import {
    ANTHROPIC_API_KEY,
    CLAUDE_SUBSCRIPTION,
    GITHUB_TOKEN,
    OPENAI_API_KEY,
} from '../../host-core/crypto/escrow';
import {
    generateEncryptionKeypair,
    seal,
    sodiumReady,
    type EncryptionKeypair,
} from '../../host-core/crypto/sealed-box';
import {
    applyCredentialRevoke,
    refreshManagedCredentials,
    resetManagedCredentials,
    type ManagedCredentialClient,
} from '../../host-core/crypto/managed-credentials';
import { resetClaudeRotation } from '../../host-core/crypto/claude-rotation';
import { buildTerminalEnv } from '../terminal-env';

/**
 * SYNTHETIC KEYS + FAKE VALUES ONLY — the "credentials" here are literals this
 * test invented and the keypairs are generated in-process.
 */

const FAKE = {
    anthropic: 'fake-anthropic-0000',
    openai: 'fake-openai-0000',
    github: 'fake-gh-token-0000',
    claude: '{"fake":true,"refresh":"fake-refresh-0000"}',
};

beforeAll(async () => {
    await sodiumReady();
});

afterEach(() => {
    resetManagedCredentials();
    resetClaudeRotation();
});

afterAll(() => cleanupTmpRoot());

describe('buildTerminalEnv (merge order)', () => {
    it('injects the managed credentials into a terminal env', () => {
        const env = buildTerminalEnv(undefined, {
            managedEnv: () => ({ ANTHROPIC_API_KEY: FAKE.anthropic }),
            workspaceEnv: () => ({}),
        });

        expect(env).toEqual({ ANTHROPIC_API_KEY: FAKE.anthropic });
    });

    it('lets an explicit workspace .env OVERRIDE the managed credential', () => {
        // A value the human put in the workspace's own .env is a deliberate local
        // override and must win over the fleet-wide managed default.
        const env = buildTerminalEnv('/ws', {
            managedEnv: () => ({ ANTHROPIC_API_KEY: FAKE.anthropic }),
            workspaceEnv: () => ({ ANTHROPIC_API_KEY: 'fake-workspace-override' }),
        });

        expect(env.ANTHROPIC_API_KEY).toBe('fake-workspace-override');
    });

    it('keeps non-colliding workspace vars alongside the managed ones', () => {
        const env = buildTerminalEnv('/ws', {
            managedEnv: () => ({ OPENAI_API_KEY: FAKE.openai }),
            workspaceEnv: () => ({ TYNN_AGENT_TOKEN: 'rpk_fake' }),
        });

        expect(env).toEqual({ OPENAI_API_KEY: FAKE.openai, TYNN_AGENT_TOKEN: 'rpk_fake' });
    });

    it('returns the managed env even with no workspace at all', () => {
        expect(
            buildTerminalEnv(undefined, {
                managedEnv: () => ({ OPENAI_API_KEY: FAKE.openai }),
                workspaceEnv: () => {
                    throw new Error('must not be called without a workspace');
                },
            }),
        ).toEqual({ OPENAI_API_KEY: FAKE.openai });
    });
});

describe('buildTerminalEnv (wired to the real managed state)', () => {
    async function injectFleetCredentials(): Promise<{ escrow: EncryptionKeypair }> {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const client: ManagedCredentialClient = {
            fetchBundle: async () => ({
                escrow: {
                    publicKeyB64: escrow.publicKeyB64,
                    wrappedPrivateKeyB64: await seal(
                        Buffer.from(escrow.privateKeyB64, 'base64'),
                        host.publicKeyB64,
                    ),
                },
                credentials: [
                    {
                        provider: ANTHROPIC_API_KEY,
                        ciphertext: await seal(FAKE.anthropic, escrow.publicKeyB64),
                    },
                    {
                        provider: OPENAI_API_KEY,
                        ciphertext: await seal(FAKE.openai, escrow.publicKeyB64),
                    },
                    {
                        provider: GITHUB_TOKEN,
                        ciphertext: await seal(FAKE.github, escrow.publicKeyB64),
                    },
                    {
                        provider: CLAUDE_SUBSCRIPTION,
                        ciphertext: await seal(FAKE.claude, escrow.publicKeyB64),
                    },
                ],
            }),
            putCredential: vi.fn(),
            listEscrowPending: vi.fn(async () => []),
            wrapEscrowForHost: vi.fn(),
        };
        const files = new Map<string, string>();
        await refreshManagedCredentials(client, host, {
            homeDir: makeTmpDir('term-env-home'),
            fs: {
                mkdirSync: vi.fn(),
                writeFileSync: (file, data) => void files.set(file, data),
                chmodSync: vi.fn(),
                existsSync: (file) => files.has(file),
                rmSync: (file) => void files.delete(file),
            },
            runner: { run: async () => ({ code: 0, stderr: '' }) },
        });
        return { escrow };
    }

    it('a real refresh reaches a real terminal spawn, merged over the real .env', async () => {
        const ws = makeTmpDir('term-env-ws');
        fs.writeFileSync(path.join(ws, '.env'), 'SOME_WORKSPACE_VAR=fake-ws-value\n');
        await injectFleetCredentials();

        const env = buildTerminalEnv(ws);

        expect(env.ANTHROPIC_API_KEY).toBe(FAKE.anthropic);
        expect(env.OPENAI_API_KEY).toBe(FAKE.openai);
        expect(env.SOME_WORKSPACE_VAR).toBe('fake-ws-value');
        // The GitHub token and the subscription blob are materialized elsewhere —
        // they must NEVER appear in a child process environment.
        expect(JSON.stringify(env)).not.toContain(FAKE.github);
        expect(JSON.stringify(env)).not.toContain('fake-refresh-0000');
    });

    it('a REVOKE removes the credential from the very next spawn', async () => {
        const ws = makeTmpDir('term-env-revoke');
        await injectFleetCredentials();
        expect(buildTerminalEnv(ws).ANTHROPIC_API_KEY).toBe(FAKE.anthropic);

        applyCredentialRevoke({ provider: ANTHROPIC_API_KEY }, { homeDir: makeTmpDir('revoke-home') });

        const env = buildTerminalEnv(ws);
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBe(FAKE.openai);
    });

    it('an ALL-revoke leaves a spawn with no managed credential at all', async () => {
        const ws = makeTmpDir('term-env-revoke-all');
        await injectFleetCredentials();

        applyCredentialRevoke({ all: true }, { homeDir: makeTmpDir('revoke-all-home') });

        expect(buildTerminalEnv(ws)).toEqual({});
    });

    it('injects nothing when no managed credential has been opened', () => {
        expect(buildTerminalEnv(makeTmpDir('term-env-empty'))).toEqual({});
    });
});
