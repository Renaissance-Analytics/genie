import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackendProject } from '../../backend/backend';
import { addWorkspace, getDb, initDatabase, listWorkspaces } from '../../db';
import { syncGappDevWorkspaces } from '../gapp-dev-sync';

/**
 * The whole chain the owner's report runs through: a workspace row → its Tynn
 * link → the project list → the `gapp_dev` column. The decisions are unit-tested
 * in gapp-dev.test.ts; this proves they are actually WIRED to real rows and a
 * real link resolution, against a real database.
 */

/**
 * A project exactly as `listAllProjects()` hands it over — the REAL wire shape
 * rather than a reduced stand-in, so this suite also pins that a `BackendProject`
 * flows into the sync with no mapping step in between.
 */
function proj(id: string, isGapp?: boolean): BackendProject {
    return { backend: 'tynn', id, name: 'Widget App', slug: 'widget', isGapp };
}

let dir: string;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-gdw-'));
    initDatabase(dir);
});

afterAll(() => {
    try {
        getDb().close();
    } catch {
        /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
    getDb().prepare('DELETE FROM workspaces').run();
});

function makeWorkspace(over: Partial<Parameters<typeof addWorkspace>[0]> = {}) {
    return addWorkspace({
        id: 'ws-1',
        backend: 'tynn',
        project_id: 'proj-1',
        project_name: 'Widget App',
        tynn_project_id: 'proj-1',
        tynn_project_name: 'Widget App',
        shape: 'agi',
        path: path.join(dir, 'widget.agi'),
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 1,
        ...over,
    });
}

function gappDevOf(id: string): number | null {
    const row = getDb()
        .prepare<[string], { gapp_dev: number | null } | undefined>(
            'SELECT gapp_dev FROM workspaces WHERE id = ?',
        )
        .get(id);
    return row?.gapp_dev ?? null;
}

describe('syncGappDevWorkspaces', () => {
    it('a new workspace starts as an ORDINARY one', () => {
        makeWorkspace();
        expect(gappDevOf('ws-1')).not.toBe(1);
    });

    it('turning `is_gapp` ON in Tynn upgrades the linked workspace', () => {
        makeWorkspace();
        expect(syncGappDevWorkspaces([proj('proj-1', true)])).toBe(1);
        expect(gappDevOf('ws-1')).toBe(1);
        // …and the row the renderer reads carries it.
        expect(listWorkspaces().find((w) => w.id === 'ws-1')?.gapp_dev).toBe(1);
    });

    it('turning it back OFF downgrades the same workspace', () => {
        makeWorkspace();
        syncGappDevWorkspaces([proj('proj-1', true)]);
        expect(gappDevOf('ws-1')).toBe(1);

        expect(syncGappDevWorkspaces([proj('proj-1', false)])).toBe(1);
        expect(gappDevOf('ws-1')).toBe(0);
    });

    it('re-running with the same answer writes nothing', () => {
        makeWorkspace();
        expect(syncGappDevWorkspaces([proj('proj-1', true)])).toBe(1);
        expect(syncGappDevWorkspaces([proj('proj-1', true)])).toBe(0);
    });

    it('an offline backend (empty list) leaves an existing GDW alone', () => {
        makeWorkspace();
        syncGappDevWorkspaces([proj('proj-1', true)]);
        expect(syncGappDevWorkspaces([])).toBe(0);
        expect(gappDevOf('ws-1')).toBe(1);
    });

    it('a GApp workspace Genie created for an INSTALLED app is never touched', () => {
        // Installed-app + dev-install workspaces are `backend: 'aionima'` and their
        // `tynn_project_id` holds a MANIFEST id, not a Tynn ULID. If that ever
        // resolved as a link, an app id colliding with a project id would style
        // somebody's installed app as a development workspace.
        makeWorkspace({
            id: 'app-widget',
            backend: 'aionima',
            project_id: 'com.example.widget',
            tynn_project_id: 'com.example.widget',
        });
        expect(syncGappDevWorkspaces([proj('com.example.widget', true)])).toBe(0);
        expect(gappDevOf('app-widget')).not.toBe(1);
    });

    it('an explicit UNLINK in project.json downgrades, even with the row still pointing at it', () => {
        // `unlinkWorkspaceTynn` writes `tynn: {}` — the deliberate "unlinked"
        // marker that `pickTynnLink` honours over the durable row.
        const wsPath = path.join(dir, 'unlinked.agi');
        fs.mkdirSync(wsPath, { recursive: true });
        makeWorkspace({ id: 'ws-unlinked', path: wsPath });
        syncGappDevWorkspaces([proj('proj-1', true)]);
        expect(gappDevOf('ws-unlinked')).toBe(1);

        fs.writeFileSync(
            path.join(wsPath, 'project.json'),
            JSON.stringify({ name: 'unlinked', tynn: {} }),
        );
        expect(syncGappDevWorkspaces([proj('proj-1', true)])).toBe(1);
        expect(gappDevOf('ws-unlinked')).toBe(0);
    });
});
