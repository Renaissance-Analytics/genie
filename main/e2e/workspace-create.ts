/**
 * E2E fixture for MAKING a workspace (genie#431), gated on the
 * `e2e-workspace-create` harness page alone.
 *
 * WHAT IS STOOD IN FOR, AND WHAT IS NOT
 * -------------------------------------
 * Almost nothing, which is the point. `agi:create` really scaffolds the folder,
 * really runs `git init`, and really writes the first commit; `workspaces:add`
 * really registers the row. The spec then reads the folder off disk, which no
 * amount of DOM assertion could stand in for — a route that "creates a
 * workspace" and leaves nothing behind is exactly the failure #431 was.
 *
 * Two things are set up:
 *
 *   1. `primary_workspace` — the parent folder the form offers by default, so
 *      the spec never has to walk a folder tree to answer "where should it go?".
 *      A returning user has one.
 *
 *   2. GitHub reports DISCONNECTED. The shared E2E mock signs a user in by
 *      default, and a connected account means the workspace also gets its
 *      container repository (`containerRepoPlan`) — a real network call this
 *      spec has no business making. Disconnected is also the state that proves
 *      the other half of #431: GitHub is never a precondition, so a machine with
 *      no GitHub at all must still be able to create a workspace.
 */

import { ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listWorkspaces, removeWorkspace, setSettings } from '../db';

/** True only when the workspace-create harness page is the one under test. */
export function isE2EWorkspaceCreate(): boolean {
    return (
        process.env.GENIE_E2E === '1' &&
        process.env.GENIE_E2E_PAGE === 'e2e-workspace-create'
    );
}

export interface WorkspaceCreateSeed {
    /** The parent folder the form offers by default. */
    parentPath: string;
    /** The name the spec types, and the folder that name should produce. */
    workspaceName: string;
    expectedPath: string;
}

const WORKSPACE_NAME = 'E2E Fresh Start';
const EXPECTED_FOLDER = 'e2e-fresh-start.agi';

/**
 * Seeded BEFORE the window loads. The E2E profile is reused across runs, so the
 * parent folder is emptied and any workspace a previous run registered under it
 * is dropped — otherwise `agi:create` would (correctly) refuse a folder that is
 * not empty, and the spec would fail on last run's success.
 */
export function seedWorkspaceCreateE2E(): WorkspaceCreateSeed {
    const parentPath = path.join(os.tmpdir(), 'genie-e2e-workspace-create');
    fs.rmSync(parentPath, { recursive: true, force: true });
    fs.mkdirSync(parentPath, { recursive: true });

    for (const ws of listWorkspaces()) {
        if (ws.path && ws.path.startsWith(parentPath)) removeWorkspace(ws.id);
    }

    setSettings({ primary_workspace: parentPath });

    const seed: WorkspaceCreateSeed = {
        parentPath,
        workspaceName: WORKSPACE_NAME,
        expectedPath: path.join(parentPath, EXPECTED_FOLDER),
    };
    (globalThis as Record<string, unknown>).__GENIE_E2E_WORKSPACE_CREATE__ = seed;
    return seed;
}

export function registerWorkspaceCreateE2EMocks(): void {
    const override: typeof ipcMain.handle = (channel, listener) => {
        ipcMain.removeHandler(channel as string);
        ipcMain.handle(channel as string, listener as never);
    };

    override('github:status', async () => ({
        connected: false,
        username: null,
        needsReauth: false,
        clientIdSet: true,
        builtInClientId: true,
        usingOverride: false,
        activeClientId: 'Iv1.e2e…dev',
        storageOk: true,
        storageHint: null,
        flow: { kind: 'idle' },
    }));

    override('github:capabilities', async () => ({
        connected: false,
        satisfiedFeatures: [],
        missing: [],
        missingPermissions: [],
        missingByPermission: [],
    }));
}
