import { hostHashOf } from './update-kind.js';
import type { RowsPatch } from './agent-push-wire.js';
import type { GateView } from './rate-limit-gate.js';
import type { LiveSession } from './roster.js';
import type { TimedEvent } from './stream-view.js';
import { parseFrame, type Frame, type FrameRefusal } from './remote-protocol.js';

/**
 * THE AGENT ENGINE ON THE WIRE (the host split, phase 1 — `.ai/plans/genie-2-host-split-2026-10-31.md` in the envelope).
 *
 * The owner, 2026-10-31: "the actions agents take should not be routed through my UI … All work should be handled on the
 * host side." Phase 1 moves the agent engine — every session, its provider, its ACP parsing, its ledger and its thread
 * writes — out of the window's process into `genie-host` (main/genie-host.ts). The window's Electron main keeps a
 * replica (main/session-engine-client.ts) fed by this protocol.
 *
 * The envelope is the remote bridge's (core/remote-protocol.ts `Frame`): `hello{auth: token}` → `welcome`, `call` →
 * `result`, `event`. Only the method table is this file's. Calls go both ways: the window calls `engine.*`; the host
 * calls the window back for the one thing only the window has in phase 1 (`client.prepareMcpServers`: an agent's private
 * credentials, prepared with the OS secret store Electron owns).
 */

/**
 * Bumped on any change a peer of another build could misread. A mismatch is refused, named, and the host replaced.
 * 4: the window's protocol connections ride this link (`engine.protocol`, Tynn #898 step 2d-4b); a host of 3 has no tunnel.
 */
export const ENGINE_PROTOCOL = 4;

/**
 * What a link says in its `hello`. A WINDOW answers the host's calls to it (a forwarded tool, an elevation); the Genie
 * browser's own process (browser-process.ts) links to the host too, for its pages and cookies, and answers neither.
 */
export const WINDOW_LINK_LABEL = 'genie window';
export const BROWSER_LINK_LABEL = 'genie browser';
/**
 * GENIE'S LAUNCHER (Tynn #1058 L5; native/launcher/src/host.rs LINK_LABEL): it starts the host, stops it, and asks what it
 * runs for its tray. Its link is not a window: no dump, never counted (it must not hold off the host's idle exit), and it
 * may call these methods only.
 */
export const LAUNCHER_LINK_LABEL = 'genie launcher';
/**
 * L6 (updates): the launcher may also ask the host's updater (`engine.updates`: `state`, `check`, `install`). L7 (Tynn #716):
 * and the host's toolchain for its Updates list (`engine.toolchain`: `state`, `check`, `update`), whose install is the host's.
 */
export const LAUNCHER_LINK_METHODS = ['engine.ping', 'engine.shutdown', 'engine.activity', 'engine.updates', 'engine.toolchain'] as const;

