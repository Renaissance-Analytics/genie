import { BrowserWindow, ipcMain, WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    terminalManager,
    subscribeBackendEvents,
    detectShells,
    defaultShellId,
    resolveDefaultShell,
    type CreateTerminalOpts,
    type TerminalInfo,
} from '@particle-academy/fancy-term-host';
import {
    getAllSettings,
    getTerminalSpec,
    listTerminalSpecs,
    updateTerminalSpec,
    workspaceMcpEnabled,
    createTerminalSpec,
    getWorkspace,
    getWorkspaceAgentCap,
    listWorkspaceAgents,
    getDb,
    markWorkspaceAgentTransportState,
    type TerminalSpecRow,
    type TerminalSpecMeta,
} from '../db';
import {
    UNLIMITED,
    countAgentTerminals,
    decideAgentSpawn,
    type AgentCapValue,
    type AgentSpawnDecision,
    type SpawnActor,
} from './agent-cap';
import { agentInboxBroker } from '../agentinbox/broker';
import { harnessTransportRegistry } from '../agentinbox/harness-transport';
import {
    CODEX_APP_TOKEN_ENV,
    codexAppServerConfigArgs,
    codexAppServerManager,
    codexRemoteTuiLaunch,
    prepareCodexAppServer,
    type PreparedCodexAppServer,
} from '../agentinbox/codex-app-server-lifecycle';
import { agentInboxJoinInputFor } from '../agentinbox/join-input';
import {
    renderAgentLaunch,
    captureSessionByDetect,
    agentRelaunchDecision,
    transcriptDirFor,
} from '../agentinbox/session-capture';
import { withProviderStartupInstructions } from '../agents/startup';
import { launchBlockReason } from '../agents/availability';
import { buildSubmitBytes } from './keystrokes';
import {
    normalizePurpose,
    type AgentInboxJoinInput,
    type AgentInboxScope,
} from '../agentinbox/types';
import { withCodexGenieMcpLaunch } from '../mcp/agent-config';
import { buildTerminalEnv } from './terminal-env';
import { computeOrphans } from './orphans';
import { buildProcessArgs } from './process-spawn';
import { devServiceHostEnvFor } from '../dev-server';
import { terminalServiceEnv } from '../dev-server/services/env-wiring';
import { withoutManagedServiceKeys } from '../dev-server/services/env-sync';
import {
    TerminalReadBuffer,
    type ReadResult,
    type TerminalReadState,
} from './read-buffer';
import { recordTerminalSize, isUsableGrid } from './size-tracker';
import {
    startProcess,
    stopProcess,
    restartProcess,
    getProcessStatuses,
    onProcessPtyExit,
    forgetProcess,
    recordProcessOutput,
    getProcessLog,
    clearProcessLog,
} from './process-supervisor';
import { getScheduleInfo, runScheduleNow } from './process-scheduler';
import {
    registerTerminalEndpoint,
    unregisterTerminalEndpoint,
    workspaceEndpointUrl,
} from '../mcp/server';
import { mobileEmit, mobileTermFanout, mobileTermClose } from '../mobile/server';
import { broadcastLocal } from '../remote';
import { terminalNoticeFacts } from '../attention/terminal-facts';
import { planInboxIncomingNotice } from '../attention/inbox-incoming-notice';
import { getSnapshotStore, dbSettingsProvider } from './genie-adapter';
import { listAllProcesses } from './process-list';
import { logPtyOsc } from './osc-debug';
import { agentPulse } from './agent-pulse';
import { InputHolds } from './input-hold';
import { devChannelConsentReply } from './dev-channel-consent';
import crypto from 'node:crypto';

/**
 * Tier 2 resource cap. The number of terminals that may be RETAINED (kept
 * running with zero attached windows) at once. Disabling a terminal past this
 * cap is blocked with a clear message rather than silently evicting a live
 * session — losing a dev server you forgot about is worse than a "cap reached"
 * toast. Tune here; the renderer surfaces the limit in its hint.
 */
export const MAX_RETAINED = 8;

/**
 * When the LAST owner of a pty detaches, should the pty be KILLED?
 *
 * The detached pty-host exists so terminals (and the agents in them) PERSIST
 * across a window close — so a window CLOSE must NEVER kill the backend pty: we
 * just drop the renderer's attachment and leave the pty alive in the host,
 * re-attachable when a window reopens (terminal:create's rejoin path replays
 * scrollback). Only a DELIBERATE per-panel detach (the renderer's
 * `terminal:detach` — e.g. deselecting a panel) kills a non-retained pty, as
 * before; a retained (suspended) pty always survives. Explicit close (the panel
 * X) is a separate `terminal:kill`, unaffected.
 *
 * Pure → unit-testable without booting Electron.
 */
export function shouldKillOnDetach(input: {
    /** True when this detach left the pty with zero owners. */
    lastOwner: boolean;
    /** The manager's retained (suspended) flag for this pty. */
    retained: boolean;
    /** True when the detach was triggered by the window being destroyed (close),
     *  vs a deliberate `terminal:detach` from a still-live renderer. */
    fromWindowClose: boolean;
}): boolean {
    if (!input.lastOwner) return false; // other windows still attached
    if (input.fromWindowClose) return false; // persistence: a close never kills
    return !input.retained; // deliberate detach kills a non-retained pty
}

/**
 * Decide whether a RETAIN request (hiding a terminal to keep its pty alive +
 * windowless) must be REFUSED by the MAX_RETAINED cap.
 *
 * AGENT terminals are EXEMPT: the owner deliberately runs MANY hidden-but-alive
 * agents, and losing one (its shell, MCP endpoint, and AgentInbox membership)
 * discards live work — so an agent terminal neither counts toward the cap nor is
 * ever blocked by it. Only PLAIN terminals are capped, among themselves (a
 * runaway of windowless shells still can't grow unbounded). An already-retained
 * id is idempotent (never refused).
 *
 * Pure → unit-testable without the pty manager.
 */
export function refuseRetainForCap(input: {
    /** The terminal being retained runs an agent (spec meta.agent_id). */
    isAgent: boolean;
    /** It is already retained (re-retain is idempotent). */
    alreadyRetained: boolean;
    /** How many NON-agent ptys are currently retained (agents don't count). */
    nonAgentRetainedCount: number;
    max: number;
}): boolean {
    if (input.isAgent || input.alreadyRetained) return false;
    return input.nonAgentRetainedCount >= input.max;
}

/**
 * IPC layer for the terminal subsystem. The manager owns ptys + emits
 * `data`/`exit` events; this layer fans those events out to whichever
 * webContents own each terminal id, and routes renderer-side write /
 * resize / kill calls back to the manager.
 *
 * Multi-attach is supported: a single pty can be displayed in more
 * than one window at the same time (TheFloor + a Stage, for example).
 * Owners are tracked as a Set per terminal id. The pty is killed only
 * when the LAST owner detaches.
 *
 * Channels (renderer → main):
 *   terminal:create  (opts: CreateTerminalOpts)
 *                   → { id, pid, shell, existing, scrollback }
 *   terminal:write   (id, data: string)         → boolean
 *   terminal:resize  (id, cols, rows)           → boolean
 *   terminal:detach  (id)                       → boolean   ← per-window
 *   terminal:kill    (id)                       → boolean   ← global
 *   terminal:list    ()                         → TerminalInfo[]
 *
 * Push (main → renderer):
 *   terminal:data    {id, data}
 *   terminal:exit    {id, exitCode, signal}
 */

interface OwnerEntry {
    /** Per-spec set of webContents currently rendering this terminal. */
    owners: Set<WebContents>;
    /** Cleanup hook bound to each owner via webContents.once('destroyed'). */
    cleanup: WeakMap<WebContents, () => void>;
}

/**
 * Owner registry, module-scoped so the quit-time helper
 * (snapshotRetainedWindowless) can tell which retained ptys currently have no
 * attached window. registerTerminalIpc is called exactly once at app-ready.
 */
const ownersByTerminal = new Map<string, OwnerEntry>();

/**
 * workspaceId → the terminal id most recently created/written in it. The
 * workspace-scoped MCP endpoint uses this to resolve which terminal a tool call
 * (imDone / ForceTheQuestion) targets when the agent doesn't pass an explicit
 * `terminalId`. Module-scoped so the MCP server's workspaceTerminals() dep can
 * read it via lastActiveTerminalForWorkspace().
 */
const lastActiveByWorkspace = new Map<string, string>();

/** Record that a terminal saw activity, so it becomes its workspace's default. */
function noteTerminalActivity(terminalId: string): void {
    const ws = getTerminalSpec(terminalId)?.workspace_id;
    if (ws) lastActiveByWorkspace.set(ws, terminalId);
}

/** The most-recently-active terminal id for a workspace (or null). */
export function lastActiveTerminalForWorkspace(workspaceId: string): string | null {
    return lastActiveByWorkspace.get(workspaceId) ?? null;
}

/**
 * Bounded per-terminal output ring buffer for the agent-control MCP READ
 * actions (manageTerminals.read / runAgent.read). Fed from the SAME onData
 * fan-out the renderer windows get (below), so an agent can poll a terminal's
 * recent output without owning a window. Module-scoped so killTerminalById +
 * the exit handler can drop a dead terminal's buffer, and the agent helpers can
 * read it. Capacity-capped (see read-buffer.ts) so it can't grow unboundedly.
 */
const agentReadBuffer = new TerminalReadBuffer();

