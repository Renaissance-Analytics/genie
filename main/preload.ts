import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { TailscaleStatus } from './tailscale';
import type { AgentInboxScope } from './agentinbox/types';
import type { AgentInboxIncomingPayload } from './terminal/ipc';
// The IssueWatch bucket tallies, from the module that OWNS them. This boundary
// used to restate the shape by hand in two places, and they had already drifted
// apart — the `issue-watch:update` payload still declared a `dependabot` key
// that stopped existing when the three alert kinds collapsed into `security`.
// Nothing failed, because a hand-written duplicate cannot disagree with
// anything. `import type` is fully erased (isolatedModules), so this costs no
// runtime import across the context bridge.
import type { TypeCounts } from './issue-watch';
import type { TynnHealth } from './mcp/tynn-health';
import type { HostToolName } from './dev-server/toolchain-detect';
import {
    TERMINAL_RECOVER_CHANNEL,
    TERMINAL_RECOVERY_STATUS_CHANNEL,
    type TerminalRecoverPayload,
    type TerminalRecoveryStatusPayload,
} from './terminal/recovery-channels';

/** Remote-link health pushed/read by a host window's overlay (see link-state.ts). */
type RemoteLinkStatePayload = {
    phase: 'connected' | 'mismatch' | 'reconnecting' | 'lost';
    direction?: 'host-behind' | 'client-behind';
    hostVersion?: number;
    localVersion?: number;
    reason?: 'upgrade' | 'dropped';
    hostBuildBehind?: { hostVersion: string | null; localVersion: string };
};

/** The Testing Browser chrome's render state (serve-local-sites Phase D). Mirrors
 *  `chromeState` in main/testing-browser/index.ts. */
interface TestingBrowserState {
    connKey: string;
    hostname: string;
    tabs: Array<{ id: string; url: string; title: string }>;
    activeTabId: string | null;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    presetId: string;
    presets: Array<{ id: string; label: string }>;
    sites: Array<{ genName: string; hostname: string; scheme: string; port: number }>;
}

/**
 * Typed contextBridge exposed to the renderer. Every channel matches a
 * handler registered in main/ipc.ts. No `nodeIntegration`, no `remote`,
 * no `eval` — the renderer's only path into the OS is this object.
 *
 * Naming notes:
 *   - `tynn.*` channels are historic. They now fan out across whichever
 *     backends are signed in (Tynn + Aionima). Aionima-specific config
 *     lives under `aionima.*`.
 */

/** The `mobile:status` payload (mirrors MobileStatus in renderer/lib/genie.ts). */
interface MobileStatus {
    running: boolean;
    enabled: boolean;
    /** True when the phone web UI is being served. */
    mobileUiEnabled: boolean;
    /** True when desktop Genie Remote connections are allowed. */
    remoteEnabled: boolean;
    ip: string | null;
    port: number | null;
    configuredPort: number;
    url: string | null;
    conflict: boolean;
    tailnetNotDetected: boolean;
    listeners: Array<{
        network: 'local' | 'lan' | 'tailscale';
        ip: string;
        port: number;
        secure: boolean;
    }>;
    locked: boolean;
    /** Everyone who can drive right now, with their attribution emoji. */
    participants: Array<{
        id: string;
        name: string;
        emoji: string;
        isOwner: boolean;
        holdsControl: boolean;
    }>;
    /** The desktop's view of the baton (who is driving, with which emoji). */
    control: {
        locked: boolean;
        holder: string | null;
        holderEmoji: string | null;
        you: string | null;
    };
    pin: string;
    qrDataUrl: string | null;
    /** win32 only: server listening but no inbound firewall rule for the port. */
    needsFirewallRule: boolean;
    /** True when served over browser-trusted HTTPS (Tailscale cert); false = http. */
    secure: boolean;
}
/** Who holds the host's baton, as this driver sees it (mirrors main/remote). */
interface RemoteControlState {
    /** True when SOMEBODY ELSE is driving and this window is view-only. */
    locked: boolean;
    /** The holder's attribution emoji (null when free / an older host). */
    holderEmoji?: string | null;
    /** The holder's display name (null when free / an older host). */
    holderName?: string | null;
}

