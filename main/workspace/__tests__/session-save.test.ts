import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// session-save imports `../db` for the DEFAULT deps factory only; the operation
// itself is fully injected. Stub the module so the suite never loads sqlite.
vi.mock('../../db', () => ({ listWorkspaces: () => [] }));

import {
    SESSION_BRANCH_PREFIX,
    discoverWorkspaceRepos,
    runHostSessionSave,
    saveWorkspacesForTeardown,
    sessionBranchName,
    type SessionSaveDeps,
    type SessionSaveWorkspace,
} from '../session-save';

const NOW = new Date('2026-07-28T14:32:05.123Z');

/** State a fake repo reports back to the injected git runner. */
interface FakeRepo {
    /** `git status --porcelain=v1 -uall` stdout. */
    porcelain?: string;
    /** `git status --porcelain=v1 --ignored` stdout. */
    ignoredPorcelain?: string;
    /** Working branch reported by `rev-parse --abbrev-ref HEAD`. */
    branch?: string;
    /** Commits ahead of upstream; `null` = no upstream configured. */
    ahead?: number | null;
    /** Only consulted when `ahead` is null. */
    remoteContainsHead?: boolean;
    /** `null` = no `origin` remote. */
    remote?: string | null;
    head?: string;
    /** Non-empty = `git push` rejects with this message. */
    pushFails?: string;
    /** Non-empty = `git checkout -b` rejects with this message. */
    checkoutFails?: string;
    /** false = `git var GIT_COMMITTER_IDENT` fails (no user.name/email). */
    identity?: boolean;
    /** Non-empty = every git call rejects with this message. */
    explodes?: string;
}

interface GitCall {
    repo: string;
    args: string[];
    config: string[];
}

function makeGit(repos: Record<string, FakeRepo>): {
    git: SessionSaveDeps['git'];
    calls: GitCall[];
    callsFor: (repo: string) => string[][];
} {
    const calls: GitCall[] = [];
    const git: SessionSaveDeps['git'] = async (repoPath, args, config = []) => {
        calls.push({ repo: repoPath, args, config });
        const st = repos[repoPath];
        if (!st) throw new Error(`fatal: not a git repository: ${repoPath}`);
        if (st.explodes) throw new Error(st.explodes);
        const [cmd] = args;
        if (cmd === 'status') {
            return args.includes('--ignored')
                ? (st.ignoredPorcelain ?? '')
                : (st.porcelain ?? '');
        }
        if (cmd === 'rev-parse') return `${st.branch ?? 'main'}\n`;
        if (cmd === 'rev-list') {
            if (st.ahead === null || st.ahead === undefined) {
                throw new Error("fatal: no upstream configured for branch 'main'");
            }
            return `${st.ahead}\n`;
        }
        if (cmd === 'branch') return st.remoteContainsHead ? '  origin/main\n' : '\n';
        if (cmd === 'var') {
            if (st.identity === false) throw new Error('unable to auto-detect email address');
            return 'Dev <dev@example.com> 1 +0000\n';
        }
        if (cmd === 'checkout') {
            if (st.checkoutFails) throw new Error(st.checkoutFails);
            return '';
        }
        if (cmd === 'add') return '';
        if (cmd === 'commit') return '';
        if (cmd === 'remote') {
            if (st.remote === null) {
                throw new Error("error: No such remote 'origin'");
            }
            return `${st.remote ?? 'git@github.com:owner/repo.git'}\n`;
        }
        if (cmd === 'push') {
            if (st.pushFails) throw new Error(st.pushFails);
            return '';
        }
        if (cmd === 'log') return `${st.head ?? 'abc1234'}\n`;
        throw new Error(`unexpected git call: ${args.join(' ')}`);
    };
    return {
        git,
        calls,
        callsFor: (repo) => calls.filter((c) => c.repo === repo).map((c) => c.args),
    };
}

function ws(id: string, wsPath: string): SessionSaveWorkspace {
    return { id, name: `ws-${id}`, path: wsPath };
}

