import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupTmpRoot, makeTmpDir } from '../../../../test/helpers';
import { ANTHROPIC, API_KEY, GITHUB, OPENAI, SUBSCRIPTION, type OpenedCredential } from '../escrow';
import {
    CLAUDE_CREDENTIALS_MODE,
    applyGithubToken,
    claudeCredentialsPath,
    credentialEnv,
    envVarForCredential,
    materializeClaudeCredentials,
    resolveHostGlobal,
    wipeClaudeCredentials,
    type CommandRunner,
} from '../credential-materializer';

/**
 * FAKE VALUES ONLY. Every "credential" below is a literal this test invented
 * (`fake-…`); no real provider secret is used. Assertions compare against those
 * literals — nothing decrypted is ever printed.
 */

const FAKE_ANTHROPIC = 'fake-anthropic-0000';
const FAKE_OPENAI = 'fake-openai-0000';
const FAKE_GH = 'fake-gh-token-0000';
const FAKE_CLAUDE_BLOB = '{"fake":true,"refresh":"fake-refresh-0000"}';

function cred(
    id: string,
    provider: string,
    kind: string,
    value: string,
    scope = 'account',
    projectId: string | null = null,
): OpenedCredential {
    return { id, provider, kind, scope, projectId, label: null, value };
}

afterAll(() => cleanupTmpRoot());

describe('envVarForCredential', () => {
    it('maps only the api_key kinds onto env vars', () => {
        expect(envVarForCredential({ provider: ANTHROPIC, kind: API_KEY })).toBe('ANTHROPIC_API_KEY');
        expect(envVarForCredential({ provider: OPENAI, kind: API_KEY })).toBe('OPENAI_API_KEY');
    });

    it('returns null for the kinds materialized through a CLI credential store', () => {
        // Same PROVIDER, different KIND — proving kind is what decides, not provider.
        expect(envVarForCredential({ provider: ANTHROPIC, kind: SUBSCRIPTION })).toBeNull();
        expect(envVarForCredential({ provider: GITHUB, kind: API_KEY })).toBeNull();
        expect(envVarForCredential({ provider: 'something_new', kind: API_KEY })).toBeNull();
    });
});

describe('credentialEnv', () => {
    it('exports the api_key credentials as the env vars the agent CLIs read', () => {
        expect(
            credentialEnv([
                cred('a', ANTHROPIC, API_KEY, FAKE_ANTHROPIC),
                cred('o', OPENAI, API_KEY, FAKE_OPENAI),
            ]),
        ).toEqual({ ANTHROPIC_API_KEY: FAKE_ANTHROPIC, OPENAI_API_KEY: FAKE_OPENAI });
    });

    it('does NOT put the GitHub token or the Claude subscription in the environment', () => {
        // Those two are materialized through their CLI's own credential store, so
        // they must never leak into a child process env (or `ps -e` / a crash dump).
        const env = credentialEnv([
            cred('g', GITHUB, API_KEY, FAKE_GH),
            cred('s', ANTHROPIC, SUBSCRIPTION, FAKE_CLAUDE_BLOB),
        ]);

        expect(env).toEqual({});
        expect(JSON.stringify(env)).not.toContain(FAKE_GH);
        expect(JSON.stringify(env)).not.toContain('fake-refresh-0000');
    });

    it('lets a PROJECT-scoped credential override the account one for its own workspace', () => {
        const credentials = [
            cred('acct', ANTHROPIC, API_KEY, FAKE_ANTHROPIC),
            cred('proj', ANTHROPIC, API_KEY, 'fake-anthropic-proj', 'project', 'p-42'),
        ];

        expect(credentialEnv(credentials, 'p-42').ANTHROPIC_API_KEY).toBe('fake-anthropic-proj');
        // A different workspace, and no workspace at all, both get the account one.
        expect(credentialEnv(credentials, 'p-99').ANTHROPIC_API_KEY).toBe(FAKE_ANTHROPIC);
        expect(credentialEnv(credentials).ANTHROPIC_API_KEY).toBe(FAKE_ANTHROPIC);
    });

    it('uses a project credential even when NO account credential exists', () => {
        const credentials = [cred('proj', OPENAI, API_KEY, FAKE_OPENAI, 'project', 'p-42')];

        expect(credentialEnv(credentials, 'p-42')).toEqual({ OPENAI_API_KEY: FAKE_OPENAI });
        // …but it must NOT leak into an unrelated workspace.
        expect(credentialEnv(credentials, 'p-99')).toEqual({});
        expect(credentialEnv(credentials)).toEqual({});
    });

    it('drops blank values rather than exporting empty strings', () => {
        expect(credentialEnv([cred('a', ANTHROPIC, API_KEY, '   ')])).toEqual({});
    });
});

