import { describe, expect, it } from 'vitest';
import {
    buildPlan,
    choosePrimary,
    convertCommitMessage,
    envelopeRepos,
    isLocalPathLike,
    knowledgeTargetFor,
    parseGitModulesText,
    parseEnvelopePlan,
    patchRepo,
    planProblem,
    renameWorkspace,
    repoNamesProblem,
    sanitiseRepoName,
    setMonorepoMode,
    sourceKindOf,
    sourceOptions,
    startDraft,
    suggestDisposition,
    unionSubmodules,
    usesDisposition,
    type EnvelopePlan,
    type SourceAnalysis,
} from '../src/core/envelope-plan.js';

/**
 * THE WIZARD'S PLAN (Add workspace parity item 7): Genie 1's analyse.ts rules and InteractiveUpgradeWizard defaults, as
 * pure functions — what a folder is, what each step starts with, and what the plan the main process builds says. The
 * real-git half (the source untouched, the envelope's tree and commits) is test/envelope-build.test.ts.
 */

const single: SourceAnalysis = {
    root: '/src/acme-app',
    sourceKind: 'single-repo',
    repos: [{ relPath: '.', absPath: '/src/acme-app', defaultName: 'acme-app', originUrl: 'git@github.com:acme/acme-app.git', headRef: 'trunk' }],
    knowledge: [],
    other: [],
    rootEntries: [
        { relPath: 'README.md', absPath: '/src/acme-app/README.md', kind: 'file', gitState: 'tracked', suggested: 'codebase', suggestedTarget: '' },
        { relPath: 'notes.md', absPath: '/src/acme-app/notes.md', kind: 'file', gitState: 'untracked', suggested: 'knowledge', suggestedTarget: 'knowledge' },
        { relPath: '.ai', absPath: '/src/acme-app/.ai', kind: 'directory', gitState: 'ignored', suggested: 'knowledge', suggestedTarget: '' },
    ],
    submodules: [],
};

const mono: SourceAnalysis = {
    root: '/src/mono',
    sourceKind: 'monorepo',
    repos: [{ relPath: '.', absPath: '/src/mono', defaultName: 'mono', originUrl: null, headRef: 'main' }],
    knowledge: [],
    other: [],
    rootEntries: [],
    submodules: [
        { name: 'packages/ui', path: 'packages/ui', url: 'https://github.com/acme/ui.git', localPath: '/src/mono/packages/ui' },
        { name: 'tools', path: 'tools', url: '/src/mono/tools', localPath: '/src/mono/tools' },
    ],
};

const collection: SourceAnalysis = {
    root: '/src/coll',
    sourceKind: 'repo-collection',
    repos: [
        { relPath: '_web', absPath: '/src/coll/_web', defaultName: 'web', originUrl: null, headRef: 'main' },
        { relPath: 'api', absPath: '/src/coll/api', defaultName: 'api', originUrl: 'https://github.com/acme/api.git', headRef: 'main' },
    ],
    knowledge: [
        { relPath: 'README.md', absPath: '/src/coll/README.md', kind: 'file', suggestedTarget: 'knowledge' },
        { relPath: 'plans', absPath: '/src/coll/plans', kind: 'directory', suggestedTarget: 'plans' },
    ],
    other: [{ relPath: 'misc', kind: 'directory' }],
    rootEntries: null,
    submodules: [],
};

