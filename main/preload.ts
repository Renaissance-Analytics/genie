import { contextBridge, ipcRenderer } from 'electron';

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
            ipcRenderer.invoke('issue-watch:counts') as Promise<Record<string, number>>,
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
        disconnect: () => ipcRenderer.invoke('github:disconnect'),
        user: () => ipcRenderer.invoke('github:user'),
        orgs: () => ipcRenderer.invoke('github:orgs'),
        createRepo: (opts: {
            name: string;
            owner?: string | null;
            description?: string;
            private?: boolean;
        }) => ipcRenderer.invoke('github:create-repo', opts),
        forkRepo: (opts: {
            owner: string;
            repo: string;
            intoOrg?: string | null;
            name?: string;
        }) => ipcRenderer.invoke('github:fork-repo', opts),
        parseRemote: (url: string) =>
            ipcRenderer.invoke('github:parse-remote', url),
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

    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        set: (patch: Record<string, unknown>) =>
            ipcRenderer.invoke('settings:set', patch),
        chooseFolder: (label?: string) =>
            ipcRenderer.invoke('settings:choose-folder', label),
        chooseFile: (label?: string) =>
            ipcRenderer.invoke('settings:choose-file', label),
        detectEditors: () => ipcRenderer.invoke('settings:detect-editors'),
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
        repos: (id: string) =>
            ipcRenderer.invoke('workspaces:repos', id) as Promise<string[]>,
        open: (id: string) => ipcRenderer.invoke('workspaces:open', id),
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
    },

    tynn: {
        projects: () => ipcRenderer.invoke('tynn:projects'),
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
    },

    tynnHost: {
        get: () => ipcRenderer.invoke('tynn-host:get'),
    },

    app: {
        hideCapture: () => ipcRenderer.invoke('app:hide-capture'),
        getCurrentProject: () => ipcRenderer.invoke('app:get-current-project'),
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
                questions: Array<{
                    header: string;
                    question: string;
                    multiSelect?: boolean;
                    options: Array<{ label: string; description?: string }>;
                }>;
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
        // Customization: play a notification chime (agent imDone). The renderer
        // synthesizes the tone — no audio asset is shipped.
        notifySound: (cb: (payload: { kind: string }) => void) => {
            const handler = (_e: unknown, payload: { kind: string }) => cb(payload);
            ipcRenderer.on('notify:sound', handler);
            return () => ipcRenderer.off('notify:sound', handler);
        },
        // Issue Watch: per-workspace unread counts changed (poll / toggle / seen).
        issueWatchUpdate: (
            cb: (payload: { counts: Record<string, number> }) => void,
        ) => {
            const handler = (_e: unknown, payload: { counts: Record<string, number> }) =>
                cb(payload);
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
