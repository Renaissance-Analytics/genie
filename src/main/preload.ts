import { contextBridge, ipcRenderer } from 'electron';
import type { AgentDetail, GenieBridge, GenieSnapshot } from '../renderer/bridge.js';

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

    addWorkspace: () => {
        void ipcRenderer.invoke('genie:add-workspace');
    },

    /**
     * TERMINALS — keyed by workspace, never by agent. Output and exits are PUSHED on two
     * channels carrying the terminal id, so one listener per window serves every terminal;
     * the renderer's reducer keeps what belongs to its workspace.
     */
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
};

contextBridge.exposeInMainWorld('genie', bridge);
