import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Published, RemoteChoice } from '../src/core/agi-remote.js';
import { startDraft, type SourceAnalysis } from '../src/core/envelope-plan.js';
import { signedOutGithubView, type GithubInstallation, type GithubView } from '../src/core/github.js';
import { NewWorkspaceForm } from '../src/renderer/components/AddWorkspaceModal.js';
import { WorkspaceStepView } from '../src/renderer/components/AddWorkspaceWizard.js';
import { PublishedView, RemoteChoiceView } from '../src/renderer/components/AgiRemoteChoice.js';

/**
 * THE REMOTE CHOICE ON SCREEN (Add workspace parity items 10 + 11): None / GitHub / Paste URL on New and on the wizard's
 * Workspace step (Genie 1's InteractiveUpgradeWizard :1719-1787), the owner picker with its not-installed prompt and
 * "Install Genie on another account/org…" (GitHubConnect.tsx :669-790), the private toggle, and the partial-success
 * screen — "<name> is ready" with the step that failed in the service's words (AddWorkspaceModal.tsx :446-471).
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

const install = (account: string, isOrg: boolean, id = 1): GithubInstallation => ({ id, account, isOrg, selection: 'all', repoCount: null, repos: null, permissions: { contents: 'write' }, settingsUrl: `https://github.com/settings/installations/${id}` });
const signedIn = (installations: GithubInstallation[] | null): GithubView => ({ ...signedOutGithubView(null), status: 'signed-in', user: { login: 'ada', name: 'Ada' }, installations });

function view(choice: RemoteChoice, github: GithubView | null) {
    const chosen: RemoteChoice[] = [];
    const asked: string[] = [];
    const ui = RemoteChoiceView({ choice, github, folder: 'acme.agi', onChoice: (c) => chosen.push(c), onGithub: (a) => asked.push(a) });
    return { ui, html: renderToStaticMarkup(ui), chosen, asked };
}

describe('None / GitHub / Paste URL', () => {
    it('three choices, None first; pressing each chooses it — COUNTED', () => {
        const { ui, chosen } = view({ kind: 'none' }, signedIn([install('ada', false)]));
        const kinds = findAll(ui, (p) => typeof p['data-remote-kind'] === 'string');
        expect(kinds.map((k) => k['data-remote-kind'])).toEqual(['none', 'github', 'paste']);
        for (const k of kinds) (k.onClick as () => void)();
        expect(chosen.map((c) => c.kind)).toEqual(['none', 'github', 'paste']);
        // GitHub chosen from None starts under the person, private.
        expect(chosen[1]).toEqual({ kind: 'github', owner: 'ada', private: true });
    });

    it('signed out of GitHub: None is selected, GitHub is unavailable and says how to sign in — Paste URL still works', () => {
        const { ui, html, asked } = view({ kind: 'none' }, signedOutGithubView(null));
        expect(html).toMatch(/data-remote-kind="none"[^>]*aria-pressed="true"/);
        expect(html).toMatch(/data-remote-kind="github"[^>]*disabled=""/);
        expect(html).not.toMatch(/data-remote-kind="paste"[^>]*disabled=""/);
        expect(html).toContain('Kept on this machine. You can add a remote later.');
        expect(html).toMatch(/Sign in to GitHub/);
        for (const b of findAll(ui, (p) => p['data-action'] === 'github-sign-in')) (b.onClick as () => void)();
        expect(asked).toEqual(['sign-in']);
    });

    it('Paste URL: a field for the remote, its value shown, and the plan line names it', () => {
        const { ui, html, chosen } = view({ kind: 'paste', url: 'git@example.com:me/acme.agi.git' }, null);
        expect(html).toMatch(/data-field="remote-url"[^>]*value="git@example.com:me\/acme.agi.git"/);
        expect(html).toContain('Pushed to git@example.com:me/acme.agi.git as origin once it is made.');
        const field = findAll(ui, (p) => p['data-field'] === 'remote-url')[0]!;
        (field.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'https://x/y.agi.git' } });
        expect(chosen).toEqual([{ kind: 'paste', url: 'https://x/y.agi.git' }]);
    });
});

describe('GitHub: the owner picker and the private toggle', () => {
    const gh = signedIn([install('ada', false, 1), install('acme-org', true, 2)]);

    it('lists the person and each installed org; picking one chooses it; the plan line says owner/slug.agi (private)', () => {
        const { ui, html, chosen } = view({ kind: 'github', owner: 'ada', private: true }, gh);
        const select = findAll(ui, (p) => p['data-field'] === 'remote-owner')[0]!;
        expect((select.list as Array<{ value: string }>).map((o) => o.value)).toEqual(['ada', 'acme-org']);
        (select.onValueChange as (v: string) => void)('acme-org');
        expect(chosen).toEqual([{ kind: 'github', owner: 'acme-org', private: true }]);
        expect(html).toContain('Backed up to GitHub as ada/acme.agi (private), pushed once it exists.');
    });

    it('the private toggle is ticked by default and unticking it asks for a public repository', () => {
        const { ui, html, chosen } = view({ kind: 'github', owner: 'ada', private: true }, gh);
        expect(html).toMatch(/data-field="remote-private"[^>]*checked=""/);
        const box = findAll(ui, (p) => p['data-field'] === 'remote-private')[0]!;
        (box.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: false } });
        expect(chosen).toEqual([{ kind: 'github', owner: 'ada', private: false }]);
    });

    it('the chosen account without the App: says so and offers the install — and an installed one does not (control)', () => {
        const notInstalled = signedIn([install('acme-org', true, 2)]);
        const { ui, html, asked } = view({ kind: 'github', owner: 'ada', private: true }, notInstalled);
        expect(html).toMatch(/isn(?:'|&#x27;)t installed on[^<]*<strong>ada<\/strong>/);
        for (const b of findAll(ui, (p) => p['data-action'] === 'github-install')) (b.onClick as () => void)();
        expect(asked).toEqual(['install']);
        const installed = view({ kind: 'github', owner: 'acme-org', private: true }, notInstalled);
        expect(installed.html).not.toMatch(/isn(?:'|&#x27;)t installed on/);
        expect(findAll(installed.ui, (p) => p['data-action'] === 'github-install')).toHaveLength(0);
    });

    it('"Install Genie on another account/org…" and "Check again" are always there while GitHub is chosen', () => {
        const { ui, asked } = view({ kind: 'github', owner: 'ada', private: true }, gh);
        for (const b of findAll(ui, (p) => p['data-action'] === 'github-install-other' || p['data-action'] === 'github-refresh')) (b.onClick as () => void)();
        expect(asked.sort()).toEqual(['install', 'refresh']);
    });
});

describe('the partial-success screen', () => {
    const published = (problems: Published['problems']): Published => ({ remote: null, repo: null, pushed: false, tynn: 'not-linked', problems });

    it('"<name> is ready", where it is, and each failed step in the service’s own words', () => {
        const ui = PublishedView({ name: 'Acme', path: '/w/acme.agi', published: published([{ step: 'push', message: 'fatal: repository not found' }, { step: 'tynn', message: 'Tynn answered 403: forbidden' }]), onOpen: () => {}, onGithub: () => {} });
        const html = renderToStaticMarkup(ui);
        expect(html).toContain('Acme is ready');
        expect(html).toContain('/w/acme.agi');
        const rows = findAll(ui, (p) => typeof p['data-publish-problem'] === 'string');
        expect(rows.map((r) => r['data-publish-problem'])).toEqual(['push', 'tynn']);
        expect(html).toContain('fatal: repository not found');
        expect(html).toContain('Tynn answered 403: forbidden');
    });

    it('not installed on an account: an install button; Open workspace opens it', () => {
        const asked: string[] = [];
        let opened = 0;
        const ui = PublishedView({ name: 'Acme', path: '/w/acme.agi', published: published([{ step: 'github', message: 'The Genie AOS app is not installed on acme-org', account: 'acme-org' }]), onOpen: () => { opened++; }, onGithub: (a) => asked.push(a) });
        for (const b of findAll(ui, (p) => p['data-action'] === 'github-install' || p['data-action'] === 'open-workspace')) (b.onClick as () => void)();
        expect(asked).toEqual(['install']);
        expect(opened).toBe(1);
    });
});

describe('the choice is on New and on the wizard’s Workspace step', () => {
    it('New: the three choices are in the form, and an unusable paste keeps Create disabled (a usable one does not — control)', () => {
        const base = { name: 'acme', parent: '/w', sep: '/', busy: false, error: null, onName: () => {}, onBrowse: () => {}, onCreate: () => {}, onCancel: () => {}, github: null, onRemote: () => {}, onGithub: () => {} };
        const bad = renderToStaticMarkup(NewWorkspaceForm({ ...base, remote: { kind: 'paste', url: '' } }));
        expect(bad).toContain('data-remote-kind="none"');
        expect(bad).toMatch(/data-action="create-workspace"[^>]*disabled=""/);
        const good = renderToStaticMarkup(NewWorkspaceForm({ ...base, remote: { kind: 'paste', url: 'https://x/acme.agi.git' } }));
        expect(good).not.toMatch(/data-action="create-workspace"[^>]*disabled=""/);
    });

    it('the wizard’s Workspace step carries the same choice', () => {
        const analysis: SourceAnalysis = { root: '/src/notes', sourceKind: 'plain-folder', repos: [], knowledge: [], other: [], submodules: [], rootEntries: [] };
        const draft = startDraft(analysis, { parent: '/w' });
        const html = renderToStaticMarkup(WorkspaceStepView({ draft, sep: '/', onName: () => {}, onBrowse: () => {}, remote: { kind: 'none' }, github: null, onRemote: () => {}, onGithub: () => {} }));
        expect(html).toContain('data-remote-kind="paste"');
        expect(html).toContain('Kept on this machine. You can add a remote later.');
    });
});