/** Deps with one workspace whose repos are exactly `Object.keys(repos)`. */
function makeDeps(
    repos: Record<string, FakeRepo>,
    over: Partial<SessionSaveDeps> = {},
): SessionSaveDeps & { calls: GitCall[]; callsFor: (r: string) => string[][] } {
    const { git, calls, callsFor } = makeGit(repos);
    return {
        listWorkspaces: () => [ws('w1', '/ws/one.agi')],
        discoverRepos: () => Object.keys(repos),
        git,
        auth: () => ({ config: ['url.https://github.com/.insteadOf=git@github.com:'], secrets: [] }),
        now: () => NOW,
        ...over,
        calls,
        callsFor,
    };
}

/** Every git subcommand run against `repo`, e.g. ['status','checkout',…]. */
function verbs(callsFor: (r: string) => string[][], repo: string): string[] {
    return callsFor(repo).map((a) => a[0]);
}

describe('sessionBranchName', () => {
    it('is prefixed genie-session/ and carries the instant', () => {
        const name = sessionBranchName(NOW);
        expect(name.startsWith(SESSION_BRANCH_PREFIX)).toBe(true);
        expect(name).toContain('2026-07-28');
        expect(name).toContain('14-32-05');
    });

    it('produces a git-LEGAL ref (a raw ISO timestamp is not one)', () => {
        const name = sessionBranchName(NOW);
        // ':' is illegal in a ref name; '..' and a trailing '.lock' too.
        expect(name).not.toContain(':');
        expect(name).not.toContain('..');
        expect(name.endsWith('.lock')).toBe(false);
        expect(name).toMatch(/^genie-session\/[A-Za-z0-9._-]+$/);
    });
});

describe('saveWorkspacesForTeardown — a dirty repo', () => {
    it('commits to the session branch and pushes, reporting saved', async () => {
        const deps = makeDeps({
            '/ws/one.agi/repos/app': {
                porcelain: ' M src/index.ts\n?? notes.txt\n',
                branch: 'main',
                ahead: 0,
                head: 'deadbee',
            },
        });
        const report = await saveWorkspacesForTeardown(deps);

        expect(report.branch).toBe(sessionBranchName(NOW));
        expect(report.repos).toHaveLength(1);
        const r = report.repos[0];
        expect(r.result).toBe('saved');
        expect(r.branch).toBe(report.branch);
        expect(r.commit).toBe('deadbee');
        expect(r.pushed).toBe(true);
        expect(r.workingBranch).toBe('main');
        expect(r.dirtyFiles).toBe(2);
        expect(r.reason).toBeUndefined();
        expect(report.ok).toBe(true);
        expect(report.counts).toEqual({ saved: 1, clean: 0, failed: 0 });
    });

    it('runs checkout -b, add -A (never -f), commit and push in that order', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps({
            [repo]: { porcelain: ' M a.ts\n', branch: 'main', ahead: 0 },
        });
        await saveWorkspacesForTeardown(deps);
        const args = deps.callsFor(repo);

        const checkout = args.find((a) => a[0] === 'checkout');
        expect(checkout).toEqual(['checkout', '-b', sessionBranchName(NOW)]);

        const add = args.find((a) => a[0] === 'add');
        expect(add).toEqual(['add', '-A']);
        expect(add).not.toContain('-f');
        expect(add).not.toContain('--force');

        const commit = args.find((a) => a[0] === 'commit');
        expect(commit?.[1]).toBe('-m');
        expect(commit?.[2]).toBe(`Genie session autosave — ${NOW.toISOString()}`);

        const push = args.find((a) => a[0] === 'push');
        expect(push).toEqual(['push', 'origin', sessionBranchName(NOW)]);

        const order = verbs(deps.callsFor, repo);
        expect(order.indexOf('checkout')).toBeLessThan(order.indexOf('add'));
        expect(order.indexOf('add')).toBeLessThan(order.indexOf('commit'));
        expect(order.indexOf('commit')).toBeLessThan(order.indexOf('push'));
    });

    it('NEVER moves the working branch — no checkout back, reset or branch -f', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps({
            [repo]: { porcelain: ' M a.ts\n', branch: 'main', ahead: 3 },
        });
        await saveWorkspacesForTeardown(deps);
        const args = deps.callsFor(repo);

        expect(args.filter((a) => a[0] === 'checkout')).toHaveLength(1);
        expect(args.some((a) => a[0] === 'reset')).toBe(false);
        expect(args.some((a) => a[0] === 'branch' && a.includes('-f'))).toBe(false);
        expect(args.some((a) => a.includes('main'))).toBe(false);
        // The push targets the session branch only — never the working branch.
        expect(args.find((a) => a[0] === 'push')).not.toContain('main');
    });

    it('passes the owner-auth -c config to the PUSH (and not to the status read)', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps({
            [repo]: { porcelain: ' M a.ts\n', branch: 'main', ahead: 0 },
        });
        await saveWorkspacesForTeardown(deps);

        const push = deps.calls.find((c) => c.args[0] === 'push');
        expect(push?.config).toContain('url.https://github.com/.insteadOf=git@github.com:');
        const status = deps.calls.find((c) => c.args[0] === 'status');
        expect(status?.config ?? []).toEqual([]);
    });
});

