import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import { readBoardForPanel, reviewBoardPost, type WireDeps } from './artboard/wire';
import { app, clipboard, dialog, ipcMain, shell, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { writeClipboardImagePng } from './clipboard-image';
import {
    addWorkspace,
    AI_SYSTEM_MAX,
    getAllSettings,
    getWorkspace,
    listWorkspaces,
    removeWorkspace,
    reorderWorkspaces,
    setWorkspaceMcp,
    setWorkspaceProcessApproval,
    setWorkstationOperator,
    getWorkspaceAgentCap,
    setWorkspaceAgentCap,
    setWorkspaceTerminalApproval,
    setWorkspaceScheduleApproval,
    getWorkspaceAgentAccess,
    setWorkspaceAgentAccess,
    getWorkspaceIssuewatchPolicyBuckets,
    setWorkspaceIssuewatchPolicyBuckets,
    type IssuewatchPolicyBuckets,
    getWorkspaceIssuewatchGranularity,
    setWorkspaceIssuewatchGranularity,
    type IssuewatchGranularity,
    getWorkspaceIssuewatchHandlers,
    setWorkspaceIssuewatchHandlers,
    listWorkspaceIssuewatchAgents,
    setSettings,
    touchWorkspace,
    updateWorkspace,
    WorkspaceRow,
    getAionimaConfig,
    setAionimaConfig,
    BackendConfig,
    createTerminalSpec,
    deleteTerminalSpec,
    getTerminalSpec,
    listTerminalSpecs,
    touchTerminalSpec,
    reorderTerminalSpecs,
    updateTerminalSpec,
    TerminalSpecRow,
} from './db';
import { rebuildMenu } from './tray';
import { broadcastIssueWatchUpdate } from './issue-watch';
import { readSoundDataUrl } from './notify-sound';
import { detectFolder } from './workspace/detect';
import {
    createAgiEnvelope,
    CreateAgiOpts,
    convertToAgi,
    ConvertToAgiOpts,
    convertToAgiPlan,
    ConvertPlanOpts,
    workspaceDocHealth,
    repairWorkspaceDocs,
} from './workspace/create-agi';
import { analyseFolder } from './workspace/analyse';
import { syncGappDevWorkspaces } from './workspace/gapp-dev-sync';
import { validateSimpleWorkspace } from './workspace/create-simple';
import { openWorkspace } from './workspace/open';
import { cloneRepo } from './workspace/clone';
import {
    listEnvelopeRepos,
    addEnvelopeRepo,
    removeEnvelopeRepo,
    listKnowledgeFolders,
    createKnowledgeFolder,
} from './workspace/envelope';
import { stopProcess, forgetProcess } from './terminal/process-supervisor';
import { armSchedule, forgetSchedule } from './terminal/process-scheduler';
import { broadcastTerminalSpecsChanged, liveTerminalCount } from './terminal/ipc';
import { agentPulse } from './terminal/agent-pulse';
import {
    createSpecializedAgentTerminal,
    restartAgentTerminal,
    updateAgentInboxChannel,
} from './mcp/host-tools';
import { agentInboxBroker } from './agentinbox/broker';
import { type AgentInboxScope } from './agentinbox/types';
import {
    postAsHuman,
    readHumanAttachment,
    type HumanInboxAttachment,
} from './agentinbox/human';
import {
    listPendingQuestions,
    answerPendingQuestion,
    onQuestionsChanged,
} from './ask/force-question';
import { groupPendingByWorkspace, pendingCount } from './ask/inbox';
import type { ForceAnswer } from './mcp/protocol';
import { getKnowledgeStore } from './knowledge/store';
import { writeWorkspaceAgentMcp } from './mcp/agent-config';
import {
    TYNN_HEALTH_CHANNEL,
    onTynnHealthResult,
    tynnHealthService,
} from './mcp/tynn-health-service';
import {
    provisionWorkspaceTynn,
    provisionStatus,
    linkWorkspaceTynn,
    unlinkWorkspaceTynn,
} from './tynn/provision';
import {
    computeOpsRepoPlan,
    applyOpsRepoPlan,
    type OpsRepoDesired,
} from './tynn/ops-repos';
import {
    computeOpsProvisionPlan,
    applyOpsProvision,
    provisionTargets,
    type OpsProvisionTarget,
} from './tynn/ops-provision';
import type { ProjectJsonTynn } from './workspace/project-json';
import {
    workspaceEndpointUrl,
    mcpServerState,
    restartMcpServer,
    serverPushDiagnostics,
} from './mcp/server';
import {
    mobileEmit,
    mobileServerState,
    restartMobileServer,
    setMobileEnabled,
    setRemoteEnabled,
    setLocked,
    requestControl,
    regeneratePin,
    currentPin,
    revokeAllSessions,
    revokeSession,
    listSessions,
    type MobileServerState,
} from './mobile/server';
import { DESKTOP_PRINCIPAL } from './mobile/baton';
import { firewallRuleExists, ensureFirewallRule } from './mobile/firewall';
import { getTailscaleStatus, tailscaleUp, installTailscale } from './tailscale';
import { discoverHosts, openRemoteWindow } from './workmode';
import {
    connectRemote,
    disconnectRemote,
    remoteStatusFor,
    remoteBindingFor,
    connKeyForWindow,
    remoteLinkStateFor,
    remoteControlStateFor,

    remoteUpgradeHost,
    remoteReconnect,
    remoteRequest,
    remoteAttachTerminal,
    remoteTerminalInput,
    remoteTerminalResize,
    remoteDetachTerminal,
    listKnownHosts,
    forgetHost,
    renameKnownHost,
    broadcastLocal,
    remoteListEnabledGenSites,
    type RemoteHost,
} from './remote';
import { listLocalEnabledGenSites } from './sites/local-sites';
import { runManageSite, runtimeInfo } from './mcp/dev-site-tools';
import { runManageService } from './mcp/dev-service-tools';
import { devLifecycle } from './dev-server/lifecycle';
import { workstationDevServerInfo, workstationEngineAction } from './dev-server/workstation';
import { inspectToolchain, detectToolchainUpdates } from './dev-server/toolchain-setup';
import { shouldCheckToolchainUpdates } from './dev-server/toolchain-updates';
import type { ToolUpdate } from './dev-server/toolchain-updates';

/** The last completed toolchain update scan, reused until it goes stale (#242
 *  P4). Process-lifetime only: a fresh boot re-scans, which is the right default
 *  after an install or an upgrade. */
let toolchainUpdateCache: { at: number | null; rows: ToolUpdate[] } = { at: null, rows: [] };

/**
 * The Toolchain page's machine bindings.
 *
 * Injected rather than imported inside `toolchain-manager.ts` so the manager
 * stays free of the settings store and the site manager, and so the one thing
 * worth being careful about — that the default is written as a TARGETED patch —
 * is visible here beside the handler that does it.
 */
function toolchainManagerDeps(): ToolchainManagerDeps {
    return {
        readDefaults: () => getAllSettings().toolchain_defaults,
        writeDefaults: (raw) => {
            setSettings({ toolchain_defaults: raw });
        },
        // Which sites consume which language, across EVERY workspace — the input
        // to "changing the default moves these sites". `siteEngineUse` owns that
        // judgement: a Genie-SERVED php site runs php whatever its detected stack
        // says, a static site runs no engine, and a site that PINS a version is
        // reported with it so the notice does not claim to move it (genie#207).
        listSiteUsage: (): ToolchainSiteUsage[] => {
            const manager = devSiteManager();
            if (!manager) return [];
            try {
                return manager.list().flatMap((row) => {
                    const use = siteEngineUse(row);
                    return use ? [use] : [];
                });
            } catch {
                return [];
            }
        },
    };
}

/**
 * What a toolchain update would walk into RIGHT NOW.
 *
 * Read fresh at the moment of the click, never cached: the whole point is the
 * state of the machine as the binary is about to be replaced, and an agent can
 * start a turn between opening the page and pressing Update.
 */
async function readToolchainActivity(): Promise<ToolchainActivity> {
    const busyAgents = agentPulse
        .workingAgentTerminals()
        // A terminal id means nothing to a human; the warning has to say WHO.
        .map((id) => getTerminalSpec(id)?.label || id);
    // LIVE ptys, not specs: a spec outlives its pty (terminals are revivable),
    // and what aborts the Git installer is a RUNNING bash.exe.
    const openTerminals = liveTerminalCount();
    let runningEngines: string[] = [];
    try {
        const info = await workstationDevServerInfo();
        runningEngines = info.engines
            .filter((e) => e.state === 'running')
            .map((e) => (e.engine === 'custom' ? e.label : `${e.label} ${e.version}`));
    } catch {
        // Never let a diagnostics read block the guard — an unknown engine list
        // means we simply cannot NAME containers, not that the update is safe to
        // wave through on the agent-critical path above.
    }
    // A `.gen` site only resolves a port once its server is up, so this set IS
    // the running one.
    const runningSites = devServerGenSites().map((s) => s.genName);
    return { busyAgents, openTerminals, runningSites, runningEngines, platform: process.platform };
}
import { hostToolCommandRunner } from './dev-server/seams';
import { runInstallPlan } from './dev-server/toolchain-install';
import { planToolUpdate } from './dev-server/toolchain-plan';
import { installIntentFor } from './dev-server/toolchain-adapters';
import { DEFAULT_TOOLCHAIN } from './dev-server/toolchain-detect';
import type { HostToolName } from './dev-server/toolchain-detect';
import {
    addToolchainVersion,
    createToolchainInstallEffect,
    resolveOnPath,
    toolchainRoot,
    removeToolchainVersion,
    setToolchainDefault,
    toolchainInstallsInfo,
    repairToolchainPath,
    applyToolchainPrecedence,
    currentManagedDirs,
    refreshManagedInis,
    type ToolchainManagerDeps,
    type ToolchainSiteUsage,
} from './dev-server/toolchain-manager';
import { isLanguageTool } from './dev-server/toolchain-versions';
import { siteEngineUse } from './dev-server/sites-config';
import { devSiteManager } from './dev-server/site-manager';
import type { EngineActionRequest } from './dev-server/services/service-manager';
import type { ManageServiceRequest, ManageSiteRequest } from './mcp/protocol';
import { devServerGenSites } from './dev-server/site-manager';
import { toolchainUpdateRisk } from './dev-server/toolchain-update-risk';
import type { ToolchainActivity } from './dev-server/toolchain-update-risk';
import type { DevSiteProgress } from './dev-server/site-manager';
import { remoteGenUrl } from './sites/gen-url';
import {
    openTestingBrowser,
    LOCAL_CONN_KEY,
    testingBrowserState,
    testingBrowserNavigate,
    testingBrowserBack,
    testingBrowserForward,
    testingBrowserReload,
    testingBrowserNewTab,
    testingBrowserCloseTab,
    testingBrowserActivateTab,
    testingBrowserSetBounds,
    testingBrowserSetViewport,
    testingBrowserRefreshSites,
} from './testing-browser';
import QRCode from 'qrcode';
import { registerShortcuts } from './shortcuts';
import { startSignIn, redeemCode } from './auth';
import {
    hideCaptureWindow,
    showSettingsWindow,
    showDocsWindow,
    showKnowledgeWindow,
    showMainWindow,
    showStageWindow,
    showHostWindow,
} from './background';
import {
    allConfiguredBackends,
    backendOfKind,
    fetchMergedInbox,
    getAionimaBackend,
    getTynnBackend,
    listAllProjects,
    signedInBackends,
} from './backend/registry';
import type { BackendKind } from './backend/backend';
import { openWorkstationById } from './workstation-open';
import { visibleConnectableWorkstations } from './tynn/connectable-workstations';
import { readWorkstationIdentity } from './tynn/workstation-identity';
import {
    getAutostart,
    isAutostartSupported,
    setAutostart,
} from './autostart';

/**
 * Wire every typed channel exposed by preload.ts to its main-side handler.
 *
 * Two backends ride through this layer: Tynn (session-cookied web app)
 * and Aionima (locally-hosted AGI gateway). Most channels fan out across
 * whichever backends the user has connected; a `backendKind` parameter
 * pins the call to one backend for surfaces (capture, sign-out) where
 * the target is explicit.
 */
/**
 * Make Genie's own toolchain win on PATH for everything Genie spawns.
 *
 * Runs once at startup, BEFORE terminals, sites, services and agents exist, and
 * again whenever a version is installed or a default changes. It has to run every
 * launch: the repair is in-process only — it does not rewrite the owner's
 * persisted PATH, which is their shell environment and not Genie's to edit — so a
 * fresh process re-inherits the machine's ordering and has to re-apply.
 *
 * Never throws. A scan failure must not stop Genie from starting; the worst case
 * is the machine behaves exactly as it did before this existed.
 */
export async function applyStartupToolchainPrecedence(): Promise<void> {
    try {
        applyToolchainPrecedence(await currentManagedDirs(toolchainManagerDeps()));
    } catch {
        /* precedence is an improvement, never a prerequisite for booting */
    }
    try {
        // …and the CONFIG of the toolchain precedence just selected. These belong
        // together: beta.270 shipped the PATH half automatically and left this
        // half behind a button, so every machine was switched onto Genie's PHP
        // while that PHP kept an ini written by an older release. On the
        // reporting machine that meant no `sodium` (breaking `composer require
        // laravel/passport`, via lcobucci/jwt) and a `bcmath` line warning on
        // stderr of every PHP process. Switching the interpreter and then
        // declining to configure it until asked is worse than doing neither.
        //
        // Idempotent: an ini already current is not rewritten, so this cannot
        // churn a file on every launch.
        await refreshManagedInis();
    } catch {
        /* same rule: config repair is an improvement, never a boot prerequisite */
    }
}

/**
 * ArtBoard's host wiring. Injected rather than imported inside the module so the
 * decisions stay testable without a disk or a broker.
 */
function artboardDeps(): WireDeps {
    return {
        workspaceRoot: (id) => getWorkspace(id)?.path ?? null,
        deliver: (terminalId, text) =>
            agentInboxBroker.deliverHumanMessageToTerminal(terminalId, text),
    };
}

/**
 * Register an existing folder as a workspace, deriving the row from the folder.
 *
 * The `workspaces:add` IPC takes a fully-built `WorkspaceRow` because the
 * Add-workspace UI has already collected every field. An OPERATOR AGENT has only
 * a path, so this is the same registration with the row derived: the shape is
 * read off disk (`project.json` ⇒ an `.agi` envelope, else a simple folder) and
 * the name from the folder, which is what the UI defaults to anyway.
 *
 * Exported so `manageWorkspaces add` and the UI land in ONE registration path —
 * two would drift, and the drifting half would be the one nobody clicks.
 */
export function addWorkspaceFromFolder(folder: string): { ok: boolean; error?: string } {
    try {
        const isEnvelope = fsSync.existsSync(path.join(folder, 'project.json'));
        if (!isEnvelope) validateSimpleWorkspace({ path: folder });
        const row = addWorkspace({
            id: randomUUID(),
            project_name: path.basename(folder.replace(/[\/]+$/, '')) || folder,
            path: folder,
            shape: isEnvelope ? 'agi' : 'simple',
            backend: 'tynn',
        } as Parameters<typeof addWorkspace>[0]);
        // MCP is ON by default for a new workspace, exactly as the IPC does it,
        // so an agent that lands there discovers the genie server immediately.
        if (row.mcp_enabled) writeWorkspaceAgentMcp(row.path, true, workspaceEndpointUrl(row.id));
        rebuildMenu();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

export function registerIpcHandlers(): void {
    // --- Auth -----------------------------------------------------------
    ipcMain.handle('auth:start-sign-in', async (_e, kind?: BackendKind) => {
        // Tynn uses the browser-handoff (genie://) flow. Aionima signs in
        // by configuring host + token in Settings → see auth:aionima-set.
        if (kind === 'aionima') {
            return { ok: false, message: 'Configure Aionima host + token in Settings.' };
        }
        const { url } = await startSignIn();
        return { ok: true, url };
    });
    ipcMain.handle('auth:redeem-code', async (_e, code: string) => {
        const ok = await redeemCode(typeof code === 'string' ? code : '');
        return { ok };
    });
    ipcMain.handle('auth:sign-out', async (_e, kind: BackendKind = 'tynn') => {
        await backendOfKind(kind).signOut();
        broadcast('auth:changed', { backend: kind, signedIn: false });
        return { ok: true };
    });
    ipcMain.handle('auth:whoami', async (_e, kind?: BackendKind) => {
        if (kind) return backendOfKind(kind).whoami();
        // No kind given → return per-backend whoami map.
        const out: Record<string, unknown> = {};
        for (const b of allConfiguredBackends()) {
            out[b.kind] = await b.whoami();
        }
        return out;
    });

    // Aionima connection management (manual paste-host + paste-token
    // path today; will swap to the pairing flow once
    // https://github.com/Civicognita/agi/issues/178 Q5.2a is answered).
    ipcMain.handle('auth:aionima-config', () => getAionimaConfig());
    ipcMain.handle(
        'auth:aionima-set',
        async (_e, patch: BackendConfig) => {
            const next = setAionimaConfig(patch);
            const { user, error } = await getAionimaBackend().probe();
            broadcast('auth:changed', { backend: 'aionima', signedIn: !!user });
            return { config: next, user, error };
        },
    );

    // --- Settings -------------------------------------------------------
    ipcMain.handle('settings:get', () => getAllSettings());
    ipcMain.handle('settings:set', (_e, patch: Record<string, unknown>) => {
        // Ai.System is injected verbatim into every workspace's AGENTS.md, so cap
        // it server-side (never trust the UI's maxLength alone) to keep AGENTS.md
        // from bloating. Truncate anything over the limit before persisting.
        if (typeof patch.ai_system === 'string' && patch.ai_system.length > AI_SYSTEM_MAX) {
            patch = { ...patch, ai_system: patch.ai_system.slice(0, AI_SYSTEM_MAX) };
        }
        const next = setSettings(patch as Record<string, string>);
        if ('global_hotkey' in patch) registerShortcuts();
        // Tell every window a setting changed so live UI (e.g. a terminal's
        // copy/paste mode) re-reads without a restart. Settings are global, so
        // this reaches all windows including host windows (their xterm rendering
        // is local). The payload carries the changed keys for cheap filtering.
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.webContents.isDestroyed()) {
                w.webContents.send('settings:changed', Object.keys(patch));
            }
        }
        return next;
    });

    // System clipboard via the MAIN process (Electron `clipboard`). The renderer's
    // navigator.clipboard is unreliable in a sandboxed Electron window — it fails
    // SILENTLY (no permission / lost user-gesture), so terminal copy never reached
    // the OS clipboard. Routing through main is the reliable path.
    ipcMain.handle('clipboard:write', (_e, text: unknown) => {
        clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''));
        return { ok: true };
    });
    ipcMain.handle('clipboard:read', () => clipboard.readText());
    // Image clipboard — the terminal's image-paste path. `read-image` returns the
    // LOCAL clipboard image as a PNG data-URL (null when there's no image), so the
    // renderer can detect a copied image and sync it to the machine the terminal
    // runs on. `write-image` places a PNG (base64) where the local CLI reads it; in
    // a host window the remote bridge re-points this to the HOST over the authed
    // bridge. On Windows/macOS that's the OS clipboard (Ctrl+V reads it); on Linux
    // it's a temp FILE whose `path` comes back so the caller pastes the path
    // instead (Claude Code can't reliably read a Linux clipboard image). Shared
    // with the bridge route via `writeClipboardImagePng`.
    ipcMain.handle('clipboard:read-image', () => {
        const img = clipboard.readImage();
        return img.isEmpty() ? null : img.toDataURL();
    });
    ipcMain.handle('clipboard:write-image', (_e, dataBase64: unknown) => {
        const b64 = typeof dataBase64 === 'string' ? dataBase64 : '';
        if (!b64) return { ok: false, supported: true };
        return writeClipboardImagePng(Buffer.from(b64, 'base64'));
    });
    ipcMain.handle(
        'settings:choose-folder',
        async (_e, label?: string, defaultPath?: string) => {
            const r = await dialog.showOpenDialog({
                title: label ?? 'Choose folder',
                // Seed the picker at a starting directory when one is given
                // (e.g. ~/ for a System Workspace process). Ignored when absent.
                ...(defaultPath ? { defaultPath } : {}),
                properties: ['openDirectory', 'createDirectory'],
            });
            return r.canceled ? null : r.filePaths[0];
        },
    );
    ipcMain.handle('settings:choose-file', async (_e, label?: string) => {
        const r = await dialog.showOpenDialog({
            title: label ?? 'Choose file',
            properties: ['openFile'],
        });
        return r.canceled ? null : r.filePaths[0];
    });
    // Read a sound file (custom alert sound) into a base64 data-URL so the
    // sandboxed renderer can play it via new Audio(...). Used by the Settings
    // sound Preview and the per-alert "Custom file…" choice. Null when the path
    // is empty/missing/unreadable/too large (see readSoundDataUrl's guards).
    ipcMain.handle('settings:sound-data-url', (_e, p: string) =>
        readSoundDataUrl(typeof p === 'string' ? p : ''),
    );

    // --- Workspaces -----------------------------------------------------
    ipcMain.handle('workspaces:list', () => listWorkspaces());
    ipcMain.handle('workspaces:add', (_e, row: WorkspaceRow) => {
        if (row.shape === 'simple') {
            validateSimpleWorkspace({ path: row.path });
        }
        const r = addWorkspace({
            ...row,
            backend: (row.backend ?? 'tynn') as 'tynn' | 'aionima',
        });
        // MCP is ON by default for new workspaces — write the genie server into
        // its Claude (.mcp.json) + Cursor (.cursor/mcp.json) config so agents
        // there discover it immediately. Best-effort.
        if (r.mcp_enabled) writeWorkspaceAgentMcp(r.path, true, workspaceEndpointUrl(r.id));
        rebuildMenu();
        return r;
    });
    // Clone a remote repo to a chosen parent → return the local path, so the
    // Add-workspace Simple flow can register a remote repo (not just a folder).
    ipcMain.handle(
        'workspaces:clone',
        (_e, url: string, parentPath: string, folder?: string) =>
            cloneRepo({ url, parent_path: parentPath, folder }),
    );
    ipcMain.handle(
        'workspaces:update',
        (_e, id: string, patch: Partial<WorkspaceRow>) => {
            const r = updateWorkspace(id, patch);
            rebuildMenu();
            // A rename (project_name) must reflect live in the sidebar rail.
            broadcastWorkspacesChanged();
            return r;
        },
    );
    // Reveal a workspace-relative path (a repo under repos/, an .ai/ knowledge
    // folder) in the OS file manager. Guard-resolved under the workspace root so
    // a `..`/absolute path can't escape it.
    ipcMain.handle(
        'workspaces:reveal',
        async (_e, workspacePath: string, relPath: string) => {
            const root = path.resolve(workspacePath);
            const abs = path.resolve(root, relPath ?? '');
            if (abs !== root && !abs.startsWith(root + path.sep)) {
                return { ok: false };
            }
            const err = await shell.openPath(abs);
            return { ok: !err, error: err || undefined };
        },
    );
    ipcMain.handle('workspaces:remove', async (_e, id: string) => {
        // Tear the Dev Server down BEFORE the row goes: the teardown reads this
        // workspace's sites and services to release the shared engines it holds
        // and to stop advertising its `.gen` names, and a deleted row answers
        // neither. Awaited, because a removal that returns while containers are
        // still coming down would let the UI offer to re-add the workspace onto
        // a half-swept sandbox. (#234 P4)
        await devLifecycle()
            ?.onWorkspaceRemove(id)
            .catch((e) => console.error('[dev-server] teardown failed', e));
        removeWorkspace(id);
        rebuildMenu();
        return { ok: true };
    });
    ipcMain.handle('workspaces:touch', (_e, id: string) => {
        touchWorkspace(id);
        rebuildMenu();
        return { ok: true };
    });
    ipcMain.handle('workspaces:reorder', (_e, ids: string[]) => {
        reorderWorkspaces(ids);
        rebuildMenu();
        return { ok: true };
    });
    ipcMain.handle('workspaces:set-mcp', (_e, id: string, enabled: boolean) => {
        setWorkspaceMcp(id, enabled);
        // Auto-register (or remove) the genie MCP server in the workspace's
        // Claude (.mcp.json) + Cursor (.cursor/mcp.json) config so agents there
        // discover it. Best-effort; the env injection works regardless.
        const ws = getWorkspace(id);
        if (ws) writeWorkspaceAgentMcp(ws.path, enabled, workspaceEndpointUrl(id));
        return { ok: true };
    });
    // WORKSTATION OPERATOR (Tynn #248) — authority over every workspace on this
    // machine, so it is granted here by an explicit human act in Workspace
    // settings and nowhere else. No agent-facing tool sets it.
    ipcMain.handle(
        'workspaces:set-workstation-operator',
        (_e, id: string, on: boolean) => {
            setWorkstationOperator(id, on);
            return { ok: true };
        },
    );
    // AGENT-TERMINAL CAP (Tynn #117) — how many agent terminals this workspace may
    // run at once. An agent that can raise its own cap has no cap, so the setter is
    // reachable from HERE and nowhere else: this channel is called by a real
    // window's preload, `main/mcp/` never imports `setWorkspaceAgentCap`, and the
    // column is deliberately absent from `updateWorkspace`'s allowlist so a generic
    // patch naming it is dropped. Same structural rule as the workstation operator
    // above. `null` clears the override back to inheriting the workstation default.
    //
    // Reading goes through its own channel rather than the `workspaces:list` row
    // because the column encodes "unlimited" as a private sentinel that db.ts keeps
    // inside its two accessors. The UI gets the decoded `number | 'unlimited' |
    // null`, so the sentinel stays where it was documented to stay.
    ipcMain.handle('workspaces:get-max-agent-terminals', (_e, id: string) =>
        getWorkspaceAgentCap(id),
    );
    ipcMain.handle(
        'workspaces:set-max-agent-terminals',
        (_e, id: string, cap: number | 'unlimited' | null) => {
            setWorkspaceAgentCap(id, cap);
            return { ok: true };
        },
    );
    ipcMain.handle(
        'workspaces:set-process-approval',
        (_e, id: string, require: boolean) => {
            setWorkspaceProcessApproval(id, require);
            return { ok: true };
        },
    );
    ipcMain.handle(
        'workspaces:set-terminal-approval',
        (_e, id: string, require: boolean) => {
            setWorkspaceTerminalApproval(id, require);
            return { ok: true };
        },
    );
    ipcMain.handle(
        'workspaces:set-schedule-approval',
        (_e, id: string, require: boolean) => {
            setWorkspaceScheduleApproval(id, require);
            return { ok: true };
        },
    );
    ipcMain.handle('workspaces:get-agent-access', (_e, id: string) =>
        getWorkspaceAgentAccess(id),
    );
    ipcMain.handle(
        'workspaces:set-agent-access',
        (_e, id: string, access: import('./agentinbox/types').WorkspaceAgentAccess, workspaces?: string[]) => {
            setWorkspaceAgentAccess(id, access, workspaces ?? []);
            return { ok: true };
        },
    );
    ipcMain.handle('workspaces:get-issuewatch-policy', (_e, id: string) =>
        getWorkspaceIssuewatchPolicyBuckets(id),
    );
    ipcMain.handle(
        'workspaces:set-issuewatch-policy',
        (_e, id: string, buckets: IssuewatchPolicyBuckets) => {
            setWorkspaceIssuewatchPolicyBuckets(id, buckets);
            return { ok: true };
        },
    );
    ipcMain.handle('workspaces:get-issuewatch-granularity', (_e, id: string) =>
        getWorkspaceIssuewatchGranularity(id),
    );
    ipcMain.handle(
        'workspaces:set-issuewatch-granularity',
        async (_e, id: string, granularity: IssuewatchGranularity) => {
            setWorkspaceIssuewatchGranularity(id, granularity);
            // Refresh the rail pills immediately — the read paths gate on the live
            // granularity, so a re-broadcast reflects the new setting without a poll.
            await broadcastIssueWatchUpdate().catch(() => {});
            return { ok: true };
        },
    );
    // IssueWatch handler DESIGNATION: which of a workspace's handle-enabled agents
    // are the designated recipients of its pings. The getter returns BOTH the
    // designated id set AND the candidate agents (so the UI renders checkboxes with
    // each agent's live handle/action state); the setter persists the chosen set.
    ipcMain.handle('workspaces:get-issuewatch-handlers', (_e, id: string) => ({
        designated: getWorkspaceIssuewatchHandlers(id),
        agents: listWorkspaceIssuewatchAgents(id),
    }));
    ipcMain.handle(
        'workspaces:set-issuewatch-handlers',
        (_e, id: string, terminalIds: string[]) => {
            setWorkspaceIssuewatchHandlers(id, Array.isArray(terminalIds) ? terminalIds : []);
            return { ok: true };
        },
    );

    // --- the container DEV SERVER (#234) -----------------------------------
    // The dev servers GENIE runs — a container in the workspace's sandbox,
    // published to loopback and routed at `<name>.gen`. Since the hosts-file
    // source was retired this is the ONLY thing that makes a `.gen` site exist.
    //
    // TWO channels, not twenty, and each is the MCP tool with the agent's
    // authorization swapped for the window's own workspace. The discovery made
    // the agent the primary administrator and the human UX a secondary viewer
    // over the SAME backend; running literally the same function is how that
    // stays true instead of being a claim two implementations slowly break.
    ipcMain.handle('dev:site', async (_e, workspaceId: string, req: ManageSiteRequest) => {
        const ws = getWorkspace(String(workspaceId));
        if (!ws) return { ok: false, error: 'Unknown workspace.', sites: [] };
        return runManageSite(ws, req ?? { action: 'list' });
    });
    ipcMain.handle('dev:service', async (_e, workspaceId: string, req: ManageServiceRequest) => {
        // `catalog` is answerable with no workspace — it is how the UX shows
        // what could be added before anything has been.
        const ws = (workspaceId ? getWorkspace(String(workspaceId)) : null) ?? null;
        if (!ws && req?.action !== 'catalog') {
            return { ok: false, error: 'Unknown workspace.', services: [] };
        }
        return runManageService(ws, req ?? { action: 'list' });
    });
    // Which runtime is driving, or why none is. A pure probe — the Workstation
    // settings page must never start a download by being looked at.
    ipcMain.handle('dev:runtime-status', () => runtimeInfo());
    // The MACHINE's Dev Server: the container runtime, what the dev base image
    // provides, and every shared service ENGINE — installed, running, and who
    // holds it. Machine-level because a service engine is: one container serves
    // every workspace on the same (engine, major), so no workspace can answer
    // for it. Also a pure read; nothing here pulls or starts anything.
    ipcMain.handle('dev:workstation', () => workstationDevServerInfo());
    // … and the one WRITE that belongs at this level: start / stop / logs for a
    // shared engine. Routed through the service manager so the reference count
    // follows the container rather than being quietly invalidated behind it.
    ipcMain.handle('dev:engine', (_e, req: EngineActionRequest) =>
        workstationEngineAction(req ?? { recordKey: '', action: 'logs' }),
    );
    // First-run toolchain setup (Tynn #240): what dev tools THIS machine has, the
    // package managers it could install with, the plan for what's missing, and the
    // consent object to approve. A PURE probe — inspecting never installs. Local
    // (this machine) because zero-setup runs where Genie runs.
    ipcMain.handle('toolchain:inspect', (_e, pmChoice?: string) =>
        inspectToolchain({
            runner: hostToolCommandRunner,
            os: process.platform,
            arch: process.arch,
            ...(pmChoice ? { pmChoice: pmChoice as never } : {}),
        }),
    );
    // Scan the installed toolchain for available updates (Toolchain Manager,
    // #242). A PURE read — it runs `<pm> outdated` etc. but installs nothing;
    // this machine's tools/engines with their update status.
    // CACHED: a scan shells out to `winget upgrade` / `brew outdated` /
    // `npm outdated -g`, so re-running it every time a settings page opens would
    // make the page feel broken and hammer three package managers for an answer
    // that changes about daily. Not a poll either — nothing runs on a timer; an
    // open (or an explicit Refresh) decides whether THIS moment does the work.
    ipcMain.handle('toolchain:updates', async (_e, force?: boolean) => {
        if (
            !shouldCheckToolchainUpdates({
                lastCheckedAt: toolchainUpdateCache.at,
                now: Date.now(),
                ...(force ? { force: true } : {}),
            })
        ) {
            return toolchainUpdateCache.rows;
        }
        const rows = await detectToolchainUpdates({
            runner: hostToolCommandRunner,
            os: process.platform,
            // Resolve each present tool's binary so its row can say WHO installed
            // it and WHERE — the question the Languages tab already answers and
            // this one could not (genie#213).
            resolvePath: resolveOnPath,
            origin: {
                platform: process.platform,
                home: os.homedir(),
                genieRoot: toolchainRoot(),
            },
        });
        toolchainUpdateCache = { at: Date.now(), rows };
        return rows;
    });

    // Run the install plan the wizard reviewed. MAIN re-inspects and runs its OWN
    // plan (never a renderer-supplied one), so a compromised renderer can't ask to
    // run an arbitrary command; the only lever it has is the package-manager
    // choice. Clicking Install in the reviewed wizard IS the consent (approved).
    // Per-tool progress streams back on `toolchain:progress`.
    ipcMain.handle('toolchain:install', async (e, pmChoice?: string) => {
        const ctx = { os: process.platform, arch: process.arch, genieRoot: toolchainRoot() };
        const insp = await inspectToolchain({
            runner: hostToolCommandRunner,
            ...ctx,
            ...(pmChoice ? { pmChoice: pmChoice as never } : {}),
        });
        const perform = createToolchainInstallEffect(ctx, toolchainManagerDeps());
        return runInstallPlan({
            steps: insp.plan,
            ctx,
            perform,
            approved: true,
            present: insp.report.present,
            onProgress: (p) => {
                if (!e.sender.isDestroyed()) e.sender.send('toolchain:progress', p);
            },
        });
    });

    // Update ONE already-installed tool to latest (Toolchain Manager, #242 P2).
    // Same trust model as install: MAIN validates the tool against its OWN
    // toolchain set and builds the command from its OWN tables (planToolUpdate +
    // the adapters) — the renderer's only lever is WHICH known tool, never an
    // arbitrary command line — and re-inspects to pick the package manager. The
    // `update` intent makes a package-manager step an upgrade, not an install.
    // Per-tool progress streams on `toolchain:progress`, same as install.
    ipcMain.handle('toolchain:update', async (e, tool: string, confirmed?: boolean) => {
        if (!(DEFAULT_TOOLCHAIN as readonly string[]).includes(tool)) {
            return { ok: false, results: [], restartRequired: false, skipped: [] };
        }
        // What this would walk into, read at the MOMENT of the click. An update
        // replaces a binary other live things are running on: replacing an agent
        // TUI (or Node) mid-turn fails on Windows and corrupts the turn
        // elsewhere, and a Docker update restarts the engine under running
        // containers. Refuse the first, and make the rest an informed choice.
        const risk = toolchainUpdateRisk(tool as HostToolName, await readToolchainActivity());
        if (risk.risk === 'blocked' || (risk.risk === 'warn' && !confirmed)) {
            return {
                ok: false,
                results: [],
                restartRequired: false,
                skipped: [],
                risk: risk.risk,
                error: risk.reason,
                affected: risk.affected,
            };
        }
        const ctx = { os: process.platform, arch: process.arch, genieRoot: toolchainRoot() };
        const insp = await inspectToolchain({ runner: hostToolCommandRunner, ...ctx });
        const perform = createToolchainInstallEffect(ctx, toolchainManagerDeps());
        const result = await runInstallPlan({
            steps: [planToolUpdate(tool as HostToolName, ctx.os, insp.pmChoice)],
            ctx,
            perform,
            approved: true,
            present: insp.report.present,
            // Install what is absent, update what is here — the page offers both
            // actions now, and they are not the same command (genie#212).
            intent: installIntentFor(tool as HostToolName, insp.report.present),
            onProgress: (p) => {
                if (!e.sender.isDestroyed()) e.sender.send('toolchain:progress', p);
            },
        });
        // The machine just changed, so the cached scan is now a lie — drop it so
        // the next read reports the version we actually installed.
        toolchainUpdateCache = { at: null, rows: [] };
        return result;
    });

    // --- the Toolchain page: multi-version languages ------------------------
    //
    // Genie OWNS its toolchain. It DETECTS what other installers (Herd, XAMPP,
    // nvm, a system package) put on the machine — so the machine is legible —
    // but it INSTALLS every language, and its config, under
    // `<userData>/toolchain/<lang>/<version>`, and only those are selectable.
    // A borrowed toolchain is one another app can upgrade or reconfigure
    // underneath a running site.
    //
    // The read is PURE: it lists directories and, only where a directory name
    // cannot name its version, runs `--version`. Opening the page never
    // downloads anything.
    // CACHED, like the update scan above and for the same reason: a scan spawns a
    // `where`/`which` per language and walks Genie's install directories, and
    // `devServerChanged` fires on every site start and stop. Not a poll — an open
    // (or an explicit Check again, which passes `force`) decides whether THIS
    // moment does the work. Every write drops the cache.
    // REPAIR (owner report): Herd was uninstalled and left its binaries AND its
    // PATH entry behind, so `php` resolved to a shim for an install that no
    // longer existed while Genie's own toolchain sat unused — and every terminal,
    // agent and dev server Genie spawned inherited it. Reorders Genie's own entry
    // to the FRONT and reports what it found. It never deletes another tool's
    // entry: those belong to software Genie did not install.
    // --- ArtBoard ---------------------------------------------------------
    // The review surface an agent posts a mockup or an image to. Reading resolves
    // each post's FILE into markup or a data URL host-side, so the renderer never
    // holds a path; reviewing records the verdict AND hands it to the agent that
    // is waiting on it.
    ipcMain.handle('artboard:read', (_e, workspaceId: string) =>
        readBoardForPanel(String(workspaceId ?? ''), artboardDeps()),
    );
    ipcMain.handle(
        'artboard:review',
        (_e, workspaceId: string, postId: string, review: { verdict: 'approved' | 'rejected'; comment?: string }) =>
            reviewBoardPost(
                String(workspaceId ?? ''),
                String(postId ?? ''),
                {
                    // Anything that is not an explicit approval is a rejection —
                    // a malformed verdict must never resolve to "approved".
                    verdict: review?.verdict === 'approved' ? 'approved' : 'rejected',
                    ...(typeof review?.comment === 'string' && review.comment.trim()
                        ? { comment: review.comment.trim() }
                        : {}),
                },
                artboardDeps(),
            ),
    );

    ipcMain.handle('toolchain:repair', async () => repairToolchainPath(toolchainManagerDeps()));

    ipcMain.handle('toolchain:installs', (_e, force?: boolean) =>
        toolchainInstallsInfo(toolchainManagerDeps(), force ? { force: true } : {}),
    );

    // Point the machine at a different version. Main re-scans and accepts only a
    // GENIE-managed install that exists right now — the renderer's lever is
    // WHICH known version, never a path. The write is a TARGETED settings patch
    // (`toolchain_defaults` is in RUNTIME_OWNED_SETTINGS_KEYS) so the Settings
    // form's whole-object Save cannot carry a stale default back over it.
    ipcMain.handle('toolchain:set-default', async (_e, tool: string, version: string) => {
        if (!isLanguageTool(tool)) return { ok: false, error: `Unknown language ${tool}.` };
        const res = await setToolchainDefault(toolchainManagerDeps(), tool, String(version));
        // The managed dirs just changed, so PATH and the cache both point at a
        // version that may no longer be the default. Re-apply before anything
        // else spawns.
        if (res.ok) await applyStartupToolchainPrecedence();
        if (res.ok) broadcastDevServerChanged();
        return res;
    });

    // Install one version. The version must be one THIS RELEASE has a recipe for
    // (see TOOLCHAIN_RECIPES) — there is no free-text version, so a renderer
    // cannot name an arbitrary download.
    ipcMain.handle('toolchain:add-version', async (_e, tool: string, version: string) => {
        if (!isLanguageTool(tool)) return { ok: false, error: `Unknown language ${tool}.` };
        const res = await addToolchainVersion(toolchainManagerDeps(), tool, String(version));
        // The managed dirs just changed, so PATH and the cache both point at a
        // version that may no longer be the default. Re-apply before anything
        // else spawns.
        if (res.ok) await applyStartupToolchainPrecedence();
        if (res.ok) broadcastDevServerChanged();
        return res;
    });

    // Delete a version Genie installed. Refused for anything Genie does not own
    // — deleting Herd's php would be Genie breaking another app's install.
    ipcMain.handle('toolchain:remove-version', async (_e, tool: string, version: string) => {
        if (!isLanguageTool(tool)) return { ok: false, error: `Unknown language ${tool}.` };
        const res = await removeToolchainVersion(toolchainManagerDeps(), tool, String(version));
        // The managed dirs just changed, so PATH and the cache both point at a
        // version that may no longer be the default. Re-apply before anything
        // else spawns.
        if (res.ok) await applyStartupToolchainPrecedence();
        if (res.ok) broadcastDevServerChanged();
        return res;
    });

    // The repos a site can be created against, so the picker offers them rather
    // than asking a user to type a subfolder name that has to match exactly.
    ipcMain.handle('dev:repos', (_e, workspaceId: string) => {
        const ws = getWorkspace(String(workspaceId));
        if (!ws?.path) return [];
        try {
            return detectFolder(ws.path).repos ?? [];
        } catch {
            return [];
        }
    });


    // `sites:all` — the header `.gen` popover's data, CONTEXTUAL to the window it
    // was asked from: a LOCAL Genie window lists THIS machine's `.gen` sites; a
    // HOST window (driving a remote Genie) lists THAT host's. Never a mix — the
    // globe always shows the sites of the machine the window represents. Only
    // sites a Dev Server is actually SERVING appear, so the globe can never
    // offer a name that resolves nowhere.
    ipcMain.handle('sites:all', async (e) => {
        const connKey = connKeyForWindow(e.sender.id);
        try {
            const sites = connKey
                ? await remoteListEnabledGenSites(connKey)
                : await listLocalEnabledGenSites();
            return {
                local: sites.map((s) => ({ genName: s.genName, hostname: s.hostname })),
                hosts: [],
            };
        } catch {
            return { local: [], hosts: [] };
        }
    });

    // Open a `.gen` site in the Testing Browser (full chrome — URL bar / back /
    // forward / reload / device presets), CONTEXTUAL to the calling window: a
    // HOST window opens the site on THAT host over the tunnel; a local window
    // opens it against this machine's loopback dial.
    ipcMain.handle('sites:open', (e, genName: string) => {
        const off = genieBrowserDisabled();
        if (off) return off;
        const connKey = connKeyForWindow(e.sender.id);
        if (connKey) {
            const host = listKnownHosts().find((h) => h.connKey === connKey);
            return openTestingBrowser(
                connKey,
                host?.name || host?.hostname || 'host',
                remoteGenUrl(String(genName)),
            );
        }
        return openTestingBrowser(LOCAL_CONN_KEY, 'This machine', remoteGenUrl(String(genName)));
    });

    // --- Agent MCP server status / restart (Settings → Agent MCP) -------
    ipcMain.handle('mcp:status', () => mcpServerState());
    // Server-push (SSE GET stream) measurement — did a real client open the
    // stream, echo a session id, and receive a push. See serverPushDiagnostics.
    ipcMain.handle('mcp:push-status', () => serverPushDiagnostics());
    ipcMain.handle('mcp:restart', async () => {
        await restartMcpServer();
        // Rewrite enabled workspaces' configs so their .mcp.json picks up the
        // (possibly new) port — endpoint tokens are stable across the rebind.
        for (const ws of listWorkspaces()) {
            if (ws.mcp_enabled) {
                writeWorkspaceAgentMcp(ws.path, true, workspaceEndpointUrl(ws.id));
            }
        }
        return mcpServerState();
    });

    // --- Workspace doc health + repair (Settings → Agent MCP) -----------
    ipcMain.handle('mcp:doc-health', (_e, id: string) => {
        const ws = getWorkspace(id);
        if (!ws) return null;
        return workspaceDocHealth(ws.path);
    });
    ipcMain.handle('mcp:repair-docs', (_e, id: string) => {
        const ws = getWorkspace(id);
        if (!ws) return null;
        return repairWorkspaceDocs(ws.path, ws.project_name, ws.project_name);
    });

    // --- Mobile remote-control server (Settings → Mobile) ---------------
    // The desktop-only namespace. The phone NEVER touches these — it talks to
    // the tailnet HTTP/WS server directly. `status` bundles the live server
    // state + the current PIN + a QR data-URL (of the phone URL with the PIN
    // pre-filled) so Settings can show the big PIN + a scannable code.
    const mobileStatus = async (): Promise<
        MobileServerState & {
            pin: string;
            qrDataUrl: string | null;
            needsFirewallRule: boolean;
        }
    > => {
        const state = mobileServerState();
        const pin = currentPin();
        // Encode the pairing URL (host + ?pair=<pin>) into a QR data-URL, but
        // only when the server is actually reachable (running with a URL).
        let qrDataUrl: string | null = null;
        if (state.url) {
            try {
                const pairUrl = `${state.url}?pair=${pin}`;
                qrDataUrl = await QRCode.toDataURL(pairUrl, { margin: 1, width: 240 });
            } catch {
                qrDataUrl = null;
            }
        }
        // Windows only: the server binds to the tailnet IP, but Windows blocks
        // inbound by default — so a paired phone can't connect until an allow-rule
        // for the LIVE port exists. Surface whether it's still missing so Settings
        // can offer the one-click fix. Best-effort: never block/throw the status.
        let needsFirewallRule = false;
        if (process.platform === 'win32' && state.running && state.port) {
            try {
                needsFirewallRule = !(await firewallRuleExists(state.port));
            } catch {
                needsFirewallRule = false;
            }
        }
        return { ...state, pin, qrDataUrl, needsFirewallRule };
    };
    ipcMain.handle('mobile:status', () => mobileStatus());
    ipcMain.handle('mobile:restart', async (_e, enabled?: boolean) => {
        // The Settings toggle persists `mobile_enabled` then calls restart; pass
        // the live flag through so the server reflects the new state.
        if (typeof enabled === 'boolean') setMobileEnabled(enabled);
        await restartMobileServer();
        return mobileStatus();
    });
    ipcMain.handle('remote:set-enabled', async (_e, enabled?: boolean) => {
        // Settings → Genie Remote persists `remote_enabled` then calls this. Toggling
        // desktop remote binds/unbinds the SAME host server (independent of the phone
        // UI), so it goes through the same restart path.
        if (typeof enabled === 'boolean') setRemoteEnabled(enabled);
        await restartMobileServer();
        return mobileStatus();
    });
    ipcMain.handle('mobile:regenerate-pin', async () => {
        regeneratePin();
        return mobileStatus();
    });
    // Windows only: add the inbound firewall allow-rule for the LIVE mobile port
    // via a single UAC prompt (delete-then-add, idempotent + migrates a changed
    // port). Returns the elevation result + fresh status so the panel re-checks
    // needsFirewallRule and hides the prompt on success.
    ipcMain.handle('mobile:allow-firewall', async () => {
        const state = mobileServerState();
        // The live bound port (falls back to the configured port if not yet bound).
        const port = state.port ?? state.configuredPort;
        const result = await ensureFirewallRule(port);
        return { ...result, ...(await mobileStatus()) };
    });
    ipcMain.handle('mobile:revoke-sessions', async () => {
        const n = revokeAllSessions();
        return { revoked: n, ...(await mobileStatus()) };
    });
    // The host-side roster of paired devices (NON-secret fields only — the bearer
    // token never leaves main). Drives the Settings → Devices page.
    ipcMain.handle('mobile:sessions', () =>
        listSessions().map((s) => ({
            id: s.id,
            label: s.label,
            ip: s.ip,
            createdAt: s.createdAt,
        })),
    );
    ipcMain.handle('mobile:revoke-session', async (_e, id: string) => {
        const ok = revokeSession(id);
        return { ok, ...(await mobileStatus()) };
    });
    ipcMain.handle('mobile:lock', async (_e, locked: boolean) => {
        setLocked(!!locked);
        return mobileStatus();
    });
    // Hand the baton from the desktop to a connected user — the "give" half of the
    // control model (the desktop is an owner, so it may also just TAKE it back via
    // mobile:lock). Refused unless the desktop currently holds control.
    ipcMain.handle('mobile:give-control', async (_e, principalId: string) => {
        const d = requestControl({
            kind: 'give',
            from: DESKTOP_PRINCIPAL,
            to: String(principalId ?? ''),
        });
        return { ok: d.allowed, error: d.reason, ...(await mobileStatus()) };
    });

    // Work Mode — Tailscale lifecycle management (status / bring online / install).
    ipcMain.handle('tailscale:status', () => getTailscaleStatus());
    ipcMain.handle('tailscale:up', () => tailscaleUp());
    ipcMain.handle('tailscale:open-auth', async (_e, url: string) => {
        // Only ever open Tailscale's own login URLs.
        if (typeof url === 'string' && /^https:\/\/login\.tailscale\.com\//.test(url)) {
            await shell.openExternal(url);
            return { ok: true };
        }
        return { ok: false };
    });
    ipcMain.handle('tailscale:install', async () => {
        const r = await installTailscale();
        // Non-Windows / fallback hands back a URL — open it for the user.
        if (r.url) await shell.openExternal(r.url);
        return r;
    });

    // Work Mode — remote: discover Genie hosts on the tailnet, and open a remote
    // session window driving a chosen host's /m/ surface over Tailscale.
    ipcMain.handle('workmode:discover-hosts', () => discoverHosts());
    ipcMain.handle(
        'workmode:open-remote',
        (_e, host: { ip: string; port: number; hostname: string }) =>
            openRemoteWindow(host),
    );

    // Work Mode — remote desktop. The renderer's remote bridge maps every desktop
    // call onto remote:request; the local main holds the token and routes to the
    // host over the tailnet. Pairing + opening a host go through host:open (which
    // calls connectRemote then binds a window) — there is no standalone
    // remote:connect, which would have created an orphan unbound connection.
    // Disconnect the connection THIS window drives (others stay live).
    ipcMain.handle('remote:disconnect', (e) => {
        disconnectRemote(e.sender.id);
        return { ok: true };
    });
    // Per-window status + binding — every handler routes by the CALLING window.
    ipcMain.handle('remote:status', (e) => remoteStatusFor(e.sender.id));
    ipcMain.handle('remote:my-binding', (e) => remoteBindingFor(e.sender.id));
    // Link health (version match + upgrade/limbo): read on mount + push via
    // `remote:link`. "Upgrade host" triggers the host's updater over the bridge.
    ipcMain.handle('remote:link-state', (e) => remoteLinkStateFor(e.sender.id));
    // Control state (who holds WRITE control): read on mount + pushed live via
    // `remote:control`. Drives the host window's view-only banner + input gate.
    ipcMain.handle('remote:control-state', (e) => remoteControlStateFor(e.sender.id));

    ipcMain.handle('remote:upgrade-host', (e) => remoteUpgradeHost(e.sender.id));
    ipcMain.handle('remote:reconnect', (e) => remoteReconnect(e.sender.id));
    ipcMain.handle(
        'remote:request',
        (e, path: string, init?: { method?: string; json?: unknown }) =>
            remoteRequest(e.sender.id, path, init),
    );
    // Terminal I/O bridge: the renderer's XTerm attaches to a host terminal's pty
    // (main re-emits terminal:data/exit to THIS window) and forwards keystrokes/
    // resize to it.
    ipcMain.handle(
        'remote:terminal-attach',
        (e, id: string, workspaceId?: string, cols?: number, rows?: number) => {
            remoteAttachTerminal(e.sender.id, id, workspaceId, cols, rows);
            return { ok: true };
        },
    );
    ipcMain.handle('remote:terminal-input', (e, id: string, data: string) => {
        remoteTerminalInput(e.sender.id, id, data);
        return true;
    });
    ipcMain.handle(
        'remote:terminal-resize',
        (e, id: string, cols: number, rows: number) => {
            remoteTerminalResize(e.sender.id, id, cols, rows);
            return true;
        },
    );
    ipcMain.handle('remote:terminal-detach', (e, id: string) => {
        remoteDetachTerminal(e.sender.id, id);
        return { ok: true };
    });

    // Hosts picker (local window): connect a host (handling the PIN) and open its
    // OWN native Floor window, plus the persisted known-hosts list management. The
    // local window stays local throughout — only the new host window is remote.
    ipcMain.handle(
        'host:open',
        async (_e, host: RemoteHost, pin?: string) => {
            const res = await connectRemote(host, pin);
            if (res.ok && res.connKey) showHostWindow(host, res.connKey);
            return res;
        },
    );
    ipcMain.handle('host:known', () => listKnownHosts());
    ipcMain.handle('host:forget', (_e, connKey: string) => {
        forgetHost(connKey);
        return { ok: true };
    });
    ipcMain.handle('host:rename', (_e, connKey: string, name: string) => {
        renameKnownHost(connKey, name);
        return { ok: true };
    });

    // Serve-local-sites (Phase D): the Testing Browser. `open` spins up a
    // per-connection session + shim + Genie CA and shows the browser window for an
    // already-connected host; the rest are the chrome's navigation/layout drivers,
    // each resolved by the CALLING chrome window (e.sender.id) → its instance.
    ipcMain.handle('testing-browser:open', (_e, connKey: string, hostname: string) => {
        const off = genieBrowserDisabled();
        return off ?? openTestingBrowser(connKey, hostname);
    });
    ipcMain.handle('testing-browser:state', (e) => testingBrowserState(e.sender.id));
    ipcMain.handle('testing-browser:navigate', (e, input: string) =>
        testingBrowserNavigate(e.sender.id, input),
    );
    ipcMain.handle('testing-browser:back', (e) => {
        testingBrowserBack(e.sender.id);
        return { ok: true };
    });
    ipcMain.handle('testing-browser:forward', (e) => {
        testingBrowserForward(e.sender.id);
        return { ok: true };
    });
    ipcMain.handle('testing-browser:reload', (e) => {
        testingBrowserReload(e.sender.id);
        return { ok: true };
    });
    ipcMain.handle('testing-browser:new-tab', (e, input?: string) =>
        testingBrowserNewTab(e.sender.id, input),
    );
    ipcMain.handle('testing-browser:close-tab', (e, tabId: string) => {
        testingBrowserCloseTab(e.sender.id, tabId);
        return { ok: true };
    });
    ipcMain.handle('testing-browser:activate-tab', (e, tabId: string) => {
        testingBrowserActivateTab(e.sender.id, tabId);
        return { ok: true };
    });
    ipcMain.handle(
        'testing-browser:set-bounds',
        (e, bounds: { x: number; y: number; width: number; height: number }) => {
            testingBrowserSetBounds(e.sender.id, bounds);
            return { ok: true };
        },
    );
    ipcMain.handle('testing-browser:set-viewport', (e, presetId: string) => {
        testingBrowserSetViewport(e.sender.id, presetId);
        return { ok: true };
    });
    ipcMain.handle('testing-browser:refresh-sites', (e) => testingBrowserRefreshSites(e.sender.id));

    // Virtual Workstations (relay transport): the member's entitled-workstations
    // list for the Hosts picker, and opening one — mint a connect grant from Tynn,
    // dial the relay member session, and open its OWN native Floor window. The
    // grant + relay endpoint never reach the renderer; main holds them and runs
    // the heartbeat for the connection's lifetime.
    ipcMain.handle('workstation:connectable', async () =>
        visibleConnectableWorkstations(
            await getTynnBackend().listConnectableWorkstations(),
            readWorkstationIdentity()?.workstationId,
        ),
    );
    ipcMain.handle('workstation:open', async (_e, workstationId: string, name: string) =>
        openWorkstationById(workstationId, name),
    );

    ipcMain.handle('workspaces:open', async (_e, id: string) => {
        await openWorkspace(id);
        // Open = bring it into Genie's own UI: surface the master window so the
        // user lands on the now-active workspace + its in-app editor.
        showMainWindow();
        return { ok: true };
    });
    // The repo subfolders under a workspace's envelope (names only). Used by the
    // Add Process UX so a background process can target a specific repo's cwd
    // (e.g. repos/tynn) instead of the envelope root.
    ipcMain.handle('workspaces:repos', (_e, id: string): string[] => {
        const ws = getWorkspace(id);
        if (!ws) return [];
        try {
            return detectFolder(ws.path).repos ?? [];
        } catch {
            return [];
        }
    });

    // --- AGI envelope ---------------------------------------------------
    ipcMain.handle('agi:detect', (_e, folder: string) => detectFolder(folder));
    ipcMain.handle('agi:create', async (_e, opts: CreateAgiOpts) => {
        return createAgiEnvelope(opts);
    });
    ipcMain.handle('agi:import', async (_e, folder: string) => {
        return detectFolder(folder);
    });
    ipcMain.handle('agi:convert', async (_e, opts: ConvertToAgiOpts) => {
        return convertToAgi(opts);
    });
    ipcMain.handle('agi:analyse', async (_e, root: string) => {
        return analyseFolder(root);
    });
    ipcMain.handle('agi:convert-plan', async (_e, opts: ConvertPlanOpts) => {
        return convertToAgiPlan(opts);
    });
    ipcMain.handle(
        'agi:push',
        async (_e, envelopePath: string, branch?: string) => {
            const { pushEnvelopeToOrigin } = await import('./workspace/create-agi');
            await pushEnvelopeToOrigin(envelopePath, branch ?? 'main');
            return { ok: true };
        },
    );
    ipcMain.handle('agi:doc-status', async (_e, envelopePath: string) => {
        const { structureDocStatus } = await import('./workspace/create-agi');
        return structureDocStatus(envelopePath);
    });
    ipcMain.handle(
        'agi:add-docs',
        async (_e, envelopePath: string, name: string, slug: string) => {
            const { addStructureDocs } = await import('./workspace/create-agi');
            return addStructureDocs(envelopePath, name, slug);
        },
    );
    ipcMain.handle('agi:mcp-status', async (_e, envelopePath: string) => {
        const { mcpStatus } = await import('./workspace/mcp');
        return mcpStatus(envelopePath);
    });
    ipcMain.handle('agi:consolidate-mcp', async (_e, envelopePath: string) => {
        const { consolidateMcpAndCommit } = await import('./workspace/create-agi');
        return consolidateMcpAndCommit(envelopePath);
    });

    // --- Envelope repo + knowledge management (workspace settings window) ----
    // Read the envelope's member repos (project.json registry ∪ on-disk
    // submodules), add a repo (submodule add + register), remove one (deinit +
    // rm + unregister). All no-ops / { isEnvelope:false } for plain folders.
    ipcMain.handle('agi:repos-list', (_e, workspacePath: string) =>
        listEnvelopeRepos(workspacePath),
    );
    ipcMain.handle(
        'agi:repo-add',
        (_e, workspacePath: string, url: string, name: string) =>
            addEnvelopeRepo(workspacePath, url, name),
    );
    ipcMain.handle('agi:repo-remove', (_e, workspacePath: string, name: string) =>
        removeEnvelopeRepo(workspacePath, name),
    );
    // The envelope's `.ai/` knowledge folders + a scaffold for a missing one.
    ipcMain.handle('agi:knowledge-list', (_e, workspacePath: string) =>
        listKnowledgeFolders(workspacePath),
    );
    ipcMain.handle(
        'agi:knowledge-create',
        (_e, workspacePath: string, name: string) =>
            createKnowledgeFolder(workspacePath, name),
    );

    // --- Terminal specs (persistent definitions, NOT live ptys) ---------
    ipcMain.handle('terminal-spec:list', (): TerminalSpecRow[] => listTerminalSpecs());
    ipcMain.handle(
        'terminal-spec:create',
        (_e, input: Parameters<typeof createTerminalSpec>[0]) => {
            const row = createTerminalSpec(input);
            // A spec created here is created BY THE HUMAN, so a schedule on it is
            // approved by definition (the agent path gates in host-tools.ts).
            armSchedule(row.id);
            return row;
        },
    );
    ipcMain.handle(
        'terminal-spec:update',
        (_e, id: string, patch: Record<string, unknown>) => {
            const row = updateTerminalSpec(
                id,
                patch as Parameters<typeof updateTerminalSpec>[1],
            );
            // Re-arm from the CURRENT spec after any edit: a changed expression
            // retargets the timer, and a removed schedule / disabled task disarms
            // (armSchedule disarms whatever is no longer armable).
            armSchedule(id);
            return row;
        },
    );
    ipcMain.handle('terminal-spec:delete', (_e, id: string) => {
        // If it's a running Process, stop + forget it before dropping the spec.
        const spec = getTerminalSpec(id);
        if (spec?.type === 'process') {
            stopProcess(id);
            forgetProcess(id);
            forgetSchedule(id);
        }
        return deleteTerminalSpec(id);
    });
    ipcMain.handle('terminal-spec:get', (_e, id: string) => getTerminalSpec(id));
    ipcMain.handle('terminal-spec:touch', (_e, id: string) => {
        touchTerminalSpec(id);
        return { ok: true };
    });
    // Grid drag-reorder — the full ordered spec-id list for one workspace.
    // Broadcast so any OTHER window showing the same workspace (a Stage window)
    // re-lists and picks up the new order instead of holding a stale one.
    ipcMain.handle('terminal-spec:reorder', (_e, ids: string[]) => {
        reorderTerminalSpecs(ids);
        broadcastTerminalSpecsChanged();
        return { ok: true };
    });

    // --- Specialized Terminals + AgentInbox ----------------------------
    // Create an AI-TUI terminal FROM THE UI (the split Add-Terminal button) via
    // the SHARED create-agent path — resolve the agent's CLI command, spawn a
    // headless agent terminal (stamping its captured chat-session id + AgentInbox
    // identity/accessibility, joining the broker), and launch it. No approval gate
    // — the human is creating it directly. The same helper backs the host endpoint
    // (POST /api/desktop/terminal-spec/create-agent) so a REMOTE host window
    // creates specialized terminals identically.
    ipcMain.handle(
        'terminal-spec:create-agent',
        (
            _e,
            input: {
                workspace_id: string;
                agent: 'claude' | 'codex' | 'custom';
                command?: string;
                cwd?: string;
                label?: string;
                purpose: string;
                scope: AgentInboxScope;
                scope_workspaces?: string[];
                wake_on_dm?: boolean;
                issuewatch_handle?: boolean;
                issuewatch_action?: 'notify' | 'wake';
            },
        ) => createSpecializedAgentTerminal(input),
    );

    // Gracefully restart an agent terminal so its TUI reconnects to the current
    // MCP rig (fresh tools/protocol) WITHOUT losing the conversation — resume the
    // captured session, or refuse when it isn't resumable. Delegates to the same
    // engine the `runAgent restart` MCP action uses.
    ipcMain.handle('terminal-spec:restart-agent', (_e, id: string) => restartAgentTerminal(id));

    // The human AgentInbox panel: read the agent directory, channel list, and a
    // channel / human↔agent DM history; post as the human; and edit an agent's
    // accessibility (re-keys its channel + re-emits presence). The live push
    // (agentInbox:presence / agentInbox:message) rides the broker's presence emitter.
    // AgentPulse — the last-60s per-workspace byte buckets, fetched once when the
    // workspace menu opens to backfill each sparkline; live `agent-pulse` pushes
    // advance it from there.
    ipcMain.handle('agent-pulse:snapshot', () => ({ pulses: agentPulse.snapshot() }));

    ipcMain.handle('agentinbox:directory', () => ({ agents: agentInboxBroker.directory() }));
    ipcMain.handle('agentinbox:channels', () => ({ channels: agentInboxBroker.channels() }));
    // Every DM thread (human↔agent AND agent↔agent) so the panel can view the
    // agent-to-agent conversations that fire the unread badge but were unviewable.
    ipcMain.handle('agentinbox:dm-threads', () => ({ threads: agentInboxBroker.dmThreads() }));
    ipcMain.handle(
        'agentinbox:history',
        (
            _e,
            opts: {
                channelKey?: string;
                agentId?: string;
                dmPair?: [string, string];
                limit?: number;
                before?: number;
            },
        ) => ({ messages: agentInboxBroker.history(opts ?? {}) }),
    );
    ipcMain.handle(
        'agentinbox:post',
        async (
            _e,
            input: {
                channelKey?: string;
                toAgentId?: string;
                text: string;
                attachments?: HumanInboxAttachment[];
            },
        ) => postAsHuman(input),
    );
    ipcMain.handle('agentinbox:send-pending-nudge', (_e, terminalId: string) =>
        agentInboxBroker.sendPendingNudge(String(terminalId)),
    );
    // Hand an attachment's BYTES back to the panel so the human can download it.
    // Genie reads its OWN blob store here — no filesystem egress — and the client
    // saves the file, so a human on a remote window gets it on THEIR machine.
    ipcMain.handle('agentinbox:attachment-bytes', (_e, id: string) =>
        readHumanAttachment(String(id ?? '')),
    );
    // genie #64 — AGENT-LAG: how far behind the agents are on their inboxes. Seeds
    // the header badge on mount; the live `agentinbox:lag` push keeps it current.
    ipcMain.handle('agentinbox:lag', () => ({ count: agentInboxBroker.agentLagCount() }));
    // genie #64 — WIPE a conversation. A HOST op: the durable log lives in
    // genie.db, so the broker clears its in-memory panel log AND the store rows
    // and pushes `agentinbox:cleared` to every open window. Agent inboxes and ACK
    // cursors are deliberately untouched (see the broker's doc comments).
    ipcMain.handle('agentinbox:clear-channel', (_e, channelKey: string) =>
        agentInboxBroker.clearChannel(channelKey),
    );
    ipcMain.handle('agentinbox:delete-thread', (_e, pairKey: string) =>
        agentInboxBroker.deleteThread(pairKey),
    );
    // genie #66 — MASS delete: one call for a whole multi-select, so the panel
    // doesn't fire N round trips (N relay requests on a remote Host).
    ipcMain.handle(
        'agentinbox:wipe-many',
        (_e, input: { channelKeys?: string[]; pairKeys?: string[] }) =>
            agentInboxBroker.wipeMany(input ?? {}),
    );
    ipcMain.handle(
        'agentinbox:update-channel',
        (
            _e,
            specId: string,
            patch: {
                purpose?: string;
                scope?: AgentInboxScope;
                scope_workspaces?: string[];
                wake_on_dm?: boolean;
                issuewatch_handle?: boolean;
                issuewatch_action?: 'notify' | 'wake';
            },
        ) => updateAgentInboxChannel(specId, patch),
    );

    // --- PendingQuestions inbox (top-bar question icon) ------------------
    // The master window's question inbox reads the grouped pending list (modal
    // queue + DND-deferred) and answers any of them; `answerPendingQuestion`
    // routes a modal-queue answer to the blocked agent and clears a deferred one.
    // Every change pushes `questions:changed` so the badge + panel refresh live
    // (event-driven, never polled).
    ipcMain.handle('questions:list', () => {
        const pending = listPendingQuestions();
        return { groups: groupPendingByWorkspace(pending), count: pendingCount(pending) };
    });
    ipcMain.handle('questions:answer', (_e, id: string, answers: ForceAnswer[]) =>
        answerPendingQuestion(id, answers ?? []),
    );
    onQuestionsChanged(() => {
        // Carry the count so the badge updates push-style (fetch-free, like the
        // AgentInbox). broadcastLocal SKIPS host-bound windows — those get the
        // HOST's count via mobileEmit + PASSTHROUGH, so a client's local 0 never
        // clobbers it (genie #60).
        const pending = listPendingQuestions();
        broadcastLocal('questions:changed', {
            count: pendingCount(pending),
            workspaces: groupPendingByWorkspace(pending).length,
        });
    });

    // --- Knowledge Graph (workstation-wide local memory store) -----------
    // The renderer Knowledge Graph window reads/writes the shared store here;
    // window CRUD stamps source 'user' (an agent's MCP writes stamp 'agent').
    // Mutations broadcast `knowledge:changed` (via the store's emitter) so a live
    // window re-fetches — incl. nodes an agent added over MCP. openWindow
    // create-or-focuses the singleton Genie-skinned window.
    ipcMain.handle(
        'knowledge:search',
        (_e, query: string, opts?: { limit?: number; tags?: string[] }) =>
            getKnowledgeStore().search({
                query: String(query ?? ''),
                limit: opts?.limit,
                tags: opts?.tags,
            }),
    );
    ipcMain.handle('knowledge:list', (_e, opts?: { tag?: string; limit?: number }) =>
        getKnowledgeStore().list(opts ?? {}),
    );
    ipcMain.handle('knowledge:get', (_e, id: string) => getKnowledgeStore().get(id));
    ipcMain.handle(
        'knowledge:add',
        (
            _e,
            input: { title: string; body?: string; tags?: string[]; links?: string[] },
        ) =>
            getKnowledgeStore().add({
                title: input?.title ?? '',
                body: input?.body,
                tags: input?.tags,
                links: input?.links,
                source: 'user',
            }),
    );
    ipcMain.handle(
        'knowledge:update',
        (
            _e,
            id: string,
            patch: { title?: string; body?: string; tags?: string[]; links?: string[] },
        ) => getKnowledgeStore().update(id, patch ?? {}),
    );
    ipcMain.handle('knowledge:delete', (_e, id: string) => getKnowledgeStore().delete(id));
    ipcMain.handle('knowledge:graph', () => getKnowledgeStore().graph());
    ipcMain.handle('knowledge:open-window', () => {
        showKnowledgeWindow();
        return { ok: true };
    });

    // --- Backend projects (fans out across signed-in backends) ----------
    /**
     * The project list, and the one place Genie learns that a project became (or
     * stopped being) a Genie App.
     *
     * `is_gapp` rides the project row and nothing else carries it — not the
     * agent-token mint, not a push channel — so this fetch IS the sync (genie#245).
     * Reconciling here rather than on a timer of its own means every surface that
     * already asks for projects converges the workspaces for free, and a flag
     * flipped in Tynn lands the next time the shell asks — which the master window
     * does on focus, i.e. when the user comes back from the browser they flipped it in.
     */
    ipcMain.handle('tynn:projects', async () => {
        const projects = await listAllProjects();
        // Only when something actually moved: this handler runs on every modal
        // open, and a broadcast that changes nothing still costs every window a
        // workspace re-fetch.
        if (syncGappDevWorkspaces(projects) > 0) broadcastWorkspacesChanged();
        return projects;
    });
    // Project CREATION is Tynn-specific (the Aionima backend has no create
    // API), so these route straight to the Tynn backend rather than fanning
    // out. Used by the Add-workspace "Create new project" form.
    ipcMain.handle('tynn:owner-options', async () =>
        getTynnBackend().ownerOptions(),
    );
    ipcMain.handle(
        'tynn:create-project',
        async (
            _e,
            input: {
                name: string;
                owner_type?: 'user' | 'organization' | 'team';
                owner_id?: string;
                slug?: string;
            },
        ) => getTynnBackend().createProject(input),
    );
    // FEEDBACK about Genie itself (Tynn #249). Separate channel from capture-wish
    // because they land in different places: a wish is work the user WANTS and
    // goes to the backlog; feedback is a report about the tool and goes to Tynn's
    // feedback pipeline to be triaged, quick-accepted or converted.
    ipcMain.handle(
        'tynn:submit-feedback',
        async (
            _e,
            projectId: string,
            message: string,
            meta: Record<string, string> = {},
            backendKind: BackendKind = 'tynn',
        ) => {
            try {
                const backend = backendOfKind(backendKind);
                const result = await backend.submitFeedback(projectId, message, {
                    ...meta,
                    genie_version: app.getVersion(),
                });
                return { ok: true, id: result.id };
            } catch (e) {
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
    );
    ipcMain.handle(
        'tynn:capture-wish',
        async (
            _e,
            projectId: string,
            content: string,
            backendKind: BackendKind = 'tynn',
        ) => {
            const backend = backendOfKind(backendKind);
            return backend.captureWish(projectId, content);
        },
    );
    ipcMain.handle('tynn:inbox', async () => fetchMergedInbox());
    ipcMain.handle(
        'tynn:open-in-browser',
        async (_e, urlOrPath: string, backendKind: BackendKind = 'tynn') => {
            backendOfKind(backendKind).openInBrowser(urlOrPath);
            return { ok: true };
        },
    );

    // --- Tynn auto-provisioning (agent token + Agent MCP config) --------
    // Link a workspace to a Tynn project (writes the secret-free project.json
    // tynn block), check status without minting, or provision/refresh (mint a
    // token + write the workspace .mcp.json tynn server). "Auto on open" is
    // driven by the renderer calling tynn:provision when a workspace opens.
    ipcMain.handle(
        'tynn:link',
        async (_e, workspacePath: string, link: ProjectJsonTynn) => {
            linkWorkspaceTynn(workspacePath, link);
            return { ok: true };
        },
    );
    ipcMain.handle('tynn:provision-status', async (_e, workspacePath: string) =>
        provisionStatus(workspacePath),
    );
    // Clear a workspace's Tynn project link (drops the project.json tynn block).
    ipcMain.handle('tynn:unlink', async (_e, workspacePath: string) => {
        unlinkWorkspaceTynn(workspacePath);
        return { ok: true };
    });
    // Is this workspace's Tynn MCP actually usable, and if not, WHY? Read-only
    // (initialize + tools/list, never a tools/call) — see mcp/tynn-health.ts.
    // Requested on workspace activate and when the user clicks the indicator;
    // the result is ALSO broadcast so every window updates without polling.
    ipcMain.handle(
        'tynn:health',
        async (_e, workspaceId: string, workspacePath: string, workspaceName: string) =>
            tynnHealthService.check({ workspaceId, workspacePath, workspaceName }),
    );
    ipcMain.handle('tynn:health-all', async () => tynnHealthService.all());
    // Push each finished probe at every local window, so a second window on the
    // same workspace shows the same tint without asking (and without polling —
    // health only changes when the config or the server does).
    onTynnHealthResult((health) => broadcastLocal(TYNN_HEALTH_CHANNEL, health));
    ipcMain.handle(
        'tynn:provision',
        async (_e, workspacePath: string, force = false) =>
            provisionWorkspaceTynn(workspacePath, { force }),
    );

    // Ops-project repo auto-management: compute the reconcile plan (read-only),
    // and apply only the user-APPROVED add/remove subset (mutates the envelope).
    ipcMain.handle('tynn:ops-plan', async (_e, workspacePath: string) =>
        computeOpsRepoPlan(workspacePath),
    );
    ipcMain.handle(
        'tynn:ops-apply',
        async (
            _e,
            workspacePath: string,
            approved: { add?: OpsRepoDesired[]; remove?: string[] },
        ) => applyOpsRepoPlan(workspacePath, approved),
    );

    // Ops-project WORKSPACE provisioning: compute which governed child projects
    // lack a local Genie workspace (read-only), and provision the approved ones
    // (clone their *.agi repo + register the workspace). Sibling of the repo
    // reconcile above — the renderer Ops-managed-workspaces panel drives these.
    ipcMain.handle('tynn:ops-provision-plan', async (_e, workspacePath: string) =>
        computeOpsProvisionPlan(workspacePath),
    );
    ipcMain.handle(
        'tynn:ops-provision-apply',
        async (_e, workspacePath: string, targets: OpsProvisionTarget[]) => {
            const result = await applyOpsProvision(workspacePath, targets);
            if (result.provisioned.length > 0) {
                broadcastWorkspacesChanged();
                rebuildMenu();
            }
            return result;
        },
    );

    // The ops-auto-provision-workspaces toggle (Settings → workspace settings).
    // Reads/writes the global k/v setting; the per-workspace panel surfaces it.
    ipcMain.handle('tynn:ops-auto-provision:get', () => ({
        on: getAllSettings().ops_auto_provision_workspaces === 'on',
    }));
    ipcMain.handle('tynn:ops-auto-provision:set', (_e, on: boolean) => {
        setSettings({ ops_auto_provision_workspaces: on ? 'on' : 'off' });
        return { on };
    });

    // --- Open external URLs --------------------------------------------
    // Generic external-open used by terminal web links (and anything else in
    // the renderer that needs the OS browser). The renderer can't reach
    // shell.openExternal directly, so it routes here. Sanitize to http/https
    // as defense-in-depth — the renderer-side WebLinksAddon already filters,
    // but main never trusts a renderer-supplied URL: anything that isn't a
    // plain http(s) URL (file://, javascript:, etc.) is dropped.
    ipcMain.handle('shell:open-external', async (_e, url: string) => {
        if (typeof url !== 'string') return { ok: false };
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return { ok: false };
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { ok: false };
        }
        await shell.openExternal(parsed.toString());
        return { ok: true };
    });

    // --- Backend hosts (renderer footer / sign-in hint) ----------------
    ipcMain.handle('tynn-host:get', () => getTynnBackend().host());
    ipcMain.handle('aionima-host:get', () => getAionimaBackend().host());

    // --- App lifecycle --------------------------------------------------
    ipcMain.handle('app:hide-capture', () => {
        hideCaptureWindow();
        return { ok: true };
    });
    // The user's home directory — the synthetic "System Workspace" roots its
    // terminals/editors here, and the directory picker for system processes
    // defaults to it. Surfaced from main (renderer has no `os` access).
    ipcMain.handle('app:home-dir', () => os.homedir());
    ipcMain.handle('app:show-settings', (e, fromRemote?: boolean) => {
        // fromRemote = the caller is a remote/host window → restrict Settings to the
        // connection-relevant subset. The tray/menu callers pass nothing (local).
        // When the caller is a bound HOST window, inherit ITS connKey so the Settings
        // window's api() bridge reads/writes the HOST's workspace/agent settings
        // (bucket 2) — not this client's. A local caller resolves to null → local.
        const connKey = fromRemote ? connKeyForWindow(e.sender.id) : null;
        showSettingsWindow(!!fromRemote, connKey);
        return { ok: true };
    });
    ipcMain.handle('app:show-docs', () => {
        showDocsWindow();
        return { ok: true };
    });
    ipcMain.handle('app:show-main', () => {
        showMainWindow();
        return { ok: true };
    });
    ipcMain.handle('app:open-stage', (_e, workspaceId?: string) => {
        showStageWindow(workspaceId);
        return { ok: true };
    });
    ipcMain.handle('app:quit', () => {
        (app as any).isQuiting = true;
        app.quit();
        return { ok: true };
    });
    ipcMain.handle('app:signed-in-summary', async () => {
        const list = await signedInBackends();
        return list.map((x) => ({
            backend: x.backend.kind,
            user: x.user,
            host: x.backend.host(),
        }));
    });

    // --- Autostart ("Launch Genie at sign-in") ---------------------------
    ipcMain.handle('app:autostart:get', () => ({
        enabled: getAutostart(),
        supported: isAutostartSupported(),
        platform: process.platform,
    }));
    ipcMain.handle('app:autostart:set', (_e, enabled: boolean) => {
        setAutostart(Boolean(enabled));
        return { enabled: getAutostart() };
    });
}

