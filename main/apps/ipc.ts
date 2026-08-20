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
    listWorkspaces,
    removeWorkspace as removeWorkspaceRow,
    setWorkspaceAppKind,
    upsertAppGrant,
    getAppGrant,
    getAppGrantForWorkspace,
    retainAppData,
    retainedAppData,
    forgetRetainedAppData,
    setWorkspaceDevSites,
} from '../db';
import { forceQuestion } from '../ask/force-question';
import { createAgiEnvelope } from '../workspace/create-agi';
import { toolchainMachineFacts } from './machine';
import { installAppFromFolder, type AppInstallIO, type AppInstallResult } from './install';
import { manageProcessForMcp } from '../mcp/host-tools';
import { manageSiteForMcp } from '../mcp/dev-site-tools';
import { callerIdForApp } from '../mcp/caller-identity';
import { APP_MANIFEST_FILENAME, validateAppManifest, type AppManifest } from './manifest';
import {
    appsGet,
    appsList,
    appsRequirements,
    appsSetCapabilities,
    appsSetRevoked,
    appsUninstall,
} from './manage';
import { clearAppStorage, closeAppWindows, openAppWindow } from './window';
import { uninstallDataQuestion } from './data-retention';
import { validateAppFolder, type AppFolderReport } from './validate';
import { appUpdateState, updatableApps, type AppUpdateState } from './updates';
import {
    buildGithubReview,
    parseGithubSource,
    verifyHumanConfirmation,
    type GithubInstallReview,
} from './github-install';
import { cloneRepo } from '../workspace/clone';
import { simpleGit } from 'simple-git';
import os from 'os';
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
            // The recorded SOURCE travels with it, so an install can notice that an
            // app id already in use is being replaced from somewhere else.
            return ws
                ? { workspaceId: ws.id, path: ws.path, ...(row.source ? { source: row.source } : {}) }
                : null;
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
        /**
         * DEV MODE: adopt the developer's folder as the app's workspace.
         *
         * Registered as a workspace so hosting, processes and the permission
         * chokepoint all work exactly as they do for an installed app — the ONLY
         * difference is that the files are theirs, not a copy. `app-dev` marks it
         * so the rail and the Apps panel can say so.
         */
        adoptFolder: async (folder, manifest) => {
            const existing = listWorkspaces().find((w) => w.path === folder);
            if (existing) {
                setWorkspaceAppKind(existing.id, 'app-dev');
                return { workspaceId: existing.id, path: existing.path };
            }
            const row = addWorkspace({
                id: `appdev-${manifest.slug}-${Date.now().toString(36)}`,
                backend: 'aionima',
                project_id: manifest.id,
                project_name: manifest.name,
                tynn_project_id: manifest.id,
                tynn_project_name: manifest.name,
                // A GApp source folder is a plain directory, not an envelope — its
                // sites live in genie.db rather than a project.json it does not have.
                shape: 'simple',
                path: folder,
                editor: null,
                editor_cmd: null,
                start_cmd: null,
                env_file: null,
                last_opened_at: null,
                created_by_genie: 0,
            });
            setWorkspaceAppKind(row.id, 'app-dev');
            return { workspaceId: row.id, path: row.path };
        },
        clearAppStorage,
        retainedData: (appId) => retainedAppData(appId),
        forgetRetainedData: (appId) => forgetRetainedAppData(appId),
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


/* ---- Install from GitHub (P4) ----------------------------------------- */

/**
 * A review the user is looking at, kept until they act on it.
 *
 * The CLONE is kept with it, and the install runs from that exact folder rather
 * than re-cloning. Re-cloning would mean the thing reviewed and the thing
 * installed are two different fetches of a moving branch — and the review's whole
 * value is that it describes what is about to happen.
 */
interface PendingGithubInstall {
    review: GithubInstallReview;
    folder: string;
}

const pendingGithub = new Map<string, PendingGithubInstall>();

/** Discard a clone we are not going to install. */
function discard(folder: string): void {
    try {
        fs.rmSync(folder, { recursive: true, force: true });
    } catch {
        // A temp folder we could not remove is untidy, not unsafe.
    }
}

async function reviewGithubApp(
    url: string,
    ref?: string,
): Promise<{ ok: true; review: GithubInstallReview } | { ok: false; error: string }> {
    const source = parseGithubSource(url);
    if (!source) {
        return {
            ok: false,
            error: 'That is not a GitHub repository URL. Use https://github.com/owner/repo.',
        };
    }

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-app-review-'));
    let folder: string;
    try {
        folder = (await cloneRepo({ url: source.cloneUrl, parent_path: parent, folder: 'app' }))
            .path;
    } catch (e) {
        discard(parent);
        return { ok: false, error: `Could not fetch it: ${(e as Error).message}` };
    }

    try {
        // The exact commit, because a ref is whatever is there later and the review
        // has to describe what is actually being installed.
        const commit = (await simpleGit(folder).revparse(['HEAD'])).trim();

        const report = validateAppFolder(folder, folderProbe());
        if (!report.ok || !report.app) {
            discard(parent);
            return {
                ok: false,
                error: `That repository is not an installable Genie App: ${report.errors.join(' ')}`,
            };
        }

        const raw = fs.readFileSync(path.join(folder, APP_MANIFEST_FILENAME), 'utf8');
        const parsed = validateAppManifest(JSON.parse(raw));
        if (!parsed.ok) {
            discard(parent);
            return { ok: false, error: parsed.errors.join(' ') };
        }

        const review = buildGithubReview({
            source,
            commit,
            ref: ref?.trim() || 'the default branch',
            manifest: parsed.value,
        });
        pendingGithub.set(review.commit, { review, folder });
        return { ok: true, review };
    } catch (e) {
        discard(parent);
        return { ok: false, error: (e as Error).message };
    }
}