export const ENGINE_METHODS = [
    // Commands (window → host): each answers with the session host's own answer.
    'engine.start',
    'engine.stop',
    'engine.prompt',
    // The typed-input path the inbox push uses (#1412): `{ queued }` or null, as SessionHost.handOff answers.
    'engine.handOff',
    'engine.promptWith',
    'engine.cancel',
    'engine.deliver',
    'engine.answerApproval',
    'engine.settleParked',
    'engine.notice',
    'engine.reportPlan',
    'engine.resolvePrompt',
    'engine.recordOwed',
    'engine.deliverOwed',
    'engine.forgetShown',
    'engine.ended',
    'engine.settled',
    'engine.drained',
    'engine.modelState',
    'engine.switchModel',
    // A provider's model list, for an agent not running yet (beta.61.1): asked of the provider's CLI by genie-host, which has
    // the process supervisor. `[provider, refresh]`.
    'engine.providerModels',
    // After a login: ask the provider who the account is now (Tynn #477). `[provider]`.
    'engine.refreshAccountIdentity',
    // SWITCH OFFERS (Tynn #481): the offers genie-host makes when the active account's chosen window is near its limit. `[]`;
    // Not now on one: `[offerId]`.
    'engine.switchOffers',
    // EVERY KNOWN ACCOUNT, with its readings, and the standing offers (Tynn #483): the header's account chips. `[]`.
    'engine.accounts',
    // Rename or forget a known account (Tynn #484). `[action]`.
    'engine.accountsAct',
    'engine.dismissSwitchOffer',
    'engine.resumeLimit',
    'engine.clearDesignLogin',
    'engine.stopAll',
    // An agent's recorded rows, bounded, for a provider switch's carry-over (Tynn story #380): read by the host from its own store.
    'engine.historyRows',
    // A tool row's whole output, read by the host from its own store when a person opens the row (Tynn story #386).
    'engine.toolOutput',
    // One image a thread kept, read by the host from its own store when a sent message's pill asks (Tynn #642).
    'engine.attachment',
    // Subscriptions: an agent's ledger is sent only while the window watches it (cheap, incremental — patches only).
    'engine.watchLedger',
    'engine.unwatchLedger',
    // The records the host reads per call (a Claude agent's tool setting, genie#1188), pushed by the window.
    // Liveness, and the graceful end (sessions stopped and verified, writes drained, then the process exits).
    'engine.ping',
    'engine.shutdown',
    // What this host runs now, by its own count, for the launcher's tray (Tynn #1058 L5): agents and their names, terminals,
    // kept processes, services.
    'engine.activity',
    // Window main's heartbeat to genie-host's hang watchdog (Tynn #386: hang-watchdog.ts): `[{pid, rss, bye?}]` every
    // second, call id 0 (a notification, no reply). Heard before any dispatch: never queued behind a slow call.
    'engine.heartbeat',
    // The spawn host's frames, tunnelled (the host split, P2.1): `[profile, frame]` to genie-host's child of that profile.
    // Sent with call id 0, a notification: no result per keystroke. Its children's frames come back as `spawn.frame`.
    'engine.spawn',
    // Other Tynn pages are read on this host's pairing and workspace registry, for local windows only.
    'engine.tynnPage',
    // The stores, the process supervisor and the flows went from the engine link in 2g-4d E2a (Tynn #955): a window reads and
    // writes them over the protocol (features.act/snapshot, registry.write, chatDrafts.*); genie-host keeps them in-process.
    // The host's hosting left the engine link in 2g-4d E2b (Tynn #955): a window reads its front door on frontdoor.watch and
    // drives its sites and services over the protocol (features.snapshot/act); genie-host keeps it in-process.
    // The window's environment NOW (P5a.2): `[env]`, pushed after a Check and repair so what the host starts next (a site's
    // php-cgi, an agent) reads it with no restart. Also carried with every start, as before.
    'engine.windowEnv',
    // The host's app door and its keys (P5a.2: app-inbox-host.ts): `[method, args]` — a LOCAL window's change. The keys'
    // state (names, ids, dates — never a secret) is sent as `appInbox.dump` before `engine.ready` and again as `appInbox.event`.
    'engine.appInbox',
    // The host's updater (P5b: updates-host.ts): `[method, args]` — a LOCAL window's check, download, install, channel and
    // the helper's launch. Its state is sent as `updates.dump` before `engine.ready` and as `updates.event` on change, to
    // local windows only.
    'engine.updates',
    // THE HOST'S TOOLS FOR THE LAUNCHER'S UPDATES (Tynn #1058 L7, #716: launcher-toolchain.ts): `[method, args]`, `state`, `check`
    // and `update [{tool, version?, confirmed?}]`, answered from HostFeatures' toolchain (its own installer), local links only.
    'engine.toolchain',
    // The host's safe mode (Tynn #386: safe-mode-host.ts): `['leave']`. Its view is sent as `safeMode.event` before
    // `engine.ready` and on every change, to EVERY window: the banner is on all of them.
    'engine.safeMode',
    // The latest crash record and the reopened-window notice (Tynn #386: crash-state-host.ts), LOCAL windows only: sent as
    // `crash.event` before `engine.ready` and on every change; `['dismiss']` forgets the notice.
    'engine.crash',
    // The updater helper's own (P5b: updater-helper.ts), on a link that said hello as the updater: `register`, `reply`,
    // `progress`. The host's requests reach it as `updater.event`. Nothing else is open to that link.
    'engine.updater',
    // The host's process book and scheduler (P3.3c): `[method, args]`. Its list is sent as `processes.dump` before
    // `engine.ready`, and again as `processes.event` on every change.
    'client.featureEffect',
    'engine.processes',
    'engine.cloneOffers',
    // The host's plugins (ADF A3, Tynn #447: plugins-host.ts): `[method, args]` — a LOCAL window's setEnabled or refresh.
    // Their state is sent as `plugins.event` before `engine.ready` and again on every change.
    // Anonymous Marketplace reads and reviewed installs: local window only, with connection-owned review tokens.
    'engine.marketplace',
    // The GApp book (GApps v2 V7, Tynn #572): `[operation, args]`, a local window's store actions (main/gapps-api.ts).
    'engine.gapps',
    // THE CATALOG (ADF A4, Tynn #448: protocol 3). `catalog.snapshot []` answers `{ revision, definitions }`, also sent as
    // the `catalog.snapshot` event before `engine.ready`; every change is pushed as `catalog.changed` (upserts and
    // removals from a base revision; a window that missed one asks for the snapshot again). `catalog.docs [kind, id]`
    // answers one element's definition, or null.
    'engine.browser',
    // The host's terminals (P3.3e): `[method, args]`. Their list and scrollback are sent as `terminals.dump` before
    // `engine.ready`; every change, every byte of output and every exit as `terminals.event`.
    'engine.terminals',
    // What Genie's MCP server in the host needs of the window until P3.2 (host-mcp.ts `WindowView`); the first one starts it.
    // Genie 1's database, where only the window knows it is: the host takes its memories and AgentInbox history once.
    // The MCP server's endpoint, whether it verified, and its tools (the window's Deck and terminal env read them).
    'engine.mcpStatus',
    // This machine as a workstation: the host holds its key and signs: `[method, args]`.
    'engine.workstation',
    // THE WINDOW'S PROTOCOL CONNECTIONS, TUNNELLED (Tynn #898 step 2d-4b: protocol-tunnels.ts, window-tunnel.ts): `[op,
    // tunnel, payload]` with call id 0, a notification, in order on this one socket. `open {window, label}`, `frame text`,
    // `close reason`, `browser state`. genie-host's RemoteHost answers them; its frames come back as `protocol.frame`.
    // A LOCAL window's link only: genie-host admits each as this machine's own window.
    'engine.protocol',
    // Remote access's host side (Tynn #409, P5d.1): its status, the PIN, devices, lock, pair answers, and the relay bridge.
    'engine.remoteAccess',
    // The Tynn relay host (Tynn #410, P5d.3): the registration, the role and the link, as a window reads them.
    // Take over (Tynn #553, P5d.5c): genie-host owns who has a TUI open; a window starts, ends and reads them here.
    'engine.takeOver',
    // The keyring card, as the host found it: `[method, args]`.
    // The host's GitHub account, and the authenticated git it runs (P3.4 cut c): `[method, args]`.
    // What the OS said about proxies, handed over by a window: `[{ origin: answer }]`.
    'engine.proxyRemember',
    // The host's Tynn account, as a window asks it (P3.4 cut c): `[method, args]`.
    // The host's keychain, from the window (P3.4): an agent's key only, by name. What an older Genie sealed goes on the
    // protocol's keychain.adoptLegacy instead (Tynn #959, 2g-3b).
    // Host → window.
    // A window tool's call, forwarded whole (mcp-host-tools.ts): the window runs today's handler and answers its result.
    'client.toolCall',
    // An elevation the host's hosting needs (the hosts file, the trust store), run by the window as a window always has:
    // `[steps]`. The host never raises a prompt itself; with no window it waits (hosting-host.ts WindowElevation).
    'client.elevate',
    // What only a window can do, asked of the window process that owns the caller (Tynn #898 step 2d-4b): `[op, args]`.
    // `trash [path]` (Electron's shell.trashItem), `gapps.open [id]` / `gapps.preview [id]` (an app's BrowserWindow).
    'client.windowOp',
] as const;

