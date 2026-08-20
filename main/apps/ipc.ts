/**
 * The Electron half of Genie Apps (Tynn #250).
 *
 * Everything that needs a folder picker, an OS modal, the filesystem or a window
 * lives here; everything decidable lives in the pure modules beside it and is
 * tested there. This file's job is to hand `installAppFromFolder` real I/O and to
 * expose the management operations to the renderer.
 *
 * Install stays client-local, like the plugin equivalent: it needs a native picker
 * and a path on the machine the user is sitting at.
 */

import fs from 'fs';
import path from 'path';
import { ipcMain, dialog } from 'electron';
import {
    addWorkspace,
    getWorkspace,
    removeWorkspace as removeWorkspaceRow,
    setWorkspaceAppKind,
    upsertAppGrant,
    getAppGrant,
    getAppGrantForWorkspace,
    setWorkspaceDevSites,
} from '../db';
import { forceQuestion } from '../ask/force-question';
import { createAgiEnvelope } from '../workspace/create-agi';
import { toolchainMachineFacts } from './machine';
import { installAppFromFolder, type AppInstallIO } from './install';
import { manageProcessForMcp } from '../mcp/host-tools';
import { manageSiteForMcp } from '../mcp/dev-site-tools';
import { callerIdForApp } from '../mcp/caller-identity';
import { APP_MANIFEST_FILENAME, type AppManifest } from './manifest';
import {
    appsGet,
    appsList,
    appsRequirements,
    appsSetCapabilities,
    appsSetRevoked,
    appsUninstall,
} from './manage';
import { closeAppWindows, openAppWindow } from './window';
import { validateAppFolder, type AppFolderReport } from './validate';
import { scaffoldApp, slugify } from './scaffold';
import { listAppGrants } from '../db';

/**
 * Copy the app's source into its workspace.
 *
 * A GApp is an envelope, so each declared component lands under `repos/<name>` —
 * the same layout a hand-built envelope has, which is what lets the site config
 * and the process `cwd` from `appInstallPlan` point at real directories.
 */
function copyAppSource(sourceFolder: string, workspacePath: string, manifest: AppManifest): void {
    const components = new Set<string>();
    if (manifest.frontend.repo) components.add(manifest.frontend.repo);
    for (const service of manifest.services ?? []) {
        if (service.repo) components.add(service.repo);
    }

    // An app with no named components is a single-folder app: the whole thing is
    // the workspace root.
    if (components.size === 0) {
        fs.cpSync(sourceFolder, workspacePath, { recursive: true, force: true });
        return;
    }

    for (const component of components) {
        const from = path.join(sourceFolder, component);
        if (!fs.existsSync(from)) {
            throw new Error(
                `The manifest names "${component}", but there is no such folder in ${sourceFolder}.`,
            );
        }
        fs.cpSync(from, path.join(workspacePath, 'repos', component), {
            recursive: true,
            force: true,
        });
    }
    // The manifest travels with the app so its DECLARED permissions stay readable
    // after install — that is the ceiling the permissions screen narrows to.
    fs.copyFileSync(
        path.join(sourceFolder, APP_MANIFEST_FILENAME),
        path.join(workspacePath, APP_MANIFEST_FILENAME),
    );
}


/**
 * The caller id to bring an app's own services and site up as.
 *
 * Resolved from the WORKSPACE rather than passed in, because by the time these
 * run the grant is recorded — so this reads the identity Genie stored instead of
 * trusting one threaded down from the installer. Empty means no grant, which
 * fails closed at the chokepoint exactly like any other unknown caller.
 */
function appCallerFor(workspaceId: string): string {
    const grant = getAppGrantForWorkspace(workspaceId);
    return grant ? callerIdForApp(grant.appId) : '';
}

/**
 * The real install I/O.
 *
 * Exported so the E2E harness can drive the ACTUAL chain — envelope creation,
 * file copy, project.json write, grant, service + site start — with only the OS
 * modal swapped out. Everything else about an install is filesystem and database
 * work that unit tests, by construction, replace with fakes.
 */
