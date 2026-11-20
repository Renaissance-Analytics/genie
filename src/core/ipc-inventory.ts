import { CLIPBOARD_WRITE_CHANNEL } from './clipboard-wire.js';
import { LOCAL_FRAME_CHANNELS } from './local-frame.js';

/**
 * THE WINDOW GUARD'S TABLES (Tynn #898 step 2e, story #899). A client is a dumb terminal (the owner's ruling): it reaches
 * the host over the one protocol and keeps only what is the window's own. Every ipcMain registration under src/main
 * (test/ipc-inventory.test.ts) and every use main.ts makes of its engine client (test/split-2e-window-guard.test.ts) is
 * a row here, and each row says what it is:
 *
 *  - `protocol-door`: the frames of the one protocol.
 *  - `browser-process` / `doctor-process`: registered by another process's file (genie-browser-electron.ts, Tynn #585;
 *    doctor mode's doctor.ts), never the window's.
 *  - `window:<capability>`: an operation that is the window's own, on the machine the person sits at. The capabilities
 *    are listed in WINDOW_CAPABILITIES and nothing else is one.
 *  - `move:<step>`: STILL reaches a host feature off the one protocol. The step that moves it is named, and the tests
 *    keep a frozen copy of these rows that only shrinks: a row leaves in the PR that moves it.
 *  - `link` (engine uses only): the engine link's own business, which is the window's liveness, the host's welcome, the
 *    window's launch and quit around an update, and Electron's proxy answers that the host cannot ask for itself.
 */
export const WINDOW_CAPABILITIES = [
    'chrome', // the window's frame: title-bar overlay colours, the question window's drawer
    'clipboard',
    'stall-report', // the renderer says it stalled; the window's own health
    'file-dialog', // a native picker on the person's machine
    'os-shell', // open with the OS app, reveal in the file manager: this machine's shell, like the trash
    'trash', // asked by the host through windowOps (window-tunnel.ts); no IPC channel
    'pop-out', // a window of its own: Files, terminals, a remote host's window, the question window
    'take-over-window',
    'site-panel', // the site panels, webviews in the window by design (one login per site)
    'feature-effect', // what a feature does to this window: its browser pane
    'gapp-window', // a GApp's own BrowserWindow; asked by the host through windowOps
    'host-wait', // the window shown while genie-host does not answer: it cannot be on the protocol
] as const;
export type WindowCapability = (typeof WINDOW_CAPABILITIES)[number];

/** The steps of Tynn #898 that still move something onto the one protocol: 2b #896, 2c #897, 2f (#912, then #941), 2g #913. */
export const MOVE_STEPS = ['2b', '2c', '2f', '2g'] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];

export type IpcDestination = 'protocol-door' | 'browser-process' | 'doctor-process' | `window:${WindowCapability}` | `move:${MoveStep}`;
export type IpcInventoryEntry = readonly [channel: string, destination: IpcDestination];

export const IPC_INVENTORY: readonly IpcInventoryEntry[] = [
    // The only retained protocol input: frames, never a handler per method. The reply channel has no ipcMain registration.
    [LOCAL_FRAME_CHANNELS.toHost, 'protocol-door'],
    [CLIPBOARD_WRITE_CHANNEL, 'window:clipboard'],

    ['doctor:facts', 'doctor-process'],
    ['doctor:connect', 'doctor-process'],
    ['doctor:detail', 'doctor-process'],
    ['doctor:prompt', 'doctor-process'],
    ['doctor:start', 'doctor-process'],
    ['doctor:answer-approval', 'doctor-process'],

    ['browser-window:state', 'browser-process'],
    ['browser-window:navigate', 'browser-process'],
    ['browser-window:open', 'browser-process'],
    ['browser-window:show-site', 'browser-process'],
    ['browser-window:new-tab', 'browser-process'],
    ['browser-window:activate', 'browser-process'],
    ['browser-window:close', 'browser-process'],
    ['browser-window:back', 'browser-process'],
    ['browser-window:forward', 'browser-process'],
    ['browser-window:reload', 'browser-process'],
    ['browser-window:preset', 'browser-process'],
    ['browser-window:sites-menu', 'browser-process'],
    ['browser-window:bounds', 'browser-process'],
    ['browser-window:overlay-colors', 'browser-process'],
    ['browser-window:pop-back', 'browser-process'],
    ['browser-window:restart', 'browser-process'],

    ['genie:window-overlay-colors', 'window:chrome'],
    ['genie:window-overlay-colors-current', 'window:chrome'],
    ['genie:renderer-stall', 'window:stall-report'],
    // Take over from another machine (Tynn #529 part A): this machine's Take Over window, and its ticket read once.
    ['genie:remote-takeover-open', 'window:take-over-window'],
    ['genie:takeover-ticket', 'window:take-over-window'],
    ['genie:files-open-external', 'window:os-shell'],
    ['genie:files-reveal', 'window:os-shell'],
    // The picker is the window's; its copy step moves to the host in P5.
    ['genie:files-export', 'window:file-dialog'],
    // 2f-2 (#941): its relay mode opens through the host's device link (link.browserVia).
    ['genie:browser-window-open', 'move:2f'],
    ['genie:files-popout', 'window:pop-out'],
    ['genie:terminals-popout', 'window:pop-out'],
    ['genie:remote-open-window', 'window:pop-out'],
    // The connected machine's questions into THIS machine's question window, and how an answer went (Tynn #726).
    ['genie:remote-questions', 'window:pop-out'],
    ['genie:remote-question-acted', 'window:pop-out'],
    // A pasted share link (Tynn #896, 2b-4): genie-host decides what it is (tynnNetwork.classifyLink); the window opens it,
    // in the person's browser or a workstation's window.
    ['genie:connect-link', 'window:os-shell'],
    // 2f-2 (#941): the host's device link, a second frame path beside the protocol door's.
    ['genie:relay-open', 'move:2f'],
    ['genie:relay-send', 'move:2f'],
    ['genie:relay-close', 'move:2f'],
    ['genie:device-open', 'move:2f'],
    ['genie:files-bringback', 'window:pop-out'],
    ['genie:files-windows', 'window:pop-out'],
    ['genie:features-browser-bounds', 'window:feature-effect'],

    ['host-wait:current', 'window:host-wait'],
    // Re-labelled from move:2f by the coordinator (2026-11-19, Tynn #912): shown only while genie-host does not answer; a
    // dead host cannot serve its own restart; the restart moves to the launcher in split step 6, never to the host. Its
    // handler exists only while the engine link is down (main.ts; split-2f-question-window.test.ts guards it).
    ['host-wait:act', 'window:host-wait'],

    // THE QUESTION WINDOW keeps only its window (Tynn #912, 2f-1): what to show, Later, the queue pick, the draft, Open in
    // Files and the drawer's width. Its answers and Dismiss (features.act) and its files and visuals (questions.*) go to
    // genie-host over its own frame port, like any window's.
    ['question:current', 'window:pop-out'],
    ['question:later', 'window:pop-out'],
    ['question:select', 'window:pop-out'],
    ['question:draft', 'window:pop-out'],
    // ANOTHER MACHINE'S question in this window (Tynn #726): answered, dismissed or its visuals read through the window that
    // drives that machine, which holds THAT host's protocol connection (main/remote-questions.ts), never this host.
    ['question:remote', 'window:pop-out'],
    ['question:open-in-files', 'window:pop-out'],
    ['question:drawer', 'window:chrome'],

    ['site-panel:prepare', 'window:site-panel'],
    ['site-panel:pop-out', 'window:site-panel'],
    ['site-panel:pop-back', 'window:site-panel'],
    ['site-panel:popped', 'window:site-panel'],
    ['site-panel:restart', 'window:site-panel'],
    ['site-panel:open-window', 'window:site-panel'],
];

