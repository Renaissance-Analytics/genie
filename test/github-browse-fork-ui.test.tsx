import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { patchRepo, startDraft, type SourceAnalysis } from '../src/core/envelope-plan.js';
import { signedOutGithubView, type AccessibleRepo, type GithubInstallation, type GithubView, type RepoListing } from '../src/core/github.js';
import { AddFromGitView, GithubRepoBrowser } from '../src/renderer/components/AddWorkspacePreview.js';
import { ReposStepView } from '../src/renderer/components/AddWorkspaceWizard.js';

/**
 * ADD WORKSPACE PARITY 8 + 12 ON SCREEN.
 *
 * (8) Genie 1's Remote repo source (InteractiveUpgradeWizard.tsx:989-1068): the repositories the GitHub sign-in reaches,
 * to pick from, with Refresh; the URL box stays for anything else. Signed out or not installed, it says so and offers the
 * fix (as the remote choice does, #1107).
 *
 * (12) Genie 1's third source per repository, Fork, into the owner chosen with the same picker as the remote's.
 */

type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const props = node.props as Props;
    if (match(props)) out.push(props);
    findAll(props.children, match, out);
    return out;
}
const noop = () => {};

const repo = (fullName: string, priv: boolean): AccessibleRepo => ({ fullName, owner: fullName.split('/')[0]!, name: fullName.split('/')[1]!, private: priv, cloneUrl: `https://github.com/${fullName}.git`, defaultBranch: 'main' });
const LISTED: RepoListing = { status: 'listed', truncated: false, repos: [repo('ada/notes', true), repo('Example-Org/site', false), repo('Example-Org/site-docs', true)] };

function browser(listing: RepoListing | null, query = '') {
    const picked: string[] = [];
    const asked: string[] = [];
    let reloads = 0;
    const ui = GithubRepoBrowser({ listing, query, selectedUrl: '', onQuery: noop, onPick: (r) => picked.push(r.cloneUrl), onReload: () => { reloads += 1; }, onGithub: (a) => asked.push(a) });
    return { ui, html: renderToStaticMarkup(ui), picked, asked, reloads: () => reloads };
}

describe('the repository browser beside the URL box', () => {
    it('lists what the sign-in reaches, each marked private or public; pressing one picks its clone URL — COUNTED', () => {
        const { ui, html, picked } = browser(LISTED);
        const rows = findAll(ui, (p) => typeof p['data-repo-pick'] === 'string');
        expect(rows.map((r) => r['data-repo-pick'])).toEqual(['ada/notes', 'Example-Org/site', 'Example-Org/site-docs']);
        expect(html).toMatch(/data-repo-pick="ada\/notes"[^]*?Private/);
        expect(html).toMatch(/data-repo-pick="Example-Org\/site"[^]*?Public/);
        for (const r of rows) (r.onClick as () => void)();
        expect(picked).toEqual(['https://github.com/ada/notes.git', 'https://github.com/Example-Org/site.git', 'https://github.com/Example-Org/site-docs.git']);
    });

    it('the search narrows the list (and says when nothing matches)', () => {
        const narrowed = findAll(browser(LISTED, 'site docs').ui, (p) => typeof p['data-repo-pick'] === 'string');
        expect(narrowed.map((r) => r['data-repo-pick'])).toEqual(['Example-Org/site-docs']);
        expect(browser(LISTED, 'nothing-like-it').html).toMatch(/No repository matches/);
        expect(findAll(browser(LISTED).ui, (p) => p['data-field'] === 'repo-search')).toHaveLength(1);
    });

    it('a very long list shows the first matches and asks for a search; a listing GitHub cut short says so', () => {
        const many: RepoListing = { status: 'listed', truncated: true, repos: Array.from({ length: 450 }, (_, i) => repo(`ada/r${i}`, false)) };
        const { ui, html } = browser(many);
        const rows = findAll(ui, (p) => typeof p['data-repo-pick'] === 'string');
        expect(rows.length).toBeLessThan(450);
        expect(rows.length).toBeGreaterThan(0);
        expect(html).toMatch(/search/i);
        expect(html).toMatch(/data-repos-truncated/);
    });

    it('loading: says so, never an empty list', () => {
        const { html, ui } = browser(null);
        expect(html).toContain('data-repo-browser="loading"');
        expect(findAll(ui, (p) => typeof p['data-repo-pick'] === 'string')).toEqual([]);
    });

    it('signed out: says GitHub is not signed in and offers the sign-in; the URL box is the way meanwhile', () => {
        const { ui, html, asked } = browser({ status: 'signed-out' });
        expect(html).toContain('data-repo-browser="signed-out"');
        for (const b of findAll(ui, (p) => p['data-action'] === 'github-sign-in')) (b.onClick as () => void)();
        expect(asked).toEqual(['sign-in']);
    });

    it('not installed anywhere: offers the install, and a check again once it is', () => {
        const b = browser({ status: 'not-installed' });
        expect(b.html).toContain('data-repo-browser="not-installed"');
        for (const x of findAll(b.ui, (p) => p['data-action'] === 'github-install')) (x.onClick as () => void)();
        for (const x of findAll(b.ui, (p) => p['data-action'] === 'repos-reload')) (x.onClick as () => void)();
        expect(b.asked).toEqual(['install']);
        expect(b.reloads()).toBe(1);
    });

    it('GitHub failed: its words, and Try again', () => {
        const b = browser({ status: 'failed', message: 'GitHub answered 500: Server Error' });
        expect(b.html).toContain('GitHub answered 500: Server Error');
        for (const x of findAll(b.ui, (p) => p['data-action'] === 'repos-reload')) (x.onClick as () => void)();
        expect(b.reloads()).toBe(1);
    });
});