function broadcast(channel: string, payload: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send(channel, payload);
    }
}

/**
 * The Genie Browser master switch (#232), as a refusal or `null`.
 *
 * Genie's own browser is what makes a `.gen` site openable at all, so it gets a
 * workstation-level switch on the Hosting Manager settings page — some owners want the
 * embedded browser off entirely. Default ON: this only ever refuses when the
 * user has explicitly turned it off, and it refuses with a REASON, so the click
 * doesn't read as Genie being broken.
 */
function genieBrowserDisabled(): { ok: false; error: string } | null {
    if (getAllSettings().genie_browser_enabled === 'off') {
        return {
            ok: false,
            error: 'The Genie Browser is turned off — enable it in Settings → Hosting Manager.',
        };
    }
    return null;
}

/**
 * Push a `dev-server:changed` event so every window's rail + Site Manager
 * re-read `dev:site` / `dev:service` (#234).
 *
 * PUSH, never a poll: a site's state changes at exactly three moments — a
 * config edit, a start/stop, and boot adoption — and each of them calls this. A
 * window that opened the Site Manager in another workspace still needs it,
 * because the rail icon is workspace-wide.
 *
 * Two audiences, like `workspaces:changed`: `broadcastLocal` fans to THIS client's
 * own windows but SKIPS its host windows (a local site starting must not repaint a
 * window that is driving another machine), while `mobileEmit` fans over `/ws/events`
 * to REMOTE clients driving THIS host — so their Site Manager + rail re-read the
 * HOST's sites (the client re-emits it via PASSTHROUGH_EVENTS onto the same local
 * channel). No-op when nothing is connected.
 */