describe('resolveHostGlobal (single-slot materializations)', () => {
    // `gh auth login` and ~/.claude/.credentials.json are ONE per host — there is
    // no per-project variant of either — so project scope cannot be honoured and
    // the host must not silently pick a workspace's identity for the whole box.

    it('prefers the account-scoped credential', () => {
        const resolved = resolveHostGlobal(
            [
                cred('proj', ANTHROPIC, SUBSCRIPTION, 'fake-proj-blob', 'project', 'p-1'),
                cred('acct', ANTHROPIC, SUBSCRIPTION, FAKE_CLAUDE_BLOB),
            ],
            ANTHROPIC,
            SUBSCRIPTION,
        );

        expect(resolved.status).toBe('ok');
        expect(resolved.credential?.id).toBe('acct');
    });

    it('falls back to a project-scoped credential when it is the ONLY one', () => {
        const resolved = resolveHostGlobal(
            [cred('proj', GITHUB, API_KEY, FAKE_GH, 'project', 'p-1')],
            GITHUB,
            API_KEY,
        );

        expect(resolved.status).toBe('ok');
        expect(resolved.credential?.id).toBe('proj');
    });

    it('REFUSES to guess between several project-scoped credentials', () => {
        // Picking one would silently authenticate every agent on the host as one
        // workspace's identity — worse than having no credential at all.
        const resolved = resolveHostGlobal(
            [
                cred('p1', GITHUB, API_KEY, 'fake-gh-1', 'project', 'p-1'),
                cred('p2', GITHUB, API_KEY, 'fake-gh-2', 'project', 'p-2'),
            ],
            GITHUB,
            API_KEY,
        );

        expect(resolved.status).toBe('ambiguous');
        expect(resolved.credential).toBeUndefined();
        expect(resolved.conflictIds).toEqual(['p1', 'p2']);
    });

    it('reports absent when nothing matches the provider+kind', () => {
        expect(resolveHostGlobal([cred('a', ANTHROPIC, API_KEY, FAKE_ANTHROPIC)], GITHUB, API_KEY))
            .toMatchObject({ status: 'absent' });
        expect(resolveHostGlobal([], ANTHROPIC, SUBSCRIPTION)).toMatchObject({ status: 'absent' });
    });
});