describe('saveWorkspacesForTeardown — a clean repo', () => {
    it('reports clean and creates NO branch', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps({
            [repo]: { porcelain: '', branch: 'main', ahead: 0 },
        });
        const report = await saveWorkspacesForTeardown(deps);

        expect(report.repos[0].result).toBe('clean');
        expect(report.repos[0].branch).toBeUndefined();
        expect(report.repos[0].pushed).toBeUndefined();
        expect(verbs(deps.callsFor, repo)).not.toContain('checkout');
        expect(verbs(deps.callsFor, repo)).not.toContain('commit');
        expect(verbs(deps.callsFor, repo)).not.toContain('push');
        expect(report.ok).toBe(true);
    });

    it('saves a clean-tree repo that still has UNPUSHED commits, without committing', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps({
            [repo]: { porcelain: '', branch: 'main', ahead: 2, head: 'cafe123' },
        });
        const report = await saveWorkspacesForTeardown(deps);

        expect(report.repos[0].result).toBe('saved');
        expect(report.repos[0].unpushedCommits).toBe(2);
        expect(report.repos[0].pushed).toBe(true);
        expect(verbs(deps.callsFor, repo)).toContain('checkout');
        // Nothing to commit — an empty commit would be noise, not safety.
        expect(verbs(deps.callsFor, repo)).not.toContain('commit');
    });

    it('treats a branch with NO upstream and no remote copy as work to save', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps({
            [repo]: { porcelain: '', branch: 'main', ahead: null, remoteContainsHead: false },
        });
        const report = await saveWorkspacesForTeardown(deps);
        expect(report.repos[0].result).toBe('saved');
    });

    it('treats a no-upstream branch already contained in a remote ref as clean', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps({
            [repo]: { porcelain: '', branch: 'main', ahead: null, remoteContainsHead: true },
        });
        const report = await saveWorkspacesForTeardown(deps);
        expect(report.repos[0].result).toBe('clean');
    });
});