export type EngineMethod = (typeof ENGINE_METHODS)[number];

export const isEngineMethod = (m: unknown): m is EngineMethod => typeof m === 'string' && (ENGINE_METHODS as readonly string[]).includes(m);

export type EngineFrame = Frame<EngineMethod>;

/** A frame of the engine protocol, or why not: the remote bridge's parser over this table. */
export function parseEngineFrame(text: string): { ok: true; message: EngineFrame } | FrameRefusal {
    return parseFrame(text, isEngineMethod);
}

/** What `welcome` adds on this link: the versions, so a window and a host of different builds say so instead of guessing. */
export interface EngineWelcome {
    readonly protocol: number;
    readonly build: string;
    readonly pid: number;
}

/**
 * ONE AGENT AS THE WINDOW READS IT — what the session host answers synchronously, computed on the host after each change
 * and sent as a whole (it is small). The probe carries no comms cell: the inbox lives with the window in phase 1, which
 * adds it when it reads.
 */
export interface EngineAgentView {
    readonly probe: LiveSession | null;
    readonly runOf: number | null;
    readonly promptable: number | null;
    readonly lastTurnEnd: 'replied' | 'stopped' | 'failed' | 'held' | 'signed-out' | null;
    readonly turns: number;
    readonly turnsEndedThisRun: number;
    readonly recentStderr: readonly string[];
    readonly refusal: string | null;
    readonly unusableThreadId: string | null;
    /** Whether `modelState` / `switchModel` would answer rather than `null` (the session host's `modelCaps`). */
    readonly models: { readonly state: boolean; readonly switch: boolean };
    /** What the inbox push reads (#1412): the run when a notice may be delivered now, a turn in flight, the held prompts. */
    readonly deliverable: number | null;
    readonly inTurn: boolean;
    readonly queued: readonly string[];
    /** The run's driver stopped itself and must be replaced before it takes work (SessionHost.needsNewDriver, prism-acp 0.37.0). */
    readonly needsNewDriver?: boolean;
    /** The ledger still waits on its recorded history (SessionHost.historyPending, Tynn #659): not yet the conversation. */
    readonly historyPending?: boolean;
}