/** How much of the tail the development-channel warning check reads. The dialog
 *  is a few hundred bytes, but Ink repaints it and the pty wraps every line, so
 *  the assembled frame is comfortably larger than it looks. */
const DEV_CHANNEL_SCAN_BYTES = 8 * 1024;

/**
 * How much of a terminal's output survives its pty EXIT. The spec is retained
 * (revivable) after a pty dies, so the buffer must not vanish with it — those
 * last bytes are the ONLY evidence of why an agent crashed, and an Ops loop
 * reading the terminal has nothing else to classify it by. Bounded well under
 * CAP_BYTES because a dead terminal only needs its tail, and its buffer now
 * lives until the spec itself is killed.
 */
export const EXIT_TAIL_BYTES = 16 * 1024;

/** A read plus what its emptiness actually means (see TerminalReadState). */
export interface TerminalReadResult extends ReadResult {
    state: TerminalReadState;
}

export type { TerminalReadState };

/**
 * Whether the active backend still owns a pty for `id`. Never throws.
 *
 * Exported as {@link isTerminalLive} because a SAVED agent's dormant-vs-running
 * state is exactly this question (Tynn #254), and a second `try { isLive }`
 * elsewhere would be one more place for the never-throws part to be forgotten.
 */
function ptyIsLive(id: string): boolean {
    try {
        return terminalManager().isLive(id);
    } catch {
        return false;
    }
}

export { ptyIsLive as isTerminalLive };

/**
 * Read recent output for a terminal (agent-control MCP).
 *
 * The buffer is fed by the LIVE data stream, so it holds nothing for a terminal
 * whose output predates this process — a pty that survived a Genie restart in
 * the detached pty-host, for instance. Those terminals are still alive and still
 * listed, and a PARKED agent never emits the byte that would refill the buffer,
 * so reads used to return an empty string forever (genie#217). The scrollback
 * DID survive — in the backend (the host client mirror is seeded from the host
 * on every connect) — so a read with no buffer restores it from there first.
 *
 * The result says which of the three answers it is, because "0 bytes, quiet",
 * "0 bytes, just restored" and "0 bytes, no pty" are not the same news.
 */
export function readTerminalOutput(
    id: string,
    opts: { cursor?: number; bytes?: number },
): TerminalReadResult {
    const restored = ensureReadBufferSeeded(id);
    const r =
        opts.bytes !== undefined
            ? agentReadBuffer.readTail(id, opts.bytes)
            : agentReadBuffer.readSince(id, opts.cursor);
    const state: TerminalReadState = !ptyIsLive(id)
        ? 'exited'
        : restored
          ? 'restored'
          : 'live';
    return { ...r, state };
}

/**
 * Restore a MISSING read buffer from the backend's surviving scrollback.
 * Returns true when it actually seeded (i.e. this read is serving restored
 * history). A no-op when a buffer already exists — the live tap wins.
 */
function ensureReadBufferSeeded(id: string): boolean {
    if (agentReadBuffer.has(id)) return false;
    let scrollback: string | undefined;
    try {
        scrollback = terminalManager().getScrollback(id);
    } catch {
        scrollback = undefined;
    }
    return scrollback ? agentReadBuffer.seed(id, scrollback) : false;
}

/**
 * Seed the agent read buffer for every terminal the backend already owns —
 * called once at boot, after the backend is selected and its events are
 * subscribed. Terminals that outlived Genie in the detached pty-host come back
 * with their scrollback in the host client's mirror; without this their MCP
 * reads stay empty until they happen to emit again (genie#217). Returns the ids
 * seeded. Never throws: a backend that can't be listed simply seeds nothing, and
 * the per-read restore above still covers it.
 */
/**
 * Seed + log, run right after the live data tap is wired (both the desktop IPC
 * fan-out and the headless one). Wiring the tap is exactly when we start seeing
 * output, so it is also when we should collect what we MISSED — keeping the
 * catch-up next to the subscription means no embedder can wire one without the
 * other. Never throws; a read still restores itself lazily if this finds nothing.
 */
function catchUpAgentReadBuffers(): void {
    try {
        const seeded = seedAgentReadBuffers();
        if (seeded.length > 0) {
            // eslint-disable-next-line no-console
            console.log(`[terminal] restored read buffers for ${seeded.length} terminal(s)`);
        }
    } catch {
        /* best-effort */
    }
}

export function seedAgentReadBuffers(): string[] {
    const seeded: string[] = [];
    let ids: string[] = [];
    try {
        ids = terminalManager()
            .list()
            .map((t) => t.id);
    } catch {
        return seeded;
    }
    for (const id of ids) {
        try {
            if (ensureReadBufferSeeded(id)) seeded.push(id);
        } catch {
            /* best-effort per terminal — one bad id can't sink the rest */
        }
    }
    return seeded;
}

/**
 * Point a Codex agent's genie MCP `-c` launch override at THIS terminal's OWN
 * endpoint, so the token self-identifies the terminal server-side and the agent
 * never needs to pass `terminalId` (genie #35). Codex takes its genie URL from
 * this launch override — NOT from the GENIE_MCP_URL env var, which only Claude's
 * `.mcp.json` (via env resolution) and the harness consume.
 *
 * A no-op unless the terminal's workspace has agent-MCP enabled, the agent is
 * codex, codex sync is on, and the loopback endpoint mints — mirroring the
 * GENIE_MCP_URL env gate applied alongside it. The per-terminal token is stable
 * across restarts (`registerTerminalEndpoint` reuses it), so a relaunch
 * re-derives the same URL. Both the first launch (createAgentTerminal) and the
 * restart relaunch (maybeRelaunchAgent) run the base `agent_command` — which no
 * longer carries a genie override — through here, so both get the per-terminal URL.
 */
function withTerminalGenieUrlForCodex(
    terminalId: string,
    workspaceId: string | null | undefined,
    agent: string | undefined,
    command: string,
): string {
    // The operator used to need an exemption here: it had no workspace row, so
    // `workspaceMcpEnabled` could never say yes for it and Codex launched without
    // the Genie MCP. Its row has `mcp_enabled` set like any opted-in workspace,
    // so the ordinary check answers for it.
    if (agent !== 'codex' || !workspaceId || !workspaceMcpEnabled(workspaceId)) return command;
    const mcpUrl = registerTerminalEndpoint(terminalId);
    if (!mcpUrl) return command;
    return withCodexGenieMcpLaunch(command, {
        agent: 'codex',
        mcpSyncCodexOff: getAllSettings().mcp_sync_codex === 'off',
        genieUrl: mcpUrl,
    });
}

/**
 * Spawn a HEADLESS terminal for an agent (manageTerminals.create / runAgent.start)
 * — a real pty with NO window owner, like the Process runners. It gets a persisted
 * terminal spec (so it shows up in the workspace's terminal list and survives like
 * any other), and — when the workspace has the agent MCP enabled — the
 * GENIE_MCP_URL / GENIE_TERMINAL_ID env so a launched coding agent can
 * itself reach Genie. Returns the new terminal id + its initial scrollback. The
 * APPROVAL GATE is enforced by the caller (background.ts) BEFORE this runs.
 *
 * With `agentMeta` this ALSO LAUNCHES the agent's CLI into the fresh pty (genie
 * #63 Phase 0) — the whole operation happens in the Host, with no renderer
 * involved. Callers do NOT submit the returned `command`; it is returned only so
 * they can report what was launched.
 */
