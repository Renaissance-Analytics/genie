import type { RowsPatch } from './agent-push-wire.js';
import type { GateView } from './rate-limit-gate.js';
import type { LiveSession } from './roster.js';
import type { TimedEvent } from './stream-view.js';
import { parseFrame, type Frame } from './remote-protocol.js';

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

/** Bumped on any change a peer of another build could misread. A mismatch is refused, named, and the host replaced. */
export const ENGINE_PROTOCOL = 1;

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
    'engine.ended',
    'engine.settled',
    'engine.drained',
    'engine.modelState',
    'engine.switchModel',
    'engine.resumeLimit',
    'engine.clearDesignLogin',
    'engine.stopAll',
    // Subscriptions: an agent's ledger is sent only while the window watches it (cheap, incremental — patches only).
    'engine.watchLedger',
    'engine.unwatchLedger',
    // The records the host reads per call (a Claude agent's tool setting, genie#1188), pushed by the window.
    'engine.records',
    // Liveness, and the graceful end (sessions stopped and verified, writes drained, then the process exits).
    'engine.ping',
    'engine.shutdown',
    // The spawn host's frames, tunnelled (the host split, P2.1): `[profile, frame]` to genie-host's child of that profile.
    // Sent with call id 0, a notification: no result per keystroke. Its children's frames come back as `spawn.frame`.
    'engine.spawn',
    // The file watcher's per-view subscriptions (the host split, P2.2): `[viewId, {id, path}, want]` / `[viewId]`, under the
    // calling window's connection. Its batches and git come back as `files.event`, to the windows whose views watch.
    'engine.filesWatch',
    'engine.filesUnwatch',
    // The stores agents write to, owned by genie-host (the host split, P3.1): `[store, method, args]`, a window's write
    // (or a knowledge read). The whole state is sent as `stores.dump` before `engine.ready`, every change as `stores.event`.
    'engine.stores',
    // The host's process supervisor (P3.3b): `[method, args]` — start, stop, restart, forget. Its state is sent as
    // `supervisor.dump` before `engine.ready`, every change and every line of output as `supervisor.event`.
    'engine.supervisor',
    // The host's hosting (P5a: hosting-host.ts): `[method, args]` — a window's write. Its whole readable state is sent as
    // `hosting.dump` before `engine.ready` (the front door's port and CA with it), and again as `hosting.event` on change.
    'engine.hosting',
    // The host's process book and scheduler (P3.3c): `[method, args]`. Its list is sent as `processes.dump` before
    // `engine.ready`, and again as `processes.event` on every change.
    'engine.processes',
    // The host's flows (P3.3d): `[method, args]`. Every flow is sent as `flows.event` before `engine.ready` and on change.
    'engine.browser',
    'engine.flows',
    // The host's terminals (P3.3e): `[method, args]`. Their list and scrollback are sent as `terminals.dump` before
    // `engine.ready`; every change, every byte of output and every exit as `terminals.event`.
    'engine.terminals',
    // What Genie's MCP server in the host needs of the window until P3.2 (host-mcp.ts `WindowView`); the first one starts it.
    'engine.windowView',
    // Genie 1's database, where only the window knows it is: the host takes its memories and AgentInbox history once.
    'engine.v1Import',
    // The MCP server's endpoint, whether it verified, and its tools (the window's Deck and terminal env read them).
    'engine.mcpStatus',
    // One of the host's own tools for a caller the window knows (a flow's step): `[ForwardedToolCall]`.
    'engine.runTool',
    // This machine as a workstation: the host holds its key and signs: `[method, args]`.
    'engine.workstation',
    // Another machine's socket, dialled by the host; the window holds a channel (P3.4 cut e): `[method, args]`.
    'engine.deviceLink',
    // A workspace's agent config: the host writes it, under the lock its agent preparation holds.
    'engine.configSync',
    // The keyring card, as the host found it: `[method, args]`.
    'engine.keyring',
    // The host's GitHub account, and the authenticated git it runs (P3.4 cut c): `[method, args]`.
    'engine.github',
    // What the OS said about proxies, handed over by a window: `[{ origin: answer }]`.
    'engine.proxyRemember',
    // The host's Tynn account, as a window asks it (P3.4 cut c): `[method, args]`.
    'engine.tynn',
    // The host's keychain, from the window (P3.4): an agent's key only, by name; compare answers same-or-not.
    'engine.secretProbe',
    'engine.secretRead',
    'engine.secretStore',
    'engine.secretCompare',
    // Host → window.
    // A window tool's call, forwarded whole (mcp-host-tools.ts): the window runs today's handler and answers its result.
    'client.toolCall',
    // Each kept process's app-inbox credential, minted where the app-inbox server is (the window, until P5): `[processes]`.
    'client.appEnvs',
    // An elevation the host's hosting needs (the hosts file, the trust store), run by the window as a window always has:
    // `[steps]`. The host never raises a prompt itself; with no window it waits (hosting-host.ts WindowElevation).
    'client.elevate',
] as const;

