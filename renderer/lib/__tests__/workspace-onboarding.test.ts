import { describe, expect, it } from 'vitest';
import {
    ADD_WORKSPACE_SOURCES,
    FIRST_RUN_STEPS,
    canFinishFirstRun,
    nextIncompleteFirstRunStep,
    workspaceWizardEntry,
    tynnWorkspaceSource,
    tynnProjectImportSource,
    availableTynnProjects,
    scannedWorkspaceAction,
} from '../workspace-onboarding';

it('registers an existing AGI/GApp envelope instead of wrapping it again', () => {
    expect(scannedWorkspaceAction({ has_project_json: true })).toBe('register');
    expect(scannedWorkspaceAction({ has_project_json: false })).toBe('convert');
});

describe('managed workspace entry points', () => {
    it('offers only the three managed sources', () => {
        expect(ADD_WORKSPACE_SOURCES.map((source) => source.id)).toEqual([
            'new',
            'tynn',
            'git',
        ]);
    });

    it('routes every open-world source through the scanner-driven wizard', () => {
        expect(workspaceWizardEntry('new')).toEqual({ mode: 'local' });
        expect(workspaceWizardEntry('git')).toEqual({ mode: 'remote' });
        expect(workspaceWizardEntry('tynn')).toEqual({ mode: 'tynn' });
    });

    it('never offers a plain-folder or Aionima-owned workspace', () => {
        expect(JSON.stringify(ADD_WORKSPACE_SOURCES)).not.toMatch(/simple|plain folder|Aionima/i);
    });
});

describe('Tynn workspace import', () => {
    it('offers every accessible project except ones already linked to a Genie workspace', () => {
        const projects = [
            { id: 'available-empty', name: 'Empty', slug: 'empty', repositories: [] },
            { id: 'available-repo', name: 'Repo', slug: 'repo', repositories: [{ url: 'https://github.com/acme/repo.git', kind: 'code' as const }] },
            { id: 'linked', name: 'Linked', slug: 'linked', repositories: [] },
        ];

        expect(availableTynnProjects(projects, [
            { project_id: '', tynn_project_id: 'linked' },
            { project_id: '__genie_os__', tynn_project_id: '__genie_os__' },
        ]).map((project) => project.id)).toEqual(['available-empty', 'available-repo']);
    });

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
