import { contextBridge, ipcRenderer } from 'electron';
import { LOCAL_FRAME_CHANNELS, type LocalFramePort } from '../core/local-frame.js';
import { FEATURE_CHANNELS, type AgentDetail, type GenieSnapshot, type PreloadBridge } from '../renderer/bridge.js';
import type { FeatureData } from '../renderer/features.js';
import type { WorkspacePulse } from '../core/view-requests.js';
import type { AgentPushPayload } from '../core/agent-push-wire.js';
import type { TimedEvent } from '../core/stream-view.js';
import { browserStallEnv, watchRendererStalls } from './renderer-stalls.js';

type AgentPayload = AgentPushPayload<Omit<AgentDetail, 'rows'>, TimedEvent>;

/**
 * The agents this window shows: one channel listener each, however many subscribe. Main pushes an agent only while it is
 * watched here, and only the rows that changed (main/agent-push.ts). The payload goes to the page AS IT ARRIVED — the
 * patch — and the page rebuilds the detail on its side (core/agent-push-wire.ts `AgentDetailViews`): whatever is handed
 * across `contextBridge` is copied into the page on the renderer's one thread, and a rebuilt detail is the whole ledger.
 */
/** Each files view's own id (the host split, P2.2): a subscription is one view, unwatched on its own. */
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
    designLogin: (agentId) => ipcRenderer.invoke('genie:design-login', agentId) as Promise<{ ok: true } | { ok: false; reason: string }>,

    prompt: (agentId, text, attachments) => ipcRenderer.invoke('genie:prompt', agentId, text, attachments) as Promise<{ ok: boolean; reason?: string }>,
    resolvePrompt: (agentId, promptId, action) => ipcRenderer.invoke('genie:resolve-prompt', agentId, promptId, action) as never,

    addAgent: (workspaceId, input) => ipcRenderer.invoke('genie:add-agent', workspaceId, input) as Promise<{ ok: true; id: string } | { ok: false; reason: string }>,

    // The host's reply comes back: `ok` ends the answer's flight, a refusal is said on the card (core/approval-answering.ts).
    answerApproval: (agentId, optionId, note) => ipcRenderer.invoke('genie:answer-approval', agentId, optionId, note ?? '') as Promise<{ ok: true } | { ok: false; reason: string }>,

    restartWithHandoff: (agentId, finishedId) =>
        ipcRenderer.invoke('genie:restart-with-handoff', agentId, finishedId) as Promise<{ ok: true } | { ok: false; reason: string }>,

    workspaces: {
        hibernate: (workspaceId) => ipcRenderer.invoke('genie:workspace-hibernate', workspaceId) as never,
        wake: (workspaceId) => ipcRenderer.invoke('genie:workspace-wake', workspaceId) as never,
        remove: (workspaceId) => ipcRenderer.invoke('genie:workspace-remove', workspaceId) as never,
        tynnBoard: (workspaceId, scope) => ipcRenderer.invoke('genie:workspace-tynn-board', workspaceId, scope) as never,
        tynnBoardAction: (workspaceId, input) => ipcRenderer.invoke('genie:workspace-tynn-board-action', workspaceId, input) as never,
        tynnBoardChanges: (workspaceId, scope, cursor, ids) => ipcRenderer.invoke('genie:workspace-tynn-board-changes', workspaceId, scope, cursor, [...ids]) as never,
        // Follow a workspace's board: main holds one socket for every open tab; this window hears its workspace's signals.
        tynnBoardWatch: (workspaceId, listener) => {
            const handler = (_e: unknown, id: string, signal: Parameters<typeof listener>[0]) => { if (id === workspaceId) listener(signal); };
            ipcRenderer.on('genie:workspace-tynn-board-live', handler);
            let watchId: number | null = null;
            let stopped = false;
            void (ipcRenderer.invoke('genie:workspace-tynn-board-watch', workspaceId) as Promise<number | null>).then((id) => {
                watchId = id;
                if (stopped && id !== null) void ipcRenderer.invoke('genie:workspace-tynn-board-unwatch', id);
            });
            return () => {
                stopped = true;
                ipcRenderer.removeListener('genie:workspace-tynn-board-live', handler);
                if (watchId !== null) void ipcRenderer.invoke('genie:workspace-tynn-board-unwatch', watchId);
            };
        },
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
    remoteWindows: {
        open: (url, name) => ipcRenderer.invoke('genie:remote-open-window', url, name) as Promise<void>,
        // Main asks THIS remote window to reconnect (its connection dropped and the person pressed Open; M0 finding 2).
        onReconnectAsked: (listener) => {
            const handler = () => listener();
            ipcRenderer.on('genie:remote-reconnect', handler);
            return () => { ipcRenderer.removeListener('genie:remote-reconnect', handler); };
        },
    },
    // Every chat's unsent draft, kept by main across a restart and a reload (genie#1261, main/chat-draft-store.ts).
    chatDrafts: {
        load: () => ipcRenderer.invoke('genie:chat-drafts-load') as Promise<unknown>,
        save: (agentId, draft) => ipcRenderer.invoke('genie:chat-drafts-save', agentId, draft) as Promise<void>,
        putFile: (bytes) => ipcRenderer.invoke('genie:chat-drafts-put-file', bytes) as Promise<string | null>,
        readFile: (ref) => ipcRenderer.invoke('genie:chat-drafts-read-file', ref) as Promise<Uint8Array | null>,
        release: (refs) => ipcRenderer.invoke('genie:chat-drafts-release', refs) as Promise<void>,
    },
    // Live site panels (beta.35 item 36, step 5): main places each panel's page over its box.
    sitePanels: {
        prepare: (host) => ipcRenderer.invoke('site-panel:prepare', host) as Promise<never>,
        openWindow: (host) => ipcRenderer.invoke('site-panel:open-window', host) as Promise<void>,
        restart: () => ipcRenderer.invoke('site-panel:restart') as Promise<void>,
        popOut: (panelKey, host) => ipcRenderer.invoke('site-panel:pop-out', panelKey, host) as Promise<void>,
        popBack: (panelKey) => ipcRenderer.invoke('site-panel:pop-back', panelKey) as Promise<void>,
        popped: () => ipcRenderer.invoke('site-panel:popped') as Promise<never>,
        onPoppedBack: (listener) => {
            const handler = (_event: unknown, panelKey: string) => listener(panelKey);
            ipcRenderer.on('site-panel:popped-back', handler);
            return () => { ipcRenderer.removeListener('site-panel:popped-back', handler); };
        },
    },
    // The Genie browser window (beta.35 item 36): the rail's Browser row opens it.
    browserWindow: { open: (address, hosts) => ipcRenderer.invoke('genie:browser-window-open', address, hosts) as Promise<never> },
    // This machine's disk, one folder at a time, for every picker (Tynn #835).
    host: { listDir: (path) => ipcRenderer.invoke('genie:host-list-dir', path) as Promise<never>, mkdir: (parent, name) => ipcRenderer.invoke('genie:host-mkdir', parent, name) as Promise<never>, home: () => ipcRenderer.invoke('genie:host-home') as Promise<string> },
    // The Tynn network (Tynn #837): main holds the grant, the proof key and the relay socket; the window gets a channel.
    // P5 retains outgoing channel ownership in main; device memory and Tynn reads/actions use the local client.
    deviceLink: {
        open: (url) => ipcRenderer.invoke('genie:device-open', url) as Promise<never>,
    },
    tynnNetwork: {
        open: (workstationId) => ipcRenderer.invoke('genie:relay-open', workstationId) as Promise<never>,
        // Where an open stands: main says when Tynn gave the way in and it is reaching the machine.
        onOpenStep: (listener) => {
            const handler = (_e: unknown, workstationId: string, step: 'relay') => listener(workstationId, step);
            ipcRenderer.on('genie:relay-open-step', handler);
            return () => { ipcRenderer.removeListener('genie:relay-open-step', handler); };
        },
        openLink: (text) => ipcRenderer.invoke('genie:connect-link', text) as Promise<never>,
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
    },

    files: {
        openExternal: (workspaceId, path) => ipcRenderer.invoke('genie:files-open-external', workspaceId, path) as Promise<never>,
        reveal: (workspaceId, path) => ipcRenderer.invoke('genie:files-reveal', workspaceId, path) as Promise<never>,
        export: (workspaceId, path) => ipcRenderer.invoke('genie:files-export', workspaceId, path) as Promise<never>,
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
        picked: (paths) => ipcRenderer.invoke(FEATURE_CHANNELS.picked, paths) as Promise<void>,
    },

    // The window's native buttons (Windows / Linux): their space and their colours (the owner: "content covered and
    // not following color theme").
    windowChrome: {
        overlay: process.platform !== 'darwin',
        setOverlayColors: (color: string, symbolColor: string) => ipcRenderer.invoke('genie:window-overlay-colors', color, symbolColor) as Promise<boolean>,
        current: () => ipcRenderer.invoke('genie:window-overlay-colors-current') as Promise<{ color: string; symbolColor: string } | null>,
    },

};