describe('Import from Git: the URL box stays, and a picked repository fills it', () => {
    it('picking a repository puts its clone URL in the box; the box takes anything else too', () => {
        const urls: string[] = [];
        const ui = AddFromGitView({ url: '', query: '', repos: LISTED, busy: false, onUrl: (u) => urls.push(u), onQuery: noop, onPreview: noop, onCancel: noop, onReloadRepos: noop, onGithub: noop });
        const box = findAll(ui, (p) => p.name === 'url');
        expect(box).toHaveLength(1);
        (findAll(ui, (p) => p['data-repo-pick'] === 'Example-Org/site')[0]!.onClick as () => void)();
        (box[0]!.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'git@gitlab.com:ada/x.git' } });
        expect(urls).toEqual(['https://github.com/Example-Org/site.git', 'git@gitlab.com:ada/x.git']);
    });

    it('Clone and read it sends the URL in the box', () => {
        const sent: string[] = [];
        const ui = AddFromGitView({ url: ' https://github.com/ada/notes.git ', query: '', repos: LISTED, busy: false, onUrl: noop, onQuery: noop, onPreview: (u) => sent.push(u), onCancel: noop, onReloadRepos: noop, onGithub: noop });
        const form = findAll(ui, (p) => p['data-form'] === 'add-from-git')[0]!;
        (form.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: noop });
        expect(sent).toEqual(['https://github.com/ada/notes.git']);
    });

    it('a host that cannot list repositories (an older Genie): the URL box alone, as before', () => {
        const html = renderToStaticMarkup(AddFromGitView({ url: '', query: '', repos: undefined, busy: false, onUrl: noop, onQuery: noop, onPreview: noop, onCancel: noop, onReloadRepos: noop, onGithub: noop }));
        expect(html).not.toContain('data-repo-browser');
        expect(html).toContain('name="url"');
        // Positive control: with a listing, the browser is there.
        expect(renderToStaticMarkup(AddFromGitView({ url: '', query: '', repos: LISTED, busy: false, onUrl: noop, onQuery: noop, onPreview: noop, onCancel: noop, onReloadRepos: noop, onGithub: noop }))).toContain('data-repo-browser="listed"');
    });
});

