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

    prompt: (agentId, text) => {
        void ipcRenderer.invoke('genie:prompt', agentId, text);
    },

    addAgent: (workspaceId) => {
        void ipcRenderer.invoke('genie:add-agent', workspaceId);
    },

    answerApproval: (agentId, optionId) => {
        void ipcRenderer.invoke('genie:answer-approval', agentId, optionId);
    },

    restartWithHandoff: (agentId, finishedId) =>
        ipcRenderer.invoke('genie:restart-with-handoff', agentId, finishedId) as Promise<{ ok: true } | { ok: false; reason: string }>,

    workspaces: {
        previewAdd: () => ipcRenderer.invoke('genie:workspace-preview-add') as never,
        confirmAdd: (path) => ipcRenderer.invoke('genie:workspace-confirm-add', path) as never,
        hibernate: (workspaceId) => ipcRenderer.invoke('genie:workspace-hibernate', workspaceId) as never,
        wake: (workspaceId) => ipcRenderer.invoke('genie:workspace-wake', workspaceId) as never,
        remove: (workspaceId) => ipcRenderer.invoke('genie:workspace-remove', workspaceId) as never,
    },

    agents: {
        restart: (agentId, kind) => ipcRenderer.invoke('genie:agent-restart', agentId, kind) as never,
        previewDelete: (agentId, outcome, alsoRemoveFrom) => ipcRenderer.invoke('genie:agent-preview-delete', agentId, outcome, [...alsoRemoveFrom]) as never,
        delete: (agentId, outcome, alsoRemoveFrom) => ipcRenderer.invoke('genie:agent-delete', agentId, outcome, [...alsoRemoveFrom]) as never,
        switchDriver: (agentId, to) => ipcRenderer.invoke('genie:agent-switch-driver', agentId, to) as never,
        setBudget: (agentId, dailyLimitUsd) => ipcRenderer.invoke('genie:agent-set-budget', agentId, dailyLimitUsd) as never,
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

    /*
     * UPDATES — §7. State is pushed on one channel; the three actions are invokes whose
     * answers are the host's own (a refusal is `false` / `null`, crossed as-is).
     */
    files: {
        tree: (workspaceId) => ipcRenderer.invoke('genie:files-tree', workspaceId) as Promise<never>,
        open: (workspaceId, path) => ipcRenderer.invoke('genie:files-open', workspaceId, path) as Promise<never>,
        state: (workspaceId) => ipcRenderer.invoke('genie:files-state', workspaceId) as Promise<never>,
        watch: (workspaceId) => ipcRenderer.invoke('genie:files-watch', workspaceId) as Promise<void>,
        onChange: (listener) => {
            const handler = (_e: unknown, workspaceId: string) => listener(workspaceId);
            ipcRenderer.on('genie:files-changed', handler);
            return () => { ipcRenderer.removeListener('genie:files-changed', handler); };
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