export function createAgentTerminal(opts: {
    /**
     * Honor a caller-supplied terminal id. Local spawns let the renderer pick the
     * id (Terminal.tsx keys ALL its later I/O off it); a REMOTE plain spawn must do
     * the same so the follow-on `/ws/term` attach targets this exact pty. Omitted ⇒
     * mint one (the agent path + the phone `/api/terminal/create` surface).
     */
    id?: string;
    workspaceId: string;
    cwd: string;
    label: string;
    /** Plain-terminal shell override; agent terminals ignore it (they submit a launch command). */
    shell?: string;
    args?: string[];
    /**
     * The client's ALREADY-FITTED grid, when it has one. A remote window knows its
     * real viewport at create time, so spawning at it avoids a pty that starts at the
     * engine default (80×24) and only corrects on a later resize — which, over a
     * remote link, may never arrive (see remote/index.ts's open-flush). A TUI that
     * draws its first frame against 80 cols in a 150-col viewport wraps and redraws
     * at the wrong column. Omitted ⇒ the engine default, as before.
     */
    cols?: number;
    rows?: number;
    /** Marks this terminal as running an agent (surfaced in the list). */
    agentMeta?: {
        agent: 'claude' | 'codex' | 'kiwi' | 'genie' | 'custom';
        command: string;
        /** Positional opening prompt, rendered only after all provider options. */
        instructions?: string;
    };
    /**
     * Who asked for this terminal (Tynn #117). Recorded because it cannot be
     * inferred afterwards: a plain shell an agent opened through
     * `manageTerminals create` is byte-identical to one a person opened, and the
     * agent-terminal cap has to be able to tell them apart. Defaults to `'human'`,
     * which is the safe direction — the cap counts agents, so guessing "agent"
     * would ration somebody's own terminals.
     */
    createdBy?: 'human' | 'agent';
    /** Specialized terminals: AgentInbox accessibility to stamp + join with. */
    agentInbox?: {
        purpose?: string;
        scope?: AgentInboxScope;
        scopeWorkspaces?: string[];
        /** Opt-in wake-on-DM (issue #9): a direct message wakes this agent when idle. */
        wakeOnDm?: boolean;
        /** Channel keys to carry forward (genie #65) — a RESTARTED agent terminal
         *  hands its predecessor's explicitly-joined rooms on, so a relaunch (a new
         *  terminal + a new agent id) doesn't drop it out of shared channels. */
        channels?: string[];
    };
    /** Specialized terminals: IssueWatch ping handling to stamp on the spec meta. */
    issuewatch?: {
        /** Participate in this workspace's IssueWatch deltas (default off). */
        handle?: boolean;
        /** How to react — glow (`notify`) or idle-wake (`wake`); default `notify`. */
        action?: 'notify' | 'wake';
    };
}): { id: string; scrollback: string; existing: boolean; command?: string; chatSessionId: string | null } {
    const id = opts.id ?? crypto.randomUUID();
    const resolved = resolveDefaultShell(dbSettingsProvider());

    // REVIVING a SAVED agent (Tynn #254): the caller named a spec that already
    // exists AND already runs an agent, so this is not a first launch — it is
    // that agent being brought back. Two things must not happen: a fresh
    // `--session-id` must not be minted (it would strand the conversation the
    // spec is still pointing at), and `meta.agent_id` must not be replaced (the
    // AgentInbox cursors, queued mail, channel membership and DM history all
    // hang off it, so a new one is a NEW AGENT wearing the old one's name).
    // Neither is a hypothetical: rendering a fresh launch here is exactly what
    // this function did for every re-create, and it is why reattaching had to be
    // built rather than just called.
    const priorSpec = getTerminalSpec(id);

    // genie#313 — a FRESH agent-terminal (no saved spec yet, so nothing is lost
    // by refusing) for a provider the boot-time detect pass already found
    // missing-and-uninstallable must not open a pty at all: that pty would
    // spawn a shell, type the launch command, and produce exactly the
    // `command not found` the ticket describes — just with an extra dead
    // terminal left behind. A REVIVE of an existing spec is deliberately left
    // alone: it is the same failure mode as today (unchanged behaviour), and
    // never worse, but refusing it would risk blocking a saved conversation on
    // a stale or wrong cache entry.
    if (opts.agentMeta && !priorSpec) {
        const reason = launchBlockReason(opts.agentMeta.agent);
        if (reason) throw new Error(reason);
    }

    const reviving = !!(opts.agentMeta && priorSpec?.meta?.agent);

    // Agent terminals capture their chat-session id at launch + get an AgentInbox
    // identity so they can coordinate. Render the (possibly session-augmented)
    // launch command from the agent's capture profile; a plain terminal has no
    // agentMeta and gets none of this.
    let launchCommand: string | undefined;
    let chatSessionId: string | null = null;
    let strategy: ReturnType<typeof renderAgentLaunch>['strategy'] | null = null;
    let preparedCodex: PreparedCodexAppServer | null = null;
    let agentId: string | undefined;
    let meta: TerminalSpecMeta = {};
    if (reviving && opts.agentMeta?.agent === 'codex') {
        launchCommand = typeof priorSpec?.meta?.agent_command === 'string'
            ? priorSpec.meta.agent_command
            : opts.agentMeta.command;
        agentId = priorSpec?.meta?.agent_id;
        chatSessionId = priorSpec?.meta?.chat_session_id ?? null;
        strategy = 'hook';
    }
    if (opts.agentMeta && !reviving) {
        const rendered = renderAgentLaunch(opts.agentMeta.agent, opts.agentMeta.command);
        launchCommand = rendered.command;
        chatSessionId = rendered.chatSessionId;
        strategy = rendered.strategy;
        agentId = crypto.randomUUID();
        meta = {
            agent: opts.agentMeta.agent,
            agent_command: opts.agentMeta.command,
            // PERSISTED so a revive can re-apply it. `maybeRelaunchAgent` has
            // always read `meta.agent_instructions`, but only the OS agent ever
            // wrote it -- so a project agent that was revived or restarted came
            // back with no persona and no workspace framing, silently.
            ...(opts.agentMeta.instructions?.trim()
                ? { agent_instructions: opts.agentMeta.instructions.trim() }
                : {}),
            agent_id: agentId,
            // BACK-COMPAT: stored `whisper_*` meta keys are kept after the
            // WhisperChat → AgentInbox rename (renaming them needs a data migration).
            whisper_purpose: normalizePurpose(opts.agentInbox?.purpose),
            whisper_scope: opts.agentInbox?.scope ?? 'self',
            ...(opts.agentInbox?.scopeWorkspaces?.length
                ? { whisper_workspaces: opts.agentInbox.scopeWorkspaces }
                : {}),
            ...(opts.agentInbox?.wakeOnDm ? { whisper_wake_on_dm: true } : {}),
            ...(opts.agentInbox?.channels?.length
                ? { whisper_channels: [...opts.agentInbox.channels] }
                : {}),
            ...(opts.issuewatch?.handle ? { issuewatch_handle: true } : {}),
            ...(opts.issuewatch?.handle && opts.issuewatch.action
                ? { issuewatch_action: opts.issuewatch.action }
                : {}),
            ...(chatSessionId ? { chat_session_id: chatSessionId } : {}),
        };
    }

    // Only 'agent' is stamped (Tynn #117). Absence means human — both for the
    // terminals a person opens now and for every terminal that predates the field,
    // so the cap never applies retroactively to work already running.
    if (opts.createdBy === 'agent') meta.created_by = 'agent';

    // Persist a spec so the terminal is a first-class member of the workspace
    // (appears in lists, can be reattached by a window, killed by the user). A
    // caller-supplied id may ALREADY have a spec (a remote re-open, or a respawn
    // after the host restarted and the pty died) — reuse it rather than duplicate.
    if (!priorSpec) {
        createTerminalSpec({
            id,
            workspace_id: opts.workspaceId,
            label: opts.label,
            cwd: opts.cwd,
            type: 'terminal',
            meta,
        });
    }

    // Env: the workspace `.env` (so an agent resolves ${TYNN_AGENT_TOKEN} etc.)
    // plus the workspace's agent MCP endpoint when enabled, so a coding agent
    // launched here can call imDone etc.
    // Plus any Tynn-managed provider credentials this host has opened (the
    // workspace `.env` overrides them — see buildTerminalEnv).
    let env: Record<string, string> = {};
    const ws = getWorkspace(opts.workspaceId);
    const wsRoot = ws?.path;
    // The workspace `.env` reaches a terminal MINUS the keys Genie itself wrote
    // into it (genie#242). A site's `repo` defaults to the workspace ROOT, so
    // `<workspace>/.env` is very often the very file Genie keeps the service
    // connection in — and re-exporting it here would hand every shell an ambient
    // `DB_PORT` that outranks EVERY repo's `.env`, which is the bug this feature
    // removes, enlarged. A key the USER put there is untouched.
    env = withoutManagedServiceKeys(
        buildTerminalEnv(wsRoot, ws?.project_id),
        devServiceHostEnvFor(opts.workspaceId),
    );
    if (workspaceMcpEnabled(opts.workspaceId)) {
        const mcpUrl = registerTerminalEndpoint(id);
        if (mcpUrl) {
            env = { ...env, GENIE_MCP_URL: mcpUrl, GENIE_TERMINAL_ID: id };
        }
    }
    // Codex can't read GENIE_MCP_URL from its MCP config, so weave this terminal's
    // own genie endpoint into its launch `-c` override — the token then identifies
    // the terminal and the agent never has to pass `terminalId` (genie #35). A
    // no-op for non-codex agents; the base command is stored unchanged in the spec.
    if (opts.agentMeta && launchCommand) {
        launchCommand = withTerminalGenieUrlForCodex(
            id,
            opts.workspaceId,
            opts.agentMeta.agent,
            launchCommand,
        );
        if (opts.agentMeta.instructions) {
            launchCommand = withProviderStartupInstructions(
                opts.agentMeta.agent,
                launchCommand,
                opts.agentMeta.instructions,
            );
        }
    }
    if (opts.agentMeta?.agent === 'codex' && launchCommand) {
        preparedCodex = prepareCodexAppServer(
            id,
            path.join(os.tmpdir(), 'genie-agentinbox-app-server'),
        );
        env = { ...env, [CODEX_APP_TOKEN_ENV]: preparedCodex.token };
    }

    const createOpts: CreateTerminalOpts = {
        id,
        cwd: opts.cwd,
        shell: opts.shell ?? resolved.command,
        args: opts.args ?? resolved.args,
        env,
        // Only forward a sane grid — a bogus/zero value would spawn an unusable pty,
        // whereas omitting it falls back to the engine's 80×24.
        ...(isUsableGrid(opts) ? { cols: opts.cols, rows: opts.rows } : {}),
    };
    // Idempotent on the id: if a live pty already owns it, this reattaches
    // (existing:true, scrollback replayed) instead of spawning a duplicate.
    const result = terminalManager().create(createOpts);
    noteTerminalActivity(id);

    // LAUNCH THE AGENT — here, in the Host, the moment the pty exists (genie #63
    // Phase 0). Creating an agent terminal is ONE host-side operation: spawn the
    // pty AND start the agent's CLI in it. It used to be two — this function
    // rendered the launch command and handed it back for each caller to submit —
    // so the only place that treated "a fresh pty for an agent spec must have its
    // agent launched" as a RULE was maybeRelaunchAgent, invoked exclusively from
    // the `terminal:create` renderer-attach IPC. That tied the CLI launch to a
    // human opening the panel: any create path that didn't remember to write left
    // a terminal whose agent only started once a renderer mounted it. Owning the
    // launch here means no entry point (host route, MCP tool, future Client) can
    // create an agent terminal that never starts.
    //
    // Only on a FRESH pty: a re-create that reattached to a LIVE pty (existing)
    // already has its agent running, and submitting the command again would type
    // it straight into the running TUI's prompt.
    // A REVIVE takes the relaunch path instead, which is the one that RESUMES the
    // saved conversation (`--resume <captured id>`, falling back to `--continue`
    // when that id has drifted) rather than starting a context-less new one. It
    // is also a no-op on a warm reattach, so a saved agent that is still running
    // is left strictly alone — the launch line is never typed into a live TUI's
    // prompt, which is what that bug looks like from the user's side.
    if (reviving && !preparedCodex) maybeRelaunchAgent(id, result.existing);
    else if (launchCommand && !result.existing && !preparedCodex) deliverAgentLaunch(id, launchCommand);

    // Tell every window the spec set changed so the new terminal appears live.
    broadcastTerminalSpecsChanged();

    // AgentInbox: register the fresh agent so peers can discover/DM it. When the
    // session id wasn't captured by a launch flag (detect / a custom wrapper),
    // briefly watch the transcript dir and backfill it. A revive re-registers the
    // SAME identity off the retained spec — the broker drops an agent when its
    // terminal dies, so without this a revived agent is unreachable to its peers.
    if (reviving) {
        const input = joinInputFromSpec(getTerminalSpec(id));
        if (input) agentInboxBroker.join(input);
    } else if (agentId) {
        const input = joinInputFromSpec(getTerminalSpec(id));
        if (input) agentInboxBroker.join(input);
        if (strategy === 'detect' && !chatSessionId) {
            captureSessionByDetect(opts.cwd)
                .then((sid) => {
                    if (!sid) return;
                    const cur = getTerminalSpec(id);
                    if (!cur) return;
                    updateTerminalSpec(id, { meta: { ...cur.meta, chat_session_id: sid } });
                    agentInboxBroker.setChatSession(agentId!, sid);
                    broadcastTerminalSpecsChanged();
                })
                .catch(() => {
                    /* best-effort — no id is fine */
                });
        }
    }
    if (preparedCodex && launchCommand && agentId && !result.existing) {
        const command = launchCommand;
        const configuredAgent = () => {
            try {
                return listWorkspaceAgents(opts.workspaceId).find(
                    (candidate) => candidate.terminal_spec_id === id,
                );
            } catch {
                return undefined;
            }
        };
        void codexAppServerManager.start({
            terminalId: id,
            cwd: opts.cwd,
            stateDir: path.dirname(preparedCodex.tokenFile),
            prepared: preparedCodex,
            env: { ...process.env, ...env },
            resumeThreadId: reviving ? chatSessionId : null,
            configArgs: codexAppServerConfigArgs(command),
        }).then(async (running) => {
            const configured = configuredAgent();
            harnessTransportRegistry.bind(agentId!, 'codex-app-server', (payload) =>
                running.session.deliver(payload),
            );
            if (configured) {
                markWorkspaceAgentTransportState(
                    getDb(),
                    configured.id,
                    'codex-app-server',
                    { ok: true },
                );
            }
            deliverAgentLaunch(id, codexRemoteTuiLaunch(command, running.address));
            const backlog = await agentInboxBroker.receive(agentId!, { acknowledge: false });
            for (const message of backlog.messages) {
                await running.session.deliver({
                    text: message.text,
                    messageId: message.id,
                    from: message.from,
                    fromLabel: message.fromLabel,
                    priority: message.interrupt ? 'high' : 'normal',
                });
                agentInboxBroker.acknowledge(agentId!, message.seq);
            }
        }).catch((error: unknown) => {
            const configured = configuredAgent();
            harnessTransportRegistry.unbind(agentId!);
            if (configured) {
                markWorkspaceAgentTransportState(
                    getDb(),
                    configured.id,
                    'codex-app-server',
                    { ok: false, error: error instanceof Error ? error.message : String(error) },
                );
            }
        });
    }
    return {
        id,
        scrollback: result.scrollback,
        existing: result.existing,
        command: launchCommand,
        // A revive did not capture an id — it INHERITED one, and reporting null
        // there would tell the caller the conversation was lost.
        chatSessionId: reviving
            ? (getTerminalSpec(id)?.meta?.chat_session_id ?? null)
            : chatSessionId,
    };
}

