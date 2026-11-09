import { CLIPBOARD_WRITE_CHANNEL } from './clipboard-wire.js';
import { LOCAL_FRAME_CHANNELS } from './local-frame.js';

/** P4's remaining IPC registrations. Protocol rows disappear with their handler in that family's PR. */
export type IpcDestination = `protocol:${string}` | 'protocol-door' | 'window-port' | `later:${string}`;
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

    ['browser-window:state', 'later:P2b browser process'],
    ['browser-window:navigate', 'later:P2b browser process'],
    ['browser-window:open', 'later:P2b browser process'],
    ['browser-window:show-site', 'later:P2b browser process'],
    ['browser-window:new-tab', 'later:P2b browser process'],
    ['browser-window:activate', 'later:P2b browser process'],
    ['browser-window:close', 'later:P2b browser process'],
    ['browser-window:back', 'later:P2b browser process'],
    ['browser-window:forward', 'later:P2b browser process'],
    ['browser-window:reload', 'later:P2b browser process'],
    ['browser-window:preset', 'later:P2b browser process'],
    ['browser-window:bounds', 'later:P2b browser process'],
    ['browser-window:overlay-colors', 'later:P2b browser process'],
    ['browser-window:pop-back', 'later:P2b browser process'],
    ['browser-window:restart', 'later:P2b browser process'],

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
    ['genie:browser-window-open', 'later:P2b browser process'],
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

    ['site-panel:prepare', 'later:P2b browser process'],
    ['site-panel:pop-out', 'later:P2b browser process'],
    ['site-panel:pop-back', 'later:P2b browser process'],
    ['site-panel:popped', 'later:P2b browser process'],
    ['site-panel:restart', 'later:P2b browser process'],
    ['site-panel:open-window', 'later:P2b site panels'],
];
