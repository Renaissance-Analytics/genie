import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesHost } from '../src/main/files-host.js';
import { gitFileStatus } from '../src/main/git-ports.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE PERSONA'S GIT STATE (the board's rail: `.agents/sable.md · committed`). Whether the persona a session runs on is
 * the committed one is a fact git holds: `committed` (tracked, no changes), `uncommitted changes`, or `not committed`
 * (untracked). Read with git itself on the file's own repository; a folder that is not a repository says nothing —
 * no status, never a guess. The status rides the files host's `open`, so every opened file carries it.
 */
const run = promisify(execFile);
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-persona-git-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('gitFileStatus against a real git', () => {
    it('committed, then uncommitted changes, an untracked file not committed, and nothing outside a repository', async () => {
        const work = join(dir, 'work');
        await run('git', ['init', '--quiet', '--initial-branch=main', work]);
        await mkdir(join(work, '.agents', 'sable'), { recursive: true });
        await writeFile(join(work, '.agents', 'sable', 'AGENT.md'), '# sable\n');
        await run('git', ['-C', work, 'add', '.']);
        await run('git', ['-C', work, 'commit', '--quiet', '-m', 'persona'], { env });
        expect(await gitFileStatus(work, '.agents/sable/AGENT.md')).toBe('committed');
        await writeFile(join(work, '.agents', 'sable', 'AGENT.md'), '# sable\nnew line\n');
        expect(await gitFileStatus(work, '.agents/sable/AGENT.md')).toBe('modified');
        await writeFile(join(work, 'notes.md'), 'x\n');
        expect(await gitFileStatus(work, 'notes.md')).toBe('untracked');
        const plain = join(dir, 'plain');
        await mkdir(plain);
        await writeFile(join(plain, 'a.md'), 'x\n');
        expect(await gitFileStatus(plain, 'a.md')).toBeNull();
    }, 30_000);
});

describe('the files host carries it on open', () => {
    it('from its git port; without one an opened file has no status (positive control)', async () => {
        await writeFile(join(dir, 'a.md'), 'x\n');
        const ports = { workspace: (id: string) => (id === 'tynn' ? { id: 'tynn', path: dir } : null), agentsOf: () => [], eventsOf: () => [] };
        const withGit = new FilesHost({ ...ports, gitStatus: async (root, rel) => (root === dir && rel === 'a.md' ? 'committed' : null) });
        expect(await withGit.open('tynn', 'a.md')).toMatchObject({ ok: true, text: 'x\n', git: 'committed' });
        expect(await new FilesHost(ports).open('tynn', 'a.md')).not.toHaveProperty('git');
    });
});

describe('the rail', () => {
    const session = { running: true, turnState: 'idle' as const, startedAt: null, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, model: null };
    const render = (git: 'committed' | 'modified' | 'untracked' | null) => renderToStaticMarkup(
        <AgentView agent={{ id: 'sable', name: 'sable', provider: 'claude', fidelity: 'declared', cwd: '.', instructions: '.agents/sable/AGENT.md' }} session={session} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 1} personaText="# sable" personaGit={git} />,
    );

    it('`committed`, `uncommitted changes`, `not committed` after the path; nothing when git said nothing', () => {
        expect(render('committed')).toMatch(/data-persona-git="committed"[^>]*>committed</);
        expect(render('modified')).toMatch(/data-persona-git="modified"[^>]*>uncommitted changes</);
        expect(render('untracked')).toMatch(/data-persona-git="untracked"[^>]*>not committed</);
        expect(render(null)).not.toContain('data-persona-git');
    });
});