/** `engine.agent`: one agent changed. `rows` = this run's rows; `ledger` only while the window watches it. */
export interface EngineAgentUpdate {
    readonly id: string;
    /** This update's number for this agent on this connection: what the next patch names as its base. */
    readonly seq: number;
    readonly view: EngineAgentView;
    readonly rows: RowsPatch<TimedEvent>;
    readonly ledger?: RowsPatch<TimedEvent>;
    /**
     * More frames of this one change follow (a long patch cut in PATCH_CHUNK_ROWS frames, Tynn #659): the window applies
     * it and waits for the last before it says anything changed, so a ledger is never shown in parts, oldest first.
     */
    readonly more?: true;
}

/** `engine.global`: what is per provider or per host rather than per agent. Sent when it changed. */
export interface EngineGlobalView {
    readonly startedIds: readonly string[];
    readonly heldLogins: ReadonlyArray<{ provider: string; account: string; view: GateView }>;
    readonly signedOutProviders: readonly string[];
    readonly pausedProviders: readonly string[];
    readonly pausedAgents: Readonly<Record<string, readonly string[]>>;
    readonly signedOutAgents: Readonly<Record<string, readonly string[]>>;
    readonly designLoginAgents: readonly string[];
}

/**
 * `engine.callback`: what the session host tells its owner (main.ts's SessionHost options). Queued on the host while no
 * window is connected and flushed to the next one, so a window that crashed never loses a thread id (a resume) or a plan.
 */
