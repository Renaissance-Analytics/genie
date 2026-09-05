import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createWorkspace, type AddWorkspaceRow } from '../add-workspace';
import { createAgiEnvelope } from '../create-agi';
import type { WorkspaceRow } from '../../db';
import { cleanupTmpRoot, makeTmpDir, seedGitRepo } from '../../../test/helpers';

/**
 * ONE path that makes a workspace, for every entry point there is.
 *
 * The five ways into "Add workspace" differ only in WHAT THEY ALREADY KNOW.
 * They must not differ in what they produce, and they must not differ in what
 * they require: a name and a folder. Repositories, a Tynn project, a container
 * repo on GitHub and a GitHub connection are optional, so each of them is
 * exercised here by its ABSENCE as well as its presence.
 *
 * These assertions read the ARTIFACT, not the pipeline — an envelope on disk
 * and a registered row pointing at it. A test that watched a wizard step render
 * would have passed throughout the entire life of the bug this replaces.
 *
 * (Many git subprocesses per case; Windows needs the headroom.)
 */
vi.setConfig({ testTimeout: 120_000 });

/**
 * The clone path asks whether Genie holds a GitHub token, to authenticate a
 * private container. Here the container is a folder on this disk, so the answer
 * is the one an unconnected machine gives — and giving it directly keeps this
 * file off the shared database the fork's other test files own.
 */
vi.mock('../../github/storage', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../github/storage')>()),
    getToken: () => null,
}));

afterAll(() => cleanupTmpRoot());

/** A registrar that records instead of writing to the database. */
function spyRegistrar() {
    const rows: WorkspaceRow[] = [];
    return {
        rows,
        deps: {
            register: (row: AddWorkspaceRow) => {
                const saved = { ...row, sort_order: rows.length } as WorkspaceRow;
                rows.push(saved);
                return saved;
            },
            defaultEnvFile: () => '.env.local',
        },
    };
}

const onDisk = (envelope: string) => ({
    projectJson: fs.existsSync(path.join(envelope, 'project.json')),
    repos: fs.existsSync(path.join(envelope, 'repos')),
    git: fs.existsSync(path.join(envelope, '.git')),
});

describe('a workspace needs a name and a folder — and nothing else', () => {
    /**
     * THE RULE, at its barest. No Tynn project, no repository, no remote: the
     * workspace exists on disk and is registered. Everything else in this file
     * is this test plus something optional added back.
     */
    it('creates and registers a workspace with no repos, no project and no remote', async () => {
        const parent = makeTmpDir('bare-parent');
        const { rows, deps } = spyRegistrar();

        const saved = await createWorkspace(
            {
                id: 'ws-bare',
                name: 'Bare Workspace',
                slug: 'bare-workspace',
                parentPath: parent,
                content: { kind: 'empty' },
            },
            deps,
        );

        expect(onDisk(saved.path)).toEqual({ projectJson: true, repos: true, git: true });
        expect(saved.path).toBe(path.join(parent, 'bare-workspace.agi'));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: 'ws-bare',
            path: saved.path,
            shape: 'agi',
            project_id: '',
            tynn_project_id: '',
            env_file: '.env.local',
            created_by_genie: 1,
        });
    });

    it('links a Tynn project when there is one, and keys the workspace to it', async () => {
        const parent = makeTmpDir('linked-parent');
        const { rows, deps } = spyRegistrar();

        await createWorkspace(
            {
                id: 'proj-42',
                name: 'Linked Workspace',
                slug: 'linked-workspace',
                parentPath: parent,
                content: { kind: 'empty' },
                link: { projectId: 'proj-42', projectName: 'Linked Workspace' },
            },
            deps,
        );

        expect(rows[0]).toMatchObject({
            id: 'proj-42',
            project_id: 'proj-42',
            tynn_project_id: 'proj-42',
            tynn_project_name: 'Linked Workspace',
        });
    });

    it('marks a GApp development workspace as one', async () => {
        const parent = makeTmpDir('gapp-parent');
        const { rows, deps } = spyRegistrar();

        await createWorkspace(
            {
                id: 'ws-gapp',
                name: 'Gapp Workspace',
                slug: 'gapp-workspace',
                parentPath: parent,
                content: { kind: 'empty' },
                link: { gappDev: true },
            },
            deps,
        );

        expect(rows[0].gapp_dev).toBe(1);
    });
});