describe('saveWorkspacesForTeardown — failures are isolated and honest', () => {
    it('reports a push failure as failed with the reason, and still processes the others', async () => {
        const bad = '/ws/one.agi/repos/bad';
        const good = '/ws/one.agi/repos/good';
        const deps = makeDeps({
            [bad]: {
                porcelain: ' M a.ts\n',
                branch: 'main',
                ahead: 0,
                head: 'bad1234',
                pushFails: 'remote: Permission to owner/repo.git denied',
            },
            [good]: { porcelain: ' M b.ts\n', branch: 'main', ahead: 0, head: 'good567' },
        });
        const report = await saveWorkspacesForTeardown(deps);

        const badReport = report.repos.find((r) => r.path === bad)!;
        expect(badReport.result).toBe('failed');
        expect(badReport.pushed).toBe(false);
        expect(badReport.reason).toContain('Permission to owner/repo.git denied');
        // The local commit still happened — it's reachable on the session branch.
        expect(badReport.branch).toBe(sessionBranchName(NOW));
        expect(badReport.commit).toBe('bad1234');

        const goodReport = report.repos.find((r) => r.path === good)!;
        expect(goodReport.result).toBe('saved');
        expect(goodReport.pushed).toBe(true);

        expect(report.ok).toBe(false);
        expect(report.counts).toEqual({ saved: 1, clean: 0, failed: 1 });
    });

    it('reports a missing origin remote as failed, never as saved', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps({
            [repo]: { porcelain: ' M a.ts\n', branch: 'main', ahead: 0, remote: null },
        });
        const report = await saveWorkspacesForTeardown(deps);
        expect(report.repos[0].result).toBe('failed');
        expect(report.repos[0].pushed).toBe(false);
        expect(report.repos[0].reason).toBeTruthy();
        expect(report.ok).toBe(false);
    });

    it('contains an UNEXPECTED throw to the one repo and keeps going', async () => {
        const boom = '/ws/one.agi/repos/boom';
        const ok = '/ws/one.agi/repos/ok';
        const deps = makeDeps({
            [boom]: { explodes: 'ENOENT: git not found' },
            [ok]: { porcelain: ' M b.ts\n', branch: 'main', ahead: 0 },
        });
        const report = await saveWorkspacesForTeardown(deps);

        expect(report.repos.find((r) => r.path === boom)!.result).toBe('failed');
        expect(report.repos.find((r) => r.path === boom)!.reason).toContain('git not found');
        expect(report.repos.find((r) => r.path === ok)!.result).toBe('saved');
        expect(report.ok).toBe(false);
    });

    it('reports a checkout failure as failed without attempting a push', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps({
            [repo]: {
                porcelain: ' M a.ts\n',
                branch: 'main',
                ahead: 0,
                checkoutFails: 'fatal: a branch named that already exists',
            },
        });
        const report = await saveWorkspacesForTeardown(deps);
        expect(report.repos[0].result).toBe('failed');
        expect(verbs(deps.callsFor, repo)).not.toContain('push');
    });

    it('redacts injected secrets out of a surfaced failure reason', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps(
            {
                [repo]: {
                    porcelain: ' M a.ts\n',
                    branch: 'main',
                    ahead: 0,
                    pushFails: 'failed with -c extraheader=basic ghs_supersecret',
                },
            },
            { auth: () => ({ config: [], secrets: ['ghs_supersecret'] }) },
        );
        const report = await saveWorkspacesForTeardown(deps);
        expect(report.repos[0].reason).not.toContain('ghs_supersecret');
        expect(report.repos[0].reason).toContain('***');
    });

    it('keeps a failing workspace enumeration from aborting the run', async () => {
        const deps = makeDeps(
            { '/ws/two.agi': { porcelain: ' M a.ts\n', branch: 'main', ahead: 0 } },
            {
                listWorkspaces: () => [ws('w1', '/ws/one.agi'), ws('w2', '/ws/two.agi')],
                discoverRepos: (p: string) => {
                    if (p === '/ws/one.agi') throw new Error('EACCES');
                    return ['/ws/two.agi'];
                },
            },
        );
        const report = await saveWorkspacesForTeardown(deps);
        expect(report.repos).toHaveLength(1);
        expect(report.repos[0].result).toBe('saved');
    });
});