/**
 * After a FRESH pty spawn for an AGENT terminal (a restart/reopen where the previous
 * shell + agent died), re-launch it so the panel isn't left as a plain shell (the
 * "agent terminal opens as a regular terminal" bug), resuming its captured chat
 * session when there is one. The first launch is done by createAgent; a warm reattach
 * still has the agent running. See {@link agentRelaunchDecision}.
 */
/**
 * True when a Claude transcript for `sid` actually exists in the spec's cwd
 * project dir — so `--resume <sid>` won't dead-end "No conversation found". The
 * captured id can drift from the live chat (recovered via `-c`, or regenerated),
 * so we verify on disk and let agentRelaunchDecision fall back to `--continue`
 * when it's missing. Uses the last reported cwd (OSC-7) if we have one, else the
 * spec's launch cwd — that's the dir Claude scopes its transcripts by.
 */
export function agentSessionTranscriptExists(spec: TerminalSpecRow | null, sid: string): boolean {
    const cwd = spec?.live_cwd || spec?.cwd;
    if (!cwd) return false; // can't verify → treat as missing → fall back to -c
    try {
        return fs.existsSync(path.join(transcriptDirFor(cwd), `${sid}.jsonl`));
    } catch {
        return false;
    }
}

/**
 * How long to let a FRESHLY SPAWNED shell settle (profile load) before submitting
 * an agent's boot command into it. Typing into a shell that hasn't started reading
 * its stdin yet can drop the keystrokes and leave the terminal sitting at a plain
 * prompt with no agent.
 */
export const AGENT_LAUNCH_SETTLE_MS = 500;

/**
 * Submit an agent's boot command into its FRESH pty — the ONE host-side routine
 * that starts an agent CLI in a terminal.
 *
 * Both paths that produce a fresh pty for an agent spec go through here: the
 * create path ({@link createAgentTerminal}) and the reattach-after-restart path
 * ({@link maybeRelaunchAgent}). They are the same situation — a just-spawned shell
 * that needs the agent typed into it — and running them on two different
 * disciplines is what let the create path be the less reliable of the two (it
 * submitted instantly; only the renderer-attach path waited for the shell).
 *
 * Best-effort: a pty that died between spawn and submit is not an error here.
 */
function deliverAgentLaunch(id: string, command: string): void {
    const bytes = buildSubmitBytes(command, true);
    const timer = setTimeout(() => {
        try {
            writeToTerminal(id, bytes);
        } catch {
            /* pty gone — nothing to submit */
        }
    }, AGENT_LAUNCH_SETTLE_MS);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
    }
}

function maybeRelaunchAgent(id: string, existing: boolean): void {
    const spec = getTerminalSpec(id);
    const decision = agentRelaunchDecision(spec, existing, (sid) =>
        agentSessionTranscriptExists(spec, sid),
    );
    if (!decision) return;
    if (decision.newSessionId && spec) {
        updateTerminalSpec(id, { meta: { ...spec.meta, chat_session_id: decision.newSessionId } });
    }
    // A restart re-runs the stored base `agent_command`, which carries no genie
    // override — re-point Codex at THIS terminal's endpoint so the relaunched
    // agent keeps its terminal-scoped genie URL (genie #35). No-op for non-codex.
    let command = withTerminalGenieUrlForCodex(
        id,
        spec?.workspace_id,
        spec?.meta?.agent,
        decision.command,
    );
    if (typeof spec?.meta?.agent_instructions === 'string') {
        command = withProviderStartupInstructions(
            spec.meta.agent as Parameters<typeof withProviderStartupInstructions>[0],
            command,
            spec.meta.agent_instructions,
        );
    }
    deliverAgentLaunch(id, command);
}

/**
 * Build an AgentInbox join input from a persisted agent spec — supplies the db
 * lookup the pure resolver can't do. Null when the spec isn't an AgentInbox
 * agent (no `agent_id`) or its workspace is gone.
 */
function joinInputFromSpec(spec: TerminalSpecRow | null): AgentInboxJoinInput | null {
    return agentInboxJoinInputFor(spec, (id) => getWorkspace(id));
}

/**
 * Re-register every persisted AgentInbox agent into the in-memory broker at boot
 * (its durable identity rides `terminal_specs.meta`). Agents come back `away`
 * (their pty's liveness is unknown until they next act). Called near
 * reapOrphanTerminals.
 */
export function rehydrateAgentInbox(): void {
    const inputs: AgentInboxJoinInput[] = [];
    for (const spec of listTerminalSpecs()) {
        if (!spec.meta?.agent_id) continue;
        const input = joinInputFromSpec(spec);
        if (input) inputs.push({ ...input, status: 'away' });
    }
    agentInboxBroker.rehydrate(inputs);
}

/** Send input to a terminal (manageTerminals.write / runAgent.send). */
export function writeToTerminal(id: string, data: string): boolean {
    noteTerminalActivity(id);
    return terminalManager().write(id, data);
}

