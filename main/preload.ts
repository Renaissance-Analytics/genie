import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { TailscaleStatus } from './tailscale';

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
    ip: string | null;
    port: number | null;
    configuredPort: number;
    url: string | null;
    conflict: boolean;
    tailnetNotDetected: boolean;
    locked: boolean;
    pin: string;
    qrDataUrl: string | null;
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
                Record<string, { issue: number; pr: number; security: number }>
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
    },

    // Mobile remote-control server (Settings → Mobile). Desktop-only — the phone
    // talks to the tailnet HTTP/WS server directly, never through this bridge.
    mobile: {
        status: () => ipcRenderer.invoke('mobile:status') as Promise<MobileStatus>,
        restart: (enabled?: boolean) =>
            ipcRenderer.invoke('mobile:restart', enabled) as Promise<MobileStatus>,
        regeneratePin: () =>
            ipcRenderer.invoke('mobile:regenerate-pin') as Promise<MobileStatus>,
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
                Array<{ hostname: string; peerName: string; ip: string; port: number }>
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
        terminalAttach: (id: string) =>
            ipcRenderer.invoke('remote:terminal-attach', id) as Promise<{ ok: boolean }>,
        terminalInput: (id: string, data: string) =>
            ipcRenderer.invoke('remote:terminal-input', id, data) as Promise<boolean>,
        terminalResize: (id: string, cols: number, rows: number) =>
            ipcRenderer.invoke('remote:terminal-resize', id, cols, rows) as Promise<boolean>,
        terminalDetach: (id: string) =>
            ipcRenderer.invoke('remote:terminal-detach', id) as Promise<{ ok: boolean }>,
        // Hosts picker (local window): open a host's OWN native Floor window
        // (connecting + handling the PIN), and manage the known-hosts list.
        open: (host: { ip: string; port: number; hostname: string }, pin?: string) =>
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
                    connKey: string;
                    connected: boolean;
                }>
            >,
        forget: (connKey: string) =>
            ipcRenderer.invoke('host:forget', connKey) as Promise<{ ok: boolean }>,
        rename: (connKey: string, name: string) =>
            ipcRenderer.invoke('host:rename', connKey, name) as Promise<{ ok: boolean }>,
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
        changelog: (latest: string) =>
            ipcRenderer.invoke('updater:changelog', latest),
    },

    // System clipboard via Electron MAIN (reliable; renderer navigator.clipboard
    // fails silently in a sandboxed window). Terminal copy/paste routes here.
    clipboard: {
        write: (text: string) =>
            ipcRenderer.invoke('clipboard:write', text) as Promise<{ ok: boolean }>,
        read: () => ipcRenderer.invoke('clipboard:read') as Promise<string>,
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
        setProcessApproval: (id: string, require: boolean) =>
            ipcRenderer.invoke('workspaces:set-process-approval', id, require),
        setTerminalApproval: (id: string, require: boolean) =>
            ipcRenderer.invoke('workspaces:set-terminal-approval', id, require),
        setIssuewatchPolicy: (
            id: string,
            policy: 'surface' | 'fix' | 'fix-and-ship',
        ) => ipcRenderer.invoke('workspaces:set-issuewatch-policy', id, policy),
        getIssuewatchGranularity: (id: string) =>
            ipcRenderer.invoke('workspaces:get-issuewatch-granularity', id),
        setIssuewatchGranularity: (id: string, granularity: unknown) =>
            ipcRenderer.invoke('workspaces:set-issuewatch-granularity', id, granularity),
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
        showSettings: () => ipcRenderer.invoke('app:show-settings'),
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
        list: () => ipcRenderer.invoke('process:list'),
    },

    cli: {
        info: () =>
            ipcRenderer.invoke('cli:info') as Promise<{
                shipped: boolean;
                home: string | null;
            }>,
        install: () =>
            ipcRenderer.invoke('cli:install') as Promise<{
                ok: boolean;
                output: string;
            }>,
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
    },

    files: {
        listTree: (
            workspacePath: string,
            opts?: { maxDepth?: number; maxEntries?: number; root?: string },
        ) => ipcRenderer.invoke('files:list-tree', workspacePath, opts),
        read: (workspacePath: string, relPath: string) =>
            ipcRenderer.invoke('files:read', workspacePath, relPath) as Promise<{
                content: string;
                truncated: boolean;
            }>,
        write: (workspacePath: string, relPath: string, content: string) =>
            ipcRenderer.invoke('files:write', workspacePath, relPath, content) as Promise<{
                ok: boolean;
            }>,
        createFile: (workspacePath: string, relPath: string) =>
            ipcRenderer.invoke('files:create-file', workspacePath, relPath) as Promise<{
                ok: boolean;
            }>,
        createFolder: (workspacePath: string, relPath: string) =>
            ipcRenderer.invoke('files:create-folder', workspacePath, relPath) as Promise<{
                ok: boolean;
            }>,
        rename: (workspacePath: string, fromRel: string, toRel: string) =>
            ipcRenderer.invoke('files:rename', workspacePath, fromRel, toRel) as Promise<{
                ok: boolean;
            }>,
        duplicate: (workspacePath: string, relPath: string) =>
            ipcRenderer.invoke('files:duplicate', workspacePath, relPath) as Promise<{
                ok: boolean;
                relPath: string;
            }>,
        /** Copy an external OS path (e.g. dragged from Explorer/Finder) into a
         *  workspace folder ('' = root). Returns the new workspace-relative path. */
        importExternal: (workspacePath: string, srcAbs: string, destFolderRel: string) =>
            ipcRenderer.invoke('files:import-external', workspacePath, srcAbs, destFolderRel) as Promise<{
                ok: boolean;
                relPath: string;
            }>,
        /** Resolve the OS path of a File from an external drag. Electron 42 removed
         *  File.path; webUtils.getPathForFile is the supported replacement. */
        pathForFile: (file: File): string => webUtils.getPathForFile(file),
        delete: (workspacePath: string, relPath: string) =>
            ipcRenderer.invoke('files:delete', workspacePath, relPath) as Promise<{
                ok: boolean;
            }>,
        gitStatus: (workspacePath: string, opts?: { ignored?: boolean }) =>
            ipcRenderer.invoke('files:git-status', workspacePath, opts) as Promise<
                Record<string, string>
            >,
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
                counts: Record<string, { issue: number; pr: number; dependabot: number }>;
                errors?: Record<string, unknown>;
                needsReauth?: boolean;
            }) => void,
        ) => {
            const handler = (_e: unknown, payload: any) => cb(payload);
            ipcRenderer.on('issue-watch:update', handler);
            return () => ipcRenderer.off('issue-watch:update', handler);
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
        /** Agent-integration MCP: pulse a workspace ROW (a terminal in it called
         *  imDone) — a sidebar-level "something finished here" cue, fired
         *  alongside the per-terminal attention glow. */
        workspacePulse: (cb: (payload: { workspaceId: string }) => void) => {
            const handler = (_e: unknown, payload: { workspaceId: string }) =>
                cb(payload);
            ipcRenderer.on('workspace:pulse', handler);
            return () => ipcRenderer.off('workspace:pulse', handler);
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
        /** The set of terminal specs changed outside the renderer's own edits
         *  (e.g. a process created via the MCP manageProcess tool) — re-fetch
         *  terminal-spec:list so the Processes list stays live. */
        terminalSpecsChanged: (cb: () => void) => {
            const handler = () => cb();
            ipcRenderer.on('terminal-spec:changed', handler);
            return () => ipcRenderer.off('terminal-spec:changed', handler);
        },
        /** The set of workspaces changed outside the renderer's own edits (e.g.
         *  workspaces provisioned via the MCP provisionWorkspaces tool) —
         *  re-fetch workspaces:list so the rail stays live. */
        workspacesChanged: (cb: () => void) => {
            const handler = () => cb();
            ipcRenderer.on('workspaces:changed', handler);
            return () => ipcRenderer.off('workspaces:changed', handler);
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
            }) => void,
        ) => {
            const handler = (
                _e: unknown,
                payload: {
                    terminals: Array<{ id: string; pid: number; shell: string }>;
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