const api = {
    auth: {
        startSignIn: (kind?: 'tynn' | 'aionima') =>
            ipcRenderer.invoke('auth:start-sign-in', kind),
        redeemCode: (code: string) =>
            ipcRenderer.invoke('auth:redeem-code', code) as Promise<{ ok: boolean }>,
        signOut: (kind: 'tynn' | 'aionima' = 'tynn') =>
            ipcRenderer.invoke('auth:sign-out', kind),
        whoami: (kind?: 'tynn' | 'aionima') =>
            ipcRenderer.invoke('auth:whoami', kind),
        summary: () => ipcRenderer.invoke('app:signed-in-summary'),
    },

    issueWatch: {
        repos: (workspaceId: string) =>
            ipcRenderer.invoke('issue-watch:repos', workspaceId),
        set: (workspaceId: string, owner: string, repo: string, enabled: boolean) =>
            ipcRenderer.invoke('issue-watch:set', workspaceId, owner, repo, enabled),
        feed: (workspaceId: string) =>
            ipcRenderer.invoke('issue-watch:feed', workspaceId),
        markSeen: (workspaceId: string) =>
            ipcRenderer.invoke('issue-watch:mark-seen', workspaceId),
        counts: () =>
            ipcRenderer.invoke('issue-watch:counts') as Promise<
                Record<string, TypeCounts & { knownToServer: boolean }>
            >,
        status: (workspaceId: string) =>
            ipcRenderer.invoke('issue-watch:status', workspaceId),
    },

    mcp: {
        status: () =>
            ipcRenderer.invoke('mcp:status') as Promise<{
                running: boolean;
                port: number | null;
                configuredPort: number;
                conflict: boolean;
            }>,
        restart: () =>
            ipcRenderer.invoke('mcp:restart') as Promise<{
                running: boolean;
                port: number | null;
                configuredPort: number;
                conflict: boolean;
            }>,
        docHealth: (workspaceId: string) =>
            ipcRenderer.invoke('mcp:doc-health', workspaceId),
        repairDocs: (workspaceId: string) =>
            ipcRenderer.invoke('mcp:repair-docs', workspaceId),
        /** Server-push (SSE) measurement: did a real client open the GET stream,
         *  echo a session id, and receive a push. */
        pushStatus: () =>
            ipcRenderer.invoke('mcp:push-status') as Promise<{
                open: number;
                streamsOpened: number;
                streamsWithSession: number;
                pushesSent: number;
                pushesReached: number;
                sessionsCorrelated: number;
            }>,
    },

    // Genie Apps (Tynn #250). Whole agentic applications, installed with their own
    // workspace, hosting and consented permissions. This is the MANAGEMENT surface
    // for Genie's own UI — an installed app never sees it. What a GApp gets is the
    // two-call bridge in `apps/app-preload.ts`, in a window with none of this.
    apps: {
        list: () => ipcRenderer.invoke('apps:list'),
        get: (appId: string) => ipcRenderer.invoke('apps:get', appId),
        requirements: (appId: string) => ipcRenderer.invoke('apps:requirements', appId),
        // Asks each tracked repo for its HEAD. On demand, never on a timer.
        checkUpdates: () => ipcRenderer.invoke('apps:check-updates'),
        installFolder: (folder?: string, devMode?: boolean) =>
            ipcRenderer.invoke('apps:install-folder', folder, devMode),
        // Check a folder WITHOUT installing — the loop a developer works in.
        checkFolder: (folder?: string) => ipcRenderer.invoke('apps:check-folder', folder),
        // OPEN a folder WITHOUT installing — the other half of that loop. A check
        // says the manifest is coherent; only the window answers what the app
        // actually looks like to the people who will use it.
        previewFolder: (folder?: string) => ipcRenderer.invoke('apps:preview-folder', folder),
        previews: () => ipcRenderer.invoke('apps:previews'),
        closePreview: (appId: string) => ipcRenderer.invoke('apps:preview-close', appId),
        scaffold: (req: { name: string; id?: string; parent?: string }) =>
            ipcRenderer.invoke('apps:scaffold', req),
        // Install from GitHub is TWO steps, and both belong to a human: read
        // the review, then type the app's name. The main process re-checks the
        // typing — this pair only carries it.
        reviewGithub: (url: string, ref?: string) =>
            ipcRenderer.invoke('apps:review-github', url, ref),
        installGithub: (commit: string, typed: string) =>
            ipcRenderer.invoke('apps:install-github', commit, typed),
        discardGithub: (commit: string) => ipcRenderer.invoke('apps:discard-github', commit),
        open: (appId: string) => ipcRenderer.invoke('apps:open', appId),
        setCapabilities: (appId: string, capabilities: string[]) =>
            ipcRenderer.invoke('apps:set-capabilities', appId, capabilities),
        setRevoked: (appId: string, revoked: boolean) =>
            ipcRenderer.invoke('apps:set-revoked', appId, revoked),
        uninstall: (appId: string) => ipcRenderer.invoke('apps:uninstall', appId),
        // Backups (Tynn #250, step 4). `appId` omitted reads/writes the
        // WORKSTATION default; passing one reads/writes that app's override.
        backupSettings: (appId?: string) => ipcRenderer.invoke('apps:backup-settings', appId),
        setBackup: (appId: string | null, patch: unknown) =>
            ipcRenderer.invoke('apps:set-backup', appId, patch),
        backup: (appId: string) => ipcRenderer.invoke('apps:backup', appId),
    },

    // fancy-flow workflows owned by a Genie App. This is Genie's own editing
    // surface: an installed app never sees it, and it grants nothing — a graph
    // reaching past the app's permissions saves fine (an author is mid-edit) and
    // is refused at RUN by `decideFlowAdmission`.
    flows: {
        list: (appId: string) => ipcRenderer.invoke('flows:list', appId),
        get: (flowId: string) => ipcRenderer.invoke('flows:get', flowId),
        save: (input: { id: string; appId: string; name: string; graph: unknown; enabled?: boolean }) =>
            ipcRenderer.invoke('flows:save', input),
        remove: (flowId: string) => ipcRenderer.invoke('flows:delete', flowId),
        setEnabled: (flowId: string, enabled: boolean) =>
            ipcRenderer.invoke('flows:set-enabled', flowId, enabled),
        // What this graph WOULD be allowed to do, without running it — so a
        // refusal lands on the canvas rather than at 3am on the first fire.
        check: (appId: string, graph: unknown) => ipcRenderer.invoke('flows:check', appId, graph),
        palette: (appId: string) => ipcRenderer.invoke('flows:palette', appId),
        run: (flowId: string) => ipcRenderer.invoke('flows:run', flowId),
    },

    // The GApp window's own bridge. NOT the app's — this is Genie's renderer
    // drawing the frame and the tab strip; the app's two-call surface is the
    // separate `app-preload`, in a view with none of this.
    gapp: {
        describe: () => ipcRenderer.invoke('gapp:describe'),
        showTab: (index: number) => ipcRenderer.invoke('gapp:show-tab', index),
    },

    // Plugin System (Settings → Plugins). Install / enable / grant + marketplaces.
    plugins: {
        list: () => ipcRenderer.invoke('plugins:list'),
        installRepo: (url: string, ref?: string) =>
            ipcRenderer.invoke('plugins:install-repo', url, ref),
        installFolder: (folder?: string) =>
            ipcRenderer.invoke('plugins:install-folder', folder),
        enable: (id: string, enabled: boolean) =>
            ipcRenderer.invoke('plugins:enable', id, enabled),
        setGrant: (id: string, category: string, key: string, granted: boolean) =>
            ipcRenderer.invoke('plugins:set-grant', id, category, key, granted),
        uninstall: (id: string) => ipcRenderer.invoke('plugins:uninstall', id),
        marketplaces: () => ipcRenderer.invoke('plugins:marketplaces'),
        addMarketplace: (url: string, ref?: string) =>
            ipcRenderer.invoke('plugins:add-marketplace', url, ref),
        refreshMarketplace: (id: string) =>
            ipcRenderer.invoke('plugins:refresh-marketplace', id),
        refreshMarketplaces: (maxAgeMs?: number) =>
            ipcRenderer.invoke('plugins:refresh-marketplaces', maxAgeMs),
        removeMarketplace: (id: string) =>
            ipcRenderer.invoke('plugins:remove-marketplace', id),
        installMarketplacePlugin: (marketplaceId: string, pluginId: string) =>
            ipcRenderer.invoke('plugins:install-marketplace-plugin', marketplaceId, pluginId),
        official: () => ipcRenderer.invoke('plugins:official'),
        installBundled: (id: string) => ipcRenderer.invoke('plugins:install-bundled', id),
        recipes: () => ipcRenderer.invoke('plugins:recipes'),
        // Launchable workspace panels contributed by enabled + `ui.panel`-granted plugins.
        panels: () => ipcRenderer.invoke('plugins:panels'),
        // Capability-scoped binary bridge for a granted plugin's editor (§6.2).
        editorRead: (pluginId: string, root: string, relPath: string) =>
            ipcRenderer.invoke('plugins:editor-read', pluginId, root, relPath),
        editorWrite: (pluginId: string, root: string, relPath: string, base64: string) =>
            ipcRenderer.invoke('plugins:editor-write', pluginId, root, relPath, base64),
        // Which enabled plugin's editor claims this file's extension (§6.1).
        editorFor: (fileName: string) =>
            ipcRenderer.invoke('plugins:editor-for', fileName),
        // Markdown <-> DOCX conversion for the Document editor (main-side seam).
        convertDocument: (req: { to: 'markdown' | 'docx'; base64?: string; markdown?: string }) =>
            ipcRenderer.invoke('plugins:document-convert', req),
        // Developer Mode + trusted signing keys (Phase 3).
        developerMode: () => ipcRenderer.invoke('plugins:developer-mode'),
        setDeveloperMode: (enabled: boolean) =>
            ipcRenderer.invoke('plugins:set-developer-mode', enabled),
        addTrustedKey: (publicKeyPem: string, label?: string) =>
            ipcRenderer.invoke('plugins:add-trusted-key', publicKeyPem, label),
        removeTrustedKey: (keyId: string) =>
            ipcRenderer.invoke('plugins:remove-trusted-key', keyId),
    },

    // Repository panel (the first plugin-panel consumer): host-side git ops the
    // renderer's RepoChangesPanel adapter drives. Every op is contained to the
    // workspace root + a workspace-relative repo folder.
    repo: {
        list: (workspaceRoot: string) => ipcRenderer.invoke('repo:list', workspaceRoot),
        status: (workspaceRoot: string, repoRel: string) =>
            ipcRenderer.invoke('repo:status', workspaceRoot, repoRel),
        diff: (workspaceRoot: string, repoRel: string, filePath: string, staged: boolean) =>
            ipcRenderer.invoke('repo:diff', workspaceRoot, repoRel, filePath, staged),
        stage: (workspaceRoot: string, repoRel: string, paths: string[]) =>
            ipcRenderer.invoke('repo:stage', workspaceRoot, repoRel, paths),
        unstage: (workspaceRoot: string, repoRel: string, paths: string[]) =>
            ipcRenderer.invoke('repo:unstage', workspaceRoot, repoRel, paths),
        commit: (workspaceRoot: string, repoRel: string, message: string) =>
            ipcRenderer.invoke('repo:commit', workspaceRoot, repoRel, message),
        push: (workspaceRoot: string, repoRel: string, remote?: string) =>
            ipcRenderer.invoke('repo:push', workspaceRoot, repoRel, remote),
        pull: (workspaceRoot: string, repoRel: string) =>
            ipcRenderer.invoke('repo:pull', workspaceRoot, repoRel),
        createBranch: (workspaceRoot: string, repoRel: string, name: string) =>
            ipcRenderer.invoke('repo:create-branch', workspaceRoot, repoRel, name),
    },

    // Mobile remote-control server (Settings → Mobile). Desktop-only — the phone
    // talks to the tailnet HTTP/WS server directly, never through this bridge.
    mobile: {
        status: () => ipcRenderer.invoke('mobile:status') as Promise<MobileStatus>,
        restart: (enabled?: boolean) =>
            ipcRenderer.invoke('mobile:restart', enabled) as Promise<MobileStatus>,
        /** Toggle desktop Genie Remote independently of the phone UI (binds/unbinds
         *  the same host server). */
        setRemoteEnabled: (enabled: boolean) =>
            ipcRenderer.invoke('remote:set-enabled', enabled) as Promise<MobileStatus>,
        regeneratePin: () =>
            ipcRenderer.invoke('mobile:regenerate-pin') as Promise<MobileStatus>,
        /** win32: add the inbound firewall rule for the live port (one UAC prompt).
         *  Returns the elevation result merged with fresh status. */
        allowFirewall: () =>
            ipcRenderer.invoke('mobile:allow-firewall') as Promise<
                MobileStatus & { ok: boolean; cancelled?: boolean; error?: string }
            >,
        revokeSessions: () =>
            ipcRenderer.invoke('mobile:revoke-sessions') as Promise<
                MobileStatus & { revoked: number }
            >,
        /** The host-side roster of paired devices (no bearer tokens). */
        sessions: () =>
            ipcRenderer.invoke('mobile:sessions') as Promise<
                Array<{ id: string; label: string; ip: string; createdAt: number }>
            >,
        /** Unpair one device by its roster id. */
        revokeSession: (id: string) =>
            ipcRenderer.invoke('mobile:revoke-session', id) as Promise<
                MobileStatus & { ok: boolean }
            >,
        lock: (locked: boolean) =>
            ipcRenderer.invoke('mobile:lock', locked) as Promise<MobileStatus>,
        /** Hand the baton to a connected user (the desktop must be holding it). */
        giveControl: (principalId: string) =>
            ipcRenderer.invoke('mobile:give-control', principalId) as Promise<
                MobileStatus & { ok: boolean; error?: string }
            >,
    },

    // Work Mode — Tailscale lifecycle management (status / bring online / install).
    tailscale: {
        status: () => ipcRenderer.invoke('tailscale:status') as Promise<TailscaleStatus>,
        up: () =>
            ipcRenderer.invoke('tailscale:up') as Promise<{
                ok: boolean;
                authUrl?: string | null;
                message?: string;
            }>,
        openAuth: (url: string) =>
            ipcRenderer.invoke('tailscale:open-auth', url) as Promise<{ ok: boolean }>,
        install: () =>
            ipcRenderer.invoke('tailscale:install') as Promise<{
                started: boolean;
                url?: string;
                message?: string;
            }>,
    },

    // Work Mode — remote: discover Genie hosts on the tailnet + open a remote
    // session window driving a host's /m/ surface.
    workmode: {
        discoverHosts: () =>
            ipcRenderer.invoke('workmode:discover-hosts') as Promise<
                Array<{
                    hostname: string;
                    peerName: string;
                    ip: string;
                    port: number;
                    hostId?: string;
                    dnsName?: string;
                    connKey: string;
                }>
            >,
        openRemote: (host: { ip: string; port: number; hostname: string }) =>
            ipcRenderer.invoke('workmode:open-remote', host) as Promise<{ ok: boolean }>,
    },

    // Work Mode — remote desktop: the REST proxy the renderer's remote bridge maps
    // every desktop call onto, a per-window status subscription (the titlebar
    // indicator listens on it), and the Hosts-picker surface (open/known/forget/
    // rename). Pairing happens inside `open` — there is no standalone `connect`.
    remote: {
        disconnect: () =>
            ipcRenderer.invoke('remote:disconnect') as Promise<{ ok: boolean }>,
        status: () =>
            ipcRenderer.invoke('remote:status') as Promise<{
                connected: boolean;
                host: { ip: string; port: number; hostname: string } | null;
            }>,
        // This WINDOW's binding — local, or remote to a specific host. The
        // renderer reads it once on boot to decide whether to route api() to a
        // host (a host window) or stay local (the local window).
        myBinding: () =>
            ipcRenderer.invoke('remote:my-binding') as Promise<{
                mode: 'local' | 'remote';
                host: { ip: string; port: number; hostname: string } | null;
                connKey: string | null;
            }>,
        request: (path: string, init?: { method?: string; json?: unknown }) =>
            ipcRenderer.invoke('remote:request', path, init),
        onStatus: (
            cb: (s: {
                connected: boolean;
                host: { ip: string; port: number; hostname: string } | null;
            }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: {
                    connected: boolean;
                    host: { ip: string; port: number; hostname: string } | null;
                },
            ) => cb(payload);
            ipcRenderer.on('remote:status', handler);
            return () => ipcRenderer.off('remote:status', handler);
        },
        // Link health (bridge version match + upgrade/limbo reconnect): the host
        // window reads it on mount + subscribes for live changes; "Upgrade host"
        // drives the host's updater over the bridge.
        linkState: () =>
            ipcRenderer.invoke('remote:link-state') as Promise<RemoteLinkStatePayload>,
        upgradeHost: () =>
            ipcRenderer.invoke('remote:upgrade-host') as Promise<{
                ok: boolean;
                error?: string;
            }>,
        reconnect: () =>
            ipcRenderer.invoke('remote:reconnect') as Promise<{ ok: boolean; error?: string }>,
        onLink: (cb: (s: RemoteLinkStatePayload) => void) => {
            const handler = (_e: unknown, payload: RemoteLinkStatePayload) => cb(payload);
            ipcRenderer.on('remote:link', handler);
            return () => ipcRenderer.off('remote:link', handler);
        },
        // Control state (who holds WRITE control of the host): `locked:true` ⇒ the
        // host took control and this driver is view-only. Read on mount + live via
        // `remote:control`.
        controlState: () =>
            ipcRenderer.invoke('remote:control-state') as Promise<RemoteControlState>,
        onControl: (cb: (s: RemoteControlState) => void) => {
            const handler = (_e: unknown, payload: RemoteControlState) => cb(payload);
            ipcRenderer.on('remote:control', handler);
            return () => ipcRenderer.off('remote:control', handler);
        },

        terminalAttach: (id: string, workspaceId?: string, cols?: number, rows?: number) =>
            ipcRenderer.invoke('remote:terminal-attach', id, workspaceId, cols, rows) as Promise<{
                ok: boolean;
            }>,
        terminalInput: (id: string, data: string) =>
            ipcRenderer.invoke('remote:terminal-input', id, data) as Promise<boolean>,
        terminalResize: (id: string, cols: number, rows: number) =>
            ipcRenderer.invoke('remote:terminal-resize', id, cols, rows) as Promise<boolean>,
        terminalDetach: (id: string) =>
            ipcRenderer.invoke('remote:terminal-detach', id) as Promise<{ ok: boolean }>,
        // Hosts picker (local window): open a host's OWN native Floor window
        // (connecting + handling the PIN), and manage the known-hosts list.
        open: (
            host: {
                ip: string;
                port: number;
                hostname: string;
                hostId?: string;
                dnsName?: string;
            },
            pin?: string,
        ) =>
            ipcRenderer.invoke('host:open', host, pin) as Promise<{
                ok: boolean;
                connKey?: string;
                error?: string;
                needsPin?: boolean;
            }>,
        known: () =>
            ipcRenderer.invoke('host:known') as Promise<
                Array<{
                    ip: string;
                    port: number;
                    hostname: string;
                    name?: string;
                    hostId?: string;
                    dnsName?: string;
                    connKey: string;
                    connected: boolean;
                }>
            >,
        forget: (connKey: string) =>
            ipcRenderer.invoke('host:forget', connKey) as Promise<{ ok: boolean }>,
        rename: (connKey: string, name: string) =>
            ipcRenderer.invoke('host:rename', connKey, name) as Promise<{ ok: boolean }>,
    },

    // Serve-local-sites (Phase D): the Testing Browser chrome. `open` is called
    // from the Hosts UI for a connected host; the rest are called BY the chrome
    // window itself (each resolves to that window's browser instance in main). The
    // React chrome renders `onState`; the WebContentsView content is owned by main.
    testingBrowser: {
        open: (connKey: string, hostname: string) =>
            ipcRenderer.invoke('testing-browser:open', connKey, hostname) as Promise<{
                ok: boolean;
                error?: string;
            }>,
        state: () =>
            ipcRenderer.invoke('testing-browser:state') as Promise<TestingBrowserState | null>,
        navigate: (input: string) =>
            ipcRenderer.invoke('testing-browser:navigate', input) as Promise<{
                ok: boolean;
                error?: string;
            }>,
        back: () => ipcRenderer.invoke('testing-browser:back') as Promise<{ ok: boolean }>,
        forward: () => ipcRenderer.invoke('testing-browser:forward') as Promise<{ ok: boolean }>,
        reload: () => ipcRenderer.invoke('testing-browser:reload') as Promise<{ ok: boolean }>,
        newTab: (input?: string) =>
            ipcRenderer.invoke('testing-browser:new-tab', input) as Promise<{
                ok: boolean;
                error?: string;
            }>,
        closeTab: (tabId: string) =>
            ipcRenderer.invoke('testing-browser:close-tab', tabId) as Promise<{ ok: boolean }>,
        activateTab: (tabId: string) =>
            ipcRenderer.invoke('testing-browser:activate-tab', tabId) as Promise<{ ok: boolean }>,
        setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
            ipcRenderer.invoke('testing-browser:set-bounds', bounds) as Promise<{ ok: boolean }>,
        setViewport: (presetId: string) =>
            ipcRenderer.invoke('testing-browser:set-viewport', presetId) as Promise<{
                ok: boolean;
            }>,
        refreshSites: () =>
            ipcRenderer.invoke('testing-browser:refresh-sites') as Promise<void>,
        onState: (cb: (s: TestingBrowserState) => void) => {
            const handler = (_e: unknown, payload: TestingBrowserState) => cb(payload);
            ipcRenderer.on('testing-browser:state', handler);
            return () => ipcRenderer.off('testing-browser:state', handler);
        },
        onLoadError: (
            cb: (e: { tabId: string; code: number; description: string; url: string }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: { tabId: string; code: number; description: string; url: string },
            ) => cb(payload);
            ipcRenderer.on('testing-browser:load-error', handler);
            return () => ipcRenderer.off('testing-browser:load-error', handler);
        },
    },

    // Virtual Workstations (relay transport): the signed-in member's entitled
    // workstations (Hosts picker) + opening one over the Tynn relay. The connect
    // grant is minted + held in main; the renderer only ever sees id + name.
    workstations: {
        connectable: () =>
            ipcRenderer.invoke('workstation:connectable') as Promise<
                Array<{
                    id: string;
                    name: string;
                    status: string;
                    relay_endpoint: string;
                    connectable: boolean;
                    capability: string | null;
                    scopes: string[];
                    source: 'owner' | 'grant' | 'invite' | null;
                }>
            >,
        open: (workstationId: string, name: string) =>
            ipcRenderer.invoke('workstation:open', workstationId, name) as Promise<{
                ok: boolean;
                connKey?: string;
                error?: string;
            }>,
    },

    aionima: {
        getConfig: () => ipcRenderer.invoke('auth:aionima-config'),
        setConfig: (patch: { host?: string; token?: string | null }) =>
            ipcRenderer.invoke('auth:aionima-set', patch),
        hostInfo: () => ipcRenderer.invoke('aionima-host:get'),
    },

    github: {
        status: () => ipcRenderer.invoke('github:status'),
        startDevice: () => ipcRenderer.invoke('github:device:start'),
        cancelDevice: () => ipcRenderer.invoke('github:device:cancel'),
        resetClientId: () => ipcRenderer.invoke('github:reset-client-id'),
        installUrl: (targetId?: number | null) =>
            ipcRenderer.invoke('github:install-url', targetId),
        disconnect: () => ipcRenderer.invoke('github:disconnect'),
        user: () => ipcRenderer.invoke('github:user'),
        orgs: () => ipcRenderer.invoke('github:orgs'),
        installations: () => ipcRenderer.invoke('github:installations'),
        repositories: () => ipcRenderer.invoke('github:repositories'),
        repoOwner: (owner: string, repo: string) =>
            ipcRenderer.invoke('github:repo-owner', owner, repo),
        createRepo: (opts: {
            name: string;
            owner?: string | null;
            ownerId?: number | null;
            description?: string;
            private?: boolean;
        }) => ipcRenderer.invoke('github:create-repo', opts),
        forkRepo: (opts: {
            owner: string;
            repo: string;
            intoOrg?: string | null;
            intoOrgId?: number | null;
            name?: string;
        }) => ipcRenderer.invoke('github:fork-repo', opts),
        parseRemote: (url: string) =>
            ipcRenderer.invoke('github:parse-remote', url),
        capabilities: () => ipcRenderer.invoke('github:capabilities'),
        canAccess: (key: string) =>
            ipcRenderer.invoke('github:can-access', key) as Promise<boolean>,
        recheckCapabilities: () =>
            ipcRenderer.invoke('github:recheck-capabilities'),
    },

    updater: {
        mode: () =>
            ipcRenderer.invoke('updater:mode') as Promise<'phase1' | 'phase2'>,
        status: () => ipcRenderer.invoke('updater:status'),
        check: () => ipcRenderer.invoke('updater:check'),
        apply: () => ipcRenderer.invoke('updater:apply'),
        restart: () =>
            ipcRenderer.invoke('updater:restart') as Promise<{
                ok: boolean;
                error?: string;
            }>,
        getConfig: () => ipcRenderer.invoke('updater:config:get'),
        setConfig: (patch: { repo?: string; pollHours?: number }) =>
            ipcRenderer.invoke('updater:config:set', patch),
        changelog: (latest: string, fromVersion?: string) =>
            ipcRenderer.invoke('updater:changelog', latest, fromVersion),
    },

    // System clipboard via Electron MAIN (reliable; renderer navigator.clipboard
    // fails silently in a sandboxed window). Terminal copy/paste routes here.
    clipboard: {
        write: (text: string) =>
            ipcRenderer.invoke('clipboard:write', text) as Promise<{ ok: boolean }>,
        read: () => ipcRenderer.invoke('clipboard:read') as Promise<string>,
        /** LOCAL clipboard image as a PNG data-URL, or null when there's no image. */
        readImage: () =>
            ipcRenderer.invoke('clipboard:read-image') as Promise<string | null>,
        /** Place a PNG (base64, no data-URL prefix) where this machine's CLI reads
         *  it: Windows/macOS → OS clipboard; Linux → a temp file whose `path` comes
         *  back so the caller pastes the path (the CLI can't read a Linux clipboard
         *  image). `supported:false` ⇒ the target can't accept an image (a legacy
         *  unwired host, only reachable via the remote-bridge override). */
        writeImage: (dataBase64: string) =>
            ipcRenderer.invoke('clipboard:write-image', dataBase64) as Promise<{
                ok: boolean;
                supported: boolean;
                path?: string;
            }>,
    },
    // Built-in editor — the renderer's reply to a main `editor:open-file` request
    // (openFileForUser MCP tool): reports whether it reused an open panel or
    // opened a new one, keyed by the request id main is awaiting.
    editor: {
        openFileResult: (
            requestId: string,
            result: { reused: boolean; opened: boolean },
        ) =>
            ipcRenderer.invoke('editor:open-file-result', requestId, result) as Promise<{
                ok: boolean;
            }>,
    },
    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        set: (patch: Record<string, unknown>) =>
            ipcRenderer.invoke('settings:set', patch),
        chooseFolder: (label?: string, defaultPath?: string) =>
            ipcRenderer.invoke('settings:choose-folder', label, defaultPath),
        chooseFile: (label?: string) =>
            ipcRenderer.invoke('settings:choose-file', label),
        /** Read a sound file into a base64 data-URL (null if unreadable). Used
         *  by the per-alert "Custom file…" sound + the Settings Preview. */
        soundDataUrl: (path: string) =>
            ipcRenderer.invoke('settings:sound-data-url', path) as Promise<
                string | null
            >,
        detectShells: () =>
            ipcRenderer.invoke('terminal:shells') as Promise<{
                shells: Array<{
                    id: string;
                    label: string;
                    command: string;
                    args: string[];
                }>;
                defaultId: string | null;
            }>,
    },

    workspaces: {
        list: () => ipcRenderer.invoke('workspaces:list'),
        add: (row: Record<string, unknown>) =>
            ipcRenderer.invoke('workspaces:add', row),
        update: (id: string, patch: Record<string, unknown>) =>
            ipcRenderer.invoke('workspaces:update', id, patch),
        remove: (id: string) => ipcRenderer.invoke('workspaces:remove', id),
        touch: (id: string) => ipcRenderer.invoke('workspaces:touch', id),
        reorder: (ids: string[]) => ipcRenderer.invoke('workspaces:reorder', ids),
        setMcp: (id: string, enabled: boolean) =>
            ipcRenderer.invoke('workspaces:set-mcp', id, enabled),
        setWorkstationOperator: (id: string, on: boolean) =>
            ipcRenderer.invoke('workspaces:set-workstation-operator', id, on),
        getMaxAgentTerminals: (id: string) =>
            ipcRenderer.invoke('workspaces:get-max-agent-terminals', id),
        setMaxAgentTerminals: (id: string, cap: number | 'unlimited' | null) =>
            ipcRenderer.invoke('workspaces:set-max-agent-terminals', id, cap),
        setProcessApproval: (id: string, require: boolean) =>
            ipcRenderer.invoke('workspaces:set-process-approval', id, require),
        setTerminalApproval: (id: string, require: boolean) =>
            ipcRenderer.invoke('workspaces:set-terminal-approval', id, require),
        setScheduleApproval: (id: string, require: boolean) =>
            ipcRenderer.invoke('workspaces:set-schedule-approval', id, require),
        getAgentAccess: (id: string) => ipcRenderer.invoke('workspaces:get-agent-access', id),
        setAgentAccess: (id: string, access: string, workspaces?: string[]) =>
            ipcRenderer.invoke('workspaces:set-agent-access', id, access, workspaces),
        getIssuewatchPolicy: (id: string) =>
            ipcRenderer.invoke('workspaces:get-issuewatch-policy', id),
        setIssuewatchPolicy: (id: string, buckets: unknown) =>
            ipcRenderer.invoke('workspaces:set-issuewatch-policy', id, buckets),
        getIssuewatchGranularity: (id: string) =>
            ipcRenderer.invoke('workspaces:get-issuewatch-granularity', id),
        setIssuewatchGranularity: (id: string, granularity: unknown) =>
            ipcRenderer.invoke('workspaces:set-issuewatch-granularity', id, granularity),
        getIssuewatchHandlers: (id: string) =>
            ipcRenderer.invoke('workspaces:get-issuewatch-handlers', id),
        setIssuewatchHandlers: (id: string, terminalIds: string[]) =>
            ipcRenderer.invoke('workspaces:set-issuewatch-handlers', id, terminalIds),
        repos: (id: string) =>
            ipcRenderer.invoke('workspaces:repos', id) as Promise<string[]>,
        open: (id: string) => ipcRenderer.invoke('workspaces:open', id),
        /** Clone a remote git repo to `parentPath/<folder>` and return the local
         *  path, so the Add-workspace Simple flow can use a remote repo source. */
        clone: (url: string, parentPath: string, folder?: string) =>
            ipcRenderer.invoke('workspaces:clone', url, parentPath, folder) as Promise<{
                path: string;
            }>,
        /** Reveal a workspace-relative path (a repo, an .ai/ folder) in the OS
         *  file manager. Guard-resolved under the workspace root in main. */
        reveal: (workspacePath: string, relPath: string) =>
            ipcRenderer.invoke('workspaces:reveal', workspacePath, relPath) as Promise<{
                ok: boolean;
                error?: string;
            }>,
    },

    // Reading + opening this machine's `.gen` dev sites. A site is CREATED by
    // the Dev Server (`devServer` below) — there is nothing to configure here.
    sites: {
        // The header `.gen` popover — contextual to THIS window (local sites in a
        // local window, the host's sites in a host window).
        all: () => ipcRenderer.invoke('sites:all'),
        open: (genName: string) => ipcRenderer.invoke('sites:open', genName),
    },

    // The container DEV SERVER (#234) — what GENIE serves, and the only thing
    // that makes a `.gen` site exist: a container in the workspace's sandbox,
    // published to loopback and routed at `<name>.gen`. `sites` above reads and
    // opens what this creates.
    //
    // TWO calls, mirroring the `manageSite` / `manageService` MCP tools
    // one-for-one, because main runs literally the same function for both. The
    // Site Manager is a viewer over the agent's surface, not a second one.
    devServer: {
        /** Drive one workspace's SITES: list | detect | create | start | stop |
         *  restart | status | logs | open | remove. */
        site: (workspaceId: string, req: unknown) =>
            ipcRenderer.invoke('dev:site', workspaceId, req),
        /** Drive one workspace's SERVICES: catalog | list | add | start | stop |
         *  status | logs | connection | dedicated | remove. `catalog` answers
         *  with no workspace, so the picker can offer engines before any exist. */
        service: (workspaceId: string, req: unknown) =>
            ipcRenderer.invoke('dev:service', workspaceId, req),
        /** Which container runtime is driving, or why none is. A pure probe —
         *  looking at the settings page never starts a download. */
        runtimeStatus: () => ipcRenderer.invoke('dev:runtime-status'),
        /** First-run toolchain setup (#240): inspect what dev tools THIS machine
         *  has, which package managers could install the rest, the plan for the
         *  missing set, and the consent object. Inspecting installs NOTHING; pass
         *  a package-manager choice to re-plan with it. */
        toolchainInspect: (pmChoice?: string, wanted?: HostToolName[]) =>
            ipcRenderer.invoke('toolchain:inspect', pmChoice, wanted),
        /** Run the reviewed install plan (main runs its OWN plan; the choice is the
         *  only lever). Per-tool progress arrives on `on.toolchainProgress`. */
        toolchainInstall: (pmChoice?: string, wanted?: HostToolName[]) =>
            ipcRenderer.invoke('toolchain:install', pmChoice, wanted),
        /** Toolchain Manager (#242): scan installed tools for available updates.
         *  A pure read — it queries `<pm> outdated` but installs nothing. */
        toolchainUpdates: (force?: boolean) => ipcRenderer.invoke('toolchain:updates', force),
        /** Toolchain Manager (#242 P2): update ONE installed tool to latest. Main
         *  validates the tool + builds the command; the renderer picks only which
         *  known tool. Per-tool progress arrives on `on.toolchainProgress`. */
        toolchainUpdate: (tool: string, confirmed?: boolean) =>
            ipcRenderer.invoke('toolchain:update', tool, confirmed),
        /** The Toolchain page: every language version on this machine — Genie's
         *  own under `<userData>/toolchain` plus the ones Herd / XAMPP / nvm /
         *  the system left, the latter for AWARENESS only. A pure read: it lists
         *  directories and never downloads. */
        toolchainInstalls: (force?: boolean) => ipcRenderer.invoke('toolchain:installs', force),
        /** ArtBoard: the posts an agent has put up for review in this workspace,
         *  resolved to markup / data URLs host-side (the renderer cannot read the
         *  filesystem, and so never holds a path). */
        artboardRead: (workspaceId: string) => ipcRenderer.invoke('artboard:read', workspaceId),
        /** Record an approve/reject with an optional comment, and hand it to the
         *  agent that posted. Reports whether that agent was actually told. */
        artboardReview: (
            workspaceId: string,
            postId: string,
            review: { verdict: 'approved' | 'rejected'; comment?: string },
        ) => ipcRenderer.invoke('artboard:review', workspaceId, postId, review),
        /** Repair PATH precedence so Genie’s own toolchain wins (owner report:
         *  Herd was uninstalled and left both its binaries and its PATH entry
         *  behind, so  resolved to a shim for an install that no longer
         *  existed). Moves Genie’s entry to the FRONT and reports what it found
         *  before and after. It never deletes another tool’s entry. */
        toolchainRepair: () => ipcRenderer.invoke('toolchain:repair'),
        /** Make a Genie-managed version the MACHINE default. Unpinned sites
         *  follow it, so main names which ones before this is called. */
        toolchainSetDefault: (tool: string, version: string) =>
            ipcRenderer.invoke('toolchain:set-default', tool, version),
        /** Install one version Genie has a recipe for. No free-text versions. */
        toolchainAddVersion: (tool: string, version: string) =>
            ipcRenderer.invoke('toolchain:add-version', tool, version),
        /** Delete a version GENIE installed. Refused for anyone else's. */
        toolchainRemoveVersion: (tool: string, version: string) =>
            ipcRenderer.invoke('toolchain:remove-version', tool, version),
        /** The MACHINE's Dev Server: which runtime is driving, what the dev base
         *  image provides, and every shared service engine with its holders.
         *  Machine-level because an engine is shared across every workspace on
         *  the same (engine, major). A pure read — never pulls or starts. */
        workstation: () => ipcRenderer.invoke('dev:workstation'),
        /** Machine-level start | stop | logs for ONE shared engine. */
        engine: (req: unknown) => ipcRenderer.invoke('dev:engine', req),
        /** The repo subfolders a site can be created against. */
        repos: (workspaceId: string) => ipcRenderer.invoke('dev:repos', workspaceId),
    },

    agi: {
        detect: (path: string) => ipcRenderer.invoke('agi:detect', path),
        create: (opts: Record<string, unknown>) =>
            ipcRenderer.invoke('agi:create', opts),
        importExisting: (path: string) =>
            ipcRenderer.invoke('agi:import', path),
        convert: (opts: Record<string, unknown>) =>
            ipcRenderer.invoke('agi:convert', opts),
        analyse: (path: string) => ipcRenderer.invoke('agi:analyse', path),
        convertPlan: (opts: Record<string, unknown>) =>
            ipcRenderer.invoke('agi:convert-plan', opts),
        push: (envelopePath: string, branch?: string) =>
            ipcRenderer.invoke('agi:push', envelopePath, branch),
        docStatus: (envelopePath: string) =>
            ipcRenderer.invoke('agi:doc-status', envelopePath),
        addDocs: (envelopePath: string, name: string, slug: string) =>
            ipcRenderer.invoke('agi:add-docs', envelopePath, name, slug),
        mcpStatus: (envelopePath: string) =>
            ipcRenderer.invoke('agi:mcp-status', envelopePath),
        consolidateMcp: (envelopePath: string) =>
            ipcRenderer.invoke('agi:consolidate-mcp', envelopePath),
        // Envelope repo registry management (workspace settings window).
        reposList: (workspacePath: string) =>
            ipcRenderer.invoke('agi:repos-list', workspacePath),
        repoAdd: (workspacePath: string, url: string, name: string) =>
            ipcRenderer.invoke('agi:repo-add', workspacePath, url, name),
        repoRemove: (workspacePath: string, name: string) =>
            ipcRenderer.invoke('agi:repo-remove', workspacePath, name),
        // Envelope `.ai/` knowledge folders.
        knowledgeList: (workspacePath: string) =>
            ipcRenderer.invoke('agi:knowledge-list', workspacePath),
        knowledgeCreate: (workspacePath: string, name: string) =>
            ipcRenderer.invoke('agi:knowledge-create', workspacePath, name),
    },

    tynn: {
        projects: () => ipcRenderer.invoke('tynn:projects'),
        // "Create new project" form in the Add-workspace flow: the owners the
        // user may create under, and the create itself (Tynn-only).
        ownerOptions: () => ipcRenderer.invoke('tynn:owner-options'),
        createProject: (input: {
            name: string;
            owner_type?: 'user' | 'organization' | 'team';
            owner_id?: string;
            slug?: string;
        }) => ipcRenderer.invoke('tynn:create-project', input),
        submitFeedback: (
            projectId: string,
            message: string,
            meta: Record<string, string> = {},
            backendKind: 'tynn' | 'aionima' = 'tynn',
        ) =>
            ipcRenderer.invoke('tynn:submit-feedback', projectId, message, meta, backendKind),
        captureWish: (
            projectId: string,
            content: string,
            backendKind: 'tynn' | 'aionima' = 'tynn',
        ) =>
            ipcRenderer.invoke(
                'tynn:capture-wish',
                projectId,
                content,
                backendKind,
            ),
        inbox: () => ipcRenderer.invoke('tynn:inbox'),
        openInBrowser: (
            path: string,
            backendKind: 'tynn' | 'aionima' = 'tynn',
        ) => ipcRenderer.invoke('tynn:open-in-browser', path, backendKind),
        // Auto-provisioning: link a workspace to a Tynn project, read its
        // provision status (no mint), or provision/refresh (mint + write config).
        link: (
            workspacePath: string,
            link: { host?: string; owner?: string; project?: string; projectId?: string },
        ) => ipcRenderer.invoke('tynn:link', workspacePath, link),
        provisionStatus: (workspacePath: string) =>
            ipcRenderer.invoke('tynn:provision-status', workspacePath),
        provision: (workspacePath: string, force = false) =>
            ipcRenderer.invoke('tynn:provision', workspacePath, force),
        /** Clear the workspace's Tynn project link (drops the project.json block). */
        unlink: (workspacePath: string) =>
            ipcRenderer.invoke('tynn:unlink', workspacePath),
        /** Probe this workspace's Tynn MCP endpoint (read-only) — see
         *  main/mcp/tynn-health.ts. Also broadcast on `tynn-health:update`. */
        health: (workspaceId: string, workspacePath: string, workspaceName: string) =>
            ipcRenderer.invoke('tynn:health', workspaceId, workspacePath, workspaceName),
        /** The last probe results, per workspace id — no re-probe. */
        healthAll: () => ipcRenderer.invoke('tynn:health-all'),
        // Ops-project repo auto-management.
        opsPlan: (workspacePath: string) =>
            ipcRenderer.invoke('tynn:ops-plan', workspacePath),
        opsApply: (
            workspacePath: string,
            approved: {
                add?: Array<{ name: string; url: string; projectId: string }>;
                remove?: string[];
            },
        ) => ipcRenderer.invoke('tynn:ops-apply', workspacePath, approved),
        // Ops-project WORKSPACE provisioning.
        opsProvisionPlan: (workspacePath: string) =>
            ipcRenderer.invoke('tynn:ops-provision-plan', workspacePath),
        opsProvisionApply: (
            workspacePath: string,
            targets: Array<{
                projectId: string;
                name: string;
                slug: string;
                cloneUrl: string;
            }>,
        ) => ipcRenderer.invoke('tynn:ops-provision-apply', workspacePath, targets),
        opsAutoProvisionGet: () =>
            ipcRenderer.invoke('tynn:ops-auto-provision:get'),
        opsAutoProvisionSet: (on: boolean) =>
            ipcRenderer.invoke('tynn:ops-auto-provision:set', on),
    },

    tynnHost: {
        get: () => ipcRenderer.invoke('tynn-host:get'),
    },

    app: {
        hideCapture: () => ipcRenderer.invoke('app:hide-capture'),
        getCurrentProject: () => ipcRenderer.invoke('app:get-current-project'),
        /** The user's home directory (for the synthetic System Workspace). */
        homeDir: () => ipcRenderer.invoke('app:home-dir') as Promise<string>,
        genieOsWorkspace: () => ipcRenderer.invoke('app:genie-os-workspace') as Promise<{ path: string }>,
        syncGenieOs: (remoteUrl: string) => ipcRenderer.invoke('app:genie-os-sync', remoteUrl) as Promise<{ ok: true; path: string }>,
        showSettings: (fromRemote?: boolean) =>
            ipcRenderer.invoke('app:show-settings', fromRemote),
        showDocs: () => ipcRenderer.invoke('app:show-docs'),
        showMain: () => ipcRenderer.invoke('app:show-main'),
        openStage: (workspaceId?: string) =>
            ipcRenderer.invoke('app:open-stage', workspaceId),
        quit: () => ipcRenderer.invoke('app:quit'),
        /**
         * Reply to the manual-quit terminal confirmation (see
         * on.confirmQuitTerminals). `confirmed:false` aborts the quit; otherwise
         * `keepIds` are the host terminals to LEAVE RUNNING — every other live one
         * is killed before quit. Fire-and-forget `send` (main is just listening),
         * not invoke, since the main side completes the quit on its own.
         */
        quitDecision: (payload: { confirmed: boolean; keepIds: string[] }) =>
            ipcRenderer.send('app:quit-decision', payload),
        autostart: {
            get: () =>
                ipcRenderer.invoke('app:autostart:get') as Promise<{
                    enabled: boolean;
                    supported: boolean;
                    platform: NodeJS.Platform;
                }>,
            set: (enabled: boolean) =>
                ipcRenderer.invoke('app:autostart:set', enabled) as Promise<{
                    enabled: boolean;
                }>,
        },
    },

    shell: {
        /**
         * Open an http/https URL in the OS default browser. Used by the
         * terminal's clickable web links. Main re-validates the scheme, so a
         * non-http(s) URL resolves `{ ok: false }` and opens nothing.
         */
        openExternal: (url: string) =>
            ipcRenderer.invoke('shell:open-external', url) as Promise<{
                ok: boolean;
            }>,
    },

    docs: {
        list: () =>
            ipcRenderer.invoke('docs:list') as Promise<
                Array<{ slug: string; title: string }>
            >,
        read: (slug: string) =>
            ipcRenderer.invoke('docs:read', slug) as Promise<string | null>,
    },

    process: {
        start: (id: string) => ipcRenderer.invoke('process:start', id),
        stop: (id: string) => ipcRenderer.invoke('process:stop', id),
        restart: (id: string) => ipcRenderer.invoke('process:restart', id),
        statuses: () =>
            ipcRenderer.invoke('process:statuses') as Promise<
                Record<string, string>
            >,
        log: (id: string) =>
            ipcRenderer.invoke('process:log', id) as Promise<string>,
        clearLog: (id: string) =>
            ipcRenderer.invoke('process:clear-log', id) as Promise<{ ok: boolean }>,
        list: () => ipcRenderer.invoke('process:list'),
    },

    /** Scheduled tasks — a Process with `meta.schedule`. The schedule itself is
     *  edited through terminalSpec.update (it lives on the spec's meta); these
     *  are the runtime-only bits the Host owns. */
    schedule: {
        /** Per-task next-run instant + human description, keyed by spec id. */
        info: () =>
            ipcRenderer.invoke('schedule:info') as Promise<
                Record<string, { nextAt: number | null; description: string }>
            >,
        runNow: (id: string) =>
            ipcRenderer.invoke('schedule:run-now', id) as Promise<{ ok: boolean }>,
    },

    terminalSpec: {
        list: () => ipcRenderer.invoke('terminal-spec:list'),
        create: (input: {
            id: string;
            workspace_id: string | null;
            label: string;
            cwd: string;
            shell?: string | null;
            args?: string[];
            env?: Record<string, string>;
            type?: 'terminal' | 'code';
            meta?: Record<string, unknown>;
        }) => ipcRenderer.invoke('terminal-spec:create', input),
        update: (id: string, patch: Record<string, unknown>) =>
            ipcRenderer.invoke('terminal-spec:update', id, patch),
        remove: (id: string) => ipcRenderer.invoke('terminal-spec:delete', id),
        get: (id: string) => ipcRenderer.invoke('terminal-spec:get', id),
        touch: (id: string) => ipcRenderer.invoke('terminal-spec:touch', id),
        /** Persist the grid's drag-reorder: the full ordered spec-id list for
         *  one workspace (index → sort_order). */
        reorder: (ids: string[]) => ipcRenderer.invoke('terminal-spec:reorder', ids),
        /** Create an AI-TUI terminal from the split Add-Terminal button — spawns a
         *  headless agent terminal (captured chat-session id + AgentInbox identity)
         *  and launches it. Returns the created spec. */
        createAgent: (input: {
            workspace_id: string;
            agent: 'claude' | 'codex' | 'kiwi' | 'genie' | 'custom';
            command?: string;
            cwd?: string;
            label?: string;
            purpose: string;
            scope: AgentInboxScope;
            scope_workspaces?: string[];
            wake_on_dm?: boolean;
            issuewatch_handle?: boolean;
            issuewatch_action?: 'notify' | 'wake';
        }) => ipcRenderer.invoke('terminal-spec:create-agent', input),
        /** Gracefully restart an agent terminal (reconnect its TUI to the current
         *  MCP rig, resuming the conversation). Returns the old→new terminal ids,
         *  or `{ ok: false, error }` when the agent isn't resumable. */
        restartAgent: (id: string) => ipcRenderer.invoke('terminal-spec:restart-agent', id),
    },

    /** AgentInbox — the local inter-agent messaging network's human panel. */
    agentPulse: {
        /** Last-60s per-workspace byte buckets — fetched once when the workspace
         *  menu opens to backfill each sparkline; live `on.agentPulse` pushes
         *  advance it from there. */
        snapshot: () => ipcRenderer.invoke('agent-pulse:snapshot'),
    },
    /** PendingQuestions inbox — the top-bar question icon's grouped list + answers. */
    questions: {
        /** Grouped pending questions (by workspace) + the total badge count. */
        list: () => ipcRenderer.invoke('questions:list'),
        /** Answer a pending question by id — routes a modal-queue answer to the
         *  blocked agent, or clears a DND-deferred one. */
        answer: (id: string, answers: Array<{ header: string; selected: string[]; note: string }>) =>
            ipcRenderer.invoke('questions:answer', id, answers),
    },
    agentInbox: {
        /** All agents in this Genie (the human owns the workstation → no scope filter). */
        directory: () => ipcRenderer.invoke('agentinbox:directory'),
        /** Every non-empty channel (`slug:purpose`). */
        /** Every DM thread with messages — human↔agent AND agent↔agent. */
        dmThreads: () => ipcRenderer.invoke('agentinbox:dm-threads'),
        /** A channel log (`channelKey`), an arbitrary DM pair (`dmPair`), or the
         *  human↔agent DM thread (`agentId`). */
        history: (opts: {
            agentId?: string;
            dmPair?: [string, string];
            limit?: number;
            before?: number;
        }) => ipcRenderer.invoke('agentinbox:history', opts),
        /** Post as the human — to a channel (`channelKey`) or an agent (`toAgentId`),
         *  optionally with files. Attachment BYTES ride the call (base64, straight
         *  from the browser file input), so a remote window attaches from the
         *  human's OWN machine and the panel needs no filesystem access. */
        post: (input: {
            toAgentId?: string;
            text: string;
            attachments?: Array<{ filename: string; base64: string }>;
        }) => ipcRenderer.invoke('agentinbox:post', input),
        sendPendingNudge: (terminalId: string) =>
            ipcRenderer.invoke('agentinbox:send-pending-nudge', terminalId),
        /** An attachment's bytes, for the panel to save client-side. Reads Genie's
         *  own blob store — no filesystem egress. */
        attachmentBytes: (attachmentId: string) =>
            ipcRenderer.invoke('agentinbox:attachment-bytes', attachmentId),
        /** AGENT-LAG — messages this workstation's agents haven't received/ACKed.
         *  The header badge's seed; `on.agentInboxLag` keeps it live. */
        lag: () => ipcRenderer.invoke('agentinbox:lag'),
        /** Wipe a channel's history (the panel log + the durable rows). */
        /** Delete a whole DM thread by its pair key (`<idA>|<idB>`, sorted). */
        deleteThread: (pairKey: string) =>
            ipcRenderer.invoke('agentinbox:delete-thread', pairKey),
        /** Wipe MANY conversations in one call (multi-select mass delete). */
        wipeMany: (input: { pairKeys?: string[] }) =>
            ipcRenderer.invoke('agentinbox:wipe-many', input),
        /** Edit an agent's purpose/scope (re-keys its channel + re-emits presence). */
        updateChannel: (
            specId: string,
            patch: {
                purpose?: string;
                scope?: AgentInboxScope;
                scope_workspaces?: string[];
                wake_on_dm?: boolean;
                issuewatch_handle?: boolean;
                issuewatch_action?: 'notify' | 'wake';
            },
        ) => ipcRenderer.invoke('agentinbox:update-channel', specId, patch),
    },

    /** Knowledge Graph — Genie's workstation-wide local knowledge/memory store.
     *  CRUD here stamps source 'user'; agents write via the `knowledge` MCP tool
     *  (source 'agent'). Both share one workstation store. */
    knowledge: {
        /** Keyword (FTS) search → ranked `{ id, title, snippet, score, tags }[]`. */
        search: (query: string, opts?: { limit?: number; tags?: string[] }) =>
            ipcRenderer.invoke('knowledge:search', query, opts),
        /** Recent nodes (optional `tag`, `limit`). */
        list: (opts?: { tag?: string; limit?: number }) =>
            ipcRenderer.invoke('knowledge:list', opts),
        /** One node by id (with its resolved linked node ids), or null. */
        get: (id: string) => ipcRenderer.invoke('knowledge:get', id),
        /** Create a node (source 'user'); returns the created node. */
        add: (input: { title: string; body?: string; tags?: string[]; links?: string[] }) =>
            ipcRenderer.invoke('knowledge:add', input),
        /** Patch a node; returns the updated node (or null when unknown). */
        update: (
            id: string,
            patch: { title?: string; body?: string; tags?: string[]; links?: string[] },
        ) => ipcRenderer.invoke('knowledge:update', id, patch),
        /** Delete a node; returns `{ ok }`. */
        delete: (id: string) => ipcRenderer.invoke('knowledge:delete', id),
        /** The whole graph — `{ nodes, edges }`. */
        graph: () => ipcRenderer.invoke('knowledge:graph'),
        /** Open (or focus) the Knowledge Graph window. */
        openWindow: () => ipcRenderer.invoke('knowledge:open-window'),
    },

    files: {
        listTree: (
            workspacePath: string,
            opts?: { maxDepth?: number; maxEntries?: number; root?: string; system?: boolean },
        ) => ipcRenderer.invoke('files:list-tree', workspacePath, opts),
        read: (workspacePath: string, relPath: string, system?: boolean) =>
            ipcRenderer.invoke('files:read', workspacePath, relPath, system) as Promise<{
                content: string;
                truncated: boolean;
            }>,
        write: (workspacePath: string, relPath: string, content: string, system?: boolean) =>
            ipcRenderer.invoke('files:write', workspacePath, relPath, content, system) as Promise<{
                ok: boolean;
            }>,
        createFile: (workspacePath: string, relPath: string, system?: boolean) =>
            ipcRenderer.invoke('files:create-file', workspacePath, relPath, system) as Promise<{
                ok: boolean;
            }>,
        createFolder: (workspacePath: string, relPath: string, system?: boolean) =>
            ipcRenderer.invoke('files:create-folder', workspacePath, relPath, system) as Promise<{
                ok: boolean;
            }>,
        rename: (workspacePath: string, fromRel: string, toRel: string, system?: boolean) =>
            ipcRenderer.invoke('files:rename', workspacePath, fromRel, toRel, system) as Promise<{
                ok: boolean;
            }>,
        duplicate: (workspacePath: string, relPath: string, system?: boolean) =>
            ipcRenderer.invoke('files:duplicate', workspacePath, relPath, system) as Promise<{
                ok: boolean;
                relPath: string;
            }>,
        /** Copy an external OS path (e.g. dragged from Explorer/Finder) into a
         *  workspace folder ('' = root). Returns the new workspace-relative path. */
        importExternal: (workspacePath: string, srcAbs: string, destFolderRel: string, system?: boolean) =>
            ipcRenderer.invoke('files:import-external', workspacePath, srcAbs, destFolderRel, system) as Promise<{
                ok: boolean;
                relPath: string;
            }>,
        /** Resolve the OS path of a File from an external drag. Electron 42 removed
         *  File.path; webUtils.getPathForFile is the supported replacement. */
        pathForFile: (file: File): string => webUtils.getPathForFile(file),
        /** Read a LOCAL absolute file's bytes (base64) — the client half of a remote
         *  external-file drop: the bytes are shipped to the host to write into a
         *  workspace folder (the host can't read the client's disk). */
        readExternalBytes: (absPath: string) =>
            ipcRenderer.invoke('files:read-external-bytes', absPath) as Promise<{
                name: string;
                base64: string;
            }>,
        delete: (workspacePath: string, relPath: string, system?: boolean) =>
            ipcRenderer.invoke('files:delete', workspacePath, relPath, system) as Promise<{
                ok: boolean;
            }>,
        gitStatus: (workspacePath: string, opts?: { ignored?: boolean }) =>
            ipcRenderer.invoke('files:git-status', workspacePath, opts) as Promise<
                Record<string, string>
            >,
        /** Start live fs-watching of a workspace root; drives on.treeChanged. */
        watch: (workspacePath: string) =>
            ipcRenderer.invoke('files:watch', workspacePath) as Promise<{ ok: boolean }>,
        /** Stop live fs-watching (ref-counted; closes on the last unwatch). */
        unwatch: (workspacePath: string) =>
            ipcRenderer.invoke('files:unwatch', workspacePath) as Promise<{ ok: boolean }>,
    },

    terminal: {
        create: (opts: {
            id: string;
            cwd: string;
            shell?: string;
            args?: string[];
            cols?: number;
            rows?: number;
            env?: Record<string, string>;
        }) =>
            ipcRenderer.invoke('terminal:create', opts) as Promise<{
                id: string;
                pid: number;
                shell: string;
                existing: boolean;
                scrollback: string;
                snapshot?: { serialized: string; savedAt: number };
            }>,
        write: (id: string, data: string) =>
            ipcRenderer.invoke('terminal:write', id, data) as Promise<boolean>,
        resize: (id: string, cols: number, rows: number) =>
            ipcRenderer.invoke('terminal:resize', id, cols, rows) as Promise<boolean>,
        /** Persist a SerializeAddon snapshot of this terminal's buffer (Tier 1). */
        snapshot: (id: string, serialized: string) =>
            ipcRenderer.invoke('terminal:snapshot', id, serialized) as Promise<boolean>,
        /** Release this window's view of the pty without killing it. */
        detach: (id: string) =>
            ipcRenderer.invoke('terminal:detach', id) as Promise<boolean>,
        /**
         * Tier 2: keep a pty alive on zero owners (disable) or release it
         * (enable/delete). MUST be called with true BEFORE the last detach.
         * Refused when retaining would exceed the cap.
         */
        setRetained: (id: string, retained: boolean) =>
            ipcRenderer.invoke('terminal:set-retained', id, retained) as Promise<{
                ok: boolean;
                retainedCount: number;
                max: number;
                reason?: string;
            }>,
        kill: (id: string) =>
            ipcRenderer.invoke('terminal:kill', id) as Promise<boolean>,
        list: () =>
            ipcRenderer.invoke('terminal:list') as Promise<
                Array<{ id: string; pid: number; shell: string }>
            >,
        // Agent-integration MCP: clear a terminal's attention glow (imDone)
        // when the user focuses it. Broadcasts to every window so the rail,
        // flyout row, and panel border all stop pulsing.
        clearAttention: (id: string) =>
            ipcRenderer.invoke('terminal:clear-attention', id) as Promise<void>,
    },

    // Agent-integration MCP: the ForceTheQuestion modal. Main pushes a question
    // payload via `ask:show`; the modal replies with answer/cancel.
    ask: {
        onShow: (
            cb: (payload: {
                id: string;
                /** The requesting workspace's display name (for the modal title). */
                workspaceLabel?: string;
                questions: Array<{
                    header: string;
                    question: string;
                    multiSelect?: boolean;
                    options: Array<{ label: string; description?: string }>;
                }>;
                /** How many other requests are still queued behind this one. */
                queued?: number;
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: any) => cb(payload);
            ipcRenderer.on('ask:show', handler);
            return () => ipcRenderer.off('ask:show', handler);
        },
        // PendingQuestions v2 — the FULL pending queue (priority-ordered), so the
        // modal can list every pending request and let the user pick which to answer
        // / defer. `answer(id,…)` / `cancel(id)` already act on any id.
        onQueue: (
            cb: (payload: {
                pending: Array<{
                    id: string;
                    workspaceLabel?: string;
                    questions: Array<{
                        header: string;
                        question: string;
                        multiSelect?: boolean;
                        options: Array<{ label: string; description?: string }>;
                    }>;
                    index: number;
                    priority?: 'low' | 'normal' | 'high' | 'urgent';
                    remoteHost?: string;
                }>;
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: any) => cb(payload);
            ipcRenderer.on('ask:queue', handler);
            return () => ipcRenderer.off('ask:queue', handler);
        },
        answer: (
            id: string,
            answers: Array<{
                header: string;
                question: string;
                selected: string[];
                note: string;
            }>,
        ) => ipcRenderer.invoke('ask:answer', id, answers) as Promise<void>,
        cancel: (id: string) => ipcRenderer.invoke('ask:cancel', id) as Promise<void>,
        /** Tell main the show-listener is attached → main delivers the payload. */
        ready: () => ipcRenderer.invoke('ask:ready') as Promise<void>,
        /** Close this modal window regardless of state (resolves cancelled). */
        dismiss: () => ipcRenderer.invoke('ask:dismiss') as Promise<void>,
    },

    on: {
        authChanged: (
            cb: (payload: {
                backend?: 'tynn' | 'aionima';
                signedIn: boolean;
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: any) => {
                if (typeof payload === 'boolean') cb({ signedIn: payload });
                else cb(payload);
            };
            ipcRenderer.on('auth:changed', handler);
            return () => ipcRenderer.off('auth:changed', handler);
        },
        inboxUpdated: (cb: (payload: { count: number }) => void) => {
            const handler = (_e: unknown, payload: { count: number }) =>
                cb(payload);
            ipcRenderer.on('inbox:updated', handler);
            return () => ipcRenderer.off('inbox:updated', handler);
        },
        /** PendingQuestions — a question was added / answered / deferred. Carries
         *  `{count, workspaces}` so the badge sets it directly (push-driven, like the
         *  AgentInbox); forwarded so the renderer needn't re-fetch (genie #60). */
        questionsChanged: (
            cb: (payload?: { count: number; workspaces: number }) => void,
        ) => {
            const handler = (_e: unknown, payload?: { count: number; workspaces: number }) =>
                cb(payload);
            ipcRenderer.on('questions:changed', handler);
            return () => ipcRenderer.off('questions:changed', handler);
        },
        // Customization: play a notification chime. The payload carries a
        // `sound` descriptor resolved main-side from the per-alert setting:
        // synth (renderer synthesizes the tone), asset (a bundled wav), or data
        // (a custom file as a data-URL). A legacy payload with no descriptor
        // falls back to synth.
        notifySound: (
            cb: (payload: {
                kind: string;
                sound?:
                    | { mode: 'synth' }
                    | { mode: 'asset'; name: string }
                    | { mode: 'data'; dataUrl: string };
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: any) => cb(payload);
            ipcRenderer.on('notify:sound', handler);
            return () => ipcRenderer.off('notify:sound', handler);
        },
        // The tray's "Task Manager…" item asks the master window to open the
        // cross-workspace process panel.
        openTaskManager: (cb: () => void) => {
            const handler = () => cb();
            ipcRenderer.on('open-task-manager', handler);
            return () => ipcRenderer.off('open-task-manager', handler);
        },
        // Issue Watch: per-workspace unread counts (by type) + per-workspace
        // worst read detail + whether the GitHub session is dead, changed.
        issueWatchUpdate: (
            cb: (payload: {
                counts: Record<string, TypeCounts & { knownToServer: boolean }>;
                errors?: Record<string, unknown>;
                needsReauth?: boolean;
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: any) => cb(payload);
            ipcRenderer.on('issue-watch:update', handler);
            return () => ipcRenderer.off('issue-watch:update', handler);
        },
        /** A Tynn MCP health probe finished (pushed — never polled). */
        tynnHealthUpdate: (cb: (payload: TynnHealth) => void) => {
            const handler = (_e: unknown, payload: TynnHealth) => cb(payload);
            ipcRenderer.on('tynn-health:update', handler);
            return () => ipcRenderer.off('tynn-health:update', handler);
        },
        terminalData: (cb: (payload: { id: string; data: string }) => void) => {
            const handler = (_e: unknown, payload: { id: string; data: string }) =>
                cb(payload);
            ipcRenderer.on('terminal:data', handler);
            return () => ipcRenderer.off('terminal:data', handler);
        },
        terminalExit: (
            cb: (payload: { id: string; exitCode: number; signal?: number }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: { id: string; exitCode: number; signal?: number },
            ) => cb(payload);
            ipcRenderer.on('terminal:exit', handler);
            return () => ipcRenderer.off('terminal:exit', handler);
        },
        /** Main asks every window to serialize its terminals before quit (Tier 1). */
        terminalSnapshotRequest: (cb: () => void) => {
            const handler = () => cb();
            ipcRenderer.on('terminal:snapshot-request', handler);
            return () => ipcRenderer.off('terminal:snapshot-request', handler);
        },
        /** Live pty count broadcast (Tier 2 resource awareness). */
        terminalCount: (cb: (payload: { count: number }) => void) => {
            const handler = (_e: unknown, payload: { count: number }) => cb(payload);
            ipcRenderer.on('terminal:count', handler);
            return () => ipcRenderer.off('terminal:count', handler);
        },
        /** A setting changed (payload = the changed keys) — live UI re-reads
         *  without a restart (e.g. a terminal's copy/paste mode). */
        settingsChanged: (cb: (changedKeys: string[]) => void) => {
            const handler = (_e: unknown, keys: string[]) => cb(keys);
            ipcRenderer.on('settings:changed', handler);
            return () => ipcRenderer.off('settings:changed', handler);
        },
        /** Agent-integration MCP: a terminal asked for attention (imDone) or it
         *  was cleared. The renderer pulses/clears that terminal's glow. */
        terminalAttention: (
            cb: (payload: { id: string; on: boolean }) => void,
        ) => {
            const handler = (_e: unknown, payload: { id: string; on: boolean }) =>
                cb(payload);
            ipcRenderer.on('terminal:attention', handler);
            return () => ipcRenderer.off('terminal:attention', handler);
        },
        agentThumbsUp: (
            cb: (payload: {
                agentId: string;
                terminalId: string;
                workspaceId: string;
                reason: 'boot' | 'ack' | 'shutdown';
                to?: string;
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
            ipcRenderer.on('agent:thumbs-up', handler);
            return () => ipcRenderer.off('agent:thumbs-up', handler);
        },
        pluginPanelOpen: (
            cb: (payload: {
                workspaceId: string;
                pluginId: string;
                panelId: string;
                activeItemId?: string;
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
            ipcRenderer.on('plugin-panel:open', handler);
            return () => ipcRenderer.off('plugin-panel:open', handler);
        },
        /** The imDone toast was clicked: go to the terminal that finished —
         *  activate its workspace and surface its panel. */
        terminalReveal: (
            cb: (payload: { id: string; workspaceId: string | null }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: { id: string; workspaceId: string | null },
            ) => cb(payload);
            ipcRenderer.on('terminal:reveal', handler);
            return () => ipcRenderer.off('terminal:reveal', handler);
        },
        /** Agent-integration MCP: pulse a workspace ROW (a terminal in it called
         *  imDone) — a sidebar-level "something finished here" cue, fired
         *  alongside the per-terminal attention glow. */
        workspacePulse: (cb: (payload: { workspaceId: string }) => void) => {
            const handler = (_e: unknown, payload: { workspaceId: string }) =>
                cb(payload);
            ipcRenderer.on('workspace:pulse', handler);
            return () => ipcRenderer.off('workspace:pulse', handler);
        },
        /** AgentPulse — per-workspace real-time terminal-activity. `active` drives
         *  the rail-icon glow; `bytes` feeds the live 1-minute sparkline. */
        agentPulse: (
            cb: (payload: { workspaceId: string; active: boolean; bytes: number }) => void,
        ) => {
            const handler = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
            ipcRenderer.on('agent-pulse', handler);
            return () => ipcRenderer.off('agent-pulse', handler);
        },
        /** A workspace was "opened" (tray / menu / MCP) — the master window
         *  should focus it and open its in-app editor scoped to the folder. */
        workspaceOpen: (cb: (payload: { workspaceId: string }) => void) => {
            const handler = (_e: unknown, payload: { workspaceId: string }) =>
                cb(payload);
            ipcRenderer.on('workspace:open', handler);
            return () => ipcRenderer.off('workspace:open', handler);
        },
        /** openFileForUser (MCP): open a file in the workspace's built-in editor,
         *  reusing an open Code panel or opening a new one. The renderer applies
         *  the reuse-vs-new logic and replies via editor.openFileResult(requestId). */
        editorOpenFile: (
            cb: (payload: {
                requestId: string;
                workspaceId: string;
                root: string;
                relPath: string;
                line?: number;
                pluginEditor?: {
                    pluginId: string;
                    editorId: string;
                    fancyExport: string;
                    fancyPackage: string;
                    fancyVersion: string;
                };
            }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: {
                    requestId: string;
                    workspaceId: string;
                    root: string;
                    relPath: string;
                    line?: number;
                    pluginEditor?: {
                        pluginId: string;
                        editorId: string;
                        fancyExport: string;
                        fancyPackage: string;
                        fancyVersion: string;
                    };
                },
            ) => cb(payload);
            ipcRenderer.on('editor:open-file', handler);
            return () => ipcRenderer.off('editor:open-file', handler);
        },
        /** A background Process changed status (running/stopped/crashed/…). */
        processStatus: (
            cb: (payload: { id: string; status: string }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: { id: string; status: string },
            ) => cb(payload);
            ipcRenderer.on('process:status', handler);
            return () => ipcRenderer.off('process:status', handler);
        },
        /** A scheduled task was armed, fired, or disarmed — its next run moved. */
        scheduleNext: (
            cb: (payload: {
                id: string;
                nextAt: number | null;
                description: string | null;
            }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: { id: string; nextAt: number | null; description: string | null },
            ) => cb(payload);
            ipcRenderer.on('schedule:next', handler);
            return () => ipcRenderer.off('schedule:next', handler);
        },
        /** The set of terminal specs changed outside the renderer's own edits
         *  (e.g. a process created via the MCP manageProcess tool) — re-fetch
         *  terminal-spec:list so the Processes list stays live. */
        terminalSpecsChanged: (cb: () => void) => {
            const handler = () => cb();
            ipcRenderer.on('terminal-spec:changed', handler);
            return () => ipcRenderer.off('terminal-spec:changed', handler);
        },
        /** AgentInbox presence — an agent joined/changed (full info), or LEFT
         *  (`{ agentId, status:'offline', left:true }`). The panel updates its
         *  directory + channel list live. */
        agentInboxPresence: (cb: (payload: unknown) => void) => {
            const handler = (_e: unknown, payload: unknown) => cb(payload);
            ipcRenderer.on('agentinbox:presence', handler);
            return () => ipcRenderer.off('agentinbox:presence', handler);
        },
        /** AgentInbox message preview — a DM or channel message was delivered.
         *  The panel appends it to the live stream (history has the full text). */
        agentInboxMessage: (
            cb: (payload: {
                kind: 'dm' | 'channel';
                channelKey?: string;
                toAgentId?: string;
                from: string;
                fromLabel: string;
                seq: number;
                ts: number;
                preview: string;
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
            ipcRenderer.on('agentinbox:message', handler);
            return () => ipcRenderer.off('agentinbox:message', handler);
        },
        /** AgentInbox AGENT-LAG level (genie #64) — how many messages the agents
         *  haven't received/ACKed. Drives the header badge (a LEVEL: it only fires
         *  on a transition). NOT the human's unread, which is client-side. */
        agentInboxLag: (cb: (payload: { count: number }) => void) => {
            const handler = (_e: unknown, payload: { count: number }) => cb(payload);
            ipcRenderer.on('agentinbox:lag', handler);
            return () => ipcRenderer.off('agentinbox:lag', handler);
        },
        /** AgentInbox: the human WIPED a conversation (genie #64) — the panel drops
         *  its cached history/activity for that channel or DM pair. */
        agentInboxCleared: (cb: (payload: { scope: 'channel' | 'dm'; key: string }) => void) => {
            const handler = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
            ipcRenderer.on('agentinbox:cleared', handler);
            return () => ipcRenderer.off('agentinbox:cleared', handler);
        },
        /** AgentInbox escalation (Track C) — an urgent DM went unACKed past the
         *  window, or (`resolved`) was finally received. The panel shows/clears a
         *  "waiting on <agent>" oversight alert. */
        agentInboxEscalation: (
            cb: (payload: {
                messageId: string;
                targetAgentId: string;
                targetLabel?: string;
                fromLabel?: string;
                preview?: string;
                sinceTs?: number;
                resolved?: boolean;
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
            ipcRenderer.on('agentinbox:escalation', handler);
            return () => ipcRenderer.off('agentinbox:escalation', handler);
        },
        /** The Knowledge Graph changed (a node added/updated/deleted or an edge
         *  linked — incl. an AGENT's write via the `knowledge` MCP tool). The
         *  Knowledge Graph window re-fetches to stay live. */
        knowledgeChanged: (
            cb: (payload: { action: 'add' | 'update' | 'delete' | 'link'; id?: string }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: { action: 'add' | 'update' | 'delete' | 'link'; id?: string },
            ) => cb(payload);
            ipcRenderer.on('knowledge:changed', handler);
            return () => ipcRenderer.off('knowledge:changed', handler);
        },
        /** A file was created/renamed/deleted on disk in a watched workspace
         *  (outside the renderer's own edits — an agent, a git op, a tool). The
         *  Code panel re-lists its tree. Debounced + ignore-filtered in main. */
        treeChanged: (
            cb: (payload: { workspacePath: string; changed: string[] | null }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: { workspacePath: string; changed?: string[] | null },
            ) => cb({ workspacePath: payload.workspacePath, changed: payload.changed ?? null });
            ipcRenderer.on('files:tree-changed', handler);
            return () => ipcRenderer.off('files:tree-changed', handler);
        },
        /** The set of workspaces changed outside the renderer's own edits (e.g.
         *  workspaces provisioned via the MCP provisionWorkspaces tool) —
         *  re-fetch workspaces:list so the rail stays live. */
        workspacesChanged: (cb: () => void) => {
            const handler = () => cb();
            ipcRenderer.on('workspaces:changed', handler);
            return () => ipcRenderer.off('workspaces:changed', handler);
        },
        /** A dev site or service was configured, started, stopped or removed
         *  (#234) — the rail's sites icon and any open Site Manager re-read
         *  `dev:site` / `dev:service`. Push, not a poll: a site can come up
         *  minutes after boot (an image pull, or a Dockerfile build). */
        devServerChanged: (cb: () => void) => {
            const handler = () => cb();
            ipcRenderer.on('dev-server:changed', handler);
            return () => ipcRenderer.off('dev-server:changed', handler);
        },
        /** A live START tick for one dev site (Gap 2): `pulling → building →
         *  starting → ready|failed`, carrying the streaming build/pull log — so an
         *  open Site Manager card reflects a site coming up the moment Start is
         *  clicked, not only when the whole build finishes. High-frequency (a
         *  chunk per log line), separate from the coarse `devServerChanged`. */
        devSiteProgress: (
            cb: (payload: {
                workspaceId: string;
                siteId: string;
                name: string;
                genName: string;
                phase: 'pulling' | 'building' | 'starting' | 'ready' | 'failed';
                log?: string;
                error?: string;
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
            ipcRenderer.on('dev-server:site-progress', handler);
            return () => ipcRenderer.off('dev-server:site-progress', handler);
        },
        /** Per-tool progress from an in-flight toolchain install (#240): a `start`
         *  then a `done` (with status) for each tool the wizard is installing. */
        toolchainProgress: (
            cb: (payload: {
                tool: string;
                phase: 'start' | 'done';
                status?: 'succeeded' | 'failed' | 'skipped';
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
            ipcRenderer.on('toolchain:progress', handler);
            return () => ipcRenderer.off('toolchain:progress', handler);
        },
        /** Tier 3 detached-host status — fired when the host is unavailable and
         *  Genie falls back to in-process. The renderer surfaces a non-fatal toast. */
        terminalHostStatus: (
            cb: (payload: { message: string; level: 'info' | 'warn' }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: { message: string; level: 'info' | 'warn' },
            ) => cb(payload);
            ipcRenderer.on('terminal:host-status', handler);
            return () => ipcRenderer.off('terminal:host-status', handler);
        },
        /** A message landed for an agent whose input box Genie would not touch, so
         *  the notice was APPENDED there without being submitted. The renderer
         *  raises a top-centre toast — otherwise it is just mystery text in
         *  someone's prompt and the message looks like it never arrived.
         *
         *  The payload NAMES the terminal it is about (see
         *  `AgentInboxIncomingPayload`): this used to carry `{ id }` alone and the
         *  toast said "this agent", which meant whichever one had focus — usually
         *  not the addressee. */
        agentInboxIncoming: (cb: (payload: AgentInboxIncomingPayload) => void) => {
            const handler = (_e: unknown, payload: AgentInboxIncomingPayload) => cb(payload);
            ipcRenderer.on('agentinbox:incoming', handler);
            return () => ipcRenderer.off('agentinbox:incoming', handler);
        },
        /** Host-loss recovery (genie#203): main asks the renderer to remount these
         *  terminals so their create() rejoins the respawned host and replays
         *  scrollback after a mid-session pty-host death. */
        terminalRecover: (cb: (payload: TerminalRecoverPayload) => void) => {
            const handler = (_e: unknown, payload: TerminalRecoverPayload) => cb(payload);
            ipcRenderer.on(TERMINAL_RECOVER_CHANNEL, handler);
            return () => ipcRenderer.off(TERMINAL_RECOVER_CHANNEL, handler);
        },
        /** Host-loss recovery status (genie#203): 'recovering' → 'recovered' |
         *  'degraded', for the recovery banner. */
        terminalRecoveryStatus: (
            cb: (payload: TerminalRecoveryStatusPayload) => void,
        ) => {
            const handler = (_e: unknown, payload: TerminalRecoveryStatusPayload) => cb(payload);
            ipcRenderer.on(TERMINAL_RECOVERY_STATUS_CHANNEL, handler);
            return () => ipcRenderer.off(TERMINAL_RECOVERY_STATUS_CHANNEL, handler);
        },
        /**
         * Manual-quit terminal confirmation (T3). Main asks the master window to
         * confirm which detached terminals to keep running vs shut down before
         * Genie quits. The renderer shows a modal and replies via
         * app.quitDecision(). Payload carries the live host terminals (id + pid +
         * shell); the renderer joins ids → spec label/workspace itself.
         */
        confirmQuitTerminals: (
            cb: (payload: {
                terminals: Array<{ id: string; pid: number; shell: string }>;
                destructive?: boolean;
            }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: {
                    terminals: Array<{ id: string; pid: number; shell: string }>;
                    destructive?: boolean;
                },
            ) => cb(payload);
            ipcRenderer.on('app:confirm-quit-terminals', handler);
            return () => ipcRenderer.off('app:confirm-quit-terminals', handler);
        },
        updaterStatus: (cb: (status: unknown) => void) => {
            const handler = (_e: unknown, payload: unknown) => cb(payload);
            ipcRenderer.on('updater:status', handler);
            return () => ipcRenderer.off('updater:status', handler);
        },
        // GitHub capability status changed (boot check, connect/reconnect,
        // disconnect, explicit recheck). The renderer re-renders the resolve
        // modal + header warning and re-gates features from the payload.
        githubCapabilities: (cb: (payload: any) => void) => {
            const handler = (_e: unknown, payload: any) => cb(payload);
            ipcRenderer.on('github:capabilities-changed', handler);
            return () => ipcRenderer.off('github:capabilities-changed', handler);
        },
        updaterLog: (cb: (payload: { line: string }) => void) => {
            const handler = (_e: unknown, payload: { line: string }) =>
                cb(payload);
            ipcRenderer.on('updater:log', handler);
            return () => ipcRenderer.off('updater:log', handler);
        },
    },
};

contextBridge.exposeInMainWorld('genie', api);

export type GenieApi = typeof api;
