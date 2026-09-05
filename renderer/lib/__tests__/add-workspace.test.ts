import { describe, expect, it } from 'vitest';
import {
    addWorkspaceDraft,
    addWorkspacePlan,
    type AddWorkspaceEntry,
} from '../add-workspace';

/**
 * ONE flow, three questions, most of them already answered.
 *
 * A workspace is a NAME and a FOLDER. Repositories, a Tynn project, an `.agi`
 * container and a GitHub remote are all optional, and the rule this file exists
 * to hold is that **nothing optional may gate creation**. Every defect the
 * rebuild fixed was the same defect wearing a different hat: something optional
 * treated as a precondition.
 *
 * So the model answers one question — *what has this entry point NOT told us?* —
 * and the flow asks exactly that. An entry point that knows everything asks
 * nothing and the user presses one button.
 */

const TYNN_ENVELOPE = {
    id: 'proj-envelope',
    name: 'Enveloped Product',
    isWorkspace: true,
    repositories: [
        { url: 'https://github.com/acme/product.git', kind: 'code' as const },
        {
            url: 'https://github.com/acme/product.agi.git',
            kind: 'envelope' as const,
            defaultBranch: 'trunk',
        },
    ],
};

/** The project at the centre of the bug: in Tynn, real, and holding no repos. */
const TYNN_BARE = { id: 'proj-bare', name: 'Bare Project' };

const ctx = (over: Partial<Parameters<typeof addWorkspaceDraft>[1]> = {}) => ({
    primaryWorkspace: 'D:/code',
    workspaces: [],
    ...over,
});

describe('what each entry point leaves to ask', () => {
    /**
     * THE BUG. `tynnImportRoute` used to fall through to the scan-and-convert
     * wizard in `mode: 'local'` for a project with no envelope repo — which
     * means "go and find a folder to convert". The one entry point that knows
     * exactly which workspace you mean was the one that asked you to locate it
     * on disk.
     */
    it('asks NOTHING when Tynn already named the project and the machine has a default location', () => {
        const draft = addWorkspaceDraft({ source: 'tynn', project: TYNN_BARE }, ctx());

        expect(draft.asks).toEqual([]);
        expect(draft.name).toBe('Bare Project');
        expect(draft.parentPath).toBe('D:/code');
        expect(draft.content).toEqual({ kind: 'empty', reason: 'no-repositories' });
    });

    /**
     * POSITIVE CONTROL for the assertion above. "It asked nothing" is satisfied
     * just as well by a flow that DOES nothing, so the same entry point must
     * still be seen carrying a real envelope through to a clone.
     */
    it('still clones the container a Tynn project declares', () => {
        const draft = addWorkspaceDraft({ source: 'tynn', project: TYNN_ENVELOPE }, ctx());

        expect(draft.asks).toEqual([]);
        expect(draft.content).toEqual({
            kind: 'envelope',
            url: 'https://github.com/acme/product.agi.git',
            branch: 'trunk',
        });
    });

    /**
     * A Tynn project's repositories ARE its content — Tynn already knows them,
     * so there is nothing on disk to read and nothing to inspect. They become
     * the new workspace's repos.
     */
    it('takes a Tynn project’s own repositories as the content, without inspecting anything', () => {
        const draft = addWorkspaceDraft(
            {
                source: 'tynn',
                project: {
                    id: 'proj-code',
                    name: 'Code Only',
                    repositories: [
                        { url: 'https://github.com/acme/api.git', kind: 'code' as const },
                        {
                            url: 'https://github.com/acme/web.git',
                            kind: 'code' as const,
                            defaultBranch: 'develop',
                        },
                    ],
                },
            },
            ctx(),
        );

        expect(draft.asks).toEqual([]);
        expect(draft.content).toEqual({
            kind: 'repos',
            repos: [
                { url: 'https://github.com/acme/api.git', branch: 'main', name: 'api' },
                { url: 'https://github.com/acme/web.git', branch: 'develop', name: 'web' },
            ],
        });
    });

    /** Only the ONE thing the machine has not answered is asked for. */
    it('asks only for the location when there is no default one', () => {
        expect(
            addWorkspaceDraft(
                { source: 'tynn', project: TYNN_BARE },
                ctx({ primaryWorkspace: '' }),
            ).asks,
        ).toEqual(['location']);
    });

    it('asks for a name when nothing has supplied one', () => {
        expect(addWorkspaceDraft({ source: 'new' }, ctx()).asks).toEqual(['name']);
        expect(addWorkspaceDraft({ source: 'gapp' }, ctx()).asks).toEqual(['name']);
    });

    /**
     * The two entry points with something to READ. Inspection is not a route
     * any more, it is the answer to the Content question — but it must still
     * happen, or "nothing is asked" would be true of a flow that never looks at
     * the folder it was pointed at.
     */
    it('asks for the content of a folder or a repository, because it has not been told', () => {
        expect(addWorkspaceDraft({ source: 'local' }, ctx()).asks).toEqual(['content']);
        expect(addWorkspaceDraft({ source: 'git' }, ctx()).asks).toEqual(['content']);
        expect(addWorkspaceDraft({ source: 'local' }, ctx()).content).toEqual({
            kind: 'inspect',
            mode: 'local',
            sourceUrl: '',
        });
    });

    /** A project already here is not imported a second time. */
    it('offers the workspace that already exists instead of a second copy', () => {
        const draft = addWorkspaceDraft(
            { source: 'tynn', project: TYNN_ENVELOPE },
            ctx({
                workspaces: [
                    { id: 'ws-here', project_id: 'proj-envelope', tynn_project_id: 'proj-envelope' },
                ],
            }),
        );

        expect(draft.existingWorkspaceId).toBe('ws-here');
    });
});