contextBridge.exposeInMainWorld('genie', bridge);
// contextBridge makes this main-supplied value immutable in the page, including when false.
contextBridge.exposeInMainWorld('genieTestMode', process.argv.includes('--genie-page-probe'));

// One string frame pair, separate from the bridge families that have not moved yet. Admission belongs to main.
contextBridge.exposeInMainWorld('genieLocalProtocol', {
    send: (action, connection, text) => {
        if (typeof action !== 'string' || typeof connection !== 'string' || typeof text !== 'string') throw new TypeError('the local protocol port accepts strings only');
        ipcRenderer.send(LOCAL_FRAME_CHANNELS.toHost, action, connection, text);
    },
    onFrame: (listener) => {
        const onFrame = (_event: unknown, action: unknown, connection: unknown, text: unknown): void => {
            if ((action === 'frame' || action === 'closed') && typeof connection === 'string' && typeof text === 'string') listener(action, connection, text);
        };
        ipcRenderer.on(LOCAL_FRAME_CHANNELS.toWindow, onFrame);
        return () => { ipcRenderer.removeListener(LOCAL_FRAME_CHANNELS.toWindow, onFrame); };
    },
} satisfies LocalFramePort);

// THIS WINDOW'S OWN STALLS (beta.53 freezes): a long task, or no frame presented while visible, over 1 s — sent to main's
// stall watchdog for lifecycle.log. Imported by THIS preload only: a module two preloads share becomes a chunk a sandboxed
// preload cannot require (see the clipboard note below).
const stallEnv = browserStallEnv();
if (stallEnv) watchRendererStalls((report) => ipcRenderer.send('genie:renderer-stall', report), stallEnv);

// Every copy button in this window writes through main (main/clipboard-ipc.ts): the page's clipboard can fail silently here.
// The channel is core/clipboard-wire.ts CLIPBOARD_WRITE_CHANNEL, written out: a module two preloads import becomes a shared
// chunk, and a sandboxed preload cannot require it (test/clipboard-main.test.ts holds this copy equal to the constant).
contextBridge.exposeInMainWorld('genieClipboard', {
    write: (text: string, html?: string) => ipcRenderer.invoke('genie:clipboard-write', html === undefined ? { text } : { text, html }) as Promise<boolean>,
});