describe('saveWorkspacesForTeardown — what git CANNOT save', () => {
    it('lists .gitignore-d paths instead of force-adding them', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps({
            [repo]: {
                porcelain: ' M a.ts\n',
                ignoredPorcelain: '!! .env\n!! node_modules/\n M a.ts\n',
                branch: 'main',
                ahead: 0,
            },
        });
        const report = await saveWorkspacesForTeardown(deps);

        const entry = report.cannotSave.ignoredPaths.find((p) => p.path === repo)!;
        expect(entry.ignored).toEqual(['.env', 'node_modules/']);
        expect(entry.truncated).toBe(false);
        // Ignored files are reported, NEVER committed — force-adding could leak secrets.
        expect(deps.callsFor(repo).find((a) => a[0] === 'add')).toEqual(['add', '-A']);
        // ...and they are not counted as dirty work.
        expect(report.repos[0].dirtyFiles).toBe(1);
    });

    it('lists ignored paths for a CLEAN repo too — they are lost either way', async () => {
        const repo = '/ws/one.agi/repos/app';
        const deps = makeDeps({
            [repo]: { porcelain: '', ignoredPorcelain: '!! .env\n', branch: 'main', ahead: 0 },
        });
        const report = await saveWorkspacesForTeardown(deps);
        expect(report.repos[0].result).toBe('clean');
        expect(report.cannotSave.ignoredPaths[0].ignored).toEqual(['.env']);
    });

    it('caps a huge ignored list and flags it truncated', async () => {
        const repo = '/ws/one.agi/repos/app';
        const many = Array.from({ length: 10 }, (_, i) => `!! f${i}\n`).join('');
        const deps = makeDeps(
            { [repo]: { porcelain: '', ignoredPorcelain: many, branch: 'main', ahead: 0 } },
            { maxIgnoredPaths: 3 },
        );
        const report = await saveWorkspacesForTeardown(deps);
        expect(report.cannotSave.ignoredPaths[0].ignored).toHaveLength(3);
        expect(report.cannotSave.ignoredPaths[0].truncated).toBe(true);
    });

    it('warns that processes and agent logins do not survive teardown', async () => {
        const deps = makeDeps({
            '/ws/one.agi/repos/app': { porcelain: '', branch: 'main', ahead: 0 },
        });
        const report = await saveWorkspacesForTeardown(deps);
        const notes = report.cannotSave.notes.join(' ').toLowerCase();
        expect(notes).toContain('process');
        expect(notes).toContain('login');
    });
});

describe('saveWorkspacesForTeardown — enumeration', () => {
    it('walks every workspace and de-duplicates repos shared between them', async () => {
        const shared = '/ws/shared';
        const only = '/ws/one.agi/repos/app';
        const deps = makeDeps(
            {
                [shared]: { porcelain: '', branch: 'main', ahead: 0 },
                [only]: { porcelain: '', branch: 'main', ahead: 0 },
            },
            {
                listWorkspaces: () => [ws('w1', '/ws/one.agi'), ws('w2', '/ws/two.agi')],
                discoverRepos: (p: string) =>
                    p === '/ws/one.agi' ? [only, shared] : [shared],
            },
        );
        const report = await saveWorkspacesForTeardown(deps);
        expect(report.repos.map((r) => r.path).sort()).toEqual([only, shared].sort());
    });

    it('attributes each repo to its owning workspace', async () => {
        const deps = makeDeps({
            '/ws/one.agi/repos/app': { porcelain: '', branch: 'main', ahead: 0 },
        });
        const report = await saveWorkspacesForTeardown(deps);
        expect(report.repos[0].workspaceId).toBe('w1');
        expect(report.repos[0].workspaceName).toBe('ws-w1');
    });

    it('returns an empty, ok report when the host has no workspaces', async () => {
        const deps = makeDeps({}, { listWorkspaces: () => [] });
        const report = await saveWorkspacesForTeardown(deps);
        expect(report.repos).toEqual([]);
        expect(report.ok).toBe(true);
        expect(report.timestamp).toBe(NOW.toISOString());
    });
});