/* ===== Fork in the wizard's Repos step =================================================================================== */

const install = (account: string, isOrg: boolean, id = 1): GithubInstallation => ({ id, account, isOrg, selection: 'all', repoCount: null, repos: null, permissions: { contents: 'write' }, settingsUrl: `https://github.com/settings/installations/${id}` });
const signedIn = (installations: GithubInstallation[] | null): GithubView => ({ ...signedOutGithubView(null), status: 'signed-in', user: { login: 'ada', name: 'Ada' }, installations });
const analysis: SourceAnalysis = { root: '/src/app', sourceKind: 'single-repo', repos: [{ relPath: '.', absPath: '/src/app', defaultName: 'app', originUrl: 'https://github.com/Upstream/app.git', headRef: 'main' }], knowledge: [], other: [], rootEntries: [], submodules: [] };

describe('Fork: a third source in the Repos step, into the owner chosen with the remote’s picker', () => {
    const sourceLists = (ui: ReactNode) => findAll(ui, (p) => Array.isArray(p.list) && String(p['aria-label'] ?? '').startsWith('Where'));

    it('signed in: Origin, Local and Fork are offered for a GitHub repository', () => {
        const ui = ReposStepView({ draft: startDraft(analysis, { parent: '/w' }), onPatch: noop, onMode: noop, onPrimary: noop, github: signedIn([install('ada', false)]), onForkInto: noop, onGithub: noop });
        expect((sourceLists(ui)[0]!.list as Array<{ value: string }>).map((o) => o.value)).toEqual(['origin', 'local', 'fork']);
    });

    it('signed out: no Fork (positive control above)', () => {
        const ui = ReposStepView({ draft: startDraft(analysis, { parent: '/w' }), onPatch: noop, onMode: noop, onPrimary: noop, github: signedOutGithubView(null), onForkInto: noop, onGithub: noop });
        expect((sourceLists(ui)[0]!.list as Array<{ value: string }>).map((o) => o.value)).toEqual(['origin', 'local']);
        expect(findAll(ui, (p) => p['data-field'] === 'fork-owner')).toEqual([]);
    });

    it('a Fork row: the owner picker (the person and each installed org); choosing one sets where the forks go', () => {
        const owners: string[] = [];
        const draft = patchRepo({ ...startDraft(analysis, { parent: '/w' }), forkInto: 'ada' }, '.', { source: 'fork' });
        const ui = ReposStepView({ draft, onPatch: noop, onMode: noop, onPrimary: noop, github: signedIn([install('ada', false), install('Example-Org', true, 2)]), onForkInto: (o) => owners.push(o), onGithub: noop });
        const picker = findAll(ui, (p) => p['data-field'] === 'fork-owner');
        expect(picker).toHaveLength(1);
        expect((picker[0]!.list as Array<{ value: string }>).map((o) => o.value)).toEqual(['ada', 'Example-Org']);
        expect(picker[0]!.value).toBe('ada');
        (picker[0]!.onValueChange as (v: string) => void)('Example-Org');
        expect(owners).toEqual(['Example-Org']);
        expect(renderToStaticMarkup(ui)).toMatch(/fork/i);
    });

    it('the chosen owner without the App: the install is offered right there', () => {
        const asked: string[] = [];
        const draft = patchRepo({ ...startDraft(analysis, { parent: '/w' }), forkInto: 'ada' }, '.', { source: 'fork' });
        // ada has no installation of her own (only the org has one).
        const ui = ReposStepView({ draft, onPatch: noop, onMode: noop, onPrimary: noop, github: signedIn([install('Example-Org', true, 2)]), onForkInto: noop, onGithub: (a) => asked.push(a) });
        const installs = findAll(ui, (p) => p['data-action'] === 'github-install');
        expect(installs.length).toBeGreaterThan(0);
        (installs[0]!.onClick as () => void)();
        expect(asked).toEqual(['install']);
    });
});
