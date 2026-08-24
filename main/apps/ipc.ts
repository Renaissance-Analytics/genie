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
    createTerminalSpec,
    deleteTerminalSpec,
    getAllSettings,
    getTerminalSpec,
    getWorkspace,
    listTerminalSpecs,
    listWorkspaces,
    updateTerminalSpec,
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
import {
    appBackupSettings,
    backupAppNow,
    setAppBackupOverride,
    setWorkstationBackupSettings,
    workstationBackupSettings,
} from './backup';
import type { BackupOverride, BackupSettings } from '../dev-server/services/backup';
import { createAgiEnvelope } from '../workspace/create-agi';
import { toolchainMachineFacts } from './machine';
import { installAppFromFolder, type AppInstallIO, type AppInstallResult } from './install';
import { manageProcessForMcp, resolveAgentLaunch } from '../mcp/host-tools';
import { manageSiteForMcp } from '../mcp/dev-site-tools';
import { callerIdForApp } from '../mcp/caller-identity';
import { appCopyPlan } from './install-plan';
import {
    APP_AGENTS_DIR,
    APP_MANIFEST_FILENAME,
    validateAppManifest,
    type AppAgentDecl,
    type AppManifest,
    type AppPanels,
} from './manifest';
import {
    gappPersonaPath,
    resolveGappProvider,
    withPersonaBriefing,
    type GappProvider,
} from './agent-provider';
import { ensureAgentPanels, type AgentPanelSeeding, type PlannedPanel } from './panels';
import { gappHomeUrl } from './hostname';
import {
    closePreview,
    openPreview,
    sweepPreviewWorkspaces,
    type PreviewIO,
    type RememberedConsent,
} from './preview-run';
import { listPreviews, livePreview, previewAppView } from './preview-registry';
import {
    broadcastTerminalSpecsChanged,
    createAgentTerminal,
    decideAgentTerminalSpawn,
    killTerminalById,
} from '../terminal/ipc';
import {
    appsGet,
    appsList,
    appsRequirements,
    appsSetCapabilities,
    appsSetRevoked,
    appsUninstall,
} from './manage';
import { clearAppStorage, closeAppWindows, openAppWindow, showAppTab } from './window';
import { uninstallDataQuestion } from './data-retention';
import { validateAppFolder } from './validate';
import { checkApp, type AppCheckReport, type CheckProbe } from './checkup';
import { fsCheckProbe } from './check-fs';
import { appWindowTabs } from './window-tabs';
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
import { randomUUID } from 'crypto';
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
    const plan = appCopyPlan(manifest);

    // An app with no named components is a single-folder app: the whole thing is
    // the workspace root, envelope paths included.
    if (plan.wholeFolder) {
        fs.cpSync(sourceFolder, workspacePath, { recursive: true, force: true });
        return;
    }

    for (const component of plan.components) {
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

    // Envelope-level paths belong to no component, so nothing above carries them —
    // the manifest itself, and `.agents/` when the app declared agents. Which ones
    // is decided in `appCopyPlan` and asserted there; this only moves them.
    for (const relative of plan.envelopePaths) {
        const from = path.join(sourceFolder, relative);
        if (!fs.existsSync(from)) {
            throw new Error(
                `The app declares "${relative}", but there is no such path in ${sourceFolder}.`,
            );
        }
        fs.cpSync(from, path.join(workspacePath, relative), { recursive: true, force: true });
    }
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
                // A GApp's workspace is an envelope wearing a name that says so.
                // Same format, same creator — `.gapp` is a suffix, not a fork, and
                // detection reads a folder's CONTENTS, so everything that already
                // opens a `.agi` opens this too. Envelopes already on disk keep
                // whatever suffix they were created with; nothing is renamed.
                suffix: 'gapp',
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

/**
 * The folder probe, backed by the real filesystem and the real app registry.
 *
 * The filesystem half is `fsCheckProbe`, shared with the CLI and the fixture suite,
 * so the check a developer runs in a terminal is byte for byte the one Genie runs
 * here. Only the slug question is Genie's own — it is the one answer that lives in
 * the database.
 */
function folderProbe(): CheckProbe {
    return fsCheckProbe({
        // An app re-checking ITSELF must not report its own address as taken —
        // that would make every reinstall look like a collision.
        slugTaken: (slug: string, selfId: string) =>
            listAppGrants().some((g) => g.slug === slug && g.appId !== selfId),
    });
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


/* ---- The GApp WINDOW's own surface ------------------------------------ */

/**
 * The workstation's provider and the command it launches with — or why it cannot.
 *
 * ONE resolution for a whole seeding pass, because the answer is workstation-wide:
 * every agent in a roster launches under the same TUI, so a provider that cannot
 * be launched fails ALL of them, and it must fail them BEFORE anything is created
 * rather than halfway down the list.
 *
 * The only real failure is `custom` with no command configured. That is a refusal,
 * never a fallback to a bare terminal — a terminal that quietly is not an agent is
 * the whole of genie#245.
 */
function gappAgentLaunch(
    workspace: { id: string; path: string },
): { provider: GappProvider; base: string } | { error: string } {
    // The WORKSTATION's provider, never the app's. Read from settings rather than
    // taken as a parameter, so there is no argument through which a manifest could
    // reach it.
    const provider = resolveGappProvider(getAllSettings());
    const base = resolveAgentLaunch(provider, undefined, workspace);
    if (!base) {
        return {
            error:
                `Genie has no command for the "${provider}" agent, which this workstation uses ` +
                'to run Genie App agents. Set one in Settings → Specialized terminals, or choose ' +
                'a different GApp AI Provider.',
        };
    }
    return { provider, base };
}

/**
 * How a GApp's panel actually gets written — a bare view, or an AGENT.
 *
 * The whole of genie#245 is this branch. A slot with no declared agent behind it
 * is a plain spec, exactly as before. A BOUND slot goes through
 * `createAgentTerminal`, which is the one host-side routine that spawns the pty
 * AND launches the TUI into it — the same path a specialized terminal takes, so a
 * GApp agent is an ordinary Genie agent in every way that matters: it shows in the
 * workspace, it has an AgentInbox identity, it survives a restart, and it counts
 * against the agent-terminal cap.
 *
 * Shared by the installed path and the PREVIEW path so a developer previewing
 * their app meets the same agents their users will.
 */
function createGappPanel(
    appId: string,
    workspace: { id: string; path: string },
    panel: PlannedPanel,
): void {
    const id = `gapp-${randomUUID()}`;
    if (!panel.agent) {
        createTerminalSpec({
            id,
            workspace_id: workspace.id,
            label: panel.label,
            cwd: workspace.path,
            type: panel.type,
        });
        return;
    }

    const launch = gappAgentLaunch(workspace);
    // Unreachable in practice — both seeding paths ask `mayStartAgents` first, and
    // that refuses the whole roster on this. Kept because the alternative if it
    // ever IS reached is a bare terminal wearing an agent's name.
    if ('error' in launch) throw new Error(launch.error);

    const persona = gappPersonaPath(workspace.path, panel.agent.persona);
    createAgentTerminal({
        id,
        workspaceId: workspace.id,
        cwd: workspace.path,
        label: panel.label,
        agentMeta: {
            agent: launch.provider,
            command: withPersonaBriefing(launch.base, persona, panel.agent.name),
        },
        // The APP asked for this, not the person who clicked its pill. Stamped so
        // the cap and the terminal list both attribute it to the thing that spent
        // the compute.
        createdBy: 'agent',
        // Addressable in the AgentInbox by the name the user consented to, rather
        // than as a nameless `general` agent.
        agentInbox: { purpose: panel.agent.name },
    });

    // The binding, on the spec that survives a restart: which app, which declared
    // agent, and the persona it was launched against.
    const spec = getTerminalSpec(id);
    if (spec) {
        updateTerminalSpec(id, {
            meta: {
                ...spec.meta,
                gapp_id: appId,
                gapp_agent: panel.agent.name,
                gapp_persona: persona,
            },
        });
    }
}

/**
 * Lay out the agent panels an app's manifest declared, in the app's workspace —
 * and LAUNCH the agents it declared, under the workstation's provider (genie#245).
 *
 * The decision — how many, of which kind, which agent runs in which, how many are
 * still missing, and whether the cap allows the roster — is `ensureAgentPanels`,
 * and it is tested there. This is the I/O half: which workspace the app has, what
 * already lives in it, and how a panel gets written.
 *
 * PROCESS specs are excluded from the count deliberately. A GApp's services are
 * background jobs, not panels; counting them would make an app with two services
 * believe its panels were already laid out and give the user an empty Agent tab.
 *
 * Fails soft on a missing workspace. An app with no workspace row is one whose
 * install did not finish, and refusing to open its window over a missing panel
 * would turn a partial install into an app that cannot be looked at, let alone
 * repaired. A REFUSAL is different: it is reported, because a GApp that came up
 * with fewer agents than its consent screen named, silently, is the defect.
 */
export function ensureAppAgentPanels(
    appId: string,
    panels: AppPanels,
    agents?: readonly AppAgentDecl[],
): AgentPanelSeeding {
    const app = appsGet(appId);
    const workspace = app ? getWorkspace(app.workspaceId) : null;
    if (!workspace) return { created: [] };

    // A persona that is not on disk cannot brief anything. `validateAppFolder`
    // refuses this at install, so reaching here means the folder changed under
    // Genie — and launching a TUI against a path that is not there would open an
    // agent with no instructions: the same empty terminal, now with a model session
    // attached to it.
    const missingPersona = (agents ?? []).find(
        (agent) => !fs.existsSync(gappPersonaPath(workspace.path, agent.persona)),
    );

    const seeded = missingPersona
        ? {
              created: [],
              refused:
                  `The agent “${missingPersona.name}” is declared with a persona at ` +
                  `${APP_AGENTS_DIR}/${missingPersona.persona}, but that file is not in the ` +
                  'app’s workspace. Reinstall the app, or put the persona back.',
          }
        : seedAppPanels(appId, workspace, panels, agents);

    // Same broadcast every other spec-creating path makes. A GApp's workspace is a
    // workspace, so the master window may already be looking at it — and a panel
    // that only appears after something unrelated pokes the list is a panel the
    // user reports as missing.
    if (seeded.created.length > 0) broadcastTerminalSpecsChanged();
    if (seeded.refused) reportAgentSeedingRefusal(app?.name ?? appId, seeded.refused);
    return seeded;
}

/**
 * May this workspace start `n` more GApp agents right now?
 *
 * Two questions, asked once for the whole roster and BEFORE anything is created.
 *
 * The cap (Tynn #117) is asked with the app as the ACTOR, not the person who
 * clicked its pill: the app is spending someone else's compute, and a cap an app
 * could seed past merely because a human opened its window would be a cap with a
 * door in it. GApp agents are ordinary agent terminals, so they count like any
 * others — that is the same reason they are subject to it at all.
 */
function mayStartGappAgents(
    workspace: { id: string; path: string },
    n: number,
): { allowed: boolean; reason?: string } {
    const launch = gappAgentLaunch(workspace);
    if ('error' in launch) return { allowed: false, reason: launch.error };

    const cap = decideAgentTerminalSpawn(workspace.id, 'agent', n);
    return { allowed: cap.allowed, ...(cap.reason ? { reason: cap.reason } : {}) };
}

/** The seeding itself, with a failed LAUNCH reported like any other refusal. */
function seedAppPanels(
    appId: string,
    workspace: { id: string; path: string },
    panels: AppPanels,
    agents?: readonly AppAgentDecl[],
): AgentPanelSeeding {
    try {
        return ensureAgentPanels(
            {
                countPanels: () =>
                    listTerminalSpecs().filter(
                        (s) => s.workspace_id === workspace.id && s.type !== 'process',
                    ).length,
                createPanel: (panel) => createGappPanel(appId, workspace, panel),
                mayStartAgents: (n) => mayStartGappAgents(workspace, n),
            },
            panels,
            agents,
        );
    } catch (e) {
        // A launch that threw halfway leaves whatever it created; the app is opened
        // anyway (a window that will not open is worse than one with a short Agent
        // tab) but the user is told why it is short.
        return { created: [], refused: (e as Error).message };
    }
}

/**
 * Tell the user their app's agents did not start.
 *
 * An OS message box rather than a line in a log: the failure this reports is
 * precisely a GApp coming up looking fine while quietly running fewer agents than
 * the consent screen named, and a refusal nobody sees is that same failure with
 * an extra step. Non-blocking — the window still opens.
 */
function reportAgentSeedingRefusal(appName: string, reason: string): void {
    void dialog
        .showMessageBox({
            type: 'warning',
            title: 'Genie App',
            message: `${appName} did not start its agents.`,
            detail: reason,
            buttons: ['OK'],
        })
        .catch(() => {
            /* best-effort — a modal that will not draw must not break the window */
        });
}

/**
 * Which app a Genie-drawn GApp window belongs to, keyed by its SHELL webContents.
 *
 * Deliberately a different map from the bridge's. The bridge's answers "which app
 * may call Genie through this webContents" and must contain ONLY the app's own
 * views; this one answers "which app is this window about" and contains only the
 * SHELL. Keeping them apart is what stops the shell ever being mistaken for the
 * app — the confusion that would hand the app's grant to Genie's own preload.
 */
const shellWindows = new Map<number, string>();

export function registerAppShell(webContentsId: number, appId: string): void {
    shellWindows.set(webContentsId, appId);
}

export function unregisterAppShell(webContentsId: number): void {
    shellWindows.delete(webContentsId);
}

/* ---- PREVIEW: the same window, from a folder that is not installed ------ */

/**
 * The real preview I/O.
 *
 * Every decision it feeds is tested against fakes in `preview-run.test.ts`; this
 * is the filesystem, the database, the OS modal and the hosting manager it runs
 * against for real. Exported so the E2E harness can drive the ACTUAL chain with
 * only the modal swapped out — the same treatment `installIO` gets, for the same
 * reason: what a unit test structurally cannot reach here is whether a preview
 * window ends up with real panels in a real workspace.
 */
export function previewIO(): PreviewIO {
    return {
        readManifest: (folder) => {
            const file = path.join(folder, APP_MANIFEST_FILENAME);
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        },
        exists: (p) => fs.existsSync(p),
        machine: (required) => toolchainMachineFacts(required),
        ask: (questions) => forceQuestion(questions, 'high'),
        rememberedConsent: (folder) => previewConsents.get(folder) ?? null,
        recordConsent: (folder, remembered) => {
            // In MEMORY, for this run of Genie only. A preview's grant is not a
            // decision the machine should carry forward: it was never an install,
            // and a remembered yes on disk would outlive every folder it was
            // about. The friction it removes is within one working session, which
            // is where the loop this feature exists for actually happens.
            previewConsents.set(folder, remembered);
        },
        createWorkspace: ({ appId, name, path: folder }) => {
            // Always a NEW row, never an adopt-if-the-path-matches like dev mode.
            // A preview deletes the workspace it created when its window closes,
            // and the developer very often already has a real workspace on this
            // exact folder — adopting it would make closing a preview window
            // delete their project.
            const row = addWorkspace({
                id: `preview-${randomUUID()}`,
                backend: 'aionima',
                // The PREVIEW app id, not a random one and not the app's own.
                // `project_id` is what `buildTerminalEnv` looks Tynn-managed
                // provider credentials up by, so this is the line that decides a
                // preview's terminals inherit NOBODY's credentials — a preview id
                // is not a Tynn project id and never matches one. Naming it makes
                // that deliberate rather than a happy accident of randomness, and
                // makes a stray row in the database say what it was for.
                project_id: appId,
                project_name: name,
                tynn_project_id: appId,
                tynn_project_name: name,
                // 'simple' even on a `.gapp` envelope: this row is Genie's
                // scaffolding, not the folder's own registration, and its sites
                // stay in genie.db (see `isEphemeral` in db.ts).
                shape: 'simple',
                path: folder,
                editor: null,
                editor_cmd: null,
                start_cmd: null,
                env_file: null,
                last_opened_at: null,
                created_by_genie: 0,
            });
            setWorkspaceAppKind(row.id, 'app-preview');
            return { workspaceId: row.id };
        },
        workspaceRow: (workspaceId) => getWorkspace(workspaceId) ?? null,
        removeWorkspace: (workspaceId) => removeWorkspaceRow(workspaceId),
        listWorkspaceRows: () => listWorkspaces(),
        countPanels: (workspaceId) =>
            listTerminalSpecs().filter(
                (s) => s.workspace_id === workspaceId && s.type !== 'process',
            ).length,
        createPanel: (appId, workspaceId, panel) => {
            const workspace = getWorkspace(workspaceId);
            // The SAME writer the installed path uses, so a developer previewing
            // their app meets the agents their users will — not a bare terminal
            // that behaves nothing like the shipped article.
            createGappPanel(appId, { id: workspaceId, path: workspace?.path ?? '' }, panel);
        },
        mayStartAgents: (workspaceId, n) => {
            const workspace = getWorkspace(workspaceId);
            return mayStartGappAgents({ id: workspaceId, path: workspace?.path ?? '' }, n);
        },
        removePanels: (workspaceId) => {
            for (const spec of listTerminalSpecs().filter((s) => s.workspace_id === workspaceId)) {
                // Kill BEFORE delete: a pty whose spec has already gone is one
                // nothing owns, and it would outlive the preview holding the
                // developer's folder open.
                killTerminalById(spec.id);
                deleteTerminalSpec(spec.id);
            }
        },
        panelsChanged: () => broadcastTerminalSpecsChanged(),
        persistSites: (workspaceId, sites) => setWorkspaceDevSites(workspaceId, sites),
        startSite: async (workspaceId, siteName, callerId) => {
            const r = await manageSiteForMcp(callerId, {
                action: 'start',
                workspaceId,
                name: siteName,
            });
            return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
        },
        stopSite: async (workspaceId, siteName, callerId) => {
            await manageSiteForMcp(callerId, { action: 'stop', workspaceId, name: siteName });
        },
        clearStorage: (appId) => clearAppStorage(appId),
        openWindow: ({ workspaceId, ...opts }) =>
            void openAppWindow({
                ...opts,
                // Closing the window IS the cleanup, so the teardown hangs off the
                // window rather than off a button somebody has to remember to
                // press. It covers the developer closing it, Genie quitting, and
                // the window being closed by anything else.
                //
                // SCOPED to the workspace this window opened. `closed` fires
                // asynchronously, so a window being replaced by a re-preview fires
                // its callback after the NEW preview has registered under the same
                // app id — and an unscoped teardown would dismantle the window the
                // developer is looking at.
                onClosed: () => void closePreview(opts.appId, previewIO(), workspaceId),
            }),
        closeWindow: (appId) => closeAppWindows(appId),
    };
}

/**
 * What each folder answered, and what it was answering ABOUT.
 *
 * Keyed by folder, holding a fingerprint of the manifest's permissions, so the
 * consent screen reappears exactly when the app changes what it asks for — which
 * is both the moment it has something new to say and the moment a developer most
 * wants to see how their own ask reads. Anything else would be either friction on
 * every preview or a screen they never meet.
 *
 * By FOLDER and not by hosted site, and that stays right when a manifest can
 * declare several (genie#238). Permissions are declared once for the whole app —
 * a GApp with three hosted sites has one `permissions` block, not three — so
 * asking again per site would be asking the same question three times and
 * recording three answers that can never legitimately differ.
 */
const previewConsents = new Map<string, RememberedConsent>();

/**
 * Remove preview workspaces that outlived the process. Called once at boot.
 *
 * A preview cannot outlive its window and a window cannot outlive Genie, so one
 * found here is the residue of a crash or a kill. Sweeping it is what keeps
 * "closing the window is the whole cleanup" true in the case where the window
 * never got the chance to close.
 */
export function sweepPreviewsAtBoot(): void {
    sweepPreviewWorkspaces(previewIO());
}

export function registerAppsIpc(): void {
    ipcMain.handle('apps:list', () => appsList());

    /**
     * What this window is. Answered only for a GApp SHELL — Genie's other windows
     * are not one, and get null rather than a guess.
     */
    ipcMain.handle('gapp:describe', (event) => {
        const appId = shellWindows.get(event.sender.id);
        if (!appId) return null;

        // A PREVIEW answers from the live registry, because it deliberately has no
        // grant row and never will. Checked FIRST: a preview's app id cannot
        // belong to an installed app, so there is nothing to fall through to, and
        // reading the registry second would mean an installed app of a similar
        // name could answer for it.
        const live = livePreview(appId);
        if (live) {
            return {
                app: previewAppView(live),
                workspace: getWorkspace(live.workspaceId) ?? null,
                tabs: appWindowTabs(live.manifest).map((t) => ({ kind: t.kind, title: t.title })),
                // The window has to keep saying what did not come up. An app tab
                // showing nothing, with no explanation, reads as a bug in the app
                // being built — the wrong lesson for a previewer to teach.
                preview: { folder: live.folder, warnings: live.warnings },
            };
        }

        const app = appsGet(appId);
        const row = getAppGrant(appId);
        if (!app || !row) return null;
        try {
            const parsed = validateAppManifest(JSON.parse(row.manifestJson));
            if (!parsed.ok) return null;
            return {
                app,
                // The Agent tab is a real Floor over this app's workspace, so the
                // window needs the workspace ROW — its path is where a new panel
                // opens, and its name is what the grid labels things with.
                workspace: getWorkspace(app.workspaceId) ?? null,
                tabs: appWindowTabs(parsed.value).map((t) => ({ kind: t.kind, title: t.title })),
            };
        } catch {
            return null;
        }
    });

    /**
     * Open a folder in a real GApp window without installing it.
     *
     * The folder picker is here for the same reason install's is: it needs a
     * native dialog and a path on the machine the user is sitting at.
     */
    ipcMain.handle('apps:preview-folder', async (_e, folder?: string) => {
        const dir = folder || (await pickFolder('Preview a Genie App'));
        if (!dir) return { ok: false, errors: ['No folder chosen.'] };
        return openPreview(dir, previewIO());
    });

    /**
     * Close a preview from Genie's side.
     *
     * The window closing already tears everything down; this is for the Store
     * drawer, which shows what is open and should be able to end it without the
     * user hunting for the window.
     */
    ipcMain.handle('apps:preview-close', async (_e, appId: string) => {
        closeAppWindows(String(appId));
        await closePreview(String(appId), previewIO());
        return { ok: true };
    });

    /** What is being previewed right now — for the Store drawer. */
    ipcMain.handle('apps:previews', () =>
        listPreviews().map((live) => ({
            appId: live.identity.appId,
            name: live.source.name,
            folder: live.folder,
            homeUrl: gappHomeUrl(live.manifest.slug),
            warnings: live.warnings,
        })),
    );

    /** Show a tab: the shell paints the strip, main moves the embedded view. */
    ipcMain.handle('gapp:show-tab', (event, index: number) => {
        const appId = shellWindows.get(event.sender.id);
        if (!appId) return;
        showAppTab(appId, Number(index) || 0);
    });

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
     * writing the app) works in.
     *
     * The whole SUITE, not just the install gate: schema problems, missing files,
     * a roster the window cannot run, a front end reaching for an API that does not
     * exist, and — separately — the things that will work and are worth a second
     * thought. Being stricter than the installer is the point. An app that installs
     * perfectly and opens on an empty window is the failure this exists to catch,
     * and by definition the install gate has nothing to say about it.
     */
    ipcMain.handle('apps:check-folder', async (_e, folder?: string): Promise<AppCheckReport> => {
        const dir = folder ?? (await pickFolder('Check a Genie App'));
        if (!dir) {
            return {
                ok: false,
                ran: [],
                findings: [
                    {
                        check: 'check.no-folder',
                        severity: 'error',
                        where: '',
                        problem: 'No folder was chosen.',
                        fix: `Pick the folder that holds your ${APP_MANIFEST_FILENAME}.`,
                    },
                ],
            };
        }
        return checkApp(dir, folderProbe());
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
        // The manifest travels with the open: it is what says how many tabs the
        // window has and what the Agent tab lays out. An app whose stored manifest
        // no longer parses still OPENS — with its Agent tab and nothing else —
        // rather than refusing, because the workspace half is still perfectly good.
        const row = getAppGrant(app.id);
        let manifest: AppManifest | undefined;
        try {
            const parsed = row ? validateAppManifest(JSON.parse(row.manifestJson)) : null;
            if (parsed?.ok) manifest = parsed.value;
        } catch {
            /* open without app tabs */
        }
        openAppWindow({
            appId: app.id,
            slug: app.slug,
            name: app.name,
            homeUrl: app.homeUrl,
            devMode: app.devMode,
            ...(manifest ? { manifest } : {}),
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

    // --- backups (Tynn #250, step 4) ---------------------------------------
    //
    // Read and write BOTH levels through one pair of channels, because the two
    // are only meaningful together: a folder shown without saying whether it came
    // from this app or from the workstation is a value nobody can safely edit.

    ipcMain.handle('apps:backup-settings', (_e, appId?: string) =>
        appId ? appBackupSettings(String(appId)) : { workstation: workstationBackupSettings() },
    );

    ipcMain.handle(
        'apps:set-backup',
        (_e, appId: string | null, patch: Partial<BackupSettings> | BackupOverride | null) => {
            // No appId ⇒ the WORKSTATION default. `null` for an app clears its
            // override so it follows that default again — a different state from
            // "copy the current default in", and the one Reset means.
            if (!appId) {
                return { ok: true, workstation: setWorkstationBackupSettings(patch ?? {}) };
            }
            setAppBackupOverride(String(appId), (patch as BackupOverride | null) ?? null);
            return { ok: true, ...appBackupSettings(String(appId)) };
        },
    );

    ipcMain.handle('apps:backup', (_e, appId: string) => backupAppNow(String(appId)));

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