// --- backend-event fan-out (renderer-free) ----------------------------------
// The pieces of the pty data/exit handling that DON'T touch a window: the OSC
// diagnostic, the Process-runner log buffer, the agent read buffer (so
// manageTerminals.read / runAgent.read work with no window attached), and the
// mobile /ws/term mirror. Shared by the desktop `registerTerminalIpc` (which
// adds the owner-window fan-out on top) and the headless
// `subscribeHeadlessBackendEvents` (which uses ONLY these).

function feedTerminalData(id: string, data: string): void {
    // Diagnostic (no-op unless GENIE_OSC_DEBUG=1): the RAW pty bytes pre-xterm.
    logPtyOsc(id, data);
    // Buffer output for headless Process runners (no-op for non-process ids).
    recordProcessOutput(id, data);
    // Agent-control read buffer (manageTerminals.read / runAgent.read).
    agentReadBuffer.append(id, data);
    // AgentPulse: pty output = an agent is doing something → feed the workspace's
    // real-time activity pulse (rail glow + 1-min sparkline). Single hook for
    // every terminal, desktop AND headless.
    const pulseWs = getTerminalSpec(id)?.workspace_id;
    if (pulseWs) {
        agentPulse.note(pulseWs, data.length);
        // Turn-state glow: an agent terminal producing output is MID-TURN, so keep
        // the workspace lit even if it then goes quiet waiting on a tool/API call —
        // until imDone / exit. Byte-activity alone darkened it after 1.5s.
        if (agentInboxBroker.isAgentTerminal(id)) agentPulse.noteAgentWorking(pulseWs, id);
    }
    // Wake-on-DM idle signal (issue #9): any output means the agent is active — so
    // a DM wake fails closed until it's genuinely quiet again. Cheap (a timestamp).
    agentInboxBroker.noteOutput(id);
    // Answer OUR OWN development-channel warning, and nothing else.
    // `--dangerously-load-development-channels` is the only flag that registers
    // a custom channel, and it stops on a full-screen warning every launch with
    // nothing available to pre-accept it. Genie added the flag and owns this
    // pty, so it answers for its own decision — see dev-channel-consent.ts for
    // why the match is narrow enough for that to be defensible.
    maybeAnswerDevChannelWarning(id);
    // Mirror to any attached mobile /ws/term socket (no-op when off / unwatched).
    mobileTermFanout(id, data);
}

/** Terminals whose development-channel warning we have already answered. One
 *  reply per pty: the dialog is drawn once, but Ink repaints it many times, and
 *  a second Enter would land in the session that follows it. */
const devChannelAnswered = new Set<string>();

function maybeAnswerDevChannelWarning(id: string): void {
    if (devChannelAnswered.has(id)) return;
    // Read from the SAME capped buffer `manageTerminals.read` uses, so the
    // decision sees the assembled frame rather than one arbitrary chunk — the
    // channel list routinely arrives split across writes.
    const recent = agentReadBuffer.readTail(id, DEV_CHANNEL_SCAN_BYTES);
    if (!recent.buffered || devChannelConsentReply(recent.data) !== 'accept') return;
    devChannelAnswered.add(id);
    try {
        // The confirm choice is already selected when the dialog opens, so a
        // bare Enter accepts it. Anything more would be typing into a TUI whose
        // state we are inferring.
        terminalManager().write(id, '\r');
    } catch {
        // A pty that died between the read and the write is not an error worth
        // surfacing — the warning went with it.
    }
}

/**
 * Release a PULL harness binding whose holder has gone.
 *
 * The Claude Channel bridge is a child of the agent's own process, so the pty
 * dying takes the channel with it. Nothing ever calls into a pull binding, so it
 * cannot fail its way out the way a push adapter does — a stale one would
 * swallow every message AND suppress the PTY fallback that exists for exactly
 * this state. Push bindings are deliberately left alone: they own their own
 * lifecycle (a send that throws unbinds them).
 */
function releaseHarnessPullTransport(id: string): void {
    const agentId = agentInboxBroker.agentIdForTerminal(id);
    if (agentId) harnessTransportRegistry.unbindPull(agentId);
}

function feedTerminalExit(id: string, payload: { exitCode: number; signal?: number }): void {
    // Supervisor decides a Process runner's fate (no-op for other ids).
    onProcessPtyExit(id, payload);
    // The pty is gone but the SPEC is retained (revivable) and still listed — so
    // keep a bounded tail of its final output instead of dropping the buffer
    // outright (genie#217). Those bytes are the only evidence of WHY it died; an
    // agent monitor that reads the terminal has nothing else to tell a crash from
    // an idle session. The buffer is released for real when the terminal is
    // killed (killTerminalById), which is also when its spec goes.
    agentReadBuffer.trimToTail(id, EXIT_TAIL_BYTES);
    // AgentInbox: the pty exited but the spec is retained (revivable) — mark the
    // agent `away` (no-op for a non-agent terminal).
    releaseHarnessPullTransport(id);
    agentInboxBroker.away(id);
    // AgentPulse: the agent's process is gone → its turn is over. Drop the mid-turn
    // glow (no-op if the terminal wasn't a working agent).
    const exitWs = getTerminalSpec(id)?.workspace_id;
    if (exitWs) agentPulse.noteAgentIdle(exitWs, id);
    // Tell any attached mobile /ws/term socket the pty exited + drop it.
    mobileTermClose(id, payload);
}

/**
 * Headless analogue of `registerTerminalIpc`'s backend subscription: the SAME
 * data/exit fan-out (Process log, agent read buffer, mobile /ws/term) MINUS the
 * renderer owner-window fan-out (no windows headless) and the renderer IPC
 * handlers. The host-core calls this so the MCP/mobile servers see live terminal
 * output with no GUI. Follows the active backend across a Tier-3 swap, like the
 * desktop path. Call once at boot.
 */
export function subscribeHeadlessBackendEvents(): void {
    subscribeBackendEvents({ onData: feedTerminalData, onExit: feedTerminalExit });
    catchUpAgentReadBuffers();
}

