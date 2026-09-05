import { describe, expect, it } from 'vitest';
import {
    ADD_WORKSPACE_SOURCES,
    FIRST_RUN_STEPS,
    canFinishFirstRun,
    containerRepoPlan,
    nextIncompleteFirstRunStep,
    workspaceFolderName,
    workspacePathPreview,
    workspaceSlug,
    workspaceWizardEntry,
    tynnWorkspaceSource,
    tynnProjectImportSource,
    scannedWorkspaceAction,
    gdwChoicesForSource,
} from '../workspace-onboarding';

it('registers a folder that is already a workspace instead of wrapping it again', () => {
    expect(scannedWorkspaceAction({ has_project_json: true })).toBe('register');
    expect(scannedWorkspaceAction({ has_project_json: false })).toBe('convert');
});

describe('managed workspace entry points', () => {
    /**
     * genie#431 — CREATING is not CONVERTING. "New workspace" used to return
     * `{ mode: 'local' }`, which is the same route an import takes, so the
     * inspect-and-convert wizard opened on a workspace that does not exist yet
     * and demanded a folder to upgrade. There was no way to make an empty one.
     */
    it('separates making a workspace from adopting one', () => {
        expect(ADD_WORKSPACE_SOURCES.map((source) => source.id)).toEqual([
            'new',
            'gapp',
            'local',
            'git',
            'tynn',
        ]);
    });

    it('groups the sources by whether they MAKE a workspace or ADOPT one', () => {
        // The distinction the fix turns on, said out loud on the screen it was
        // missing from — and the reason the picker can show five cards without
        // looking like a list of five unrelated buttons.
        const byGroup = (group: string) =>
            ADD_WORKSPACE_SOURCES.filter((s) => s.group === group).map((s) => s.id);
        expect(byGroup('create')).toEqual(['new', 'gapp']);
        expect(byGroup('adopt')).toEqual(['local', 'git', 'tynn']);
    });

    it('offers GDW as a destination for scratch, local, Git, and Tynn sources', () => {
        expect(gdwChoicesForSource('new')).toEqual(['workspace', 'gdw']);
        expect(gdwChoicesForSource('git')).toEqual(['workspace', 'gdw']);
        expect(gdwChoicesForSource('tynn')).toEqual(['workspace', 'gdw']);
    });

    it('sends a new workspace straight to creation, never through the scanner', () => {
        expect(workspaceWizardEntry('new')).toEqual({ mode: 'create' });
        expect(workspaceWizardEntry('gapp')).toEqual({ mode: 'gapp' });
    });

    it('keeps the scanner for the two sources that HAVE something to inspect', () => {
        expect(workspaceWizardEntry('local')).toEqual({ mode: 'local' });
        expect(workspaceWizardEntry('git')).toEqual({ mode: 'remote' });
    });

    it('never offers a plain-folder or Aionima-owned workspace', () => {
        expect(JSON.stringify(ADD_WORKSPACE_SOURCES)).not.toMatch(/simple|plain folder|Aionima/i);
    });

    /**
     * genie#432 — the picker is the first screen of the product for a new user.
     * It must not teach the storage format to explain what a workspace is.
     */
    it('describes the sources without format vocabulary', () => {
        expect(JSON.stringify(ADD_WORKSPACE_SOURCES)).not.toMatch(/envelope|upgrade|\.agi/i);
    });
});

describe('what a new workspace is called', () => {
    it('derives the folder from the name the user typed', () => {
        expect(workspaceSlug('Acme Storefront')).toBe('acme-storefront');
        expect(workspaceSlug('  Tynn.ai  ')).toBe('tynn.ai');
        expect(workspaceSlug('My_Weird  Name!!')).toBe('my-weird-name');
        expect(workspaceFolderName('Acme Storefront')).toBe('acme-storefront.agi');
    });

    it('does not double the suffix when the name already carries one', () => {
        expect(workspaceFolderName('tynn.ai.agi')).toBe('tynn.ai.agi');
    });

    it('has nothing to name when nothing was typed', () => {
        expect(workspaceSlug('   ')).toBe('');
        expect(workspaceFolderName('   ')).toBe('');
    });

    /**
     * The form shows the path before it makes it, so someone can see where the
     * folder is going while they are still typing its name. The renderer has no
     * `node:path`, and the separator has to match the machine it is describing —
     * a Windows parent joined with `/` is a path that reads as wrong to the only
     * person who can check it.
     */
    it('previews the destination in the separator the parent already uses', () => {
        expect(workspacePathPreview('C:\\Projects', 'acme.agi')).toBe('C:\\Projects\\acme.agi');
        expect(workspacePathPreview('/home/wish/code', 'acme.agi')).toBe('/home/wish/code/acme.agi');
        expect(workspacePathPreview('C:\\Projects\\', 'acme.agi')).toBe('C:\\Projects\\acme.agi');
        expect(workspacePathPreview('/home/wish/code/', 'acme.agi')).toBe('/home/wish/code/acme.agi');
    });
});