export type EngineCallback =
    | { readonly name: 'threadId'; readonly agentId: string; readonly threadId: string }
    | { readonly name: 'carryOverSent'; readonly agentId: string }
    | { readonly name: 'redockSent'; readonly agentId: string; readonly at: string }
    // Genie's own words are in the agent's thread now (genie#1519): its record says so, as the window's registry writes it.
    | { readonly name: 'genieWords'; readonly agentId: string }
    | { readonly name: 'plan'; readonly agentId: string; readonly steps: readonly { content: string; status: string }[] }
    | { readonly name: 'turnNumbered'; readonly agentId: string; readonly n: number }
    | { readonly name: 'action'; readonly agentId: string; readonly kind: string }
    | { readonly name: 'headroom'; readonly provider: string; readonly headroom: unknown; readonly stamp?: { readonly accountId: string; readonly runId: string; readonly fresh?: boolean } }
    | { readonly name: 'mcpServers'; readonly agentId: string; readonly reports: readonly unknown[] }
    | { readonly name: 'stopUnverified'; readonly agentId: string; readonly reason: string }
    // openFileForUser while no window was there (P3.1): shown when the next one connects.
    | { readonly name: 'openFileForUser'; readonly call: unknown }
    // A tool's moment for the window: a glow, a thumbs-up, an action signal (moment-only).
    | { readonly name: 'toolSignal'; readonly signal: unknown };

/** Callbacks that change the window's stores: queued while no window is connected. The rest are moment-only. */
export const DURABLE_CALLBACKS: ReadonlySet<EngineCallback['name']> = new Set(['threadId', 'carryOverSent', 'redockSent', 'genieWords', 'plan', 'turnNumbered', 'stopUnverified', 'openFileForUser']);

/** An attachment on the wire: its bytes as base64 (JSON has no bytes). */
export interface WireAttachment {
    readonly name: string;
    readonly type: string;
    readonly b64: string;
    /** Saved into the workspace by the host (Tynn #829): where, as `Attachment.saved`. */
    readonly saved?: { readonly path: string; readonly type: string; readonly size: number };
}
/** Where the host writes what a window needs to find and trust it (`<genieHome>/runtime/host.json`). */
export interface HostRecord {
    readonly pid: number;
    readonly endpoint: string;
    readonly protocol: number;
    readonly build: string;
    readonly startedAt: number;
}

export function parseHostRecord(text: string | null): HostRecord | null {
    if (text === null) return null;
    try {
        const raw = JSON.parse(text) as Record<string, unknown>;
        if (typeof raw.pid !== 'number' || typeof raw.endpoint !== 'string' || typeof raw.protocol !== 'number' || typeof raw.build !== 'string' || typeof raw.startedAt !== 'number') return null;
        return { pid: raw.pid, endpoint: raw.endpoint, protocol: raw.protocol, build: raw.build, startedAt: raw.startedAt };
    } catch {
        return null;
    }
}

/** What a window does with the host it found. */
export type HostDecision = { readonly kind: 'start' } | { readonly kind: 'adopt'; readonly record: HostRecord } | { readonly kind: 'replace'; readonly record: HostRecord; readonly why: string };

/**
 * ADOPT, REPLACE OR START (pure). A live host of this protocol and build is adopted — its agents keep running across a
 * window restart or crash. A live host of another build is replaced (gracefully: `engine.shutdown`). No record, or a
 * dead pid, is a start.
 */
export function hostDecision(record: HostRecord | null, alive: (pid: number) => boolean, want: { protocol: number; build: string }): HostDecision {
    if (record === null || !alive(record.pid)) return { kind: 'start' };
    if (record.protocol !== want.protocol) return { kind: 'replace', record, why: `protocol ${record.protocol}, this window speaks ${want.protocol}` };
    // The same host by its hash, whatever the version (Tynn #413): a client-only update's window adopts the host that kept running.
    if (record.build !== want.build && !(hostHashOf(record.build) !== null && hostHashOf(record.build) === hostHashOf(want.build))) {
        return { kind: 'replace', record, why: `build ${record.build}, this window is ${want.build}` };
    }
    return { kind: 'adopt', record };
}

/** The per-user endpoint: a named pipe on Windows (per user by its name and token), a socket in the runtime dir elsewhere. */
export function hostEndpoint(platform: NodeJS.Platform, runtimeDir: string, userKey: string): string {
    return platform === 'win32' ? `\\\\.\\pipe\\genie-host-${userKey}` : `${runtimeDir}/host.sock`;
}
