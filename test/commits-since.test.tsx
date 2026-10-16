import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitLogSince } from '../src/main/git-ports.js';
import { buildHostApi } from '../src/main/host-api.js';
import { commitsSinceIn, type RepoOpsPorts } from '../src/main/repo-ops-host.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * COMMITS since the Take Over window opened (the board's blind index): git's own account of every registered repo,
 * merged newest first, each with its author and repo. A folder that is not a repository is an empty list; a remote
 * window reads it like any read.
 */
const run = promisify(execFile);
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };

describe('gitLogSince against a real git', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-commits-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('returns the commits after the moment, newest first, with sha, subject, author and time; none before it; nothing for a plain folder', async () => {
        const work = join(dir, 'work');
        await run('git', ['init', '--quiet', '--initial-branch=main', work]);
        const commit = async (name: string, when: string) => {
            await writeFile(join(work, name), `${name}\n`);
            await run('git', ['-C', work, 'add', name]);
            await run('git', ['-C', work, 'commit', '--quiet', '-m', `add ${name}`], { env: { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
        };
        await commit('old.txt', '2026-10-12T10:00:00Z');
        await commit('new.txt', '2026-10-12T12:00:00Z');
        await commit('newer.txt', '2026-10-12T12:30:00Z');

        const since = Date.parse('2026-10-12T11:00:00Z');
        const log = await gitLogSince(work, since);
        expect(log.map((c) => c.subject)).toEqual(['add newer.txt', 'add new.txt']);
        expect(log[0]).toMatchObject({ author: 't', at: Date.parse('2026-10-12T12:30:00Z') });
        expect(log[0]!.sha).toMatch(/^[0-9a-f]{7,}$/);
        expect(await gitLogSince(dir, since)).toEqual([]);
    }, 30_000);
});

describe('commitsSinceIn', () => {
    const manifest = { name: 'tynn', type: 'agi', repos: [{ name: 'tynn.ai', slug: 'tynn-ai', path: '.' }, { name: 'genie2', slug: 'genie2', path: 'repos/genie2' }] };
    const ports = (gitLog: NonNullable<RepoOpsPorts['gitLog']>): RepoOpsPorts => ({
        fs: { exists: async () => true, readJson: async (p) => (p.replace(/\\/g, '/') === '/w/tynn/project.json' ? manifest : null), writeJson: async () => {} },
        registry: { workspace: (id) => (id === 'tynn' ? { id: 'tynn', path: '/w/tynn' } : null) },
        gitLog,
    });

    it('merges every repo’s commits newest first, each with its slug; an unknown workspace is a reason', async () => {
        const seen: string[] = [];
        const r = await commitsSinceIn(ports(async (path, since) => {
            seen.push(`${path.replace(/\\/g, '/')}@${since}`);
            return path.endsWith('genie2') ? [{ sha: 'b2', subject: 'two', author: 'kora', at: 2_000 }] : [{ sha: 'a3', subject: 'three', author: 'you', at: 3_000 }, { sha: 'a1', subject: 'one', author: 'you', at: 1_000 }];
        }), 'tynn', 500);
        expect(r).toEqual({ ok: true, commits: [
            { repo: 'tynn-ai', sha: 'a3', subject: 'three', author: 'you', at: 3_000 },
            { repo: 'genie2', sha: 'b2', subject: 'two', author: 'kora', at: 2_000 },
            { repo: 'tynn-ai', sha: 'a1', subject: 'one', author: 'you', at: 1_000 },
        ] });
        expect(seen).toEqual(['/w/tynn@500', '/w/tynn/repos/genie2@500']);
        expect(await commitsSinceIn(ports(async () => []), 'nope', 1)).toEqual({ ok: false, reason: 'no workspace "nope"' });
    });
});

describe('a remote window', () => {
    it('reads commits through the host, or is refused when the host cannot', async () => {
        const withIt = buildHostApi({ workspaceOps: { commitsSince: async (id: string, since: number) => ({ ok: true, commits: [], id, since }) } } as never);
        expect(await withIt.invoke('workspaces.commitsSince', ['tynn', 7])).toEqual({ ok: true, commits: [], id: 'tynn', since: 7 });
        const without = buildHostApi({ workspaceOps: {} } as never);
        expect(await without.invoke('workspaces.commitsSince', ['tynn', 7])).toEqual({ ok: false, reason: 'this host cannot read commits' });
    });
});

describe('the Activity tab', () => {
    const agent = { id: 'k1', name: 'kora', provider: 'claude', fidelity: 'observed' as const, cwd: '/w/tynn', instructions: null };
    const render = (commits: { repo: string; sha: string; subject: string; author: string; at: number }[] | null) =>
        renderToStaticMarkup(<AgentView agent={agent} session={null} rows={[]} tab="activity" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 100_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} takeOver={{ terminalId: 't1', startedAt: 50_000, lastOutputAt: null, bursts: [] }} initialCommits={commits} />);

    it('lists the commits with sha, subject, author and repo', () => {
        const html = render([{ repo: 'genie2', sha: '9e1c2af', subject: 'Agent view: the cursor', author: 'kora', at: 60_000 }]);
        expect(html).toContain('data-observed-commits="k1"');
        expect(html).toMatch(/data-observed-commit="9e1c2af"[\s\S]*?9e1c2af[\s\S]*?Agent view: the cursor[\s\S]*?kora · genie2/);
    });

    it('`None yet.` with none; no section without the read (positive controls)', () => {
        expect(render([])).toContain('data-observed-commits-none=""');
        expect(render(null)).not.toContain('data-observed-commits');
    });
});