describe('discoverWorkspaceRepos', () => {
    const tmpDirs: string[] = [];

    afterEach(() => {
        for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });

    function tmp(): string {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-session-save-'));
        tmpDirs.push(d);
        return d;
    }

    it('returns the envelope root AND every repos/<name> submodule', () => {
        const root = tmp();
        fs.mkdirSync(path.join(root, '.git'));
        fs.writeFileSync(path.join(root, '.gitmodules'), '');
        fs.writeFileSync(path.join(root, 'project.json'), '{}');
        for (const name of ['app', 'lib']) {
            fs.mkdirSync(path.join(root, 'repos', name, '.git'), { recursive: true });
        }
        // A non-git folder under repos/ is not a repo.
        fs.mkdirSync(path.join(root, 'repos', 'notes'), { recursive: true });

        expect(discoverWorkspaceRepos(root).sort()).toEqual(
            [root, path.join(root, 'repos', 'app'), path.join(root, 'repos', 'lib')].sort(),
        );
    });

    it('returns the workspace itself for a simple (single-repo) workspace', () => {
        const root = tmp();
        fs.mkdirSync(path.join(root, '.git'));
        expect(discoverWorkspaceRepos(root)).toEqual([root]);
    });

    it('returns nothing for a path that is not a repo at all', () => {
        expect(discoverWorkspaceRepos(path.join(tmp(), 'missing'))).toEqual([]);
    });
});

/**
 * `runHostSessionSave` is what the HOST endpoint (`POST /api/desktop/session-save`)
 * calls. Teardown can plausibly fire it twice — an operator's "End session" racing
 * the idle-timeout — and two concurrent walks over the SAME repos collide: they
 * fight over the git index, and the second `checkout -b` finds the branch already
 * there. That turns a perfectly good save into a `failed` report and blocks a
 * teardown that should have been allowed. So concurrent callers coalesce onto the
 * one in-flight run, and the slot is released whether it resolves OR throws.
 */
describe('runHostSessionSave — single-flight', () => {
    /** Deps for one clean repo whose git only resolves once `release()` is called. */
    function gated() {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        let walks = 0;
        const deps: SessionSaveDeps = {
            listWorkspaces: () => {
                walks += 1;
                return [ws('w1', '/ws/one.agi')];
            },
            discoverRepos: () => ['/ws/one.agi'],
            git: async (_repo, args) => {
                await gate;
                if (args[0] === 'rev-parse') return 'main\n';
                if (args[0] === 'rev-list') return '0\n';
                return '';
            },
            auth: () => ({ config: [], secrets: [] }),
            now: () => NOW,
        };
        return { deps, release: () => release(), walks: () => walks };
    }

    it('coalesces concurrent callers onto ONE walk', async () => {
        const g = gated();
        const a = runHostSessionSave(g.deps);
        const b = runHostSessionSave(g.deps);
        g.release();
        const [ra, rb] = await Promise.all([a, b]);

        expect(g.walks()).toBe(1);
        expect(ra).toBe(rb); // the very same report — not two racing walks
        expect(ra.counts).toEqual({ saved: 0, clean: 1, failed: 0 });
        expect(ra.ok).toBe(true);
    });

    it('runs again once the in-flight save has settled', async () => {
        const first = gated();
        first.release();
        await runHostSessionSave(first.deps);

        const second = gated();
        second.release();
        const report = await runHostSessionSave(second.deps);

        expect(second.walks()).toBe(1); // a later teardown is not served a stale report
        expect(report.ok).toBe(true);
    });

    it('releases the slot when a save THROWS, so a retry is still possible', async () => {
        const boom: SessionSaveDeps = {
            listWorkspaces: () => {
                throw new Error('workspace db unreadable');
            },
            discoverRepos: () => [],
            git: async () => '',
            auth: () => ({ config: [], secrets: [] }),
            now: () => NOW,
        };
        await expect(runHostSessionSave(boom)).rejects.toThrow('workspace db unreadable');

        const g = gated();
        g.release();
        await expect(runHostSessionSave(g.deps)).resolves.toMatchObject({ ok: true });
    });
});
