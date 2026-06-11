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
        disconnect: () => ipcRenderer.invoke('github:disconnect'),
        user: () => ipcRenderer.invoke('github:user'),
        orgs: () => ipcRenderer.invoke('github:orgs'),
        createRepo: (opts: {
            name: string;
            owner?: string | null;
            description?: string;
            private?: boolean;
        }) => ipcRenderer.invoke('github:create-repo', opts),
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
    },

    workspaces: {
        list: () => ipcRenderer.invoke('workspaces:list'),
        add: (row: Record<string, unknown>) =>
            ipcRenderer.invoke('workspaces:add', row),
        update: (id: string, patch: Record<string, unknown>) =>
            ipcRenderer.invoke('workspaces:update', id, patch),
        remove: (id: string) => ipcRenderer.invoke('workspaces:remove', id),
        touch: (id: string) => ipcRenderer.invoke('workspaces:touch', id),
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
        showMain: () => ipcRenderer.invoke('app:show-main'),
        openStage: (workspaceId?: string) =>
            ipcRenderer.invoke('app:open-stage', workspaceId),
        quit: () => ipcRenderer.invoke('app:quit'),
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
        }) => ipcRenderer.invoke('terminal-spec:create', input),
        update: (id: string, patch: Record<string, unknown>) =>
            ipcRenderer.invoke('terminal-spec:update', id, patch),
        remove: (id: string) => ipcRenderer.invoke('terminal-spec:delete', id),
        get: (id: string) => ipcRenderer.invoke('terminal-spec:get', id),
        touch: (id: string) => ipcRenderer.invoke('terminal-spec:touch', id),
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
            }>,
        write: (id: string, data: string) =>
            ipcRenderer.invoke('terminal:write', id, data) as Promise<boolean>,
        resize: (id: string, cols: number, rows: number) =>
            ipcRenderer.invoke('terminal:resize', id, cols, rows) as Promise<boolean>,
        /** Release this window's view of the pty without killing it. */
        detach: (id: string) =>
            ipcRenderer.invoke('terminal:detach', id) as Promise<boolean>,
        kill: (id: string) =>
            ipcRenderer.invoke('terminal:kill', id) as Promise<boolean>,
        list: () =>
            ipcRenderer.invoke('terminal:list') as Promise<
                Array<{ id: string; pid: number; shell: string }>
            >,
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
