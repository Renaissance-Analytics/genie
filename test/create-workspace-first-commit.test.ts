import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, type WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';
import { nodeWorkspaceFs } from '../src/main/workspace-fs.js';
import { writeAgentGitignore } from '../src/main/agent-gitignore.js';
import { writeAgentRouters } from '../src/main/agent-routers.js';

/**
 * NEW WORKSPACE MAKES ITS FIRST COMMIT (Add workspace parity, item 1). The card promises it — "Name it, say where it
 * lives. Genie makes the folder and its first commit." (AddWorkspaceModal.tsx) — and Genie 1's createAgiEnvelope did it:
 * the skeleton with .gitkeep files, a .gitignore keeping sandbox/ and .trash/ out, README/AGENTS/CLAUDE, `git init
 * --initial-branch=main`, an identity when the machine has none, one commit. Genie 2 ran a bare `git init` and stopped.
 *
 * Measured with the REAL git and the SAME filesystem functions main.ts hands the workspace ops (workspace-fs.ts), in a
 * temp folder: the branch, the commit count, what is tracked, what is ignored, and who the commit is by. Git's global
 * config is a file this test owns (GIT_CONFIG_GLOBAL), so "no identity" and "an identity" are both real states, and the
 * person's own config is never read or written. Every absence is paired with a presence measured the same way.
 */

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
/** `git check-ignore -q`: exit 0 = ignored, exit 1 = not ignored. Anything else is a broken probe, and throws. */
const ignored = async (cwd: string, path: string): Promise<boolean> => {
    try { await run('git', ['check-ignore', '-q', '--', path], { cwd }); return true; } catch (error) {
        if ((error as { code?: number }).code === 1) return false;
        throw error;
    }
};

let dir: string;
let globalConfig: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-first-commit-'));
    globalConfig = join(dir, 'global.gitconfig');
    await writeFile(globalConfig, '');
    // A git that knows nothing but what this test gives it: no system config, a global config file of the test's own, and
    // no identity from the environment (git would take EMAIL or GIT_AUTHOR_* over any config).
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    for (const k of ['EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) vi.stubEnv(k, undefined);
});
afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
});

function ports(): WorkspaceOpsPorts {
    const workspaces = new Map<string, { id: string; path: string; asleep: boolean }>();
    return {
        fs: { ...nodeWorkspaceFs(), gitClone: async () => { throw new Error('no clone in this test'); } },
        registry: {
            workspace: (id) => workspaces.get(id) ?? null,
            addWorkspace: async (w) => { workspaces.set(w.id, { ...w, asleep: false }); },
            agentsOf: () => [],
            setAsleep: async () => false,
            forgetWorkspace: async () => null,
        },
        host: { probe: () => null, prompt: () => false, stop: () => false },
        attention: { finished: () => [] },
        terminals: { list: () => [], close: () => false },
        supervisor: { list: () => [], stop: () => false },
        now: () => Date.now(),
        sleep: async () => {},
    };
}

async function create(name = 'Acme Storefront'): Promise<string> {
    const parent = join(dir, 'parent');
    await mkdir(parent);
    const r = await createWorkspace(ports(), name, parent);
    expect(r).toMatchObject({ ok: true });
    return (r as { path: string }).path;
}

