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
    // Host → window.
    'client.prepareMcpServers',
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
    | { readonly name: 'stopUnverified'; readonly agentId: string; readonly reason: string };

/** Callbacks that change the window's stores: queued while no window is connected. The rest are moment-only. */
export const DURABLE_CALLBACKS: ReadonlySet<EngineCallback['name']> = new Set(['threadId', 'plan', 'turnNumbered', 'stopUnverified']);

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