/**
 * THE DOORS MAIN TUNNELS OVER ITS ENGINE LINK (Tynn #896, 2b-2b; the coordinator's ruling): each `tunnelDoor(<door>, …)`
 * in main.ts. A door carries protocol connections to genie-host's RemoteHost, which serves them; it is a PROTOCOL DOOR on
 * the link, never a listener (it has no address, and main starts no server: test/split-2e-window-guard.test.ts).
 *  - `localDoor`: the window's IPC door (local-protocol-door.ts), its pages' connections.
 *  - `ownProtocol.door`: main's own protocol client (own-protocol-client.ts), one connection per call: the tray's.
 */
export const WINDOW_PROTOCOL_DOORS: readonly (readonly [door: string, kind: 'protocol-door'])[] = [
    ['localDoor', 'protocol-door'],
    ['ownProtocol.door', 'protocol-door'],
];

export type EngineUseDestination = 'link' | `window:${WindowCapability}` | `move:${MoveStep}`;

/** Every use main.ts makes of its engine client: a member of SessionEngineClient, or `call:<method>` for a raw call. */
export const WINDOW_ENGINE_INVENTORY: readonly (readonly [use: string, destination: EngineUseDestination])[] = [
    ['welcome', 'link'],
    ['heartbeat', 'link'],
    // Electron resolves this machine's proxies; the host is told what it cannot ask for itself.
    ['call:engine.proxyRemember', 'link'],
    // The window announces itself and its launch line, and quits when the host installs an update.
    ['updates', 'link'],
    // The window's browser pane and its site panels.
    ['browserCall', 'window:feature-effect'],
    ['onBrowserEvent', 'window:feature-effect'],
    ['gappSessions', 'window:gapp-window'],
    // 2f-2 (#941): main's deck liveness until the question window and the tray badge read the host's deck (the coordinator,
    // 2026-11-19). Take Over itself is the protocol's since 2b-1 (#896).
    ['takeOvers', 'move:2f'],
    // 2g (#913), re-labelled from 2c by the coordinator (2026-11-19, 2c-5): the crash report (2c-2) and the scratch terminal
    // (2c-4) are the protocol's. main's terminals replica is still read by its own MCP tool server (genieToolDeps) and,
    // synchronously, by the tray count, the Restart/Shut-down list, the quit plan and quit's closeAll: they move with it.
    ['terminals', 'move:2g'],
    // 2f-2 (#941): the device link's frames. The question window's answers left in 2f-1 (#912).
    ['deviceLink', 'move:2f'],
    // 2g (#913): what the window still composes (composeWindowServices) or reads over genie-host's replicas.
    ['appInbox', 'move:2g'],
    ['catalog', 'move:2g'],
    ['flows', 'move:2g'],
    ['github', 'move:2g'],
    ['hosting', 'move:2g'],
    ['keyring', 'move:2g'],
    ['plugins', 'move:2g'],
    ['processBook', 'move:2g'],
    ['recordsChanged', 'move:2g'],
    ['relayHost', 'move:2g'],
    ['remoteAccess', 'move:2g'],
    ['stores', 'move:2g'],
    ['supervisor', 'move:2g'],
    ['tynn', 'move:2g'],
    ['tynnPage', 'move:2g'],
    ['workstation', 'move:2g'],
];
