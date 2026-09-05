import { describe, expect, it } from 'vitest';
import { tynnImportChoices, tynnImportContent, tynnImportRoute } from '../tynn-import';

/**
 * WHAT A TYNN PROJECT IS, to Genie.
 *
 * It is a WORKSPACE. Not a repository to clone, not a folder to convert — every
 * project in Tynn is a workspace, and it may legitimately contain nothing yet.
 *
 * The route used to answer a different question: "what is there to clone or
 * convert here?" A project with an `.agi` repo was cloned; everything else fell
 * into the scan-and-convert wizard, in `mode: 'local'` when there were no repos
 * at all — which means *"go and find a folder to convert."* So the one entry
 * point that knows exactly which workspace you mean was the one that asked you
 * to locate it on disk (genie#431 → this rebuild).
 *
 * The decision lives here as a pure function, so both halves of it can be
 * asserted without a window — and both halves ARE asserted, deliberately: "the
 * wizard did not open" passes just as well against an import that does nothing
 * at all, so every negative below is paired with a positive control.
 */
describe('Tynn import routing', () => {
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

    it('sends an envelope-backed project straight to its clone, never to an inspection', () => {
        const route = tynnImportRoute(envelopeProject, []);

        expect(route).toEqual({
            stage: 'tynn-workspace',
            content: {
                kind: 'envelope',
                url: 'git@github.com:acme/product.agi.git',
                branch: 'trunk',
            },
        });
    });

    /**
     * THE DEFECT, stated as a rule: a Tynn project with no repositories is a
     * workspace with no repositories. There is nothing to clone, nothing to
     * convert and nothing to ask.
     */
    it('makes a workspace for a project that has no repositories at all', () => {
        expect(tynnImportRoute({ id: 'proj-bare', name: 'Bare' }, [])).toEqual({
            stage: 'tynn-workspace',
            content: { kind: 'empty', reason: 'no-repositories' },
        });
    });

    /**
     * POSITIVE CONTROL for the two above. A project whose repositories are
     * ordinary code repos still brings them: without this, "it asked nothing"
     * would be satisfied by a route that carries nothing either.
     */
    it('brings a project’s own repositories into the workspace it makes', () => {
        expect(
            tynnImportRoute(
                {
                    id: 'proj-plain',
                    name: 'Plain',
                    isWorkspace: false,
                    repositories: [
                        { url: 'https://github.com/acme/plain.git', kind: 'code' },
                        {
                            url: 'https://github.com/acme/brain.git',
                            kind: 'code',
                            defaultBranch: 'develop',
                        },
                    ],
                },
                [],
            ),
        ).toEqual({
            stage: 'tynn-workspace',
            content: {
                kind: 'repos',
                repos: [
                    { url: 'https://github.com/acme/plain.git', branch: 'main', name: 'plain' },
                    { url: 'https://github.com/acme/brain.git', branch: 'develop', name: 'brain' },
                ],
            },
        });
    });

    /**
     * Tynn's `is_workspace` (its `is_envelope`) says a project HAS a container;
     * only the `envelope`-kind repository says WHERE. A project that claims one
     * and declares no repo for it leaves Genie nothing to clone — a Tynn-side
     * gap the UI should NAME rather than silently absorb, which is why the
     * reason travels with the content instead of being flattened away.
     */
    it('names the Tynn-side gap when a project claims a container it does not declare', () => {
        expect(
            tynnImportRoute({ id: 'proj-claimed', name: 'Claimed', isWorkspace: true }, []),
        ).toEqual({
            stage: 'tynn-workspace',
            content: { kind: 'empty', reason: 'container-undeclared' },
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

describe('the content a Tynn project resolves to', () => {
    it('prefers the declared container over the code repos beside it', () => {
        expect(
            tynnImportContent({
                id: 'p',
                repositories: [
                    { url: 'https://github.com/acme/code.git', kind: 'code' },
                    { url: 'https://github.com/acme/code.agi.git', kind: 'envelope' },
                ],
            }),
        ).toEqual({
            kind: 'envelope',
            url: 'https://github.com/acme/code.agi.git',
            branch: 'main',
        });
    });

    it('ignores a repository with no URL rather than planning to clone nothing', () => {
        expect(
            tynnImportContent({
                id: 'p',
                repositories: [{ url: '   ', kind: 'code' }],
            }),
        ).toEqual({ kind: 'empty', reason: 'no-repositories' });
    });
});