export function broadcastDevServerChanged(): void {
    broadcastLocal('dev-server:changed');
    mobileEmit('dev-server:changed');
}

/**
 * Push one live START tick (Gap 2) so an open Site Manager card reflects a site
 * coming up — `pulling → building → starting → ready|failed`, with the build log
 * streaming — instead of a disabled button until the whole build finishes.
 *
 * Two audiences, exactly like {@link broadcastDevServerChanged}: `broadcastLocal`
 * reaches THIS client's own windows (skipping its host windows), and `mobileEmit`
 * streams the tick over `/ws/events` to REMOTE clients driving THIS host, so a
 * remote Site Manager card animates `pulling → building → starting → ready|failed`
 * with the live build log instead of a dead disabled button (the payload carries
 * the HOST's `workspaceId`, which the remote panel matches its own row against).
 * High-frequency (a chunk per log line), which is why it is a distinct,
 * payload-carrying channel rather than a coarse "re-read everything" event.
 */
export function broadcastDevSiteProgress(progress: DevSiteProgress): void {
    broadcastLocal('dev-server:site-progress', progress);
    mobileEmit('dev-server:site-progress', progress);
}

/**
 * Push a `workspaces:changed` event to every window so the rail re-fetches
 * `workspaces:list`. The renderer mirrors its OWN workspace edits locally, so
 * this is for changes it can't see — notably workspaces provisioned via the MCP
 * `provisionWorkspaces` tool, which must appear in the rail immediately.
 */
export function broadcastWorkspacesChanged(): void {
    // LOCAL-only — a host window lists the HOST's workspaces (via its /ws/events);
    // a local rail change must not force a redundant remote re-fetch there.
    broadcastLocal('workspaces:changed');
    // Mirror to the mobile dashboard push channel (no-op when the server is off).
    mobileEmit('workspaces:changed');
}