describe('New workspace: a real repository with its first commit, as the card promises', () => {
    it('is on main, with exactly one commit, and everything Genie wrote is tracked and committed', async () => {
        const ws = await create();
        expect(await git(ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
        expect(await git(ws, 'rev-list', '--count', 'HEAD')).toBe('1');
        // Genie 1's subject, with the folder in it (Genie 1 wrote a literal `{slug}`).
        expect(await git(ws, 'log', '-1', '--format=%s')).toBe('Initial commit — acme-storefront.agi envelope scaffolded by Genie');

        const tracked = (await git(ws, 'ls-files')).split('\n');
        for (const f of ['project.json', '.gitignore', 'README.md', 'RULES.md', 'AGENTS.md', 'CLAUDE.md', 'repos/.gitkeep', '.ai/plans/.gitkeep', '.ai/knowledge/.gitkeep', '.ai/pm/.gitkeep', '.ai/chat/.gitkeep', '.ai/memory/.gitkeep', '.ai/issues/.gitkeep', 'sandbox/.gitkeep', '.trash/.gitkeep']) {
            expect(tracked).toContain(f);
        }
        // Nothing written was left out of the commit.
        expect(await git(ws, 'status', '--porcelain')).toBe('');
        // The manifest is the one the workspace is registered with: its name, the published schema.
        const manifest = JSON.parse(await readFile(join(ws, 'project.json'), 'utf8')) as Record<string, unknown>;
        expect(manifest).toMatchObject({ name: 'Acme Storefront', type: 'agi', repos: [], $schema: expect.stringContaining('Civicognita/shared-schemas') });
    }, 60_000);

    it('keeps sandbox/ and .trash/ out of git, and nothing else of the envelope', async () => {
        const ws = await create();
        await writeFile(join(ws, 'sandbox', 'scratch.txt'), 'x');
        await writeFile(join(ws, '.trash', 'old.txt'), 'x');
        await writeFile(join(ws, '.ai', 'knowledge', 'note.md'), 'x');
        expect(await ignored(ws, 'sandbox/scratch.txt')).toBe(true);
        expect(await ignored(ws, '.trash/old.txt')).toBe(true);
        // Genie's token-carrying MCP config is never committed either (agent-gitignore.ts).
        expect(await ignored(ws, '.mcp.json')).toBe(true);
        // Positive controls, measured the same way: knowledge is NOT ignored, and the folders' own .gitkeep stays tracked.
        expect(await ignored(ws, '.ai/knowledge/note.md')).toBe(false);
        expect(await ignored(ws, 'sandbox/.gitkeep')).toBe(false);
        const status = (await git(ws, 'status', '--porcelain', '--untracked-files=all')).split('\n');
        expect(status).toContain('?? .ai/knowledge/note.md');
        expect(status.filter((l) => l.includes('sandbox/') || l.includes('.trash/'))).toEqual([]);
    }, 60_000);

    it('with no git identity on the machine, commits as Genie’s GitHub App bot — for that commit only', async () => {
        const ws = await create();
        expect(await git(ws, 'log', '-1', '--format=%an <%ae>')).toBe('genie-aos[bot] <294734720+genie-aos[bot]@users.noreply.github.com>');
        // Per-command config: nothing is written into the repository or the global config.
        expect(await readFile(join(ws, '.git', 'config'), 'utf8')).not.toMatch(/\[user\]|name =|email =/);
        expect(await readFile(globalConfig, 'utf8')).toBe('');
    }, 60_000);

    it('with an identity configured, the commit is the person’s, and their config is unchanged', async () => {
        const config = '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n';
        await writeFile(globalConfig, config);
        const ws = await create();
        expect(await git(ws, 'log', '-1', '--format=%an <%ae>')).toBe('Ada Lovelace <ada@example.com>');
        expect(await readFile(globalConfig, 'utf8')).toBe(config);
    }, 60_000);

    it('a half identity is completed, not replaced', async () => {
        await writeFile(globalConfig, '[user]\n\tname = Ada Lovelace\n');
        const ws = await create();
        expect(await git(ws, 'log', '-1', '--format=%an <%ae>')).toBe('Ada Lovelace <294734720+genie-aos[bot]@users.noreply.github.com>');
    }, 60_000);

    /*
     * CLAUDE.md is a REAL file, never a symlink: Genie 2's agent-routers.ts replaces a symlinked harness file because
     * Genie 1 wrote the Claude router THROUGH its symlink into AGENTS.md. Both are Genie 2's routers to README/RULES, and
     * the first sync Genie runs on the workspace (the .gitignore lines, the routers) finds the commit already right.
     */
    it('AGENTS.md and CLAUDE.md are real router files, and Genie’s first sync changes nothing that was committed', async () => {
        const ws = await create();
        expect((await lstat(join(ws, 'CLAUDE.md'))).isSymbolicLink()).toBe(false);
        expect(await git(ws, 'ls-files', '-s', 'CLAUDE.md')).toMatch(/^100644 /);
        expect(await readFile(join(ws, 'CLAUDE.md'), 'utf8')).toContain('@.agents/_genie/genie-claude.md');
        expect(await readFile(join(ws, 'AGENTS.md'), 'utf8')).toContain('@.agents/_genie/genie-codex.md');
        for (const f of ['AGENTS.md', 'CLAUDE.md']) expect(await readFile(join(ws, f), 'utf8')).toContain('@RULES.md');
        expect(await readFile(join(ws, 'RULES.md'), 'utf8')).toContain('The envelope never commits code that belongs to a submodule.');
        expect(await readFile(join(ws, 'README.md'), 'utf8')).toMatch(/^# Acme Storefront\n\nThis is a \*\*`\.agi` envelope\*\*/);

        const nodeFs = {
            read: async (p: string) => { try { return await readFile(p, 'utf8'); } catch { return null; } },
            write: async (p: string, text: string) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, text, 'utf8'); },
            unlink: (p: string) => unlink(p),
            isSymlink: async (p: string) => { try { return (await lstat(p)).isSymbolicLink(); } catch { return false; } },
            exists: async (p: string) => { try { await lstat(p); return true; } catch { return false; } },
            list: async (d: string) => { try { return await readdir(d); } catch { return []; } },
        };
        await writeAgentGitignore({ workspacePath: ws, fs: nodeFs });
        await writeAgentRouters({ workspacePath: ws, fs: nodeFs, stamp: '20261021' });
        expect(await git(ws, 'status', '--porcelain', '--untracked-files=all')).toBe('');
        // Positive control: the probe sees a change to a tracked file.
        await writeFile(join(ws, 'RULES.md'), 'changed\n');
        expect(await git(ws, 'status', '--porcelain')).toBe('M RULES.md');
    }, 60_000);
});