describe('content, when the entry point has some', () => {
    it('builds the workspace around the repositories it was given', async () => {
        const parent = makeTmpDir('repos-parent');
        const source = makeTmpDir('source-repo');
        await seedGitRepo(source);
        const { rows, deps } = spyRegistrar();

        const saved = await createWorkspace(
            {
                id: 'ws-repos',
                name: 'With Repos',
                slug: 'with-repos',
                parentPath: parent,
                content: {
                    kind: 'repos',
                    repos: [{ url: source, name: 'api', is_local: true }],
                },
            },
            deps,
        );

        expect(onDisk(saved.path).projectJson).toBe(true);
        expect(
            fs.existsSync(path.join(saved.path, 'repos', 'api', 'README.md')),
            'the repository the entry point named must actually be in the workspace',
        ).toBe(true);
        expect(rows[0].path).toBe(saved.path);
    });

    /**
     * The container already exists on a remote, so it is BROUGHT DOWN rather
     * than made — `created_by_genie: 0`, because Genie did not create it.
     */
    it('clones a container that already exists instead of building a new one', async () => {
        const remoteParent = makeTmpDir('remote-parent');
        const remote = await createAgiEnvelope({
            slug: 'published',
            name: 'Published Product',
            parent_path: remoteParent,
        });
        const parent = makeTmpDir('clone-parent');
        const { rows, deps } = spyRegistrar();

        const saved = await createWorkspace(
            {
                id: 'proj-published',
                name: 'Published Product',
                slug: 'published',
                parentPath: parent,
                content: { kind: 'envelope', url: remote.path },
                link: { projectId: 'proj-published', projectName: 'Published Product' },
            },
            deps,
        );

        expect(saved.path).toBe(path.join(parent, 'published.agi'));
        expect(onDisk(saved.path)).toEqual({ projectJson: true, repos: true, git: true });
        expect(rows[0]).toMatchObject({ id: 'proj-published', created_by_genie: 0 });
    });
});

describe('what it refuses to do', () => {
    it('will not create a workspace with no name', async () => {
        const { deps } = spyRegistrar();
        await expect(
            createWorkspace(
                {
                    id: 'ws-x',
                    name: '   ',
                    slug: '',
                    parentPath: makeTmpDir('noname'),
                    content: { kind: 'empty' },
                },
                deps,
            ),
        ).rejects.toThrow(/name/i);
    });

    it('will not create a workspace with nowhere to put it', async () => {
        const { deps } = spyRegistrar();
        await expect(
            createWorkspace(
                {
                    id: 'ws-x',
                    name: 'Nowhere',
                    slug: 'nowhere',
                    parentPath: '  ',
                    content: { kind: 'empty' },
                },
                deps,
            ),
        ).rejects.toThrow(/where|folder|location/i);
    });

    /**
     * Registration is the half that makes a folder a WORKSPACE. A creation that
     * wrote an envelope and registered nothing would leave the user staring at
     * an unchanged rail, which is exactly how "it did nothing" gets reported.
     */
    it('reports the failure rather than leaving an unregistered folder behind quietly', async () => {
        const parent = makeTmpDir('register-fails');
        await expect(
            createWorkspace(
                {
                    id: 'ws-fail',
                    name: 'Register Fails',
                    slug: 'register-fails',
                    parentPath: parent,
                    content: { kind: 'empty' },
                },
                {
                    register: () => {
                        throw new Error('database is locked');
                    },
                    defaultEnvFile: () => '.env',
                },
            ),
        ).rejects.toThrow(/database is locked/);
    });
});
