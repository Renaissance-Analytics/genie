import { describe, expect, it } from 'vitest';
import {
    accessibleRepoFrom,
    cloneAuthFor,
    filterRepos,
    githubRepoOf,
    githubSshToHttps,
    pushAuthFor,
    type AccessibleRepo,
    type GithubInstallation,
} from '../src/core/github.js';
import { buildPlan, parseEnvelopePlan, patchRepo, planProblem, repoSourceUrl, sourceOptions, startDraft, type RepoRow, type SourceAnalysis } from '../src/core/envelope-plan.js';

/**
 * ADD WORKSPACE PARITY ITEMS 8 + 12 — the pure halves.
 *
 * (8) Genie 1 rewrote a github.com SSH URL to HTTPS when its GitHub token applied (`v1:main/workspace/git-auth.ts`
 * githubSshToHttps / githubCloneAuth, used by clone.ts:42-63), so a private repository cloned with the App's sign-in
 * instead of failing for want of an SSH key. Genie 2's clone credential applied to https URLs only and left an SSH URL to
 * the person's ssh agent. And Genie 1 listed the repositories the sign-in can reach (`api.ts:409-452`) to pick from.
 *
 * (12) Genie 1's wizard had a third source per repository, Fork (`InteractiveUpgradeWizard.tsx:605-632`): fork it into
 * the chosen owner on GitHub, then make the FORK the submodule.
 */

const TOKEN = 'ghu_exampletoken0000000000000000000000';
const inst = (over: Partial<GithubInstallation> = {}): GithubInstallation => ({ id: 1, account: 'ada', isOrg: false, selection: 'all', repoCount: null, repos: null, permissions: { contents: 'read' }, settingsUrl: 'https://github.com/settings/installations/1', ...over });

describe('SSH → HTTPS (Genie 1 githubSshToHttps)', () => {
    it('both SSH forms of github.com become the HTTPS URL; anything else is left as it is', () => {
        expect(githubSshToHttps('git@github.com:ada/thing.git')).toBe('https://github.com/ada/thing.git');
        expect(githubSshToHttps('  ssh://git@github.com/Ada/thing  ')).toBe('https://github.com/Ada/thing');
        expect(githubSshToHttps('https://github.com/ada/thing.git')).toBe('https://github.com/ada/thing.git');
        expect(githubSshToHttps('git@gitlab.com:ada/thing.git')).toBe('git@gitlab.com:ada/thing.git');
        expect(githubSshToHttps('/srv/git/thing.git')).toBe('/srv/git/thing.git');
    });

    it('the clone credential for an SSH github.com URL of an installed account: the HTTPS URL to clone instead, and the header', () => {
        const auth = cloneAuthFor('git@github.com:Ada/private-thing.git', TOKEN, [inst()]);
        expect(auth).not.toBeNull();
        expect(auth!.url).toBe('https://github.com/Ada/private-thing.git');
        expect(auth!.config[0]![0]).toBe('http.https://github.com/.extraheader');
        expect(auth!.secrets).toContain(TOKEN);
        expect(cloneAuthFor('ssh://git@github.com/ada/x.git', TOKEN, [inst()])?.url).toBe('https://github.com/ada/x.git');
    });

    it('an https URL keeps its URL; SSH of an account the App does not cover, or with no sign-in, stays SSH (the person’s ssh agent answers)', () => {
        expect(cloneAuthFor('https://github.com/ada/x.git', TOKEN, [inst()])?.url).toBe('https://github.com/ada/x.git');
        // Positive control above; the same SSH URL with nothing to authenticate it is not rewritten.
        expect(cloneAuthFor('git@github.com:someone-else/x.git', TOKEN, [inst()])).toBeNull();
        expect(cloneAuthFor('git@github.com:ada/x.git', null, [inst()])).toBeNull();
        expect(cloneAuthFor('git@github.com:ada/x.git', TOKEN, [inst({ permissions: { metadata: 'read' } })])).toBeNull();
        expect(cloneAuthFor('git@gitlab.com:ada/x.git', TOKEN, [inst()])).toBeNull();
    });

    it('the push credential is unchanged: https only (an SSH remote pushes with the person’s own key)', () => {
        const ok = [inst({ permissions: { contents: 'write' } })];
        expect(pushAuthFor('https://github.com/ada/x.agi.git', TOKEN, ok)).not.toBeNull();
        expect(pushAuthFor('git@github.com:ada/x.agi.git', TOKEN, ok)).toBeNull();
    });
});