/* ---- Is there a newer version? ---------------------------------------- */

/**
 * Ask each tracked repo for its current HEAD and compare.
 *
 * `ls-remote` rather than a fetch: it is one round trip and clones nothing, so
 * this is cheap enough to run when the user opens the panel. On DEMAND, never on
 * a timer — a background poller hitting GitHub for every installed app is a rate
 * limit and a privacy footprint nobody asked for.
 *
 * Each distinct ORIGIN is asked once, however many apps came from it: a monorepo
 * can hold several.
 */
async function checkAppUpdates(): Promise<Record<string, AppUpdateState>> {
    const tracked = updatableApps(
        listAppGrants().map((g) => ({ id: g.appId, source: g.source })),
    );

    const heads = new Map<string, string | null>();
    for (const origin of new Set(tracked.map((t) => t.origin))) {
        try {
            const raw = await simpleGit().listRemote([`https://${origin}.git`, 'HEAD']);
            heads.set(origin, raw.trim().split(/\s+/)[0] ?? null);
        } catch {
            // Unreachable is UNKNOWN, never "current" — see updates.ts.
            heads.set(origin, null);
        }
    }

    const out: Record<string, AppUpdateState> = {};
    for (const grant of listAppGrants()) {
        const head = grant.source?.kind === 'github' ? heads.get(grant.source.origin) : undefined;
        out[grant.appId] = appUpdateState(grant.source, head ?? null);
    }
    return out;
}

export function registerAppsIpc(): void {
    ipcMain.handle('apps:list', () => appsList());
    // On demand — when the panel opens, or when the user asks. Never polled.
    ipcMain.handle('apps:check-updates', () => checkAppUpdates());

    /**
     * STEP 1 of installing from GitHub: fetch it and describe it.
     *
     * Nothing is installed here and no permission is granted. It clones to a temp
     * folder, pins the commit, and hands back everything a person needs to decide —
     * including every command the app will run, which no permission covers.
     */
    ipcMain.handle('apps:review-github', (_e, url: string, ref?: string) =>
        reviewGithubApp(String(url ?? ''), typeof ref === 'string' ? ref : undefined),
    );

    /**
     * STEP 2: the human's deliberate act, re-verified HERE.
     *
     * The renderer decides whether to enable a button; the main process decides
     * whether the install happens. Trusting the renderer's word for it would make
     * the one gate that exists to require a person skippable by a bug — or by a
     * window being driven.
     */
    ipcMain.handle(
        'apps:install-github',
        async (_e, commit: string, typed: string): Promise<AppInstallResult> => {
            const pending = pendingGithub.get(String(commit ?? ''));
            if (!pending) {
                return {
                    ok: false,
                    errors: ['That review has expired. Fetch the app again and re-read it.'],
                };
            }
            if (!verifyHumanConfirmation(String(typed ?? ''), pending.review)) {
                return {
                    ok: false,
                    errors: [
                        `To install “${pending.review.name}” from GitHub, type its name — ${pending.review.confirmPhrase} — exactly.`,
                    ],
                };
            }

            // Only NOW does the consent modal appear, and only now can anything be
            // granted. Install runs from the reviewed clone, not a fresh fetch.
            const result = await installAppFromFolder(pending.folder, installIO(), {
                // Provenance outlives the review: the panel goes on saying which
                // repo and which commit this app came from.
                source: {
                    kind: 'github',
                    origin: pending.review.origin,
                    commit: pending.review.commit,
                },
            });
            pendingGithub.delete(pending.review.commit);
            return result;
        },
    );

    /** Throw away a review the user walked away from, clone and all. */
    ipcMain.handle('apps:discard-github', (_e, commit: string) => {
        const pending = pendingGithub.get(String(commit ?? ''));
        if (pending) {
            discard(path.dirname(pending.folder));
            pendingGithub.delete(pending.review.commit);
        }
        return { ok: true };
    });


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

    ipcMain.handle('apps:install-folder', async (_e, folder?: string, devMode?: boolean) => {
        const dir = folder ?? (await pickFolder('Install a Genie App'));
        if (!dir) return { ok: false, errors: ['No folder was chosen.'] };
        // DEV MODE runs the app from the chosen folder rather than a copy, so an
        // edit is visible without reinstalling. Consent is asked exactly as
        // normal: building an app is not a reason to grant it anything.
        return installAppFromFolder(dir, installIO(), { devMode: devMode === true });
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
            devMode: app.devMode,
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

    ipcMain.handle('apps:uninstall', async (_e, appId: string) => {
        const app = appsGet(String(appId));
        if (!app) return { ok: false, error: 'That app is not installed.' };

        // Its data is the user's, so the user decides. Asked on the OS modal like
        // every other consequential Genie question, and a DISMISSED modal keeps the
        // data — dismissing must never be the thing that destroys it.
        const answered = await forceQuestion([uninstallDataQuestion(app.name)], 'high');
        const keepData = !answered.answers[0]?.selected.includes('Delete it');

        closeAppWindows(String(appId));
        return appsUninstall(String(appId), keepData, {
            clearStorage: clearAppStorage,
            retainData: retainAppData,
        });
    });
}