describe('what a folder is (Genie 1 analyse.ts)', () => {
    it('a repo with members is a monorepo, without them a single repo; repos below a plain folder are a collection; none, a plain folder', () => {
        expect(sourceKindOf(true, 2, 1)).toBe('monorepo');
        expect(sourceKindOf(true, 0, 1)).toBe('single-repo');
        expect(sourceKindOf(false, 0, 3)).toBe('repo-collection');
        expect(sourceKindOf(false, 0, 0)).toBe('plain-folder');
    });

    it('names: a leading underscore dropped, anything git refuses in a path made a dash', () => {
        expect(sanitiseRepoName('_web')).toBe('web');
        expect(sanitiseRepoName('My App')).toBe('My-App');
        expect(sanitiseRepoName('api.v2_x-y')).toBe('api.v2_x-y');
    });

    it('local paths and file URLs are local; scheme and scp URLs are not', () => {
        for (const v of ['/srv/x', 'C:\\x\\y', 'C:/x', 'file:///x', '\\\\server\\share', './x', '../x']) expect(isLocalPathLike(v)).toBe(true);
        for (const v of ['https://github.com/a/b.git', 'ssh://git@h/a/b', 'git@github.com:a/b.git']) expect(isLocalPathLike(v)).toBe(false);
    });

    it('knowledge-shaped names go to their .ai/ place; anything else is not knowledge', () => {
        expect(knowledgeTargetFor('Docs', 'directory')).toBe('knowledge');
        expect(knowledgeTargetFor('plans', 'directory')).toBe('plans');
        expect(knowledgeTargetFor('.ai', 'directory')).toBe('');
        expect(knowledgeTargetFor('notes.MD', 'file')).toBe('knowledge');
        expect(knowledgeTargetFor('src', 'directory')).toBeUndefined();
        expect(knowledgeTargetFor('index.ts', 'file')).toBeUndefined();
    });

    it('in a repo: tracked stays codebase; knowledge-shaped and NOT in git is suggested knowledge; regenerable output and dotfiles stay codebase', () => {
        expect(suggestDisposition('docs', 'directory', 'tracked')).toEqual({ suggested: 'codebase', suggestedTarget: '' });
        expect(suggestDisposition('notes.md', 'file', 'untracked')).toEqual({ suggested: 'knowledge', suggestedTarget: 'knowledge' });
        expect(suggestDisposition('.ai', 'directory', 'ignored')).toEqual({ suggested: 'knowledge', suggestedTarget: '' });
        // A secret is never suggested into the (committed, maybe pushed) envelope.
        expect(suggestDisposition('.env', 'file', 'ignored')).toEqual({ suggested: 'codebase', suggestedTarget: '' });
        expect(suggestDisposition('dist', 'directory', 'ignored')).toEqual({ suggested: 'codebase', suggestedTarget: '' });
    });

    it('.gitmodules is read as git reads it, and a declared member wins over a nested clone at the same path', () => {
        const text = '[submodule "ui"]\n\tpath = packages/ui\n\turl = https://github.com/acme/ui.git\n# comment\n[submodule "half"]\n\tpath = half\n';
        expect(parseGitModulesText(text)).toEqual([{ name: 'ui', path: 'packages/ui', url: 'https://github.com/acme/ui.git' }]);
        const declared = [{ name: 'ui', path: 'packages/ui', url: 'https://github.com/acme/ui.git', localPath: null }];
        const nested = [{ name: 'ui', path: 'packages/ui/', url: '/src/mono/packages/ui', localPath: '/src/mono/packages/ui' }, { name: 'tools', path: 'tools', url: '/src/mono/tools', localPath: '/src/mono/tools' }];
        expect(unionSubmodules(declared, nested)).toEqual([
            { name: 'ui', path: 'packages/ui', url: 'https://github.com/acme/ui.git', localPath: '/src/mono/packages/ui' },
            { name: 'tools', path: 'tools', url: '/src/mono/tools', localPath: '/src/mono/tools' },
        ]);
    });
});

describe('the wizard starts where Genie 1 started', () => {
    it('single repo: one row from its origin, the disposition table from git, named after the folder', () => {
        const d = startDraft(single, { parent: '/w' });
        expect(d.repos).toEqual([{ key: '.', relPath: '.', localPath: '/src/acme-app', originUrl: 'git@github.com:acme/acme-app.git', headRef: 'trunk', included: true, name: 'acme-app', source: 'origin' }]);
        expect(d.dispositions.map((r) => [r.relPath, r.disposition, r.targetSubdir])).toEqual([['README.md', 'codebase', ''], ['notes.md', 'knowledge', 'knowledge'], ['.ai', 'knowledge', '']]);
        expect(d.name).toBe('acme-app');
        expect(d.parent).toBe('/w');
        expect(usesDisposition('single-repo')).toBe(true);
        expect(usesDisposition('monorepo')).toBe(true);
        expect(usesDisposition('repo-collection')).toBe(false);
    });

    it('a repo with no remote starts Local; one with a remote starts Origin', () => {
        const d = startDraft(collection, { parent: '/w' });
        expect(d.repos.map((r) => [r.name, r.source])).toEqual([['web', 'local'], ['api', 'origin']]);
        expect(sourceOptions(d.repos[0]!, false)).toEqual(['local']);
        expect(sourceOptions(d.repos[1]!, false)).toEqual(['origin', 'local']);
        expect(d.knowledge.map((k) => [k.relPath, k.included, k.targetSubdir])).toEqual([['README.md', true, 'knowledge'], ['plans', true, 'plans']]);
        expect(d.name).toBe('coll');
    });

    it('an Import from Git clone is removed after the build, so nothing may be added from it as Local', () => {
        const d = startDraft(collection, { parent: '/w', staged: true });
        expect(sourceOptions(d.repos[1]!, true)).toEqual(['origin']);
        // A staged row with no remote has nothing to come from: offered nothing, and the plan refuses it (below).
        expect(sourceOptions(d.repos[0]!, true)).toEqual([]);
        expect(planProblem(buildPlan(d))).toMatch(/web has no remote/);
        // Positive control: leave it out and the plan is fine.
        expect(planProblem(buildPlan(patchRepo(d, '_web', { included: false })))).toBeNull();
    });

    it('monorepo: EXPLODE by default, a row per member named by its leaf, the first member the host and the name', () => {
        const d = startDraft(mono, { parent: '/w' });
        expect(d.monorepoMode).toBe('explode');
        expect(d.repos.map((r) => [r.key, r.name, r.source, r.originUrl, r.localPath])).toEqual([
            ['packages/ui', 'ui', 'origin', 'https://github.com/acme/ui.git', '/src/mono/packages/ui'],
            ['tools', 'tools', 'local', null, '/src/mono/tools'],
        ]);
        expect(d.primary).toBe('ui');
        expect(d.name).toBe('ui');
        // Choosing another host renames the workspace while the name is still Genie's suggestion.
        expect(choosePrimary(d, 'tools')).toMatchObject({ primary: 'tools', name: 'tools' });
        // A name the person typed is theirs.
        expect(choosePrimary(renameWorkspace(d, 'Acme'), 'tools')).toMatchObject({ primary: 'tools', name: 'Acme' });
    });

    it('monorepo WRAP: the whole repo as one submodule, no host to pick', () => {
        const d = setMonorepoMode(startDraft(mono, { parent: '/w' }), 'wrap');
        expect(d.repos.map((r) => [r.key, r.name])).toEqual([['.', 'mono']]);
        expect(d.primary).toBe('');
        expect(buildPlan(d).primary).toBeNull();
        // and back
        expect(setMonorepoMode(d, 'explode').repos.map((r) => r.name)).toEqual(['ui', 'tools']);
    });

    it('unchecking the host moves it to the first member still included', () => {
        const d = patchRepo(startDraft(mono, { parent: '/w' }), 'packages/ui', { included: false });
        expect(d.primary).toBe('tools');
    });

    it('names must be present and unique among the INCLUDED rows', () => {
        const d = startDraft(collection, { parent: '/w' });
        expect(repoNamesProblem(d.repos)).toBeNull();
        expect(repoNamesProblem(patchRepo(d, '_web', { name: 'api' }).repos)).toMatch(/unique/);
        expect(repoNamesProblem(patchRepo(patchRepo(d, '_web', { name: 'api' }), 'api', { included: false }).repos)).toBeNull();
        expect(repoNamesProblem(patchRepo(d, 'api', { name: '  ' }).repos)).toMatch(/name/);
    });
});