describe('materializeClaudeCredentials', () => {
    it('writes ~/.claude/.credentials.json with 0600 and a 0700 parent', () => {
        const home = makeTmpDir('mat-home');
        const written: Array<{ file: string; mode: number }> = [];
        const mkdirs: Array<{ dir: string; mode?: number }> = [];

        const result = materializeClaudeCredentials(FAKE_CLAUDE_BLOB, {
            homeDir: home,
            fs: {
                mkdirSync: (dir, opts) => void mkdirs.push({ dir, mode: opts?.mode }),
                writeFileSync: (file, _data, opts) => void written.push({ file, mode: opts.mode }),
                chmodSync: vi.fn(),
                existsSync: () => false,
                rmSync: vi.fn(),
            },
        });

        expect(result.ok).toBe(true);
        expect(result.path).toBe(path.join(home, '.claude', '.credentials.json'));
        expect(written).toEqual([{ file: result.path, mode: CLAUDE_CREDENTIALS_MODE }]);
        expect(CLAUDE_CREDENTIALS_MODE).toBe(0o600);
        expect(mkdirs).toEqual([{ dir: path.join(home, '.claude'), mode: 0o700 }]);
    });

    it('really lands 0600 on disk (POSIX modes; Windows has no POSIX bits)', () => {
        const home = makeTmpDir('mat-real');

        const result = materializeClaudeCredentials(FAKE_CLAUDE_BLOB, { homeDir: home });

        expect(result.ok).toBe(true);
        expect(fs.readFileSync(result.path, 'utf8')).toBe(FAKE_CLAUDE_BLOB);
        if (process.platform !== 'win32') {
            expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
            expect(fs.statSync(path.dirname(result.path)).mode & 0o777).toBe(0o700);
        }
    });

    it('re-applies 0600 when the file already exists with looser modes', () => {
        const home = makeTmpDir('mat-relax');
        const dir = path.join(home, '.claude');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, '.credentials.json');
        fs.writeFileSync(file, 'stale', { mode: 0o644 });

        materializeClaudeCredentials(FAKE_CLAUDE_BLOB, { homeDir: home });

        expect(fs.readFileSync(file, 'utf8')).toBe(FAKE_CLAUDE_BLOB);
        if (process.platform !== 'win32') {
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }
    });

    it('REFUSES to write a blank value (never truncates a good credential to nothing)', () => {
        const home = makeTmpDir('mat-blank');
        const writeFileSync = vi.fn();

        const result = materializeClaudeCredentials('   ', {
            homeDir: home,
            fs: {
                mkdirSync: vi.fn(),
                writeFileSync,
                chmodSync: vi.fn(),
                existsSync: () => false,
                rmSync: vi.fn(),
            },
        });

        expect(result.ok).toBe(false);
        expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('reports a write failure WITHOUT echoing the value into the reason', () => {
        const home = makeTmpDir('mat-fail');

        const result = materializeClaudeCredentials(FAKE_CLAUDE_BLOB, {
            homeDir: home,
            fs: {
                mkdirSync: vi.fn(),
                writeFileSync: () => {
                    throw new Error(`EACCES writing ${FAKE_CLAUDE_BLOB}`);
                },
                chmodSync: vi.fn(),
                existsSync: () => false,
                rmSync: vi.fn(),
            },
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toBeTruthy();
        expect(result.reason).not.toContain('fake-refresh-0000');
    });
});

describe('wipeClaudeCredentials (immediate revoke)', () => {
    it('removes the materialized file at once', () => {
        const home = makeTmpDir('wipe-home');
        const { path: file } = materializeClaudeCredentials(FAKE_CLAUDE_BLOB, { homeDir: home });
        expect(fs.existsSync(file)).toBe(true);

        expect(wipeClaudeCredentials({ homeDir: home })).toBe(true);

        expect(fs.existsSync(file)).toBe(false);
    });

    it('is idempotent when there is nothing to wipe', () => {
        const home = makeTmpDir('wipe-empty');
        expect(wipeClaudeCredentials({ homeDir: home })).toBe(true);
        expect(wipeClaudeCredentials({ homeDir: home })).toBe(true);
    });

    it('reports false rather than throwing when the file cannot be removed', () => {
        const ok = wipeClaudeCredentials({
            homeDir: makeTmpDir('wipe-fail'),
            fs: {
                mkdirSync: vi.fn(),
                writeFileSync: vi.fn(),
                chmodSync: vi.fn(),
                existsSync: () => true,
                rmSync: () => {
                    throw new Error('EBUSY');
                },
            },
        });
        expect(ok).toBe(false);
    });

    it('resolves the credential path under the injected home', () => {
        expect(claudeCredentialsPath('/tmp/h')).toBe(path.join('/tmp/h', '.claude', '.credentials.json'));
    });
});

describe('applyGithubToken', () => {
    function recordingRunner(code = 0, stderr = ''): CommandRunner & { calls: unknown[] } {
        const calls: unknown[] = [];
        return {
            calls,
            run: vi.fn(async (command, args, opts) => {
                calls.push({ command, args, input: opts.input });
                return { code, stderr };
            }),
        };
    }

    it('pipes the token on STDIN — NEVER as a command-line argument', async () => {
        const runner = recordingRunner();

        const result = await applyGithubToken(FAKE_GH, { runner });

        expect(result.ok).toBe(true);
        expect(runner.calls).toHaveLength(1);
        const call = runner.calls[0] as { command: string; args: string[]; input: string };
        expect(call.command).toBe('gh');
        expect(call.args).toEqual(['auth', 'login', '--hostname', 'github.com', '--with-token']);
        expect(call.input).toBe(FAKE_GH);
        // argv is world-readable in `ps` — the token must appear ONLY on stdin.
        expect(call.args.join(' ')).not.toContain(FAKE_GH);
    });

    it('reports failure without echoing the token, even when gh does', async () => {
        const runner = recordingRunner(1, `bad token: ${FAKE_GH}`);

        const result = await applyGithubToken(FAKE_GH, { runner });

        expect(result.ok).toBe(false);
        expect(result.reason).toBeTruthy();
        expect(result.reason).not.toContain(FAKE_GH);
    });

    it('reports failure without throwing when gh is not installed', async () => {
        const result = await applyGithubToken(FAKE_GH, {
            runner: {
                run: async () => {
                    throw new Error('spawn gh ENOENT');
                },
            },
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/gh/i);
    });

    it('refuses a blank token instead of running gh with nothing', async () => {
        const runner = recordingRunner();
        const result = await applyGithubToken('  ', { runner });

        expect(result.ok).toBe(false);
        expect(runner.calls).toEqual([]);
    });
});
