import { describe, expect, it } from 'vitest';
import {
    ADD_WORKSPACE_SOURCES,
    FIRST_RUN_STEPS,
    nextIncompleteFirstRunStep,
    tynnWorkspaceSource,
} from '../workspace-onboarding';

describe('managed workspace entry points', () => {
    it('offers only the three managed sources', () => {
        expect(ADD_WORKSPACE_SOURCES.map((source) => source.id)).toEqual([
            'new',
            'tynn',
            'git',
        ]);
    });

    it('never offers a plain-folder or Aionima-owned workspace', () => {
        expect(JSON.stringify(ADD_WORKSPACE_SOURCES)).not.toMatch(/simple|plain folder|Aionima/i);
    });
});

describe('Tynn workspace import', () => {
    it('uses the declared envelope repository, independent of its suffix', () => {
        expect(tynnWorkspaceSource({
            isWorkspace: true,
            repositories: [
                { url: 'git@github.com:acme/product.git', kind: 'code' },
                { url: 'git@github.com:acme/workspace.git', kind: 'envelope', defaultBranch: 'trunk' },
            ],
        })).toEqual({ url: 'git@github.com:acme/workspace.git', branch: 'trunk' });
    });

    it('refuses a project that is not a managed workspace', () => {
        expect(tynnWorkspaceSource({ isWorkspace: false, repositories: [] })).toBeNull();
    });
});

describe('first-run onboarding contract', () => {
    it('puts model drivers before accounts and requires a first workspace', () => {
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
        expect(FIRST_RUN_STEPS.find((step) => step.id === 'workspace')?.optional).toBe(false);
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
