import { describe, expect, it } from 'vitest';
import { parseTynnProject, submoduleName, tynnAddPlan, tynnContent, tynnLink, type TynnProject } from '../src/core/tynn.js';

/**
 * ADD A WORKSPACE FROM TYNN (§6.1) — the pure half. The signed-in person's projects come from Tynn's
 * `GET /api/v1/projects` (MeApiController::projectRow), which says per project what it CONTAINS: `repositories[]`
 * {id, url, default_branch, kind}, `is_workspace`, and the `envelope` block {clone_url, default_branch, repo_owner,
 * repo_name, …} with `envelope_status` 'present' | 'none' — Tynn names the container, Genie never guesses it. So "from
 * Tynn" brings that content, as Genie 1 did (renderer/lib/tynn-import.ts, main/workspace/add-workspace.ts): the envelope
 * repo cloned when Tynn names one; else a new envelope with the project's repos as submodules under repos/; else an
 * empty envelope. The folder is `<parent>/<slug>.agi`; the plan is shown before anything is written.
 */

/** A row as Tynn's projectRow() sends it (measured 2026-10-21), with the envelope block present. */
const enveloped = {
    id: 42,
    name: 'Tynn.ai',
    slug: 'tynn',
    vision: 'Agentic project management.',
    is_workspace: true,
    is_gapp: false,
    sacred_agent_name: null,
    repositories: [
        { id: 7, url: 'https://github.com/example-org/tynn.agi', default_branch: 'main', kind: 'envelope' },
        { id: 8, url: 'https://github.com/example-org/tynn-app', default_branch: 'develop', kind: 'code' },
    ],
    envelope: { repository_id: 7, url: 'https://github.com/example-org/tynn.agi', default_branch: 'main', kind: 'envelope', clone_url: 'https://github.com/example-org/tynn.agi.git', repo_owner: 'example-org', repo_name: 'tynn.agi', reason: null },
    envelope_status: 'present',
};

const base: TynnProject = { id: '42', name: 'Tynn.ai', slug: 'tynn', vision: 'Agentic project management.', isWorkspace: true, repositories: [], envelope: null };

describe('parseTynnProject', () => {
    it('keeps what Tynn says the project contains: its repositories, whether it is a workspace, and the envelope it names', () => {
        expect(parseTynnProject(enveloped)).toEqual({
            id: '42',
            name: 'Tynn.ai',
            slug: 'tynn',
            vision: 'Agentic project management.',
            isWorkspace: true,
            repositories: [
                { url: 'https://github.com/example-org/tynn.agi', defaultBranch: 'main', kind: 'envelope' },
                { url: 'https://github.com/example-org/tynn-app', defaultBranch: 'develop', kind: 'code' },
            ],
            envelope: { cloneUrl: 'https://github.com/example-org/tynn.agi.git', defaultBranch: 'main', owner: 'example-org', name: 'tynn.agi' },
        });
    });

    it('envelope_status "none" is no envelope, whatever else the row carries; a row with neither block says nothing it did not say', () => {
        expect(parseTynnProject({ ...enveloped, envelope: null, envelope_status: 'none' })?.envelope).toBeNull();
        // A present-looking block that Tynn marked 'none' is still none: the status is Tynn's word on it.
        expect(parseTynnProject({ ...enveloped, envelope_status: 'none' })?.envelope).toBeNull();
        expect(parseTynnProject({ id: 'p_7', name: 'X', slug: 'x' })).toEqual({ id: 'p_7', name: 'X', slug: 'x', vision: null, isWorkspace: false, repositories: [], envelope: null });
        expect(parseTynnProject({ id: 1, name: 'X', slug: 'x', vision: '' })?.vision).toBeNull();
    });

    it('a repository with no url is dropped; a missing branch or kind is null, not a guess', () => {
        const p = parseTynnProject({ id: 1, name: 'X', slug: 'x', repositories: [{ id: 1, url: '' }, { id: 2, url: 'https://github.com/a/b' }, 'nope', null] });
        expect(p?.repositories).toEqual([{ url: 'https://github.com/a/b', defaultBranch: null, kind: null }]);
    });

    it('is null for anything that is not a project: a user record, a message, no slug, a slug with a path in it', () => {
        expect(parseTynnProject({ id: 3, email: 'a@b.invalid', name: 'Someone' })).toBeNull();
        expect(parseTynnProject({ message: 'Unauthenticated.' })).toBeNull();
        expect(parseTynnProject({ id: 1, name: 'X', slug: '' })).toBeNull();
        expect(parseTynnProject({ id: 1, name: 'X', slug: '../x' })).toBeNull();
        expect(parseTynnProject({ id: 1, name: 'X', slug: 'a/b' })).toBeNull();
        expect(parseTynnProject(null)).toBeNull();
        expect(parseTynnProject('tynn')).toBeNull();
    });
});