export type EngineMethod = (typeof ENGINE_METHODS)[number];

export const isEngineMethod = (m: unknown): m is EngineMethod => typeof m === 'string' && (ENGINE_METHODS as readonly string[]).includes(m);

export type EngineFrame = Frame<EngineMethod>;

/** A frame of the engine protocol, or why not: the remote bridge's parser over this table. */
export function parseEngineFrame(text: string): { ok: true; message: EngineFrame } | { ok: false; reason: string } {
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
}

/** `engine.agent`: one agent changed. `rows` = this run's rows; `ledger` only while the window watches it. */
export interface EngineAgentUpdate {
    readonly id: string;
    /** This update's number for this agent on this connection: what the next patch names as its base. */
    readonly seq: number;
    readonly view: EngineAgentView;
    readonly rows: RowsPatch<TimedEvent>;
    readonly ledger?: RowsPatch<TimedEvent>;
}

/** `engine.global`: what is per provider or per host rather than per agent. Sent when it changed. */
export interface EngineGlobalView {
    readonly startedIds: readonly string[];
    readonly heldLogins: ReadonlyArray<{ provider: string; view: GateView }>;
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
    | { readonly name: 'plan'; readonly agentId: string; readonly steps: readonly { content: string; status: string }[] }
    | { readonly name: 'turnNumbered'; readonly agentId: string; readonly n: number }
    | { readonly name: 'action'; readonly agentId: string; readonly kind: string }
    | { readonly name: 'headroom'; readonly provider: string; readonly headroom: unknown }
    | { readonly name: 'mcpServers'; readonly agentId: string; readonly reports: readonly unknown[] }
    | { readonly name: 'stopUnverified'; readonly agentId: string; readonly reason: string }
    // openFileForUser while no window was there (P3.1): shown when the next one connects.
    | { readonly name: 'openFileForUser'; readonly call: unknown }
    // A tool's moment for the window: a glow, a thumbs-up, an action signal (moment-only).
    | { readonly name: 'toolSignal'; readonly signal: unknown };

/** Callbacks that change the window's stores: queued while no window is connected. The rest are moment-only. */
export const DURABLE_CALLBACKS: ReadonlySet<EngineCallback['name']> = new Set(['threadId', 'plan', 'turnNumbered', 'stopUnverified', 'openFileForUser']);

/** An attachment on the wire: its bytes as base64 (JSON has no bytes). */
export interface WireAttachment {
    readonly name: string;
    readonly type: string;
    readonly b64: string;
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
    if (record.build !== want.build) return { kind: 'replace', record, why: `build ${record.build}, this window is ${want.build}` };
    return { kind: 'adopt', record };
}

/** The per-user endpoint: a named pipe on Windows (per user by its name and token), a socket in the runtime dir elsewhere. */
export function hostEndpoint(platform: NodeJS.Platform, runtimeDir: string, userKey: string): string {
    return platform === 'win32' ? `\\\\.\\pipe\\genie-host-${userKey}` : `${runtimeDir}/host.sock`;
}
