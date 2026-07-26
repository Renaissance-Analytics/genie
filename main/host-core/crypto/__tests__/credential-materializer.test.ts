import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupTmpRoot, makeTmpDir } from '../../../../test/helpers';
import {
    ANTHROPIC_API_KEY,
    CLAUDE_SUBSCRIPTION,
    GITHUB_TOKEN,
    OPENAI_API_KEY,
} from '../escrow';
import {
    CLAUDE_CREDENTIALS_MODE,
    applyGithubToken,
    claudeCredentialsPath,
    credentialEnv,
    materializeClaudeCredentials,
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

afterAll(() => cleanupTmpRoot());

describe('credentialEnv', () => {
    it('maps the API-key providers onto the env vars the agent CLIs read', () => {
        expect(
            credentialEnv({ [ANTHROPIC_API_KEY]: FAKE_ANTHROPIC, [OPENAI_API_KEY]: FAKE_OPENAI }),
        ).toEqual({ ANTHROPIC_API_KEY: FAKE_ANTHROPIC, OPENAI_API_KEY: FAKE_OPENAI });
    });

    it('does NOT put the GitHub token or the Claude subscription in the environment', () => {
        // Those two are materialized through their CLI's own credential store, so
        // they must never leak into a child process env (or `ps -e` / a crash dump).
        const env = credentialEnv({
            [GITHUB_TOKEN]: FAKE_GH,
            [CLAUDE_SUBSCRIPTION]: FAKE_CLAUDE_BLOB,
        });

        expect(env).toEqual({});
        expect(JSON.stringify(env)).not.toContain(FAKE_GH);
        expect(JSON.stringify(env)).not.toContain('fake-refresh-0000');
    });

    it('ignores unknown providers and blank values rather than exporting empties', () => {
        expect(
            credentialEnv({ something_new: 'fake-x', [ANTHROPIC_API_KEY]: '   ' }),
        ).toEqual({});
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
