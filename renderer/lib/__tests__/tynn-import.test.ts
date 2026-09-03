import { describe, expect, it } from 'vitest';
import {
    importTynnEnvelopeWorkspace,
    tynnImportChoices,
    tynnImportRoute,
} from '../tynn-import';
import type { WorkspaceRow } from '../genie';

/**
 * genie#355 — importing a Tynn project that is ALREADY an `.agi` envelope was
 * routed, unconditionally, into the scan-and-convert wizard. That wizard's job
 * is turning a NON-envelope folder into one, so for these projects it had
 * nothing to do: the owner was made to pick a repo, clone it, and then walk a
 * conversion of a workspace that already existed.
 *
 * The decision lives here as a pure function so it is assertable without a
 * window, and it is asserted BOTH ways on purpose: "the wizard did not open"
 * passes just as happily against an import that does nothing at all, so the
 * non-envelope case below is the positive control that proves the wizard is
 * still reachable.
 */
describe('Tynn import routing (genie#355)', () => {
    const envelopeProject = {
        id: 'proj-envelope',
        name: 'Tynn.ai',
        isWorkspace: true,
        repositories: [
            { url: 'git@github.com:acme/product.git', kind: 'code' as const },
            {
                url: 'git@github.com:acme/product.agi.git',
                kind: 'envelope' as const,
                defaultBranch: 'trunk',
            },
        ],
    };

    it('sends an envelope-backed project straight to the clone step, never the wizard', () => {
        const route = tynnImportRoute(envelopeProject, []);

        expect(route.stage).not.toBe('agi-interactive');
        expect(route).toEqual({
            stage: 'tynn-envelope',
            reason: 'envelope-repo',
            source: { url: 'git@github.com:acme/product.agi.git', branch: 'trunk' },
        });
    });

    // POSITIVE CONTROL. Without this, the assertion above is satisfied by a
    // router that sends every project nowhere at all.
    it('still sends a project with no envelope repo into the upgrade wizard', () => {
        expect(
            tynnImportRoute(
                {
                    id: 'proj-plain',
                    name: 'Plain',
                    isWorkspace: false,
                    repositories: [{ url: 'https://github.com/acme/plain.git', kind: 'code' }],
                },
                [],
            ),
        ).toEqual({
            stage: 'agi-interactive',
            reason: 'no-envelope-repo',
            mode: 'remote',
            sourceUrl: 'https://github.com/acme/plain.git',
        });

        expect(tynnImportRoute({ id: 'proj-bare', name: 'Bare' }, [])).toEqual({
            stage: 'agi-interactive',
            reason: 'no-envelope-repo',
            mode: 'local',
            sourceUrl: '',
        });
    });

    /**
     * Tynn's `is_workspace` (its `is_envelope`) says a project HAS an envelope;
     * only the `envelope`-kind repository says WHERE it is. A project marked one
     * that declares no repo for it leaves Genie nothing to clone, so it keeps
     * the wizard — under its own reason, because that is a Tynn-side gap and not
     * an ordinary non-envelope project.
     */
    it('keeps the wizard when the project claims an envelope but declares no repo for it', () => {
        expect(
            tynnImportRoute({ id: 'proj-claimed', name: 'Claimed', isWorkspace: true }, []),
        ).toEqual({
            stage: 'agi-interactive',
            reason: 'envelope-repo-undeclared',
            mode: 'local',
            sourceUrl: '',
        });
    });

    it('offers to open a project already registered here instead of importing a second copy', () => {
        expect(
            tynnImportRoute(envelopeProject, [
                { id: 'ws-other', project_id: 'proj-other', tynn_project_id: 'proj-other' },
                { id: 'ws-here', project_id: 'proj-envelope', tynn_project_id: 'proj-envelope' },
            ]),
        ).toEqual({
            stage: 'tynn-open-existing',
            reason: 'already-registered',
            workspaceId: 'ws-here',
        });
    });

    it('matches a workspace linked through the v1 project_id column alone', () => {
        expect(
            tynnImportRoute(envelopeProject, [
                { id: 'ws-v1', project_id: 'proj-envelope', tynn_project_id: '' },
            ]).stage,
        ).toBe('tynn-open-existing');
    });

    it('lists every project, marking the ones a workspace here is already linked to', () => {
        expect(
            tynnImportChoices(
                [
                    { id: 'proj-envelope', name: 'Tynn.ai' },
                    { id: 'proj-linked', name: 'Already here' },
                ],
                [{ id: 'ws-here', project_id: 'proj-linked', tynn_project_id: 'proj-linked' }],
            ),
        ).toEqual([
            { project: { id: 'proj-envelope', name: 'Tynn.ai' }, linkedWorkspaceId: null },
            { project: { id: 'proj-linked', name: 'Already here' }, linkedWorkspaceId: 'ws-here' },
        ]);
    });
});

/**
 * The envelope route must REGISTER a workspace, not merely decline the wizard.
 * The effects are injected so the contract is assertable without Electron: the
 * declared envelope URL is cloned into the folder the user chose, and what lands
 * is an `.agi` workspace at the cloned path, linked to the Tynn project.
 */
describe('Tynn envelope import (genie#355)', () => {
    const project = { id: 'proj-envelope', name: 'Tynn.ai' };
    const source = { url: 'git@github.com:acme/product.agi.git', branch: 'trunk' };

    const spyDeps = () => {
        const clones: Array<{ url: string; parentPath: string }> = [];
        const added: WorkspaceRow[] = [];
        return {
            clones,
            added,
            deps: {
                clone: async (url: string, parentPath: string) => {
                    clones.push({ url, parentPath });
                    return { path: 'D:/code/product.agi' };
                },
                defaultEnvFile: async () => '.env.local',
                addWorkspace: async (row: WorkspaceRow) => {
                    added.push(row);
                    return { ...row, sort_order: 3 };
                },
            },
        };
    };

    it('clones the declared envelope into the chosen folder and registers it', async () => {
        const { clones, added, deps } = spyDeps();

        const saved = await importTynnEnvelopeWorkspace(
            { project, source, parentPath: '  D:/code  ' },
            deps,
        );

        expect(clones).toEqual([{ url: source.url, parentPath: 'D:/code' }]);
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({
            id: 'proj-envelope',
            backend: 'tynn',
            project_id: 'proj-envelope',
            project_name: 'Tynn.ai',
            tynn_project_id: 'proj-envelope',
            tynn_project_name: 'Tynn.ai',
            shape: 'agi',
            path: 'D:/code/product.agi',
            env_file: '.env.local',
            created_by_genie: 0,
        });
        expect(saved.sort_order).toBe(3);
    });

    it('refuses to clone anywhere until the user says where', async () => {
        const { clones, added, deps } = spyDeps();

        await expect(
            importTynnEnvelopeWorkspace({ project, source, parentPath: '   ' }, deps),
        ).rejects.toThrow(/where/i);

        expect(clones).toEqual([]);
        expect(added).toEqual([]);
    });
});