describe('tynnContent — what the workspace starts with, in Genie 1’s order', () => {
    it('the envelope Tynn names, by its clone_url and branch', () => {
        expect(tynnContent(parseTynnProject(enveloped)!)).toEqual({ kind: 'envelope', url: 'https://github.com/example-org/tynn.agi.git', branch: 'main' });
    });

    it('no envelope but repositories: each one, the envelope kind left out, named as Genie 1 named its submodules', () => {
        const p = parseTynnProject({ ...enveloped, envelope: null, envelope_status: 'none', repositories: [...enveloped.repositories, { id: 9, url: 'git@github.com:example-org/Docs Site.git', kind: 'knowledge' }] })!;
        expect(tynnContent(p)).toEqual({
            kind: 'repos',
            repos: [
                { url: 'https://github.com/example-org/tynn-app', branch: 'develop', name: 'tynn-app' },
                { url: 'git@github.com:example-org/Docs Site.git', branch: null, name: 'Docs-Site' },
            ],
        });
    });

    it('neither: empty', () => {
        expect(tynnContent(base)).toEqual({ kind: 'empty' });
        // Only an envelope-kind repository and no envelope block: nothing to submodule (an envelope is never a submodule).
        expect(tynnContent({ ...base, repositories: [{ url: 'https://github.com/a/x.agi', defaultBranch: 'main', kind: 'envelope' }] })).toEqual({ kind: 'empty' });
    });
});

describe('submoduleName (Genie 1 add-workspace.ts submoduleName/deriveRepoName)', () => {
    it('the URL’s last segment without .git, anything git would not take turned to dashes', () => {
        expect(submoduleName('https://github.com/a/api.git')).toBe('api');
        expect(submoduleName('https://github.com/a/api/')).toBe('api');
        expect(submoduleName('git@github.com:a/web.app.git')).toBe('web.app');
        expect(submoduleName('file:///tmp/x/remote api.git')).toBe('remote-api');
        expect(submoduleName('https://github.com/a/@@@')).toBe('repo');
    });
});

describe('tynnLink', () => {
    it('the link the schema defines, the host without a trailing slash, owner omitted when unknown', () => {
        expect(tynnLink(base, 'https://tynn.ai/')).toEqual({ host: 'https://tynn.ai', project: 'tynn', projectId: '42' });
    });
});