export function installIO(): AppInstallIO {
    return {
        readManifest: (folder) => {
            const file = path.join(folder, APP_MANIFEST_FILENAME);
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        },
        machine: (required) => toolchainMachineFacts(required),
        // The OS-level modal, drawn by Genie OUTSIDE any app window — which is
        // what makes it unfakeable by the app being installed.
        ask: (questions) => forceQuestion(questions, 'high'),
        existingApp: (appId) => {
            const row = getAppGrant(appId);
            if (!row) return null;
            const ws = getWorkspace(row.workspaceId);
            return ws ? { workspaceId: ws.id, path: ws.path } : null;
        },
        createWorkspace: async (manifest) => {
            const parent = path.join(path.dirname(process.cwd()), 'genie-apps');
            fs.mkdirSync(parent, { recursive: true });
            const envelope = await createAgiEnvelope({
                slug: manifest.slug,
                name: manifest.name,
                parent_path: parent,
                remote: { kind: 'none' },
            });
            const row = addWorkspace({
                id: `app-${manifest.slug}-${Date.now().toString(36)}`,
                backend: 'aionima',
                project_id: manifest.id,
                project_name: manifest.name,
                tynn_project_id: manifest.id,
                tynn_project_name: manifest.name,
                shape: 'agi',
                path: envelope.path,
                editor: null,
                editor_cmd: null,
                start_cmd: null,
                env_file: null,
                last_opened_at: null,
                created_by_genie: 1,
            });
            // Marked as an App workspace so the UI presents it as one rather than
            // as a project the user forgot creating.
            setWorkspaceAppKind(row.id, 'app');
            return { workspaceId: row.id, path: row.path };
        },
        copyAppSource,
        persistSites: (workspaceId, sites) => setWorkspaceDevSites(workspaceId, sites),
        recordGrant: (grant) => upsertAppGrant(grant),
        removeWorkspace: (workspaceId) => removeWorkspaceRow(workspaceId),
        // Services and the site come up through the SAME tools an agent uses,
        // addressed as the app itself. Deliberately not a private path into the
        // supervisor: an installer that can start processes by another route is a
        // second implementation of the thing the permission model guards.
        createService: async (workspaceId, service) => {
            const r = await manageProcessForMcp(appCallerFor(workspaceId), {
                action: 'create',
                // No workspaceId: manageProcess resolves it from the CALLER, and
                // the caller is the app, whose workspace is exactly this one.
                label: service.label,
                // The supervisor takes a command LINE; the manifest keeps literal
                // argv, because a shell string in a manifest is an injection
                // surface. Quote anything with whitespace on the way across.
                command: service.command
                    .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
                    .join(' '),
                ...(service.cwd ? { repo: service.cwd.replace(/^repos\//, '') } : {}),
                autostart: true,
            });
            return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
        },
        startSite: async (workspaceId, siteName) => {
            const r = await manageSiteForMcp(appCallerFor(workspaceId), {
                action: 'start',
                workspaceId,
                name: siteName,
            });
            return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
        },
    };
}



async function pickFolder(title: string): Promise<string | null> {
    const picked = await dialog.showOpenDialog({
        title,
        message: `Choose the folder containing ${APP_MANIFEST_FILENAME}`,
        properties: ['openDirectory'],
    });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
}

/** The folder probe, backed by the real filesystem and the real app registry. */
function folderProbe() {
    return {
        readManifest: (folder: string) => {
            const file = path.join(folder, APP_MANIFEST_FILENAME);
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        },
        exists: (p: string) => fs.existsSync(p),
        // An app re-checking ITSELF must not report its own address as taken —
        // that would make every reinstall look like a collision.
        slugTaken: (slug: string, selfId: string) =>
            listAppGrants().some((g) => g.slug === slug && g.appId !== selfId),
    };
}

export function registerAppsIpc(): void {
    ipcMain.handle('apps:list', () => appsList());

    /**
     * Check a folder WITHOUT installing it — the loop a developer (or the agent
     * writing the app) works in. Reports schema problems, missing files, and
     * separately the things that will work but are worth a second thought.
     */
    ipcMain.handle('apps:check-folder', async (_e, folder?: string): Promise<AppFolderReport> => {
        const dir = folder ?? (await pickFolder('Check a Genie App'));
        if (!dir) return { ok: false, errors: ['No folder was chosen.'], advice: [] };
        return validateAppFolder(dir, folderProbe());
    });

    /**
     * Write a new Genie App into a folder.
     *
     * Refuses to write into a folder that already holds one: silently overwriting
     * somebody's manifest is not a scaffold, it is data loss.
     */
    ipcMain.handle(
        'apps:scaffold',
        async (_e, req: { name?: string; id?: string; parent?: string }) => {
            const name = String(req?.name ?? '').trim();
            if (!name) return { ok: false, error: 'The app needs a name.' };
            const parent = req?.parent ?? (await pickFolder('Where should the app live?'));
            if (!parent) return { ok: false, error: 'No folder was chosen.' };

            const folder = path.join(parent, slugify(name));
            if (fs.existsSync(path.join(folder, APP_MANIFEST_FILENAME))) {
                return { ok: false, error: `${folder} already holds a Genie App.` };
            }

            try {
                const id =
                    String(req?.id ?? '').trim() || `com.genie.local.${slugify(name)}`;
                for (const file of scaffoldApp({ name, id })) {
                    const target = path.join(folder, file.path);
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.writeFileSync(target, file.contents, 'utf8');
                }
                return { ok: true, folder };
            } catch (e) {
                return { ok: false, error: (e as Error).message };
            }
        },
    );
    ipcMain.handle('apps:get', (_e, appId: string) => appsGet(String(appId)));
    // Resolved against the machine AS IT IS NOW, on every ask — so a user who
    // installs the missing runtime stops being told to install it.
    ipcMain.handle('apps:requirements', (_e, appId: string) => appsRequirements(String(appId)));

    ipcMain.handle('apps:install-folder', async (_e, folder?: string) => {
        const dir = folder ?? (await pickFolder('Install a Genie App'));
        if (!dir) return { ok: false, errors: ['No folder was chosen.'] };
        return installAppFromFolder(dir, installIO());
    });

    ipcMain.handle('apps:open', (_e, appId: string) => {
        const app = appsGet(String(appId));
        if (!app) return { ok: false, error: 'That app is not installed.' };
        if (app.revoked) {
            // Opening a revoked app would show a live surface whose every action
            // fails — broken, rather than revoked.
            return { ok: false, error: `“${app.name}” is turned off. Turn it back on to open it.` };
        }
        openAppWindow({
            appId: app.id,
            slug: app.slug,
            name: app.name,
            homeUrl: app.homeUrl,
        });
        return { ok: true };
    });

    ipcMain.handle('apps:set-capabilities', (_e, appId: string, capabilities: string[]) =>
        appsSetCapabilities(String(appId), Array.isArray(capabilities) ? capabilities : []),
    );

    ipcMain.handle('apps:set-revoked', (_e, appId: string, revoked: boolean) => {
        const result = appsSetRevoked(String(appId), Boolean(revoked));
        if (result.ok && revoked) closeAppWindows(String(appId));
        return result;
    });

    ipcMain.handle('apps:uninstall', (_e, appId: string) => {
        closeAppWindows(String(appId));
        return appsUninstall(String(appId));
    });
}
