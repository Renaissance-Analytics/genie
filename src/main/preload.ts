import { contextBridge, ipcRenderer } from 'electron';
import { FEATURE_CHANNELS, type AgentDetail, type GenieBridge, type GenieSnapshot, type UpdateState } from '../renderer/bridge.js';
import type { FeatureData } from '../renderer/features.js';

/**
 * THE PRELOAD — the entire surface the renderer is given.
 *
 * Nine methods, and nothing else. No `ipcRenderer`, no `require`, no `process`, no
 * filesystem. The renderer
 * receives exactly `GenieBridge` and can reach nothing else, which matters because a renderer
 * displays agent-authored text: a prompt injection that reaches `window.genie` can list
 * agents, and one that reaches Node can do anything.
 *
 * ## Nothing is normalised on the way through
 *
 * The snapshot crosses as-is. **No `?? 0`, no `|| []`, no "sensible default" anywhere in this
 * file** — every `null` in it means *Genie cannot see this*, the surfaces render that as
 * nothing, and one helpful coalesce here would turn "we have not looked" into "we looked and
 * it was none" for every row at once, with nothing downstream able to tell.
 */

const bridge: GenieBridge = {
    snapshot: () => ipcRenderer.invoke('genie:snapshot') as Promise<GenieSnapshot>,

    subscribe: (onChange) => {
        const listener = (_event: unknown, snapshot: GenieSnapshot): void => onChange(snapshot);
        ipcRenderer.on('genie:changed', listener);
        // Returning the unsubscribe is what lets the renderer's effect clean up. Without it a
        // re-render leaks a listener per mount, and Electron starts warning about it long
        // after whoever caused it has moved on.
        return () => ipcRenderer.removeListener('genie:changed', listener);
    },

    agentDetail: (agentId) => ipcRenderer.invoke('genie:agent-detail', agentId) as Promise<AgentDetail | null>,

    // The host asks the window to go somewhere (the tray's Settings…). The renderer owns the route; this only carries the request.
    onNavigate: (onRoute) => {
        const listener = (_event: unknown, route: string): void => onRoute(route);
        ipcRenderer.on('genie:navigate', listener);
        return () => ipcRenderer.removeListener('genie:navigate', listener);
    },
    onAction: (onAction) => {
        const listener = (_event: unknown, action: { agentId: string | null; kind: string }): void => onAction(action);
        ipcRenderer.on('genie:action', listener);
        return () => ipcRenderer.removeListener('genie:action', listener);
    },

    subscribeAgent: (agentId, onChange) => {
        // Filtered HERE, in the preload, rather than by broadcasting every agent's ledger to
        // every renderer and letting each one discard what it does not want. A ledger is
        // thousands of rows; the wire should carry the one being looked at.
        const channel = `genie:agent-changed:${agentId}`;
        const listener = (_event: unknown, detail: AgentDetail | null): void => onChange(detail);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    },

    openAgent: (agentId) => {
        void ipcRenderer.invoke('genie:open-agent', agentId);
    },

    stopAgent: (agentId) => {
        void ipcRenderer.invoke('genie:stop-agent', agentId);
    },

    cancelTurn: (agentId) => ipcRenderer.invoke('genie:cancel-turn', agentId) as Promise<{ ok: true } | { ok: false; reason: string }>,
    resumeLimit: (agentId) => ipcRenderer.invoke('genie:resume-limit', agentId) as Promise<{ ok: true } | { ok: false; reason: string }>,
    providerLogin: (agentId) => ipcRenderer.invoke('genie:provider-login', agentId) as Promise<{ ok: true } | { ok: false; reason: string }>,

    prompt: (agentId, text, attachments) => ipcRenderer.invoke('genie:prompt', agentId, text, attachments) as Promise<{ ok: boolean; reason?: string }>,

    addAgent: (workspaceId) => {
        void ipcRenderer.invoke('genie:add-agent', workspaceId);
    },

    answerApproval: (agentId, optionId) => {
        void ipcRenderer.invoke('genie:answer-approval', agentId, optionId);
    },

    restartWithHandoff: (agentId, finishedId) =>
        ipcRenderer.invoke('genie:restart-with-handoff', agentId, finishedId) as Promise<{ ok: true } | { ok: false; reason: string }>,

    workspaces: {
        previewAdd: (path) => ipcRenderer.invoke('genie:workspace-preview-add', path) as never,
        confirmAdd: (path) => ipcRenderer.invoke('genie:workspace-confirm-add', path) as never,
        previewAddFromGit: (url) => ipcRenderer.invoke('genie:workspace-preview-add-git', url) as never,
        confirmAddFromGit: (url, parent) => ipcRenderer.invoke('genie:workspace-confirm-add-git', url, parent) as never,
        tynnProjects: () => ipcRenderer.invoke('genie:workspace-tynn-projects') as never,
        previewAddFromTynn: (projectId) => ipcRenderer.invoke('genie:workspace-preview-add-tynn', projectId) as never,
        confirmAddFromTynn: (parent, projectId) => ipcRenderer.invoke('genie:workspace-confirm-add-tynn', parent, projectId) as never,
        hibernate: (workspaceId) => ipcRenderer.invoke('genie:workspace-hibernate', workspaceId) as never,
        wake: (workspaceId) => ipcRenderer.invoke('genie:workspace-wake', workspaceId) as never,
        remove: (workspaceId) => ipcRenderer.invoke('genie:workspace-remove', workspaceId) as never,
        listRepos: (workspaceId) => ipcRenderer.invoke('genie:workspace-repos', workspaceId) as never,
        addRepo: (workspaceId, input) => ipcRenderer.invoke('genie:workspace-repo-add', workspaceId, input) as never,
        removeRepo: (workspaceId, slug) => ipcRenderer.invoke('genie:workspace-repo-remove', workspaceId, slug) as never,
        locateRepo: (workspaceId, slug) => ipcRenderer.invoke('genie:workspace-repo-locate', workspaceId, slug) as never,
        commitsSince: (workspaceId, since) => ipcRenderer.invoke('genie:workspace-commits-since', workspaceId, since) as never,
        removeRepoLock: (workspaceId, slug) => ipcRenderer.invoke('genie:workspace-repo-unlock', workspaceId, slug) as never,
        settings: (workspaceId) => ipcRenderer.invoke('genie:workspace-settings', workspaceId) as never,
        setSetting: (workspaceId, key, value) => ipcRenderer.invoke('genie:workspace-setting-set', workspaceId, key, value) as never,
        resetSetting: (workspaceId, key) => ipcRenderer.invoke('genie:workspace-setting-reset', workspaceId, key) as never,
        setGoverns: (workspaceId, childIds) => ipcRenderer.invoke('genie:workspace-set-governs', workspaceId, [...childIds]) as never,
        setDefaultAgent: (workspaceId, agentId) => ipcRenderer.invoke('genie:workspace-set-default-agent', workspaceId, agentId) as never,
    },

    agents: {
        restart: (agentId, kind) => ipcRenderer.invoke('genie:agent-restart', agentId, kind) as never,
        previewDelete: (agentId, outcome, alsoRemoveFrom) => ipcRenderer.invoke('genie:agent-preview-delete', agentId, outcome, [...alsoRemoveFrom]) as never,
        delete: (agentId, outcome, alsoRemoveFrom) => ipcRenderer.invoke('genie:agent-delete', agentId, outcome, [...alsoRemoveFrom]) as never,
        switchDriver: (agentId, to) => ipcRenderer.invoke('genie:agent-switch-driver', agentId, to) as never,
        setBudget: (agentId, dailyLimitUsd) => ipcRenderer.invoke('genie:agent-set-budget', agentId, dailyLimitUsd) as never,
        setMode: (agentId, mode) => ipcRenderer.invoke('genie:agent-set-mode', agentId, mode) as never,
        setAccessScope: (agentId, scope) => ipcRenderer.invoke('genie:agent-set-access-scope', agentId, scope) as never,
        setAutoApprove: (agentId, on) => ipcRenderer.invoke('genie:agent-set-auto-approve', agentId, on) as never,
        setIssueWatch: (agentId, setting) => ipcRenderer.invoke('genie:agent-set-issue-watch', agentId, setting) as never,
        setPermissions: (agentId, permissions) => ipcRenderer.invoke('genie:agent-set-permissions', agentId, permissions) as never,
        setModel: (agentId, model) => ipcRenderer.invoke('genie:agent-set-model', agentId, model) as never,
        diagnose: (agentId) => ipcRenderer.invoke('genie:agent-diagnose', agentId) as never,
    },

    addWorkspace: () => {
        void ipcRenderer.invoke('genie:add-workspace');
    },

    /**
     * TERMINALS — keyed by workspace, never by agent. Output and exits are PUSHED on two
     * channels carrying the terminal id, so one listener per window serves every terminal;
     * the renderer's reducer keeps what belongs to its workspace.
     */
    takeOver: (agentId) =>
        ipcRenderer.invoke('genie:take-over', agentId) as Promise<
            { ok: true; terminalId: string } | { ok: false; reason: string }
        >,

    terminals: {
        open: (workspaceId, options) =>
            ipcRenderer.invoke('genie:terminal-open', workspaceId, options) as Promise<{
                id: string; pid: number; shell: string; scrollback: string;
            }>,
        write: (id, data) => { void ipcRenderer.invoke('genie:terminal-write', id, data); },
        resize: (id, cols, rows) => { void ipcRenderer.invoke('genie:terminal-resize', id, cols, rows); },
        close: (id) => { void ipcRenderer.invoke('genie:terminal-close', id); },
        list: (workspaceId) =>
            ipcRenderer.invoke('genie:terminal-list', workspaceId) as Promise<
                readonly { id: string; pid: number; shell: string }[]
            >,
        attach: (workspaceId, id) =>
            ipcRenderer.invoke('genie:terminal-attach', workspaceId, id) as Promise<{ id: string; pid: number; shell: string; scrollback: string } | null>,
        previousSession: (workspaceId) => ipcRenderer.invoke('genie:terminal-previous', workspaceId) as Promise<string | null>,
        onData: (listener) => {
            const handler = (_e: unknown, payload: { id: string; data: string }) => listener(payload.id, payload.data);
            ipcRenderer.on('genie:terminal-data', handler);
            return () => { ipcRenderer.removeListener('genie:terminal-data', handler); };
        },
        onExit: (listener) => {
            const handler = (_e: unknown, payload: { id: string; exitCode: number }) => listener(payload.id, payload.exitCode);
            ipcRenderer.on('genie:terminal-exit', handler);
            return () => { ipcRenderer.removeListener('genie:terminal-exit', handler); };
        },
    },

    // A known remote host in its own window (Tynn #819).
    remoteWindows: { open: (url) => ipcRenderer.invoke('genie:remote-open-window', url) as Promise<void> },
    // This machine's disk, one folder at a time, for every picker (Tynn #835).
    host: { listDir: (path) => ipcRenderer.invoke('genie:host-list-dir', path) as Promise<never> },
    // The Tynn network (Tynn #837): main holds the grant, the proof key and the relay socket; the window gets a channel.
    tynnNetwork: {
        workstations: () => ipcRenderer.invoke('genie:tynn-workstations') as Promise<never>,
        open: (workstationId) => ipcRenderer.invoke('genie:relay-open', workstationId) as Promise<never>,
        send: (channel, text) => ipcRenderer.send('genie:relay-send', channel, text),
        close: (channel) => ipcRenderer.send('genie:relay-close', channel),
        onMessage: (listener) => {
            const handler = (_e: unknown, channel: string, text: string) => listener(channel, text);
            ipcRenderer.on('genie:relay-message', handler);
            return () => { ipcRenderer.removeListener('genie:relay-message', handler); };
        },
        onClosed: (listener) => {
            const handler = (_e: unknown, channel: string, reason: string | null) => listener(channel, reason);
            ipcRenderer.on('genie:relay-closed', handler);
            return () => { ipcRenderer.removeListener('genie:relay-closed', handler); };
        },
        // Sharing this machine through Tynn (Tynn #839).
        shares: {
            list: (workspaceId) => ipcRenderer.invoke('genie:tynn-share-links', workspaceId) as Promise<never>,
            mint: (input) => ipcRenderer.invoke('genie:tynn-share-mint', input) as Promise<never>,
            revoke: (linkId) => ipcRenderer.invoke('genie:tynn-share-revoke', linkId) as Promise<never>,
        },
    },

    /*
     * UPDATES — §7. State is pushed on one channel; the three actions are invokes whose
     * answers are the host's own (a refusal is `false` / `null`, crossed as-is).
     */
    files: {
        tree: (workspaceId) => ipcRenderer.invoke('genie:files-tree', workspaceId) as Promise<never>,
        children: (workspaceId, dir) => ipcRenderer.invoke('genie:files-children', workspaceId, dir) as Promise<never>,
        open: (workspaceId, path) => ipcRenderer.invoke('genie:files-open', workspaceId, path) as Promise<never>,
        openExternal: (workspaceId, path) => ipcRenderer.invoke('genie:files-open-external', workspaceId, path) as Promise<never>,
        reveal: (workspaceId, path) => ipcRenderer.invoke('genie:files-reveal', workspaceId, path) as Promise<never>,
        lastCommitted: (workspaceId, path) => ipcRenderer.invoke('genie:files-last-committed', workspaceId, path) as Promise<string | null>,
        state: (workspaceId) => ipcRenderer.invoke('genie:files-state', workspaceId) as Promise<never>,
        watch: (workspaceId) => ipcRenderer.invoke('genie:files-watch', workspaceId) as Promise<void>,
        write: (workspaceId, path, text, expectedSha) => ipcRenderer.invoke('genie:files-write', workspaceId, path, text, expectedSha) as Promise<never>,
        onChange: (listener) => {
            const handler = (_e: unknown, workspaceId: string, paths?: readonly string[]) => listener(workspaceId, paths);
            ipcRenderer.on('genie:files-changed', handler);
            return () => { ipcRenderer.removeListener('genie:files-changed', handler); };
        },
        windows: {
            popOut: (workspaceId) => ipcRenderer.invoke('genie:files-popout', workspaceId) as Promise<void>,
            bringBack: (workspaceId) => ipcRenderer.invoke('genie:files-bringback', workspaceId) as Promise<void>,
            list: () => ipcRenderer.invoke('genie:files-windows') as Promise<readonly string[]>,
            onChange: (listener) => {
                const handler = (_e: unknown, popped: readonly string[]) => listener(popped);
                ipcRenderer.on('genie:files-windows-changed', handler);
                return () => { ipcRenderer.removeListener('genie:files-windows-changed', handler); };
            },
        },
    },
    features: {
        snapshot: () => ipcRenderer.invoke(FEATURE_CHANNELS.snapshot) as Promise<FeatureData>,
        subscribe: (onChange) => {
            const handler = (_e: unknown, data: FeatureData) => onChange(data);
            ipcRenderer.on(FEATURE_CHANNELS.changed, handler);
            return () => { ipcRenderer.removeListener(FEATURE_CHANNELS.changed, handler); };
        },
        act: (action) => ipcRenderer.invoke(FEATURE_CHANNELS.act, action) as Promise<FeatureData>,
        setBrowserBounds: (bounds) => ipcRenderer.invoke(FEATURE_CHANNELS.browserBounds, bounds) as Promise<void>,
        pickFiles: () => ipcRenderer.invoke(FEATURE_CHANNELS.pickFiles) as Promise<string[]>,
        soundData: (key) => ipcRenderer.invoke(FEATURE_CHANNELS.soundData, key) as Promise<string | null>,
    },

    // The window's native buttons (Windows / Linux): their space and their colours (the owner: "content covered and
    // not following color theme").
    windowChrome: {
        overlay: process.platform !== 'darwin',
        setOverlayColors: (color: string, symbolColor: string) => ipcRenderer.invoke('genie:window-overlay-colors', color, symbolColor) as Promise<boolean>,
        current: () => ipcRenderer.invoke('genie:window-overlay-colors-current') as Promise<{ color: string; symbolColor: string } | null>,
    },

    updates: {
        state: () => ipcRenderer.invoke('genie:updates-state') as Promise<UpdateState>,
        subscribe: (onChange) => {
            const handler = (_e: unknown, state: UpdateState) => onChange(state);
            ipcRenderer.on('genie:updates-changed', handler);
            return () => { ipcRenderer.removeListener('genie:updates-changed', handler); };
        },
        check: () => ipcRenderer.invoke('genie:updates-check') as Promise<UpdateState>,
        download: () => ipcRenderer.invoke('genie:updates-download') as Promise<boolean>,
        install: () => ipcRenderer.invoke('genie:updates-install') as Promise<{ report: string } | null>,
    },
};

contextBridge.exposeInMainWorld('genie', bridge);
