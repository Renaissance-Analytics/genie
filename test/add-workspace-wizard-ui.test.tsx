import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { patchRepo, renameWorkspace, setMonorepoMode, startDraft, type SourceAnalysis } from '../src/core/envelope-plan.js';
import { AddFromGitForm } from '../src/renderer/components/AddWorkspacePreview.js';
import {
    canLeaveStep,
    DispositionStepView,
    ExistingWorkspaceView,
    KnowledgeStepView,
    ReposStepView,
    SourceStepView,
    WizardStepper,
    WorkspaceStepView,
} from '../src/renderer/components/AddWorkspaceWizard.js';

/**
 * OPEN EXISTING FOLDER / IMPORT FROM GIT ON SCREEN (Add workspace parity item 7) — Genie 1's four steps, Source → Repos →
 * Knowledge → Workspace (InteractiveUpgradeWizard.tsx :130-889), each a hook-free view over the draft, rendered as markup.
 * What each step must SAY: what the folder is and that it is never changed; the repos with Origin / Local and their
 * names; what each entry becomes with its git state; where the new workspace lands and what it will hold.
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
        { name: 'ui', path: 'packages/ui', url: 'https://github.com/acme/ui.git', localPath: '/src/mono/packages/ui' },
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
    knowledge: [{ relPath: 'plans', absPath: '/src/coll/plans', kind: 'directory', suggestedTarget: 'plans' }],
    other: [{ relPath: 'misc', kind: 'directory' }],
    rootEntries: null,
    submodules: [],
};

const noop = () => {};
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('the steps', () => {
    it('Genie 1’s four, in order, the current one marked', () => {
        const html = renderToStaticMarkup(<WizardStepper step={2} onStep={noop} />);
        expect([...html.matchAll(/data-wizard-step="([^"]+)"/g)].map((m) => m[1])).toEqual(['Source', 'Repos', 'Knowledge', 'Workspace']);
        expect(count(html, 'aria-current="step"')).toBe(1);
        expect(html).toMatch(/data-wizard-step="Knowledge" aria-current="step"/);
    });
});

describe('Source', () => {
    it('says what the folder is, what was found, and that it is never changed', () => {
        const html = renderToStaticMarkup(<SourceStepView analysis={single} staged={false} />);
        expect(html).toContain('data-wizard-source="single-repo"');
        expect(html).toMatch(/Single repository/);
        expect(html).toMatch(/Found: 1 repo · 0 knowledge candidates · 0 other items/);
        expect(html).toMatch(/Genie never changes it/);
        expect(html).toMatch(/\/src\/acme-app/);
    });

    it('an import names its URL and the staging clone, not a folder of the person’s', () => {
        const html = renderToStaticMarkup(<SourceStepView analysis={{ ...collection, root: '/tmp/genie-import-x/coll' }} staged url="https://github.com/acme/coll.git" />);
        expect(html).toMatch(/Collection of repositories/);
        expect(html).toMatch(/Cloned <span class="font-mono">https:\/\/github\.com\/acme\/coll\.git<\/span> to a staging folder/);
    });
});

describe('Repos', () => {
    it('a row per repo: include, its repos/<name>, Origin when it has a remote and Local when it is on disk', () => {
        const d = startDraft(collection, { parent: '/w' });
        const html = renderToStaticMarkup(<ReposStepView draft={d} onPatch={noop} onMode={noop} onPrimary={noop} />);
        expect(count(html, 'data-repo-row=')).toBe(2);
        expect(html).toMatch(/data-repo-name="_web"[^>]*value="web"/);
        expect(html).toMatch(/data-repo-name="api"[^>]*value="api"/);
        // web has no remote: Local only. api: Origin and Local, its remote shown.
        const web = html.slice(html.indexOf('data-repo-row="_web"'), html.indexOf('data-repo-row="api"'));
        const api = html.slice(html.indexOf('data-repo-row="api"'));
        expect(web).toMatch(/Local path/);
        expect(web).not.toMatch(/Origin \(clone\)/);
        expect(api).toMatch(/Origin \(clone\)/);
        expect(api).toMatch(/Local path/);
        expect(api).toMatch(/https:\/\/github\.com\/acme\/api\.git/);
        // No host column outside an exploded monorepo; no problem with valid names.
        expect(html).not.toContain('name="wizard-host"');
        expect(html).not.toContain('data-repos-problem');
    });

    it('a staged import offers no Local, and says so for a repo with no remote', () => {
        const staged = startDraft(collection, { parent: '/w', staged: true });
        const html = renderToStaticMarkup(<ReposStepView draft={staged} onPatch={noop} onMode={noop} onPrimary={noop} />);
        expect(html).not.toMatch(/Local path/);
        expect(count(html, 'data-no-source=')).toBe(1);
        // Positive control: the same rows, not staged, offer Local twice and need no warning.
        const local = renderToStaticMarkup(<ReposStepView draft={startDraft(collection, { parent: '/w' })} onPatch={noop} onMode={noop} onPrimary={noop} />);
        expect(count(local, 'Local path')).toBe(2);
        expect(count(local, 'data-no-source=')).toBe(0);
    });

    it('duplicate names are named as the problem', () => {
        const d = patchRepo(startDraft(collection, { parent: '/w' }), '_web', { name: 'api' });
        const html = renderToStaticMarkup(<ReposStepView draft={d} onPatch={noop} onMode={noop} onPrimary={noop} />);
        expect(html).toMatch(/data-repos-problem=""[^>]*>Repository names must be unique\./);
        expect(canLeaveStep(d, 1)).toBe(false);
        expect(canLeaveStep(startDraft(collection, { parent: '/w' }), 1)).toBe(true);
        // Only the Repos step is gated on the names.
        expect(canLeaveStep(d, 0)).toBe(true);
    });

    it('a monorepo: Explode (pressed by default) or Wrap; exploding shows the host, one checked', () => {
        const d = startDraft(mono, { parent: '/w' });
        const html = renderToStaticMarkup(<ReposStepView draft={d} onPatch={noop} onMode={noop} onPrimary={noop} />);
        expect(html).toMatch(/data-monorepo-mode="explode" aria-pressed="true"/);
        expect(html).toMatch(/Explode into 2 submodules/);
        expect(html).toMatch(/data-monorepo-mode="wrap" aria-pressed="false"/);
        expect(count(html, 'name="wizard-host"')).toBe(2);
        // Exactly one host radio is checked, and it is ui's (attribute order is React's business, so the tag is read whole).
        const radios = [...html.matchAll(/<input[^>]*name="wizard-host"[^>]*>/g)].map((m) => m[0]);
        expect(radios.filter((t) => /\schecked=""/.test(t)).map((t) => /aria-label="([^"]+)"/.exec(t)?.[1])).toEqual(['ui is the host']);
        const wrapped = renderToStaticMarkup(<ReposStepView draft={setMonorepoMode(d, 'wrap')} onPatch={noop} onMode={noop} onPrimary={noop} />);
        expect(wrapped).toMatch(/data-monorepo-mode="wrap" aria-pressed="true"/);
        expect(count(wrapped, 'data-repo-row=')).toBe(1);
        expect(wrapped).toMatch(/\(this folder\)/);
        expect(wrapped).not.toContain('name="wizard-host"');
    });
});

describe('Knowledge', () => {
    it('a repo source: every entry with its git state and what it becomes; a target only for Knowledge', () => {
        const d = startDraft(single, { parent: '/w' });
        const html = renderToStaticMarkup(<DispositionStepView rows={d.dispositions} onSet={noop} onSetAll={noop} />);
        expect([...html.matchAll(/data-disposition-row="([^"]+)" data-disposition="([^"]+)"/g)].map((m) => [m[1], m[2]])).toEqual([['README.md', 'codebase'], ['notes.md', 'knowledge'], ['.ai', 'knowledge']]);
        expect([...html.matchAll(/data-git-state="([^"]+)"/g)].map((m) => m[1])).toEqual(['tracked', 'untracked', 'ignored']);
        expect(count(html, 'aria-label="Where in .ai/')).toBe(2);
        for (const d2 of ['codebase', 'knowledge', 'root', 'ignore']) expect(html).toContain(`data-set-all="${d2}"`);
        expect(html).toMatch(/Ignore \(leave out\)/);
    });

    it('a collection: the knowledge candidates to copy into .ai/, and the rest listed as untouched', () => {
        const d = startDraft(collection, { parent: '/w' });
        const html = renderToStaticMarkup(<KnowledgeStepView rows={d.knowledge} other={collection.other} onPatch={noop} />);
        expect(html).toContain('data-knowledge-row="plans"');
        expect(html).toMatch(/1 other item — stay in the source folder, untouched/);
        expect(html).toMatch(/<li>misc\/<\/li>/);
    });
});

describe('Workspace', () => {
    it('the name, where it lands as <parent>/<slug>.agi, and what it will hold', () => {
        const d = renameWorkspace(startDraft(collection, { parent: '/w' }), 'Acme Coll');
        const html = renderToStaticMarkup(<WorkspaceStepView draft={d} sep="/" onName={noop} onBrowse={noop} />);
        expect(/<input[^>]*data-field="workspace-name"[^>]*>/.exec(html)?.[0]).toMatch(/\svalue="Acme Coll"/);
        expect(html).toMatch(/Lands at \/w\/acme-coll\.agi/);
        expect(html).toMatch(/adds <strong>2<\/strong> submodules, copies <strong>1<\/strong> knowledge item,/);
        expect(html).toMatch(/Your folder is not changed\./);
    });
});

describe('a folder that is already a workspace', () => {
    it('is added as it is; nothing is built', () => {
        const html = renderToStaticMarkup(<ExistingWorkspaceView path="/w/have.agi" staged={false} parent="" sep="/" onBrowse={noop} />);
        expect(html).toContain('data-wizard-existing');
        expect(html).toMatch(/already a workspace/);
        expect(html).toMatch(/nothing is built/);
        expect(html).not.toContain('data-action="browse-parent"');
    });

    it('from an import, it is cloned where the person chooses', () => {
        const html = renderToStaticMarkup(<ExistingWorkspaceView path="/tmp/genie-import-x/have.agi" staged url="https://github.com/acme/have.agi.git" parent="/w" sep="/" onBrowse={noop} />);
        expect(html).toContain('data-action="browse-parent"');
        expect(html).toMatch(/Lands at \/w\/have\.agi/);
    });
});

describe('Import from Git form', () => {
    it('takes a URL and clones it to a staging folder to read it — the person’s folders are not touched until they confirm', () => {
        const html = renderToStaticMarkup(<AddFromGitForm onPreview={noop} onCancel={noop} />);
        expect(html).toContain('data-form="add-from-git"');
        expect(html).toContain('data-action="clone-and-read"');
        expect(html).toMatch(/staging folder/);
        expect(html).not.toContain('pick-parent-and-preview');
    });

    it('while cloning, its button is disabled and says so', () => {
        const html = renderToStaticMarkup(<AddFromGitForm onPreview={noop} onCancel={noop} busy />);
        expect(html).toMatch(/data-action="clone-and-read" disabled=""/);
        expect(html).toMatch(/Cloning…/);
    });
});
