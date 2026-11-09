import { CLIPBOARD_WRITE_CHANNEL } from './clipboard-wire.js';
import { LOCAL_FRAME_CHANNELS } from './local-frame.js';

/** P4's remaining IPC registrations. Protocol rows disappear with their handler in that family's PR. */
/**
 * `browser-process`: answered by the Genie browser process (genie-browser-electron.ts); the window has no copy (Tynn #585). `window-port`: stays in the window, which is also where the site panels are, as webviews by design (one login
 * per site).
 */
export type IpcDestination = `protocol:${string}` | 'protocol-door' | 'window-port' | 'browser-process' | `later:${string}`;
export type IpcInventoryEntry = readonly [channel: string, destination: IpcDestination];

/** Protocol destinations include the local-only methods to be registered as their families move. */
export const IPC_INVENTORY: readonly IpcInventoryEntry[] = [
    // The only retained protocol input: frames, never a handler per method. The reply channel has no ipcMain registration.
    [LOCAL_FRAME_CHANNELS.toHost, 'protocol-door'],
    [CLIPBOARD_WRITE_CHANNEL, 'window-port'],

    ['doctor:facts', 'later:doctor window'],
    ['doctor:connect', 'later:doctor window'],
    ['doctor:detail', 'later:doctor window'],
    ['doctor:prompt', 'later:doctor window'],
    ['doctor:start', 'later:doctor window'],
    ['doctor:answer-approval', 'later:doctor window'],

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
    ['browser-window:bounds', 'browser-process'],
    ['browser-window:overlay-colors', 'browser-process'],
    ['browser-window:pop-back', 'browser-process'],
    ['browser-window:restart', 'browser-process'],

    ['genie:window-overlay-colors', 'window-port'],
    ['genie:window-overlay-colors-current', 'window-port'],
    ['genie:renderer-stall', 'window-port'],
    ['genie:snapshot', 'protocol:snapshot'],
    ['genie:agent-detail', 'protocol:agentDetail'],
    ['genie:agent-watch', 'protocol:agent.watch'],
    ['genie:open-agent', 'protocol:openAgent'],
    ['genie:stop-agent', 'protocol:stopAgent'],
    ['genie:resume-limit', 'protocol:resumeLimit'],
    ['genie:cancel-turn', 'protocol:cancelTurn'],
    ['genie:prompt', 'protocol:prompt'],
    ['genie:resolve-prompt', 'protocol:resolvePrompt'],
    ['genie:answer-approval', 'protocol:answerApproval'],
    ['genie:add-agent', 'protocol:addAgent'],
    ['genie:design-login', 'window-port'],
    ['genie:provider-login', 'window-port'],
    ['genie:restart-with-handoff', 'protocol:restartWithHandoff'],
    ['genie:take-over', 'window-port'],
    // Take over from another machine (Tynn #529 part A): this machine's Take Over window, and its ticket read once.
    ['genie:remote-takeover-open', 'window-port'],
    ['genie:takeover-ticket', 'window-port'],
    // The safe-mode banner's crash report (Tynn #386 part 4): built and sent from this window, with the host's proof.
    ['genie:crash-report-draft', 'window-port'],
    ['genie:crash-report-send', 'window-port'],
    // Opens a window on this machine (Tynn story #378): the window's own, like Take Over's window.
    ['genie:scratch-terminal-open', 'window-port'],
    ['genie:files-open-external', 'window-port'],
    ['genie:files-reveal', 'window-port'],
    // The picker stays a window port; its copy step moves to the host in P5.
    ['genie:files-export', 'window-port'],
    ['genie:browser-window-open', 'window-port'],
    ['genie:files-popout', 'window-port'],
    ['genie:remote-open-window', 'window-port'],
    ['genie:connect-link', 'window-port'],
    ['genie:relay-open', 'later:P5 relay client moves into genie-host'],
    ['genie:relay-send', 'later:P5 relay client moves into genie-host'],
    ['genie:relay-close', 'later:P5 relay client moves into genie-host'],
    ['genie:device-open', 'later:P5 relay client moves into genie-host'],
    ['genie:files-bringback', 'window-port'],
    ['genie:files-windows', 'window-port'],
    ['genie:add-workspace', 'window-port'],
    ['genie:provider-choose-program', 'window-port'],
    ['genie:features-browser-bounds', 'window-port'],

    ['question:current', 'later:question window'],
    ['question:answer', 'later:question window'],
    ['question:later', 'later:question window'],
    ['question:dismiss', 'later:question window'],
    ['question:select', 'later:question window'],
    ['question:draft', 'later:question window'],
    ['question:files', 'later:question window'],
    ['question:file', 'later:question window'],
    ['question:drawer', 'later:question window'],

    ['site-panel:prepare', 'window-port'],
    ['site-panel:pop-out', 'window-port'],
    ['site-panel:pop-back', 'window-port'],
    ['site-panel:popped', 'window-port'],
    ['site-panel:restart', 'window-port'],
    ['site-panel:open-window', 'window-port'],
];