describe('a GitHub repository named by its URL', () => {
    it('owner and repo from https and SSH forms, `.git` and a trailing slash dropped; anything else null', () => {
        expect(githubRepoOf('https://github.com/Ada/thing.git')).toEqual({ owner: 'Ada', repo: 'thing' });
        expect(githubRepoOf('https://github.com/ada/thing/')).toEqual({ owner: 'ada', repo: 'thing' });
        expect(githubRepoOf('git@github.com:ada/my.repo.git')).toEqual({ owner: 'ada', repo: 'my.repo' });
        expect(githubRepoOf('ssh://git@github.com/ada/thing')).toEqual({ owner: 'ada', repo: 'thing' });
        expect(githubRepoOf('https://gitlab.com/ada/thing.git')).toBeNull();
        expect(githubRepoOf('/srv/git/thing.git')).toBeNull();
        expect(githubRepoOf('https://github.com/ada')).toBeNull();
        expect(githubRepoOf(null)).toBeNull();
    });
});

describe('the repositories the sign-in can reach (Genie 1 listAccessibleRepositories)', () => {
    it('one row of GitHub’s answer: full name, owner, private mark, clone URL; a row without them is dropped', () => {
        expect(accessibleRepoFrom({ id: 7, name: 'site', full_name: 'Example-Org/site', private: true, clone_url: 'https://github.com/Example-Org/site.git', default_branch: 'trunk', owner: { login: 'Example-Org' } }))
            .toEqual({ fullName: 'Example-Org/site', owner: 'Example-Org', name: 'site', private: true, cloneUrl: 'https://github.com/Example-Org/site.git', defaultBranch: 'trunk' });
        expect(accessibleRepoFrom({ name: 'x', full_name: 'ada/x', clone_url: 'https://github.com/ada/x.git' })).toEqual({ fullName: 'ada/x', owner: 'ada', name: 'x', private: false, cloneUrl: 'https://github.com/ada/x.git', defaultBranch: null });
        expect(accessibleRepoFrom({ full_name: 'ada/x' })).toBeNull();
        expect(accessibleRepoFrom(null)).toBeNull();
    });

    const repos: AccessibleRepo[] = [
        { fullName: 'ada/notes', owner: 'ada', name: 'notes', private: true, cloneUrl: 'https://github.com/ada/notes.git', defaultBranch: 'main' },
        { fullName: 'Example-Org/site', owner: 'Example-Org', name: 'site', private: false, cloneUrl: 'https://github.com/Example-Org/site.git', defaultBranch: 'main' },
        { fullName: 'Example-Org/site-docs', owner: 'Example-Org', name: 'site-docs', private: true, cloneUrl: 'https://github.com/Example-Org/site-docs.git', defaultBranch: 'main' },
    ];

    it('search: every word must appear in the full name, case-insensitively; an empty search is everything', () => {
        expect(filterRepos(repos, '').map((r) => r.fullName)).toEqual(['ada/notes', 'Example-Org/site', 'Example-Org/site-docs']);
        expect(filterRepos(repos, 'SITE').map((r) => r.fullName)).toEqual(['Example-Org/site', 'Example-Org/site-docs']);
        expect(filterRepos(repos, 'example docs').map((r) => r.fullName)).toEqual(['Example-Org/site-docs']);
        expect(filterRepos(repos, 'nothing-like-it')).toEqual([]);
    });
});

