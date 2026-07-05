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
    setWorkspaceTerminalApproval,
    getWorkspaceIssuewatchPolicyBuckets,
    setWorkspaceIssuewatchPolicyBuckets,
    type IssuewatchPolicyBuckets,
    getWorkspaceIssuewatchGranularity,
    setWorkspaceIssuewatchGranularity,
    type IssuewatchGranularity,
    getWorkspaceTunnelSites,
    setWorkspaceTunnelSite,
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
import { discoverSites, type TunnelSiteConfig } from './mobile/hosts';
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
import { writeWorkspaceAgentMcp } from './mcp/agent-config';
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
} from './mcp/server';
import {
    mobileEmit,
    mobileServerState,
    restartMobileServer,
    setMobileEnabled,
    setLocked,
    regeneratePin,
    currentPin,
    revokeAllSessions,
    revokeSession,
    listSessions,
    type MobileServerState,
} from './mobile/server';
import { firewallRuleExists, ensureFirewallRule } from './mobile/firewall';
import { getTailscaleStatus, tailscaleUp, installTailscale } from './tailscale';
import { discoverHosts, openRemoteWindow } from './workmode';
import {
    connectRemote,
    connectWorkstation,
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
import { localSiteUrl } from './sites/gen-url';
import { openLocalSiteWindow } from './sites/local-window';
import {
    openTestingBrowser,
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
import { tynnCliInfo, installTynnCliSystemWide } from './cli/tynn-cli';
import { registerShortcuts } from './shortcuts';
import { startSignIn, redeemCode } from './auth';
import {
    hideCaptureWindow,
    showSettingsWindow,
    showDocsWindow,
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
import { TynnAuthError, type WorkstationConnectGrant } from './backend/tynn';
import { PopKeypair } from './remote/relay-pop';
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
    ipcMain.handle('workspaces:remove', (_e, id: string) => {
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

    // --- serve-local-sites (Phase B): discovery + the per-repo `.gen` allowlist.
    // `sites:list` discovers THIS host's loopback dev sites (hosts-file parse +
    // loopback probe) merged with the workspace's stored tunnel settings; the
    // per-workspace map is the allowlist. `sites:set` persists ONE site's config
    // keyed by the opaque siteId. Same discovery a remote reaches over /api/sites.
    ipcMain.handle(
        'sites:list',
        (_e, workspaceId?: string, opts?: { refresh?: boolean }) => {
            const settings = workspaceId ? getWorkspaceTunnelSites(workspaceId) : {};
            return discoverSites(settings, opts);
        },
    );
    ipcMain.handle(
        'sites:set',
        (_e, workspaceId: string, siteId: string, patch: TunnelSiteConfig) => {
            setWorkspaceTunnelSite(workspaceId, siteId, patch);
            return { ok: true };
        },
    );

    // `sites:all` — the header `.gen` popover's data: THIS machine's local dev
    // sites (browsable directly, no remote connection) PLUS every connected
    // host's enabled `.gen` sites. Local sites open in a Genie browser window at
    // their real loopback URL; host sites open in that host's Testing Browser.
    ipcMain.handle('sites:all', async () => {
        // Local: all discovered loopback dev sites (machine-wide; the per-workspace
        // enable/genName is a REMOTE-exposure concern, irrelevant to local browsing
        // — so we list every real `site` with a derived `.gen` label + real URL).
        let local: Array<{ genName: string; hostname: string; url: string }> = [];
        try {
            local = (await discoverSites({}))
                .filter((s) => s.kind === 'site')
                .map((s) => ({
                    genName: s.genName,
                    hostname: s.hostname,
                    url: localSiteUrl(s.scheme, s.hostname, s.port),
                }));
        } catch {
            local = [];
        }
        // Connected hosts: each one's ENABLED `.gen` set (what it chose to expose).
        const connected = listKnownHosts().filter((h) => h.connected);
        const hosts = await Promise.all(
            connected.map(async (h) => ({
                connKey: h.connKey,
                hostname: h.name || h.hostname,
                sites: await remoteListEnabledGenSites(h.connKey).catch(() => []),
            })),
        );
        return { local, hosts: hosts.filter((h) => h.sites.length > 0) };
    });

    // Open a LOCAL dev site in a Genie browser window (real loopback URL).
    ipcMain.handle('sites:open-local', (_e, url: string, label: string) =>
        openLocalSiteWindow(String(url), String(label ?? url)),
    );

    // --- Agent MCP server status / restart (Settings → Agent MCP) -------
    ipcMain.handle('mcp:status', () => mcpServerState());
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
    ipcMain.handle('remote:terminal-attach', (e, id: string, workspaceId?: string) => {
        remoteAttachTerminal(e.sender.id, id, workspaceId);
        return { ok: true };
    });
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
    ipcMain.handle('testing-browser:open', (_e, connKey: string, hostname: string) =>
        openTestingBrowser(connKey, hostname),
    );
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
    ipcMain.handle('workstation:connectable', () =>
        getTynnBackend().listConnectableWorkstations(),
    );
    ipcMain.handle('workstation:open', async (_e, workstationId: string, name: string) => {
        // PoP (P4.5): generate the ephemeral keypair in MAIN; its public JWK
        // binds the grant (cnf.jkt) and its private key answers the host's
        // post-welcome challenge. The private key never leaves main and is wiped
        // when the connection tears down (RelayMemberClient.close → discard).
        const popKeypair = PopKeypair.generate();
        let grant: WorkstationConnectGrant;
        try {
            grant = await getTynnBackend().connectGrant(workstationId, popKeypair.publicJwk);
        } catch (e) {
            if (e instanceof TynnAuthError) {
                return { ok: false, error: 'Sign in to Tynn to connect to this workstation.' };
            }
            return {
                ok: false,
                error: e instanceof Error ? e.message : 'Could not get a connection grant.',
            };
        }
        const res = await connectWorkstation({
            workstationId,
            name,
            relayUrl: grant.relay_endpoint,
            grant: grant.token,
            popKeypair,
            heartbeatIntervalMs:
                grant.heartbeat_interval > 0 ? grant.heartbeat_interval * 1000 : undefined,
            onHeartbeat: () => getTynnBackend().introspectGrant(grant.token),
        });
        if (res.ok && res.connKey) {
            const host: RemoteHost = { ip: 'relay', port: 0, hostname: name };
            showHostWindow(host, res.connKey);
        }
        return res;
    });

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

    // --- tynn-cli toolkit ----------------------------------------------
    ipcMain.handle('cli:info', () => tynnCliInfo());
    ipcMain.handle('cli:install', () => installTynnCliSystemWide());

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
        (_e, input: Parameters<typeof createTerminalSpec>[0]) =>
            createTerminalSpec(input),
    );
    ipcMain.handle(
        'terminal-spec:update',
        (_e, id: string, patch: Record<string, unknown>) =>
            updateTerminalSpec(id, patch as Parameters<typeof updateTerminalSpec>[1]),
    );
    ipcMain.handle('terminal-spec:delete', (_e, id: string) => {
        // If it's a running Process, stop + forget it before dropping the spec.
        const spec = getTerminalSpec(id);
        if (spec?.type === 'process') {
            stopProcess(id);
            forgetProcess(id);
        }
        return deleteTerminalSpec(id);
    });
    ipcMain.handle('terminal-spec:get', (_e, id: string) => getTerminalSpec(id));
    ipcMain.handle('terminal-spec:touch', (_e, id: string) => {
        touchTerminalSpec(id);
        return { ok: true };
    });

    // --- Backend projects (fans out across signed-in backends) ----------
    ipcMain.handle('tynn:projects', async () => listAllProjects());
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
