import { contextBridge, ipcRenderer } from 'electron';
import { FEATURE_CHANNELS, type AgentDetail, type GenieSnapshot, type PreloadBridge, type UpdateState } from '../renderer/bridge.js';
import type { FeatureData } from '../renderer/features.js';
import type { Headroom } from '../core/headroom.js';
import type { WorkspacePulse } from '../core/view-requests.js';
import type { AgentPushPayload } from '../core/agent-push-wire.js';
import type { TimedEvent } from '../core/stream-view.js';

type AgentPayload = AgentPushPayload<Omit<AgentDetail, 'rows'>, TimedEvent>;

/**
 * The agents this window shows: one channel listener each, however many subscribe. Main pushes an agent only while it is
 * watched here, and only the rows that changed (main/agent-push.ts). The payload goes to the page AS IT ARRIVED — the
 * patch — and the page rebuilds the detail on its side (core/agent-push-wire.ts `AgentDetailViews`): whatever is handed
 * across `contextBridge` is copied into the page on the renderer's one thread, and a rebuilt detail is the whole ledger.
 */
const watching = new Map<string, { subscribers: Set<(payload: AgentPayload) => void>; off: () => void }>();

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

const bridge: PreloadBridge = {
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
    // An agent acted in a workspace (genie#1265): the window marks it and never moves (core/view-requests.ts).
    onWorkspacePulse: (onPulse) => {
        const listener = (_event: unknown, pulse: WorkspacePulse): void => onPulse(pulse);
        ipcRenderer.on('genie:workspace-pulse', listener);
        return () => ipcRenderer.removeListener('genie:workspace-pulse', listener);
    },
    onHeadroom: (onHeadroom) => {
        const listener = (_event: unknown, limits: Readonly<Record<string, Headroom>>): void => onHeadroom(limits);
        ipcRenderer.on('genie:headroom', listener);
        void ipcRenderer.invoke('genie:headroom').then((limits: Readonly<Record<string, Headroom>>) => onHeadroom(limits), () => {});
        return () => ipcRenderer.removeListener('genie:headroom', listener);
    },
    onAction: (onAction) => {
        const listener = (_event: unknown, action: { agentId: string | null; kind: string; to?: string; id?: string; ids?: readonly string[] }): void => onAction(action);
        ipcRenderer.on('genie:action', listener);
        return () => ipcRenderer.removeListener('genie:action', listener);
    },

    subscribeAgentWire: (agentId, onPayload) => {
        // Filtered in MAIN: the window says which agents it shows, and only those are pushed. A ledger is thousands of
        // rows; the wire carries the one being looked at, and of it only what changed — and so does the bridge.
        let watch = watching.get(agentId);
        if (watch === undefined) {
            const channel = `genie:agent-changed:${agentId}`;
            const subscribers = new Set<(payload: AgentPayload) => void>();
            const listener = (_event: unknown, payload: AgentPayload): void => {
                for (const subscriber of subscribers) subscriber(payload);
            };
            ipcRenderer.on(channel, listener);
            watch = { subscribers, off: () => ipcRenderer.removeListener(channel, listener) };
            watching.set(agentId, watch);
        }
        const w = watch;
        const subscriber = (payload: AgentPayload): void => onPayload(payload);
        w.subscribers.add(subscriber);
        // Watching (again) starts with the whole ledger, to every subscriber: one joining late holds no rows a patch could
        // apply to, and a full ledger is what any receiver takes.
        ipcRenderer.send('genie:agent-watch', agentId, true);
        return () => {
            w.subscribers.delete(subscriber);
            if (w.subscribers.size > 0 || watching.get(agentId) !== w) return;
            watching.delete(agentId);
            w.off();
            ipcRenderer.send('genie:agent-watch', agentId, false);
        };
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
    accountRetry: (agentId) => ipcRenderer.invoke('genie:account-retry', agentId) as Promise<{ ok: true } | { ok: false; reason: string }>,
    designLogin: (agentId) => ipcRenderer.invoke('genie:design-login', agentId) as Promise<{ ok: true } | { ok: false; reason: string }>,

    prompt: (agentId, text, attachments) => ipcRenderer.invoke('genie:prompt', agentId, text, attachments) as Promise<{ ok: boolean; reason?: string }>,
    resolvePrompt: (agentId, promptId, action) => ipcRenderer.invoke('genie:resolve-prompt', agentId, promptId, action) as never,

    addAgent: (workspaceId, input) => ipcRenderer.invoke('genie:add-agent', workspaceId, input) as Promise<{ ok: true; id: string } | { ok: false; reason: string }>,

    // The host's reply comes back: `ok` ends the answer's flight, a refusal is said on the card (core/approval-answering.ts).
    answerApproval: (agentId, optionId, note) => ipcRenderer.invoke('genie:answer-approval', agentId, optionId, note ?? '') as Promise<{ ok: true } | { ok: false; reason: string }>,

    restartWithHandoff: (agentId, finishedId) =>
        ipcRenderer.invoke('genie:restart-with-handoff', agentId, finishedId) as Promise<{ ok: true } | { ok: false; reason: string }>,

    workspaces: {
        previewAdd: (path) => ipcRenderer.invoke('genie:workspace-preview-add', path) as never,
        confirmAdd: (path) => ipcRenderer.invoke('genie:workspace-confirm-add', path) as never,
        create: (name, parent, remote, tynnProjectId) => ipcRenderer.invoke('genie:workspace-create', name, parent, remote, tynnProjectId ?? '') as never,
        previewAddFromGit: (url, parent) => ipcRenderer.invoke('genie:workspace-preview-add-git', url, parent) as never,
        confirmAddFromGit: (url, parent) => ipcRenderer.invoke('genie:workspace-confirm-add-git', url, parent) as never,
        readSource: (path) => ipcRenderer.invoke('genie:workspace-read-source', path) as never,
        stageFromGit: (url) => ipcRenderer.invoke('genie:workspace-stage-git', url) as never,
        registerExisting: (path) => ipcRenderer.invoke('genie:workspace-register-existing', path) as never,
        buildEnvelope: (plan, remote) => ipcRenderer.invoke('genie:workspace-build-envelope', plan, remote) as never,
        discardStaged: (path) => ipcRenderer.invoke('genie:workspace-discard-staged', path) as never,
        githubRepos: () => ipcRenderer.invoke('genie:workspace-github-repos') as never,
        tynnProjects: () => ipcRenderer.invoke('genie:workspace-tynn-projects') as never,
        tynnOwnerOptions: () => ipcRenderer.invoke('genie:workspace-tynn-owner-options') as never,
        createTynnProject: (input) => ipcRenderer.invoke('genie:workspace-create-tynn-project', input) as never,
        importedAgents: (workspaceId) => ipcRenderer.invoke('genie:workspace-imported-agents', workspaceId) as never,
        adoptAgent: (workspaceId, name) => ipcRenderer.invoke('genie:workspace-adopt-agent', workspaceId, name) as never,
        previewAddFromTynn: (projectId, parent) => ipcRenderer.invoke('genie:workspace-preview-add-tynn', projectId, parent) as never,
        confirmAddFromTynn: (parent, projectId) => ipcRenderer.invoke('genie:workspace-confirm-add-tynn', parent, projectId) as never,
        hibernate: (workspaceId) => ipcRenderer.invoke('genie:workspace-hibernate', workspaceId) as never,
        wake: (workspaceId) => ipcRenderer.invoke('genie:workspace-wake', workspaceId) as never,
        remove: (workspaceId) => ipcRenderer.invoke('genie:workspace-remove', workspaceId) as never,
        listRepos: (workspaceId) => ipcRenderer.invoke('genie:workspace-repos', workspaceId) as never,
        tynnBoard: (workspaceId, scope) => ipcRenderer.invoke('genie:workspace-tynn-board', workspaceId, scope) as never,
        tynnBoardAction: (workspaceId, input) => ipcRenderer.invoke('genie:workspace-tynn-board-action', workspaceId, input) as never,
        addRepo: (workspaceId, input) => ipcRenderer.invoke('genie:workspace-repo-add', workspaceId, input) as never,
        removeRepo: (workspaceId, slug) => ipcRenderer.invoke('genie:workspace-repo-remove', workspaceId, slug) as never,
        locateRepo: (workspaceId, slug, path) => ipcRenderer.invoke('genie:workspace-repo-locate', workspaceId, slug, path) as never,
        commitsSince: (workspaceId, since) => ipcRenderer.invoke('genie:workspace-commits-since', workspaceId, since) as never,
        removeRepoLock: (workspaceId, slug) => ipcRenderer.invoke('genie:workspace-repo-unlock', workspaceId, slug) as never,
        settings: (workspaceId) => ipcRenderer.invoke('genie:workspace-settings', workspaceId) as never,
        setSetting: (workspaceId, key, value) => ipcRenderer.invoke('genie:workspace-setting-set', workspaceId, key, value) as never,
        resetSetting: (workspaceId, key) => ipcRenderer.invoke('genie:workspace-setting-reset', workspaceId, key) as never,
        onSettingsChanged: (listener) => {
            const handler = (_e: unknown, workspaceId: string) => listener(workspaceId);
            ipcRenderer.on('genie:workspace-settings-changed', handler);
            return () => { ipcRenderer.removeListener('genie:workspace-settings-changed', handler); };
        },
        setGoverns: (workspaceId, childIds) => ipcRenderer.invoke('genie:workspace-set-governs', workspaceId, [...childIds]) as never,
        setDefaultAgent: (workspaceId, agentId) => ipcRenderer.invoke('genie:workspace-set-default-agent', workspaceId, agentId) as never,
    },

    agents: {
        restart: (agentId, kind) => ipcRenderer.invoke('genie:agent-restart', agentId, kind) as never,
        previewDelete: (agentId, outcome, alsoRemoveFrom) => ipcRenderer.invoke('genie:agent-preview-delete', agentId, outcome, [...alsoRemoveFrom]) as never,
        delete: (agentId, outcome, alsoRemoveFrom, handoff) => ipcRenderer.invoke('genie:agent-delete', agentId, outcome, [...alsoRemoveFrom], handoff === true) as never,
        switchDriver: (agentId, to) => ipcRenderer.invoke('genie:agent-switch-driver', agentId, to) as never,
        setBudget: (agentId, dailyLimitUsd) => ipcRenderer.invoke('genie:agent-set-budget', agentId, dailyLimitUsd) as never,
        setMode: (agentId, mode) => ipcRenderer.invoke('genie:agent-set-mode', agentId, mode) as never,
        setAccessScope: (agentId, scope) => ipcRenderer.invoke('genie:agent-set-access-scope', agentId, scope) as never,
        setAutoApprove: (agentId, on) => ipcRenderer.invoke('genie:agent-set-auto-approve', agentId, on) as never,
        setManageTabs: (agentId, on) => ipcRenderer.invoke('genie:agent-set-manage-tabs', agentId, on) as never,
        setDrivePages: (agentId, on) => ipcRenderer.invoke('genie:agent-set-drive-pages', agentId, on) as never,
        setIssueWatch: (agentId, setting) => ipcRenderer.invoke('genie:agent-set-issue-watch', agentId, setting) as never,
        setPermissions: (agentId, permissions) => ipcRenderer.invoke('genie:agent-set-permissions', agentId, permissions) as never,
        setModel: (agentId, model) => ipcRenderer.invoke('genie:agent-set-model', agentId, model) as never,
        models: (agentId, refresh) => ipcRenderer.invoke('genie:agent-models', agentId, refresh === true) as never,
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
    // Every chat's unsent draft, kept by main across a restart and a reload (genie#1261, main/chat-draft-store.ts).
    chatDrafts: {
        load: () => ipcRenderer.invoke('genie:chat-drafts-load') as Promise<unknown>,
        save: (agentId, draft) => ipcRenderer.invoke('genie:chat-drafts-save', agentId, draft) as Promise<void>,
        putFile: (bytes) => ipcRenderer.invoke('genie:chat-drafts-put-file', bytes) as Promise<string | null>,
        readFile: (ref) => ipcRenderer.invoke('genie:chat-drafts-read-file', ref) as Promise<Uint8Array | null>,
        release: (refs) => ipcRenderer.invoke('genie:chat-drafts-release', refs) as Promise<void>,
    },
    // Live site panels (beta.35 item 36, step 5): main places each panel's page over its box.
    // Every agent's activity feed (beta.33 item 10): the workspace Dashboard's lanes. Pushed, never polled.
    activity: {
        feeds: (workspaceId) => ipcRenderer.invoke('genie:activity', workspaceId) as Promise<never>,
        subscribe: (onFeed) => {
            // A feed is small (its newest items, 30 minutes of beats), so one channel carries every agent's.
            const listener = (_event: unknown, feed: unknown): void => onFeed(feed as never);
            ipcRenderer.on('genie:activity-changed', listener);
            return () => { ipcRenderer.removeListener('genie:activity-changed', listener); };
        },
    },
    sitePanels: {
        show: (panelKey, host, bounds) => ipcRenderer.invoke('site-panel:show', panelKey, host, bounds) as Promise<never>,
        hide: (panelKey) => ipcRenderer.invoke('site-panel:hide', panelKey) as Promise<void>,
        reload: (panelKey) => ipcRenderer.invoke('site-panel:reload', panelKey) as Promise<void>,
        openWindow: (host) => ipcRenderer.invoke('site-panel:open-window', host) as Promise<void>,
    },
    // The Genie browser window (beta.35 item 36): the rail's Browser row opens it.
    browserWindow: { open: (address, hosts) => ipcRenderer.invoke('genie:browser-window-open', address, hosts) as Promise<never> },
    // This machine's disk, one folder at a time, for every picker (Tynn #835).
    host: { listDir: (path) => ipcRenderer.invoke('genie:host-list-dir', path) as Promise<never>, mkdir: (parent, name) => ipcRenderer.invoke('genie:host-mkdir', parent, name) as Promise<never>, home: () => ipcRenderer.invoke('genie:host-home') as Promise<string> },
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
        readMedia: (workspaceId, path) => ipcRenderer.invoke('genie:files-read-media', workspaceId, path) as Promise<never>,
        openExternal: (workspaceId, path) => ipcRenderer.invoke('genie:files-open-external', workspaceId, path) as Promise<never>,
        reveal: (workspaceId, path) => ipcRenderer.invoke('genie:files-reveal', workspaceId, path) as Promise<never>,
        export: (workspaceId, path) => ipcRenderer.invoke('genie:files-export', workspaceId, path) as Promise<never>,
        create: (workspaceId, path, kind) => ipcRenderer.invoke('genie:files-create', workspaceId, path, kind) as Promise<never>,
        rename: (workspaceId, from, to) => ipcRenderer.invoke('genie:files-rename', workspaceId, from, to) as Promise<never>,
        duplicate: (workspaceId, path) => ipcRenderer.invoke('genie:files-duplicate', workspaceId, path) as Promise<never>,
        trash: (workspaceId, path) => ipcRenderer.invoke('genie:files-trash', workspaceId, path) as Promise<never>,
        lastCommitted: (workspaceId, path) => ipcRenderer.invoke('genie:files-last-committed', workspaceId, path) as Promise<string | null>,
        state: (workspaceId) => ipcRenderer.invoke('genie:files-state', workspaceId) as Promise<never>,
        watch: (workspaceId) => ipcRenderer.invoke('genie:files-watch', workspaceId) as Promise<void>,
        write: (workspaceId, path, text, expectedSha) => ipcRenderer.invoke('genie:files-write', workspaceId, path, text, expectedSha) as Promise<never>,
        gitStatus: (workspaceId) => ipcRenderer.invoke('genie:files-git-status', workspaceId) as Promise<never>,
        readBytes: (workspaceId, pluginId, path) => ipcRenderer.invoke('genie:files-read-bytes', workspaceId, pluginId, path) as Promise<never>,
        writeBytes: (workspaceId, pluginId, path, base64, expectedSha) => ipcRenderer.invoke('genie:files-write-bytes', workspaceId, pluginId, path, base64, expectedSha) as Promise<never>,
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
    // The official panels (beta.33 item 14): the Repository panel's git and the ArtBoard, by workspace.
    repo: {
        call: (op, workspaceId, rel, a, b) => ipcRenderer.invoke('genie:repo', op, workspaceId, rel, a, b) as Promise<never>,
    },
    artboard: {
        read: (workspaceId) => ipcRenderer.invoke('genie:artboard-read', workspaceId) as Promise<never>,
        review: (workspaceId, postId, verdict, comment) => ipcRenderer.invoke('genie:artboard-review', workspaceId, postId, verdict, comment) as Promise<never>,
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
        notes: () => ipcRenderer.invoke('genie:updates-notes') as Promise<UpdateState | null>,
    },
};

contextBridge.exposeInMainWorld('genie', bridge);

// Every copy button in this window writes through main (main/clipboard-ipc.ts): the page's clipboard can fail silently here.
// The channel is core/clipboard-wire.ts CLIPBOARD_WRITE_CHANNEL, written out: a module two preloads import becomes a shared
// chunk, and a sandboxed preload cannot require it (test/clipboard-main.test.ts holds this copy equal to the constant).
contextBridge.exposeInMainWorld('genieClipboard', {
    write: (text: string, html?: string) => ipcRenderer.invoke('genie:clipboard-write', html === undefined ? { text } : { text, html }) as Promise<boolean>,
});
