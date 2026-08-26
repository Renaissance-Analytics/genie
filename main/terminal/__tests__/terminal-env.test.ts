import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';
import {
    ANTHROPIC,
    API_KEY,
    GITHUB,
    OPENAI,
    SUBSCRIPTION,
    type SealedCredential,
} from '../../host-core/crypto/escrow';
import {
    generateEncryptionKeypair,
    seal,
    sodiumReady,
} from '../../host-core/crypto/sealed-box';
import {
    applyCredentialChange,
    refreshManagedCredentials,
    resetManagedCredentials,
    type ManagedCredentialClient,
} from '../../host-core/crypto/managed-credentials';
import { resetClaudeRotation } from '../../host-core/crypto/claude-rotation';
import { buildTerminalEnv, withToolchainPath } from '../terminal-env';

/**
 * SYNTHETIC KEYS + FAKE VALUES ONLY — the "credentials" here are literals this
 * test invented and the keypairs are generated in-process.
 */

const FAKE = {
    anthropic: 'fake-anthropic-0000',
    anthropicProject: 'fake-anthropic-proj',
    openai: 'fake-openai-0000',
    github: 'fake-gh-token-0000',
    claude: '{"fake":true,"refresh":"fake-refresh-0000"}',
};

const PROJECT = 'proj-42';

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
        const env = buildTerminalEnv(undefined, null, {
            managedEnv: () => ({ ANTHROPIC_API_KEY: FAKE.anthropic }),
            workspaceEnv: () => ({}),
        });

        expect(env).toEqual({ ANTHROPIC_API_KEY: FAKE.anthropic });
    });

    it('lets an explicit workspace .env OVERRIDE the managed credential', () => {
        // A value the human put in the workspace's own .env is a deliberate local
        // override and must win over the fleet-wide managed default.
        const env = buildTerminalEnv('/ws', null, {
            managedEnv: () => ({ ANTHROPIC_API_KEY: FAKE.anthropic }),
            workspaceEnv: () => ({ ANTHROPIC_API_KEY: 'fake-workspace-override' }),
        });

        expect(env.ANTHROPIC_API_KEY).toBe('fake-workspace-override');
    });

    it('keeps non-colliding workspace vars alongside the managed ones', () => {
        const env = buildTerminalEnv('/ws', null, {
            managedEnv: () => ({ OPENAI_API_KEY: FAKE.openai }),
            workspaceEnv: () => ({ TYNN_AGENT_TOKEN: 'rpk_fake' }),
        });

        expect(env).toEqual({ OPENAI_API_KEY: FAKE.openai, TYNN_AGENT_TOKEN: 'rpk_fake' });
    });

    it('passes the workspace project through so scope can be resolved', () => {
        const managedEnv = vi.fn(() => ({}));

        buildTerminalEnv('/ws', PROJECT, { managedEnv, workspaceEnv: () => ({}) });

        expect(managedEnv).toHaveBeenCalledWith(PROJECT);
    });

    it('returns the managed env even with no workspace at all', () => {
        expect(
            buildTerminalEnv(undefined, null, {
                managedEnv: () => ({ OPENAI_API_KEY: FAKE.openai }),
                workspaceEnv: () => {
                    throw new Error('must not be called without a workspace');
                },
            }),
        ).toEqual({ OPENAI_API_KEY: FAKE.openai });
    });
});