describe('the plan the main process builds', () => {
    it('Origin is the remote URL; Local is the folder on disk (Genie 1 InteractiveUpgradeWizard.tsx:672-683)', () => {
        const plan = buildPlan(startDraft(collection, { parent: '/w' }));
        expect(plan.repos).toEqual([{ name: 'web', url: '/src/coll/_web', local: true }, { name: 'api', url: 'https://github.com/acme/api.git', local: false }]);
        const asLocal = buildPlan(patchRepo(startDraft(collection, { parent: '/w' }), 'api', { source: 'local' }));
        expect(asLocal.repos[1]).toEqual({ name: 'api', url: '/src/coll/api', local: true });
        expect(plan).toMatchObject({ name: 'coll', parent: '/w', source: '/src/coll', staged: false, primary: null });
        // A collection's knowledge candidates: included ones, to .ai/<target>.
        expect(plan.knowledge).toEqual([
            { from: '/src/coll/README.md', kind: 'file', to: 'ai', subdir: 'knowledge' },
            { from: '/src/coll/plans', kind: 'directory', to: 'ai', subdir: 'plans' },
        ]);
    });

    it('a repo source: Codebase and Ignore copy nothing; Knowledge goes to .ai/<target>; Root beside project.json', () => {
        let d = startDraft(single, { parent: '/w' });
        d = { ...d, dispositions: d.dispositions.map((r) => (r.relPath === 'notes.md' ? { ...r, disposition: 'root' as const } : r.relPath === '.ai' ? { ...r, disposition: 'ignore' as const } : r)) };
        expect(buildPlan(d).knowledge).toEqual([{ from: '/src/acme-app/notes.md', kind: 'file', to: 'root', subdir: '' }]);
        expect(buildPlan(startDraft(single, { parent: '/w' })).knowledge).toEqual([
            { from: '/src/acme-app/notes.md', kind: 'file', to: 'ai', subdir: 'knowledge' },
            { from: '/src/acme-app/.ai', kind: 'directory', to: 'ai', subdir: '' },
        ]);
    });

    it('an exploded monorepo names its host', () => {
        expect(buildPlan(startDraft(mono, { parent: '/w' })).primary).toBe('ui');
    });

    it('refuses a plan it cannot build, before anything is written', () => {
        const ok: EnvelopePlan = { name: 'Acme', parent: '/w', source: '/src/acme-app', staged: false, repos: [{ name: 'acme-app', url: '/src/acme-app', local: true }], knowledge: [], primary: null };
        expect(planProblem(ok)).toBeNull();
        expect(planProblem({ ...ok, name: '  ' })).toMatch(/name/i);
        expect(planProblem({ ...ok, parent: '' })).toMatch(/where/i);
        expect(planProblem({ ...ok, repos: [{ name: 'a b', url: 'x', local: true }] })).toMatch(/a b/);
        expect(planProblem({ ...ok, repos: [{ name: 'a', url: 'x', local: true }, { name: 'a', url: 'y', local: true }] })).toMatch(/Duplicate/);
        // The envelope is a NEW folder BESIDE the source, never inside it: inside, it would change the source.
        expect(planProblem({ ...ok, parent: '/src/acme-app' })).toMatch(/inside/);
        expect(planProblem({ ...ok, parent: '/src/acme-app/sub' })).toMatch(/inside/);
        expect(planProblem({ ...ok, parent: '/src' })).toBeNull();
        expect(planProblem({ ...ok, parent: '/src/acme-app-2' })).toBeNull();
        // A Root item may not replace what makes the folder an envelope.
        expect(planProblem({ ...ok, knowledge: [{ from: '/src/acme-app/project.json', kind: 'file', to: 'root', subdir: '' }] })).toMatch(/project\.json/);
        expect(planProblem({ ...ok, knowledge: [{ from: '/src/acme-app/repos', kind: 'directory', to: 'root', subdir: '' }] })).toMatch(/repos/);
        expect(planProblem({ ...ok, knowledge: [{ from: '/src/acme-app/TODO.md', kind: 'file', to: 'root', subdir: '' }] })).toBeNull();
    });

    it('the manifest: each repo at repos/<name> with its branch; the host named; Genie 2 reads it (slug)', () => {
        const m = envelopeRepos([{ name: 'ui', url: 'https://x/ui.git', branch: 'main' }, { name: 'tools', url: '/t', branch: 'dev' }], 'ui');
        expect(m).toEqual({
            primaryRepo: 'ui',
            hosting: { enabled: true },
            repos: [
                { name: 'ui', slug: 'ui', url: 'https://x/ui.git', path: 'repos/ui', role: 'host', branch: 'main' },
                { name: 'tools', slug: 'tools', url: '/t', path: 'repos/tools', role: 'package', branch: 'dev' },
            ],
        });
        // One repo is its own host; several with none named have none.
        expect(envelopeRepos([{ name: 'a', url: 'u', branch: 'main' }], null)).toMatchObject({ primaryRepo: 'a', hosting: { enabled: true } });
        expect(envelopeRepos([{ name: 'a', url: 'u', branch: 'main' }, { name: 'b', url: 'v', branch: 'main' }], null)).toMatchObject({ primaryRepo: '', hosting: { enabled: false } });
        // A detached submodule tracks no branch: none is recorded, never a guessed `main` (the Tynn import's rule too).
        expect(envelopeRepos([{ name: 'a', url: 'u', branch: null }], null)).toEqual({ primaryRepo: 'a', hosting: { enabled: true }, repos: [{ name: 'a', slug: 'a', url: 'u', path: 'repos/a', role: 'host' }] });
    });

    it('a plan from IPC or the remote wire (parseEnvelopePlan): exactly the fields Genie builds from, or nothing', () => {
        const plan = buildPlan(startDraft(collection, { parent: '/w' }));
        expect(parseEnvelopePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
        expect(parseEnvelopePlan(null)).toBeNull();
        expect(parseEnvelopePlan({ ...plan, staged: 'yes' })).toBeNull();
        expect(parseEnvelopePlan({ ...plan, repos: [{ name: 'a', url: 1, local: true }] })).toBeNull();
        expect(parseEnvelopePlan({ ...plan, knowledge: [{ from: '/x', kind: 'link', to: 'ai', subdir: '' }] })).toBeNull();
        // A knowledge target is one of .ai/'s folders — never a path that climbs out of the envelope.
        expect(parseEnvelopePlan({ ...plan, knowledge: [{ from: '/x', kind: 'file', to: 'ai', subdir: '../../etc' }] })).toBeNull();
        // Extra fields are dropped, not carried into the build.
        expect(parseEnvelopePlan({ ...plan, extra: 1, repos: [{ name: 'a', url: 'u', local: false, evil: true }] })).toEqual({ ...plan, repos: [{ name: 'a', url: 'u', local: false }] });
    });

    it('Genie 1’s second commit subject; nothing to commit is no commit', () => {
        expect(convertCommitMessage(1, 0)).toBe('Convert: migrate 1 submodule');
        expect(convertCommitMessage(2, 3)).toBe('Convert: migrate 2 submodules + 3 knowledge items');
        expect(convertCommitMessage(0, 1)).toBe('Convert: migrate 1 knowledge item');
        expect(convertCommitMessage(0, 0)).toBeNull();
    });
});