describe('the container repository', () => {
    /**
     * genie#431 — the container repo is a CONSEQUENCE of GitHub being connected.
     * It is not a mode the user picks, and it is never a precondition: a
     * workspace can always be created, GitHub or no GitHub.
     */
    it('is created whenever GitHub is connected — no question asked', () => {
        expect(containerRepoPlan({
            githubConnected: true,
            githubCanProvision: true,
            owner: 'acme',
            slug: 'storefront',
        })).toEqual({ kind: 'github', owner: 'acme', repo: 'storefront.agi' });
    });

    it('falls back to this machine only when GitHub is not connected', () => {
        expect(containerRepoPlan({
            githubConnected: false,
            githubCanProvision: false,
            owner: '',
            slug: 'storefront',
        })).toEqual({ kind: 'local-only', reason: 'not-connected' });
    });

    it('falls back rather than failing when the App cannot create repositories', () => {
        expect(containerRepoPlan({
            githubConnected: true,
            githubCanProvision: false,
            owner: 'acme',
            slug: 'storefront',
        })).toEqual({ kind: 'local-only', reason: 'missing-permission' });
    });

    it('has no repository to name before the workspace is named', () => {
        expect(containerRepoPlan({
            githubConnected: true,
            githubCanProvision: true,
            owner: 'acme',
            slug: '',
        })).toEqual({ kind: 'local-only', reason: 'unnamed' });
    });

    /**
     * The ACCOUNT decides first, and the name only decides whether there is a
     * repository name to show. Answering `unnamed` for a disconnected account
     * made the form say nothing at all until something was typed — so the one
     * fact a user needs before they start ("this stays on your machine") only
     * appeared once they had finished.
     */
    it('knows GitHub is absent before a single character is typed', () => {
        expect(containerRepoPlan({
            githubConnected: false,
            githubCanProvision: false,
            owner: '',
            slug: '',
        })).toEqual({ kind: 'local-only', reason: 'not-connected' });
        expect(containerRepoPlan({
            githubConnected: true,
            githubCanProvision: false,
            owner: 'acme',
            slug: '',
        })).toEqual({ kind: 'local-only', reason: 'missing-permission' });
    });
});

describe('Tynn workspace import', () => {
    // Which projects the picker LISTS, and what an already-linked one does, moved
    // to ./tynn-import with genie#355 — see tynn-import.test.ts.

    it('uses the declared envelope repository, independent of its suffix', () => {
        expect(tynnWorkspaceSource({
            isWorkspace: true,
            repositories: [
                { url: 'git@github.com:acme/product.git', kind: 'code' },
                { url: 'git@github.com:acme/workspace.git', kind: 'envelope', defaultBranch: 'trunk' },
            ],
        })).toEqual({ url: 'git@github.com:acme/workspace.git', branch: 'trunk' });
    });

    it('can start the scanner from an ordinary Tynn project repository', () => {
        expect(tynnProjectImportSource({
            isWorkspace: false,
            repositories: [{ url: 'https://github.com/acme/product.git', kind: 'code' }],
        })).toEqual({ kind: 'project', url: 'https://github.com/acme/product.git', branch: 'main' });
    });

    it('treats every Tynn project as a workspace regardless of legacy isWorkspace metadata', () => {
        expect(tynnWorkspaceSource({
            isWorkspace: false,
            repositories: [{ url: 'https://github.com/acme/envelope.git', kind: 'envelope' }],
        })).toEqual({ url: 'https://github.com/acme/envelope.git', branch: 'main' });
    });
});

describe('first-run onboarding contract', () => {
    it('puts model drivers before accounts without forcing existing users to add a workspace', () => {
        expect(FIRST_RUN_STEPS.map((step) => step.id)).toEqual([
            'welcome',
            'drivers',
            'tynn',
            'github',
            'verify',
            'workspace',
            'ready',
        ]);
        expect(FIRST_RUN_STEPS.find((step) => step.id === 'tynn')?.optional).toBe(false);
        expect(FIRST_RUN_STEPS.find((step) => step.id === 'github')?.optional).toBe(true);
        expect(canFinishFirstRun({ existingWorkspaceCount: 2, setupComplete: true })).toBe(true);
        expect(canFinishFirstRun({ existingWorkspaceCount: 0, setupComplete: true })).toBe(false);
    });

    it('resumes at the first incomplete required step', () => {
        expect(nextIncompleteFirstRunStep({ welcome: true, drivers: true })).toBe('tynn');
        expect(
            nextIncompleteFirstRunStep({
                welcome: true,
                drivers: true,
                tynn: true,
                verify: true,
                workspace: true,
                ready: true,
            }),
        ).toBeNull();
    });
});