export function registerTerminalIpc(): void {
    // Always resolve the LIVE active backend per-call. Tier 3 can swap the
    // backend (in-process ↔ host client) under us; capturing it once would
    // leave handlers pointed at a stale backend after a fallback.
    const mgr = () => terminalManager();

    const trackOwner = (id: string, sender: WebContents) => {
        let entry = ownersByTerminal.get(id);
        if (!entry) {
            entry = { owners: new Set(), cleanup: new WeakMap() };
            ownersByTerminal.set(id, entry);
        }
        if (entry.owners.has(sender)) return;
        entry.owners.add(sender);
        // The window being DESTROYED (closed) detaches without killing — the pty
        // persists in the host for re-attach. Hence fromWindowClose:true here.
        const handler = () => detachOwner(id, sender, true);
        entry.cleanup.set(sender, handler);
        sender.once('destroyed', handler);
    };

    const detachOwner = (id: string, sender: WebContents, fromWindowClose = false) => {
        const entry = ownersByTerminal.get(id);
        if (!entry) return;
        if (!entry.owners.delete(sender)) return;
        const handler = entry.cleanup.get(sender);
        if (handler) {
            try {
                sender.off('destroyed', handler);
            } catch {
                /* sender already gone */
            }
            entry.cleanup.delete(sender);
        }
        if (entry.owners.size === 0) {
            ownersByTerminal.delete(id);
            // A window CLOSE leaves the pty alive in the host (persistence — it
            // re-attaches on reopen via the create() rejoin path, replaying
            // scrollback). A RETAINED (suspended) terminal also survives. Only a
            // DELIBERATE detach of a non-retained terminal kills it, as before.
            if (
                shouldKillOnDetach({
                    lastOwner: true,
                    retained: mgr().isRetained(id),
                    fromWindowClose,
                })
            ) {
                mgr().kill(id);
            }
        }
    };

    ipcMain.handle(
        'terminal:create',
        (
            event,
            opts: CreateTerminalOpts,
        ): TerminalInfo & {
            existing: boolean;
            scrollback: string;
            snapshot?: { serialized: string; savedAt: number };
        } => {
            // No explicit shell on the spec → the user's configured default
            // (Settings → Terminal), which itself falls back to detection
            // (Git Bash first on Windows). Resolution lives in shells.ts so
            // the manager stays a pure pty pool. An EMPTY args array counts
            // as "no explicit args" — terminal_specs rows default to '[]',
            // and that must not strip the shell's own defaults (git-bash
            // needs --login -i for a profile-loaded interactive session).
            if (!opts.shell) {
                const resolved = resolveDefaultShell(dbSettingsProvider());
                opts = {
                    ...opts,
                    shell: resolved.command,
                    args: opts.args?.length ? opts.args : resolved.args,
                };
            }
            // Process specs run their command non-interactively via the shell
            // instead of an interactive login session. Override the args from
            // the spec's meta.command (the shell is resolved above).
            const spec = getTerminalSpec(opts.id);
            if (spec?.type === 'process' && spec.meta?.command) {
                opts = {
                    ...opts,
                    args: buildProcessArgs(opts.shell ?? '', spec.meta.command),
                };
            }
            // Load the managed provider credentials + workspace env, and
            // reconstruct TYNN_AGENT_TOKEN from the authoritative literal MCP
            // config when `.env` is missing/stale. This path covers
            // restored/resumed terminals; explicit opts.env still wins on any
            // collision. A respawn re-reads the managed env, so a credential
            // revoked since the last spawn is simply gone from this one.
            const specWs = spec?.workspace_id ? getWorkspace(spec.workspace_id) : undefined;
            const wsRoot = specWs?.path;
            const envFileVars = withoutManagedServiceKeys(
                buildTerminalEnv(wsRoot, specWs?.project_id),
                spec?.workspace_id ? devServiceHostEnvFor(spec.workspace_id) : {},
            );
            if (Object.keys(envFileVars).length) {
                opts = { ...opts, env: { ...envFileVars, ...opts.env } };
            }
            // A workspace's terminals AND managed processes run on the HOST, so
            // they must reach the workspace's Genie-managed services on their
            // PUBLISHED loopback ports (127.0.0.1:<port>) — the site container's env
            // names the engine container, which a host shell/process cannot resolve.
            // Inject that host-form service env into the pty ENVIRONMENT (applied at
            // execution, never in a typed command) so `psql` and friends reach the
            // workspace's services with nothing typed. (Host-native hosting, Wish
            // #102.)
            //
            // NARROWED through `terminalServiceEnv` (genie#221, tightened to an
            // allowlist by genie#242). This used to hand a terminal the app's own
            // configuration too — `DB_CONNECTION`, `DB_DATABASE`, the lot — so that
            // `artisan test` would "reach the DB with nothing typed". It did:
            // running a Laravel suite here dropped the development database and
            // reported `99 passed`. PHPUnit's `<env>` is `force="false"`, so the
            // `sqlite`/`:memory:` lines every Laravel skeleton ships were skipped
            // because the variable was already set, and `RefreshDatabase` ran
            // `migrate:fresh` against the live Postgres.
            //
            // A terminal now gets ONLY the CLIENT credentials (`PG*`, `MYSQL_*`);
            // everything a framework reads as its own config is under `GENIE_`. The
            // app's configuration reaches it the way the app reads it — out of the
            // repo's `.env`, which Genie keeps current (genie#242). SITES and
            // PROCESSES still receive the full set directly: they ARE the
            // application, and their env is computed at start, so it cannot go
            // stale the way a shell's can.
            if (spec?.workspace_id) {
                const svcEnv = terminalServiceEnv(devServiceHostEnvFor(spec.workspace_id));
                if (Object.keys(svcEnv).length) {
                    opts = { ...opts, env: { ...opts.env, ...svcEnv } };
                }
            }
            // Agent-integration MCP: when the spec's workspace has opted in, mint
            // this terminal's auto-wired endpoint and expose it as GENIE_MCP_URL
            // (+ GENIE_TERMINAL_ID) so an agent can drive the Genie UI (imDone).
            if (spec?.workspace_id && workspaceMcpEnabled(spec.workspace_id)) {
                const mcpUrl = registerTerminalEndpoint(opts.id);
                if (mcpUrl) {
                    opts = {
                        ...opts,
                        env: {
                            GENIE_MCP_URL: mcpUrl,
                            GENIE_TERMINAL_ID: opts.id,
                            ...opts.env,
                        },
                    };
                }
            }
            const result = mgr().create(opts);
            // Agent terminal reattach after a restart: re-launch it (resuming the
            // captured chat session) so it isn't left a plain shell. No-op for a
            // warm reattach or a non-agent terminal. See maybeRelaunchAgent.
            maybeRelaunchAgent(opts.id, result.existing);
            trackOwner(opts.id, event.sender);
            noteTerminalActivity(opts.id);
            return result;
        },
    );

    ipcMain.handle('terminal:shells', () => {
        const shells = detectShells();
        return { shells, defaultId: defaultShellId(shells) };
    });

    ipcMain.handle('terminal:write', (_event, id: string, data: string): boolean => {
        noteTerminalActivity(id);
        // HUMAN keystrokes (this IPC is a renderer sending what a person typed —
        // Genie's own injection goes through `writeToTerminal`). Feeds the model
        // of what is sitting in the input box, so a notice knows whether it may
        // cut the draft out and put it back.
        agentInboxBroker.noteUserInput(id, data);
        // A notice is swapping this terminal's draft RIGHT NOW: hold the
        // keystrokes rather than letting them land mid-swap, where they would be
        // swept into the cut or interleaved with the notice. They are replayed
        // the moment the draft is back. The model above is fed either way — the
        // person really did type them.
        if (holdTerminalInput(id, data)) return true;
        return mgr().write(id, data);
    });

    ipcMain.handle('terminal:resize', (_event, id: string, cols: number, rows: number): boolean => {
        const ok = mgr().resize(id, cols, rows);
        // Track the applied size so the mobile bridge's repaint-on-drop can nudge
        // SIGWINCH and restore the pty to exactly this size (no desktop reflow).
        if (ok) recordTerminalSize(id, cols, rows);
        return ok;
    });

    ipcMain.handle('terminal:detach', (event, id: string): boolean => {
        // Soft release: this window no longer renders the pty. Other
        // windows can keep it alive. The pty is killed only when the last
        // owner detaches.
        detachOwner(id, event.sender);
        return true;
    });

    ipcMain.handle('terminal:kill', (_event, id: string): boolean =>
        killTerminalById(id),
    );

    // Agent-integration MCP: the user focused a terminal that called imDone —
    // clear its attention glow everywhere (rail, flyout row, panel border).
    ipcMain.handle('terminal:clear-attention', (_event, id: string): void => {
        broadcastTerminalAttention(id, false);
    });

    /**
     * Tier 2: mark a terminal as retained (kept alive on zero owners) or not.
     * CRITICAL ordering: the renderer MUST set retained=true BEFORE the last
     * window detaches (before unmounting the XTerm), otherwise the detach kills
     * the pty first. The disable flow awaits this call, then unmounts.
     *
     * Enforces the MAX_RETAINED cap on the way IN (retained=true): if retaining
     * this id would exceed the cap it is REFUSED — the disable is blocked and
     * the renderer keeps the panel visible with a "cap reached" toast. Clearing
     * retention (retained=false) is always allowed.
     *
     * Returns { ok, retainedCount, max, reason? } so the renderer can both gate
     * and surface the count.
     */
    ipcMain.handle(
        'terminal:set-retained',
        (
            _event,
            id: string,
            retained: boolean,
        ): { ok: boolean; retainedCount: number; max: number; reason?: string } => {
            if (retained) {
                // AGENT terminals are exempt from the cap (the owner runs many
                // hidden-but-alive agents); only plain terminals count/are capped.
                const isAgent = !!getTerminalSpec(id)?.meta?.agent_id;
                const nonAgentRetainedCount = mgr()
                    .retainedIds()
                    .filter((rid) => !getTerminalSpec(rid)?.meta?.agent_id).length;
                if (
                    refuseRetainForCap({
                        isAgent,
                        alreadyRetained: mgr().isRetained(id),
                        nonAgentRetainedCount,
                        max: MAX_RETAINED,
                    })
                ) {
                    return {
                        ok: false,
                        retainedCount: mgr().retainedCount(),
                        max: MAX_RETAINED,
                        reason: `Retained-terminal limit reached (${MAX_RETAINED}). Re-enable or delete a suspended terminal first. (Agent terminals are exempt.)`,
                    };
                }
                mgr().setRetained(id, true);
            } else {
                mgr().setRetained(id, false);
            }
            broadcastTerminalCount();
            return {
                ok: true,
                retainedCount: mgr().retainedCount(),
                max: MAX_RETAINED,
            };
        },
    );

    ipcMain.handle('terminal:list', (): TerminalInfo[] => {
        return mgr().list();
    });
    // Manual orphan sweep (Settings/diagnostics): kill host PTYs with no spec.
    ipcMain.handle('terminal:reap-orphans', () => reapOrphanTerminals());

    // Tier 1 capture: the renderer sends a SerializeAddon reconstruction of a
    // terminal's buffer. Persist it (encrypted gz on disk) and record the
    // pointer metadata on the spec row so the next launch knows a snapshot
    // exists. Best-effort — a failed write must not reject the renderer.
    ipcMain.handle(
        'terminal:snapshot',
        (_event, id: string, serialized: string): boolean => {
            try {
                const bytes = getSnapshotStore().writeSnapshot(id, serialized);
                if (bytes == null) return false;
                try {
                    updateTerminalSpec(id, {
                        snapshot_at: Date.now(),
                        snapshot_bytes: bytes,
                    });
                } catch {
                    /* spec may be unsaved/scratch — the file is still written */
                }
                return true;
            } catch {
                return false;
            }
        },
    );

    // Fan-out pty output/exit to the owning windows. Routed through
    // subscribeBackendEvents so the binding FOLLOWS the active backend across a
    // Tier 3 swap (in-process ↔ host client) — a captured `mgr.on` would keep
    // firing from a stale backend after a fallback.
    subscribeBackendEvents({
        onData: (id: string, data: string) => {
            feedTerminalData(id, data);
            // DESKTOP fan-out: push the same bytes to the owning window(s).
            const entry = ownersByTerminal.get(id);
            if (!entry) return;
            for (const target of entry.owners) {
                if (target.isDestroyed()) continue;
                target.send('terminal:data', { id, data });
            }
        },
        onExit: (id: string, payload: { exitCode: number; signal?: number }) => {
            feedTerminalExit(id, payload);
            // DESKTOP fan-out: notify + drop the owning window(s).
            const entry = ownersByTerminal.get(id);
            ownersByTerminal.delete(id);
            if (!entry) return;
            for (const target of entry.owners) {
                if (target.isDestroyed()) continue;
                target.send('terminal:exit', { id, ...payload });
            }
        },
    });
    catchUpAgentReadBuffers();

    // --- Process service runners (headless) -----------------------------
    ipcMain.handle('process:start', (_e, id: string) => {
        startProcess(id);
        return { ok: true };
    });
    ipcMain.handle('process:stop', (_e, id: string) => {
        stopProcess(id);
        return { ok: true };
    });
    ipcMain.handle('process:restart', (_e, id: string) => {
        restartProcess(id);
        return { ok: true };
    });
    ipcMain.handle('process:statuses', () => getProcessStatuses());
    ipcMain.handle('process:log', (_e, id: string) => getProcessLog(id));
    ipcMain.handle('process:clear-log', (_e, id: string) => {
        clearProcessLog(id);
        return { ok: true };
    });
    // Task Manager: every process across every workspace (+ System), each row
    // tagged with the workspace that spawned it.
    ipcMain.handle('process:list', () => listAllProcesses());

    // --- Scheduled tasks (a process + meta.schedule) --------------------
    // Per-task next-run instant + human description, so the Processes panel can
    // paint "next run" without a second cron parser in the renderer. Live updates
    // arrive on the `schedule:next` broadcast.
    ipcMain.handle('schedule:info', () => getScheduleInfo());
    ipcMain.handle('schedule:run-now', (_e, id: string) => {
        runScheduleNow(id);
        return { ok: true };
    });
}