describe('tynnAddPlan', () => {
    it('no content: `<parent>/<slug>.agi`, a new envelope with its first commit, the Tynn link named; nothing written here', () => {
        const plan = tynnAddPlan({ project: base, parent: '/w/', folderExists: false, host: 'https://tynn.ai' });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan).toMatchObject({ source: 'tynn', path: '/w/tynn.agi', id: 'tynn', kind: 'empty', content: { kind: 'empty' }, project: base });
        expect(plan.manifest).toEqual({ name: 'Tynn.ai', description: 'Agentic project management.', tynn: { host: 'https://tynn.ai', project: 'tynn', projectId: '42' } });
        const actions = plan.steps.map((s) => s.action);
        expect(actions[0]).toBe('create /w/tynn.agi');
        expect(actions).toContain('write project.json');
        expect(actions).toContain('make the first commit on main');
        expect(actions).toContain('link to Tynn project Tynn.ai (https://tynn.ai)');
        expect(actions.filter((a) => /submodule|clone/.test(a))).toEqual([]);
        expect(plan.steps.filter((s) => !s.writes).map((s) => s.action)).toEqual(['register in Genie']);
    });

    it('repositories: the same new envelope, then each one a submodule under repos/ on its branch, then a commit', () => {
        const project: TynnProject = { ...base, repositories: [{ url: 'https://github.com/a/api.git', defaultBranch: 'develop', kind: 'code' }, { url: 'https://github.com/a/web', defaultBranch: null, kind: 'code' }] };
        const plan = tynnAddPlan({ project, parent: '/w', folderExists: false, host: 'https://tynn.ai' });
        if (!plan.ok) throw new Error(plan.reason);
        expect(plan.content).toEqual({ kind: 'repos', repos: [{ url: 'https://github.com/a/api.git', branch: 'develop', name: 'api' }, { url: 'https://github.com/a/web', branch: null, name: 'web' }] });
        const actions = plan.steps.map((s) => s.action);
        expect(actions).toContain('make the first commit on main');
        expect(actions).toContain('add https://github.com/a/api.git as the submodule repos/api, tracking develop');
        expect(actions).toContain('add https://github.com/a/web as the submodule repos/web, tracking its default branch');
        expect(actions).toContain('commit the 2 submodules');
        expect(actions.indexOf('make the first commit on main')).toBeLessThan(actions.indexOf('commit the 2 submodules'));
    });

    it('an envelope: a clone of it with its submodules, on its branch, linked back; nothing made by hand', () => {
        const plan = tynnAddPlan({ project: parseTynnProject(enveloped)!, parent: '/w', folderExists: false, host: 'https://tynn.ai' });
        if (!plan.ok) throw new Error(plan.reason);
        expect(plan).toMatchObject({ path: '/w/tynn.agi', kind: 'full-envelope', content: { kind: 'envelope', url: 'https://github.com/example-org/tynn.agi.git', branch: 'main' } });
        expect(plan.steps.map((s) => s.action)).toEqual([
            'clone https://github.com/example-org/tynn.agi.git (branch main) with its submodules into /w/tynn.agi',
            'link to Tynn project Tynn.ai (https://tynn.ai)',
            'register in Genie',
        ]);
    });

    it('refuses a folder that already exists — add that folder instead of writing into it', () => {
        expect(tynnAddPlan({ project: base, parent: '/w', folderExists: true, host: 'https://tynn.ai' })).toEqual({ ok: false, reason: '/w/tynn.agi already exists; add that folder instead of creating the Tynn envelope over it' });
    });

    it('refuses two repositories that would land in one folder, naming both, before anything is written', () => {
        const project: TynnProject = { ...base, repositories: [{ url: 'https://github.com/a/api', defaultBranch: null, kind: 'code' }, { url: 'https://gitlab.com/b/api.git', defaultBranch: null, kind: 'code' }] };
        expect(tynnAddPlan({ project, parent: '/w', folderExists: false, host: 'https://tynn.ai' })).toEqual({ ok: false, reason: 'Tynn lists two repositories that would both be repos/api (https://github.com/a/api and https://gitlab.com/b/api.git); rename one on Tynn first' });
    });

    it('a project already added here is not added twice: the refusal names the workspace to open', () => {
        expect(tynnAddPlan({ project: base, parent: '/w', folderExists: false, host: 'https://tynn.ai', addedAs: 'tynn-old' })).toEqual({ ok: false, reason: 'Tynn.ai is already added here, as the workspace tynn-old. Open that workspace instead.', workspaceId: 'tynn-old' });
    });

    it('a project with no vision gets an empty description, not the word null', () => {
        const plan = tynnAddPlan({ project: { ...base, vision: null }, parent: '/w', folderExists: false, host: 'https://tynn.ai' });
        expect(plan.ok && plan.manifest.description).toBe('');
    });
});