/* ===== Fork, in the wizard's plan ======================================================================================== */

const analysis = (originUrl: string | null, absPath = '/src/app'): SourceAnalysis => ({
    root: absPath, sourceKind: 'single-repo', repos: [{ relPath: '.', absPath, defaultName: 'app', originUrl, headRef: 'main' }], knowledge: [], other: [], rootEntries: [], submodules: [],
});
const row = (originUrl: string | null): RepoRow => startDraft(analysis(originUrl), { parent: '/w' }).repos[0]!;

describe('Fork: the third source a repository can come from', () => {
    it('offered when the repository is on GitHub and forking is possible here; never otherwise', () => {
        expect(sourceOptions(row('https://github.com/ada/app.git'), false, true)).toEqual(['origin', 'local', 'fork']);
        expect(sourceOptions(row('git@github.com:ada/app.git'), true, true)).toEqual(['origin', 'fork']);
        // Positive control above; the same repository when GitHub is not signed in, and a non-GitHub remote, offer no Fork.
        expect(sourceOptions(row('https://github.com/ada/app.git'), false, false)).toEqual(['origin', 'local']);
        expect(sourceOptions(row('https://gitlab.com/ada/app.git'), false, true)).toEqual(['origin', 'local']);
        expect(sourceOptions(row(null), false, true)).toEqual(['local']);
        // Without the third argument (an older caller): as before.
        expect(sourceOptions(row('https://github.com/ada/app.git'), false)).toEqual(['origin', 'local']);
    });

    it('a Fork row becomes a plan repo naming what to fork; the plan names where the forks go', () => {
        const d = patchRepo({ ...startDraft(analysis('git@github.com:Ada/app.git'), { parent: '/w' }), forkInto: 'Example-Org' }, '.', { source: 'fork' });
        expect(repoSourceUrl(d.repos[0]!)).toEqual({ name: 'app', url: 'git@github.com:Ada/app.git', local: false, fork: { owner: 'Ada', repo: 'app' } });
        const plan = buildPlan(d);
        expect(plan.forkInto).toBe('Example-Org');
        expect(plan.repos[0]!.fork).toEqual({ owner: 'Ada', repo: 'app' });
        expect(planProblem(plan)).toBeNull();
        // Origin and Local carry no fork, and a plan with no Fork row names no owner.
        const origin = buildPlan(startDraft(analysis('https://github.com/ada/app.git'), { parent: '/w' }));
        expect(origin.repos[0]!.fork).toBeUndefined();
        expect(origin.forkInto).toBeNull();
    });

    it('a Fork row with no owner chosen cannot be built, in words', () => {
        const d = patchRepo(startDraft(analysis('https://github.com/ada/app.git'), { parent: '/w' }), '.', { source: 'fork' });
        expect(planProblem(buildPlan(d))).toMatch(/GitHub account or organisation .*fork/i);
    });

    it('the plan crosses IPC with its forks; a malformed fork or owner is refused; an older window’s plan has none', () => {
        const d = patchRepo({ ...startDraft(analysis('https://github.com/ada/app.git'), { parent: '/w' }), forkInto: 'ada' }, '.', { source: 'fork' });
        const plan = buildPlan(d);
        expect(parseEnvelopePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
        expect(parseEnvelopePlan({ ...plan, repos: [{ ...plan.repos[0], fork: { owner: '-bad', repo: 'app' } }] })).toBeNull();
        expect(parseEnvelopePlan({ ...plan, repos: [{ ...plan.repos[0], fork: { owner: 'ada', repo: '../x' } }] })).toBeNull();
        expect(parseEnvelopePlan({ ...plan, forkInto: 42 })).toBeNull();
        const older = { ...buildPlan(startDraft(analysis('https://github.com/ada/app.git'), { parent: '/w' })) } as Record<string, unknown>;
        delete older.forkInto;
        expect(parseEnvelopePlan(older)?.forkInto).toBeNull();
    });
});