/** Tear down every pty on app quit so dangling shell processes don't survive. */
export function stopAllTerminals(): void {
    terminalManager().killAll();
}

/**
 * True when terminal `id` currently has at least one attached window (its
 * SerializeAddon can produce a snapshot via the before-quit broadcast).
 * Exposed so the update-path host snapshot (genie-adapter
 * snapshotHostTerminalsForUpdate) can skip windowed terminals without this
 * module's owner registry leaking out.
 */
export function terminalHasWindow(id: string): boolean {
    const entry = ownersByTerminal.get(id);
    return !!entry && entry.owners.size > 0;
}

/**
 * Two-phase quit support (Tier 1). Broadcast a snapshot-request to every
 * window so each live terminal serializes its current buffer and sends a final
 * `terminal:snapshot` before its pty is killed. Returns immediately — the
 * caller waits a bounded window (so quit can never hang) and THEN calls
 * stopAllTerminals(). If no windows are open, there's nothing to snapshot.
 */
export function requestFinalSnapshots(): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        try {
            w.webContents.send('terminal:snapshot-request');
        } catch {
            /* window tearing down — skip */
        }
    }
}

/**
 * Kill a single terminal or process by id — the shared teardown behind the
 * `terminal:kill` IPC and the `genie kill <id>` CLI. A PROCESS is stopped
 * deliberately (so its supervisor doesn't auto-restart it); a terminal has its
 * pty killed + snapshot dropped + MCP endpoint released. Returns false when the
 * id matches no live pty (and isn't a known process spec).
 */
export function killTerminalById(id: string): boolean {
    const spec = getTerminalSpec(id);
    if (spec?.type === 'process') {
        stopProcess(id);
        return true;
    }
    ownersByTerminal.delete(id);
    // Drop the agent read buffer for this terminal.
    agentReadBuffer.forget(id);
    // Drop the per-terminal MCP endpoint so its token stops resolving.
    unregisterTerminalEndpoint(id);
    // AgentInbox: a killed terminal is a hard leave — drop the agent from the
    // registry + channels and push an offline presence (no-op for a non-agent).
    releaseHarnessPullTransport(id);
    agentInboxBroker.leaveByTerminal(id);
    codexAppServerManager.stop(id);
    // kill() also clears the retained flag in the manager.
    const killed = terminalManager().kill(id);
    // Drop the Tier 1 snapshot too so a killed terminal can't resurrect on the
    // next launch. Best-effort.
    getSnapshotStore().deleteSnapshot(id);
    broadcastTerminalCount();
    return killed;
}

/**
 * Fully tear down EVERY terminal + process belonging to a workspace — the safe
 * deprovision primitive behind workspace-assignment DETACH. Each is stopped via
 * killTerminalById, so a running agent's pty is killed, its MCP endpoint is
 * released, its AgentInbox presence goes offline, and its snapshot is dropped —
 * nothing is orphaned. Does NOT touch the on-disk clone (uncommitted work is
 * left intact); disk removal is deliberately out of scope. Returns the ids torn
 * down (empty when the workspace had none). Best-effort per terminal.
 */
export function stopWorkspaceTerminals(workspaceId: string): string[] {
    if (!workspaceId) return [];
    const stopped: string[] = [];
    for (const spec of listTerminalSpecs()) {
        if (spec.workspace_id !== workspaceId) continue;
        try {
            killTerminalById(spec.id);
        } catch {
            /* best-effort — one stubborn terminal can't block the teardown */
        }
        stopped.push(spec.id);
    }
    return stopped;
}

/**
 * How many terminals have a LIVE pty right now.
 *
 * Not the spec count — a spec persists after its pty exits (terminals are
 * revivable), and the toolchain update guard has to know what is actually
 * RUNNING: on Windows every live terminal is a `bash.exe` holding Git's files,
 * which is what aborts the Git installer (genie#205).
 */
export function liveTerminalCount(): number {
    try {
        return terminalManager().list().length;
    } catch {
        return 0;
    }
}

/**
 * May this workspace start another agent terminal (Tynn #117)?
 *
 * Reads the workstation default and the workspace override, counts what is
 * actually running, and hands the decision to the pure resolver. Lives here
 * because this module already owns both halves of "what is alive" — the specs and
 * the pty manager.
 *
 * Callers must pass the real `actor`. A person is the authority over the limit and
 * is never refused by it; an agent is, which is the entire point.
 *
 * `want` is how many are being started AT ONCE — a GApp seeds its whole declared
 * roster in one go (genie#245). Defaults to 1, the shape every one-at-a-time
 * spawn path has.
 */
export function decideAgentTerminalSpawn(
    workspaceId: string,
    actor: SpawnActor,
    want = 1,
): AgentSpawnDecision {
    let workstation: AgentCapValue = null;
    let workspace: AgentCapValue = null;
    try {
        const raw = getAllSettings().max_agent_terminals;
        if (raw === UNLIMITED) workstation = UNLIMITED;
        else if (raw) {
            const parsed = Number.parseInt(raw, 10);
            workstation = Number.isFinite(parsed) ? parsed : null;
        }
        workspace = getWorkspaceAgentCap(workspaceId);
    } catch {
        // Unreadable settings fall through to the built-in default rather than to
        // "uncapped": a failed read must not be the thing that removes the limit.
    }

    let live: number;
    try {
        live = countAgentTerminals(listTerminalSpecs(), workspaceId, ptyIsLive);
    } catch {
        // -1 is not a count. The resolver reads it as "unknown" and fails closed
        // for agents, which is the safe direction when we cannot see the state.
        live = -1;
    }

    return decideAgentSpawn({ actor, live, want, settings: { workstation, workspace } });
}

/** Forward the broadcast helper for callers that want it. */
export function broadcastTerminalCount(): void {
    const count = terminalManager().list().length;
    for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('terminal:count', { count });
    }
}

/**
 * Reap host PTYs that no longer have a spec. The detached pty-host keeps
 * terminals alive across Genie restarts by design (Tier 3) — but nothing pruned
 * a pty whose spec was deleted, so orphans accumulated in the host. Run on
 * startup (after the host has loaded its persisted terminals) and on demand.
 * Uses killTerminalById so each orphan is torn down fully (pty + MCP endpoint +
 * snapshot). Best-effort per terminal.
 */
export function reapOrphanTerminals(): { reaped: string[]; live: number } {
    let live: string[] = [];
    try {
        live = terminalManager().list().map((t) => t.id);
    } catch {
        return { reaped: [], live: 0 };
    }
    const specIds = listTerminalSpecs().map((s) => s.id);
    const orphans = computeOrphans(live, specIds);
    for (const id of orphans) {
        try {
            killTerminalById(id);
        } catch {
            /* best-effort — one stubborn pty shouldn't abort the sweep */
        }
    }
    // Same sweep, for read buffers: a pty that EXITS now leaves a bounded tail
    // of its final output behind (so a crash stays diagnosable while the spec is
    // still revivable — genie#217). Once the SPEC is gone the terminal no longer
    // exists in any sense, so its buffer must go too — otherwise deleting a spec
    // through any of the paths that don't run killTerminalById would strand it.
    releaseReadBuffersWithoutSpec(specIds);
    if (orphans.length) {
        // eslint-disable-next-line no-console
        console.log(`[Genie] reaped ${orphans.length} orphaned host terminal(s): ${orphans.join(', ')}`);
    }

    return { reaped: orphans, live: live.length };
}

/**
 * Drop every read buffer whose terminal SPEC no longer exists. The buffer's
 * lifetime is the spec's: it survives a pty exit (the terminal is revivable, and
 * its final output is the evidence of what happened) but not the terminal's
 * deletion. Sweeping by spec list — rather than hooking each `deleteTerminalSpec`
 * caller — means a new deletion path can't quietly strand a buffer.
 */
