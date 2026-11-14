import { contextBridge, ipcRenderer } from 'electron';
import { LOCAL_FRAME_CHANNELS, type LocalFramePort } from '../core/local-frame.js';
import { FEATURE_CHANNELS, type PreloadBridge } from '../renderer/bridge.js';
import type { FeatureData } from '../renderer/features.js';
import type { WorkspacePulse } from '../core/view-requests.js';
import { browserStallEnv, watchRendererStalls } from './renderer-stalls.js';

/**
 * THE PRELOAD — native window capabilities; protocol frames use the separate port below.
 *
 * No `ipcRenderer`, no `require`, no `process`, no
 * filesystem. The renderer
 * receives exactly `GenieBridge` and can reach nothing else, which matters because a renderer
 * displays agent-authored text: a prompt injection that reaches `window.genie` can list
 * agents, and one that reaches Node can do anything.
 *
 * ## Nothing is normalised on the way through
 *
 * Values cross as-is. **No `?? 0`, no `|| []`, no "sensible default" anywhere in this
 * file** — every `null` in it means *Genie cannot see this*, the surfaces render that as
 * nothing, and one helpful coalesce here would turn "we have not looked" into "we looked and
 * it was none" for every row at once, with nothing downstream able to tell.
 */

const bridge: PreloadBridge = {
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

    providerLogin: (agentId) => ipcRenderer.invoke('genie:provider-login', agentId) as Promise<{ ok: true } | { ok: false; reason: string }>,
    designLogin: (agentId) => ipcRenderer.invoke('genie:design-login', agentId) as Promise<{ ok: true } | { ok: false; reason: string }>,


    workspaces: {
    },

    addWorkspace: () => {
        void ipcRenderer.invoke('genie:add-workspace');
    },

    /**
     * TERMINALS — keyed by workspace, never by agent. Output and exits are PUSHED on two
     * channels carrying the terminal id, so one listener per window serves every terminal;
     * the renderer's reducer keeps what belongs to its workspace.
     */
    crashReport: {
        draft: () => ipcRenderer.invoke('genie:crash-report-draft') as Promise<{ text: string }>,
        send: (text, notes) => ipcRenderer.invoke('genie:crash-report-send', text, notes) as Promise<import('../renderer/components/SafeModeBanner.js').CrashReportAnswer>,
    },

    takeOver: (agentId) =>
        ipcRenderer.invoke('genie:take-over', agentId) as Promise<
            { ok: true; terminalId: string } | { ok: false; reason: string }
        >,

    chooseProviderProgram: (provider) =>
        ipcRenderer.invoke('genie:provider-choose-program', provider) as Promise<{ ok: true } | { ok: false; reason?: string }>,

    scratchTerminal: (workspaceId) =>
        ipcRenderer.invoke('genie:scratch-terminal-open', workspaceId) as Promise<
            { ok: true; terminalId: string } | { ok: false; reason: string }
        >,

    // A known remote host in its own window (Tynn #819).
    remoteWindows: {
        open: (url, name) => ipcRenderer.invoke('genie:remote-open-window', url, name) as Promise<void>,
        // Take over from another machine (Tynn #529 part A): this machine's Take Over window on that host's terminal.
        openTakeOver: (url, terminalId, ticket, name) => ipcRenderer.invoke('genie:remote-takeover-open', url, terminalId, ticket, name) as Promise<{ ok: true } | { ok: false; reason: string }>,
        takeOverTicket: () => ipcRenderer.invoke('genie:takeover-ticket') as Promise<string | null>,
        // Main asks THIS remote window to reconnect (its connection dropped and the person pressed Open; M0 finding 2).
        onReconnectAsked: (listener) => {
            const handler = () => listener();
            ipcRenderer.on('genie:remote-reconnect', handler);
            return () => { ipcRenderer.removeListener('genie:remote-reconnect', handler); };
        },
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
    features: {
        setBrowserBounds: (bounds) => ipcRenderer.invoke(FEATURE_CHANNELS.browserBounds, bounds) as Promise<void>,
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