describe('the Tynn link, and everything else that must never block', () => {
    it('carries the Tynn project through as a LINK, never as a requirement', () => {
        const linked = addWorkspaceDraft({ source: 'tynn', project: TYNN_BARE }, ctx());
        expect(linked.links).toMatchObject({
            tynnProjectId: 'proj-bare',
            tynnProjectName: 'Bare Project',
        });

        // …and its absence adds no question, which is the whole of "optional".
        const unlinked = addWorkspaceDraft({ source: 'new' }, ctx());
        expect(unlinked.links.tynnProjectId).toBe('');
        expect(unlinked.asks).toEqual(['name']);
    });

    it('is ready to create a plain workspace with no Tynn project, no repo and no remote', () => {
        const plan = addWorkspacePlan(
            {
                ...addWorkspaceDraft({ source: 'new' }, ctx()),
                name: 'Acme Storefront',
            },
            { id: 'ws-1' },
        );

        expect(plan).toMatchObject({
            id: 'ws-1',
            name: 'Acme Storefront',
            slug: 'acme-storefront',
            parentPath: 'D:/code',
            content: { kind: 'empty' },
        });
        expect(plan.link).toMatchObject({ projectId: '', gappDev: false });
    });

    /**
     * The Tynn project id becomes the workspace id when there is one — that is
     * how every other surface finds the link. With no project, the caller's own
     * id is used, which is the whole of what "Tynn is optional" costs.
     */
    it('uses the Tynn project id as the workspace id when a project is linked', () => {
        const plan = addWorkspacePlan(
            addWorkspaceDraft({ source: 'tynn', project: TYNN_BARE }, ctx()),
            { id: 'generated-ulid' },
        );

        expect(plan.id).toBe('proj-bare');
        expect(plan.link).toMatchObject({
            projectId: 'proj-bare',
            projectName: 'Bare Project',
        });
    });

    it('refuses to plan a workspace with no name, and says so in words', () => {
        expect(() =>
            addWorkspacePlan(addWorkspaceDraft({ source: 'new' }, ctx()), { id: 'ws-1' }),
        ).toThrow(/name/i);
    });

    it('refuses to plan a workspace with nowhere to put it', () => {
        expect(() =>
            addWorkspacePlan(
                {
                    ...addWorkspaceDraft({ source: 'new' }, ctx({ primaryWorkspace: '' })),
                    name: 'Somewhere',
                },
                { id: 'ws-1' },
            ),
        ).toThrow(/where|folder|location/i);
    });

    /** An inspection is not a plan — it is a step that PRODUCES one. */
    it('never turns an uninspected folder into a plan', () => {
        const entry: AddWorkspaceEntry = { source: 'local' };
        expect(() =>
            addWorkspacePlan(
                { ...addWorkspaceDraft(entry, ctx()), name: 'Folder' },
                { id: 'ws-1' },
            ),
        ).toThrow(/inspect/i);
    });
});