function releaseReadBuffersWithoutSpec(specIds: string[]): void {
    const keep = new Set(specIds);
    for (const id of agentReadBuffer.ids()) {
        if (!keep.has(id)) agentReadBuffer.forget(id);
    }
}

/**
 * Keystroke holds for in-flight draft swaps (see main/terminal/input-hold).
 * Module-level because `terminal:write` is the choke point every human keystroke
 * passes through, and background.ts drives the swap around it.
 */
const inputHolds = new InputHolds();

/** Start holding this terminal's keyboard for a swap. False when one is already
 *  running there — the caller must not start a second. */
export function beginInputHold(id: string): boolean {
    return inputHolds.begin(id, Date.now());
}

/** Offer human keystrokes to an in-flight hold. True = buffered, do NOT write. */
export function holdTerminalInput(id: string, data: string): boolean {
    return inputHolds.hold(id, data, Date.now());
}

/** End the hold and return everything typed while it was held, to be replayed. */
export function releaseInputHold(id: string): string {
    return inputHolds.release(id);
}

/**
 * What the renderer is told when a message lands in an agent terminal whose
 * input box Genie would not touch.
 *
 * The identifying fields are the whole point. This used to be `{ id }` alone and
 * the renderer discarded even that, drawing one fixed sentence — "A message just
 * came in for THIS agent" — whichever terminal it was really about. That toast
 * was scoped to whatever had focus while the delivery was scoped to the
 * ADDRESSEE, so it routinely pointed at the wrong prompt.
 */
export interface AgentInboxIncomingPayload {
    /** The terminal the notice was delivered to — the one a click must reveal. */
    id: string;
    /** Its workspace, so the reveal can activate the right one first. */
    workspaceId: string | null;
    title: string;
    body: string;
    /** Whether the notice really is in that prompt. False = it is in the inbox
     *  and nowhere else, and the toast must not say "press Enter". */
    landed: boolean;
    /** True while the nudge is queued behind user content; false closes it. */
    pending: boolean;
}

/**
 * Tell the renderer a message has landed in an agent terminal whose input box
 * Genie would not touch — the notice was APPENDED there without being submitted,
 * so the person needs to know it is sitting behind their draft. Surfaced as a
 * top-centre toast that names the agent and opens its terminal when clicked.
 *
 * `landed` is the caller's REPORT of whether the pty writes actually succeeded,
 * not an assumption: a retained spec whose pty has exited still has a registered
 * AgentInbox agent, so a nudge to it writes nothing at all.
 */
export function announceInboxIncoming(id: string, landed: boolean, pending = true): void {
    const facts = terminalNoticeFacts(id);
    const notice = planInboxIncomingNotice({ ...facts, landed });
    const payload: AgentInboxIncomingPayload = {
        id,
        workspaceId: facts.workspaceId,
        title: notice.title,
        body: notice.body,
        landed,
        pending,
    };
    broadcastLocal('agentinbox:incoming', payload);
}

/**
 * Push a terminal's "attention" state to every window (agent-integration MCP).
 * The renderer pulses the matching terminal's glow in the rail, the flyout row,
 * and the panel border until it gets focus. Called by the MCP `imDone` tool.
 */
export function broadcastTerminalAttention(id: string, on: boolean): number {
    // LOCAL-only (mirrors broadcastWorkspacePulse): a host terminal's attention
    // arrives via its host's /ws/events, so a LOCAL terminal:attention must not
    // leak into remote-bound windows. Terminal ids are unique UUIDs so it's
    // harmless today, but broadcastLocal is the correct routing discipline.
    const local = broadcastLocal('terminal:attention', { id, on });
    // Mirror to the mobile dashboard push channel (no-op when the server is off).
    // Remote and mobile clients receive the glow HERE, not through broadcastLocal
    // — so a headless host with no local window at all can still have delivered
    // it, and counting only windows would understate it exactly as badly.
    const remote = mobileEmit('terminal:attention', { id, on });
    // How many surfaces took it. ZERO is the real case a caller must not paper
    // over: attention is a pure IPC event with no persistence anywhere, so with
    // a tray-resident Genie and nothing connected it reaches nobody, is stored
    // nowhere, and a window opened a second later never shows it.
    return local + remote;
}

/**
 * TAKE THE USER TO A TERMINAL — activate its workspace and surface its panel.
 *
 * Fired when the `imDone` toast is CLICKED. The toast's whole purpose is to pull
 * the user to the one terminal that finished, and it used to land them on the
 * master window with no idea which of several workspaces had fired it: the
 * notice named neither the workspace nor the agent, and the click went nowhere
 * in particular. Naming it in the text is half the fix; going there is the other.
 *
 * `workspaceId` is the System Workspace id for a System-Workspace terminal, and
 * null for an unattached one (the panel is still surfaced).
 */
export function broadcastTerminalReveal(id: string, workspaceId: string | null): void {
    // LOCAL-only, for the same reason as the attention glow: a host terminal's
    // reveal arrives over its host's /ws/events, and a local id must not steer a
    // remote-bound window to a panel it doesn't have.
    broadcastLocal('terminal:reveal', { id, workspaceId });
}

/**
 * Pulse a workspace ROW in the chooser (agent-integration MCP). Fired alongside
 * the per-terminal attention glow when an agent calls imDone, so the user gets a
 * sidebar-level "something finished in workspace X" cue even when the terminal
 * itself isn't visible. The renderer adds a transient `pulsing` class to that
 * workspace's rail button + flyout row, then clears it. `workspaceId` is the
 * System Workspace id for a System-Workspace terminal.
 */
export function broadcastWorkspacePulse(workspaceId: string): void {
    // LOCAL-only — a host window's pulse arrives via its host's /ws/events; a
    // local pulse carrying a shared project.id / __system__ would false-glow it.
    broadcastLocal('workspace:pulse', { workspaceId });
    mobileEmit('workspace:pulse', { workspaceId });
}

export interface PluginPanelOpenPayload {
    workspaceId: string;
    pluginId: string;
    panelId: string;
    activeItemId?: string;
}

/** Surface a plugin's declared panel in every local renderer window. */
export function broadcastPluginPanelOpen(payload: PluginPanelOpenPayload): void {
    broadcastLocal('plugin-panel:open', payload);
}

export function broadcastAgentThumbsUp(payload: {
    agentId: string;
    terminalId: string;
    workspaceId: string;
    reason: 'boot' | 'ack' | 'shutdown';
    to?: string;
}): void {
    broadcastLocal('agent:thumbs-up', payload);
    mobileEmit('agent:thumbs-up', payload);
}

/**
 * AgentPulse — install the tracker's emitter so its per-workspace activity events
 * fan out to the renderer (rail glow + live sparkline), the mobile dashboard, and
 * (via PASSTHROUGH_EVENTS) remote windows. Mirrors broadcastWorkspacePulse's
 * LOCAL-only reasoning: a host window's pulse arrives over its /ws/events, so a
 * local terminal's bytes must not false-glow it. Call once at boot.
 */
export function installAgentPulse(): void {
    agentPulse.setEmitter((ev) => {
        broadcastLocal('agent-pulse', ev);
        mobileEmit('agent-pulse', ev);
    });
}

/**
 * Tell every window the set of terminal specs changed (a spec was created,
 * deleted, or otherwise mutated outside the renderer's own local edits) so the
 * UI re-fetches `terminal-spec:list` and stays live. The renderer mirrors its
 * OWN create/delete edits locally, so this is for changes it can't see —
 * notably a process created via the MCP `manageProcess` tool, which must appear
 * in the Processes list immediately, never only after a restart.
 */
export function broadcastTerminalSpecsChanged(): void {
    // LOCAL-only — a host window re-fetches its OWN specs from its /ws/events;
    // a local spec mutation must not trigger a redundant remote round-trip there.
    broadcastLocal('terminal-spec:changed');
    mobileEmit('terminal-spec:changed');
}

/**
 * Tier 2 → Tier 1 degrade. On a real app quit, retained ptys still die via
 * stopAllTerminals (the detached pty-host is a later tier, T3). To make
 * reopening replay correctly we capture a Tier 1 snapshot for every retained
 * pty that has NO attached window — those windows are gone, so the renderer's
 * SerializeAddon can't snapshot them. We serialize the manager's raw scrollback
 * buffer instead; T1's restore path resets the screen (\x1bc) before the fresh
 * shell, so raw history-above-divider is exactly the intended shape.
 *
 * Retained terminals that DO still have a window are covered by the normal
 * requestFinalSnapshots broadcast (their SerializeAddon produces a cleaner
 * reconstruction), so we skip those here to avoid clobbering with raw bytes.
 *
 * Called from before-quit alongside requestFinalSnapshots. Best-effort and
 * synchronous so it completes inside the bounded quit window.
 */
export function snapshotRetainedWindowless(): void {
    const mgr = terminalManager();
    for (const id of mgr.retainedIds()) {
        const entry = ownersByTerminal.get(id);
        const hasWindow = !!entry && entry.owners.size > 0;
        if (hasWindow) continue; // covered by the renderer snapshot broadcast
        const scrollback = mgr.getScrollback(id);
        if (!scrollback) continue;
        try {
            const bytes = getSnapshotStore().writeSnapshot(id, scrollback);
            if (bytes == null) continue;
            try {
                updateTerminalSpec(id, {
                    snapshot_at: Date.now(),
                    snapshot_bytes: bytes,
                });
            } catch {
                /* spec gone / db not ready — file is still written */
            }
        } catch {
            /* best-effort */
        }
    }
}