describe('buildTerminalEnv (wired to the real managed state)', () => {
    async function injectFleetCredentials(): Promise<void> {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const row = async (
            id: string,
            provider: string,
            kind: string,
            value: string,
            extra: Partial<SealedCredential> = {},
        ): Promise<SealedCredential> => ({
            id,
            provider,
            kind,
            scope: 'account',
            projectId: null,
            sealedTo: 'escrow',
            ciphertext: await seal(value, escrow.publicKeyB64),
            ...extra,
        });

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
                    await row('c1', ANTHROPIC, API_KEY, FAKE.anthropic),
                    await row('c2', OPENAI, API_KEY, FAKE.openai),
                    await row('c3', GITHUB, API_KEY, FAKE.github),
                    await row('c4', ANTHROPIC, SUBSCRIPTION, FAKE.claude),
                    await row('cp', ANTHROPIC, API_KEY, FAKE.anthropicProject, {
                        scope: 'project',
                        projectId: PROJECT,
                    }),
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
                readFileSync: (file) => files.get(file) ?? '',
            },
            runner: { run: async () => ({ code: 0, stderr: '' }) },
        });
    }

    it('a real refresh reaches a real terminal spawn, merged over the real .env', async () => {
        const ws = makeTmpDir('term-env-ws');
        fs.writeFileSync(path.join(ws, '.env'), 'SOME_WORKSPACE_VAR=fake-ws-value\n');
        await injectFleetCredentials();

        const env = buildTerminalEnv(ws, null);

        expect(env.ANTHROPIC_API_KEY).toBe(FAKE.anthropic);
        expect(env.OPENAI_API_KEY).toBe(FAKE.openai);
        expect(env.SOME_WORKSPACE_VAR).toBe('fake-ws-value');
        // The GitHub token and the subscription blob are materialized elsewhere —
        // they must NEVER appear in a child process environment.
        expect(JSON.stringify(env)).not.toContain(FAKE.github);
        expect(JSON.stringify(env)).not.toContain('fake-refresh-0000');
    });

    it("a terminal in the scoped workspace gets that project's override", async () => {
        const ws = makeTmpDir('term-env-scoped');
        await injectFleetCredentials();

        expect(buildTerminalEnv(ws, PROJECT).ANTHROPIC_API_KEY).toBe(FAKE.anthropicProject);
        // A terminal in ANY other workspace keeps the account credential — one
        // workspace's key must never leak into another.
        expect(buildTerminalEnv(ws, 'proj-other').ANTHROPIC_API_KEY).toBe(FAKE.anthropic);
        expect(buildTerminalEnv(ws, null).ANTHROPIC_API_KEY).toBe(FAKE.anthropic);
    });

    it('a REVOKE removes the credential from the very next spawn', async () => {
        const ws = makeTmpDir('term-env-revoke');
        await injectFleetCredentials();
        expect(buildTerminalEnv(ws, null).ANTHROPIC_API_KEY).toBe(FAKE.anthropic);

        applyCredentialChange(
            { action: 'revoked', credentialId: 'c1' },
            { homeDir: makeTmpDir('revoke-home') },
        );

        const env = buildTerminalEnv(ws, null);
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBe(FAKE.openai);
    });

    it('revoking the account key leaves the project override intact for its workspace', async () => {
        const ws = makeTmpDir('term-env-revoke-scoped');
        await injectFleetCredentials();

        applyCredentialChange(
            { action: 'revoked', credentialId: 'c1' },
            { homeDir: makeTmpDir('revoke-scoped-home') },
        );

        expect(buildTerminalEnv(ws, PROJECT).ANTHROPIC_API_KEY).toBe(FAKE.anthropicProject);
        expect(buildTerminalEnv(ws, 'proj-other').ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('injects nothing when no managed credential has been opened', () => {
        expect(buildTerminalEnv(makeTmpDir('term-env-empty'), null)).toEqual({});
    });
});

/**
 * TOOLCHAIN PRECEDENCE reaches every terminal, and therefore every agent.
 *
 * The owner's report: "I uninstalled Herd but apparently php is still running
 * with Herd's config … make sure that Genie and the services and agents that
 * spawn from Genie are using the deps we install."
 *
 * Repairing the main process's PATH is not enough on its own. The detached
 * pty-host is connect-OR-spawn: a host started by an earlier Genie run survives
 * an upgrade — that is the whole point of the sidecar — and keeps the
 * environment it was spawned with. A terminal created against that host would
 * still resolve `php` to Herd however healthy Genie's own PATH had become.
 *
 * Per-terminal env is layered ON TOP of the host's, so setting PATH here is what
 * makes the guarantee hold regardless of which host answers.
 */
describe('toolchain precedence in a terminal environment', () => {
    const SEP = ';';

    it('puts Genie’s managed dirs ahead of a foreign install', () => {
        const env = withToolchainPath(
            {},
            {
                dirs: ['C:/genie/toolchain/php/8.4.24'],
                basePath: ['C:/Users/x/.config/herd/bin', 'C:/Windows/system32'].join(SEP),
                sep: SEP,
            },
        );

        expect(env.PATH!.split(SEP)[0]).toBe('C:/genie/toolchain/php/8.4.24');
        // Positive control: the rest of PATH still reaches the terminal. A
        // terminal that can run php but not git is not a working terminal.
        expect(env.PATH!.split(SEP)).toContain('C:/Windows/system32');
    });

    it('leaves PATH alone when Genie manages nothing yet', () => {
        // A machine with no Genie-installed engine must not get an empty or
        // truncated PATH — that would break every terminal to fix nothing.
        const env = withToolchainPath({}, { dirs: [], basePath: 'C:/Windows/system32', sep: SEP });

        expect(env.PATH).toBeUndefined();
    });

    it('does not clobber an explicit PATH the caller already set', () => {
        // `opts.env` is documented as the final word at the spawn site; a
        // deliberate per-spawn PATH must stay deliberate.
        const env = withToolchainPath(
            { PATH: 'C:/only/this' },
            { dirs: ['C:/genie/toolchain/php/8.4.24'], basePath: 'C:/Windows/system32', sep: SEP },
        );

        expect(env.PATH).toBe('C:/only/this');
    });

    it('keeps the rest of the environment untouched', () => {
        const env = withToolchainPath(
            { TYNN_AGENT_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key' },
            { dirs: ['C:/genie/toolchain/php/8.4.24'], basePath: 'C:/Windows/system32', sep: SEP },
        );

        expect(env.TYNN_AGENT_TOKEN).toBe('tok');
        expect(env.ANTHROPIC_API_KEY).toBe('key');
    });
});

/**
 * WIRING. `withToolchainPath` existing is worth nothing if the assembler does not
 * call it — that is the failure mode this codebase has shipped repeatedly, and
 * `terminal-env.ts` exists specifically so an env concern cannot be added to one
 * spawn path and forgotten on the other.
 */
describe('buildTerminalEnv applies toolchain precedence', () => {
    it('hands the terminal a PATH with Genie’s managed dirs first', () => {
        const env = buildTerminalEnv(undefined, null, {
            managedEnv: () => ({}),
            toolchainDirs: () => ['C:/genie/toolchain/php/8.4.24'],
            basePath: () => ['C:/herd/bin/php84', 'C:/Windows/system32'].join(';'),
            pathSep: () => ';',
        });

        expect(env.PATH?.split(';')[0]).toBe('C:/genie/toolchain/php/8.4.24');
        expect(env.PATH?.split(';')).toContain('C:/Windows/system32');
    });

    it('lets a workspace .env PATH win over the injection', () => {
        // Positive control for the case above AND the documented precedence: a
        // value a human deliberately put in this workspace is a local override.
        const env = buildTerminalEnv('C:/ws', null, {
            managedEnv: () => ({}),
            workspaceEnv: () => ({ PATH: 'C:/deliberate' }),
            toolchainDirs: () => ['C:/genie/toolchain/php/8.4.24'],
            basePath: () => 'C:/Windows/system32',
            pathSep: () => ';',
        });

        expect(env.PATH).toBe('C:/deliberate');
    });
});
