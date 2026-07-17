import { BrowserWindow, ipcMain, WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
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
    type TerminalSpecRow,
    type TerminalSpecMeta,
} from '../db';
import { agentInboxBroker } from '../agentinbox/broker';
import { workspaceSlug } from '../agentinbox/slug';
import {
    renderAgentLaunch,
    captureSessionByDetect,
    agentRelaunchDecision,
    transcriptDirFor,
} from '../agentinbox/session-capture';
import { buildSubmitBytes } from './keystrokes';
import {
    normalizePurpose,
    type AgentInboxJoinInput,
    type AgentInboxAgentType,
    type AgentInboxScope,
} from '../agentinbox/types';
import { loadWorkspaceTerminalEnv } from '../mcp/agent-config';
import { computeOrphans } from './orphans';
import { buildProcessArgs } from './process-spawn';
import { TerminalReadBuffer, type ReadResult } from './read-buffer';
import { recordTerminalSize } from './size-tracker';
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
import {
    registerTerminalEndpoint,
    unregisterTerminalEndpoint,
    workspaceEndpointUrl,
} from '../mcp/server';
import { mobileEmit, mobileTermFanout, mobileTermClose } from '../mobile/server';
import { broadcastLocal } from '../remote';
import { getSnapshotStore, dbSettingsProvider } from './genie-adapter';
import { listAllProcesses } from './process-list';
import { logPtyOsc } from './osc-debug';
import { agentPulse } from './agent-pulse';
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

/** Read recent output for a terminal (agent-control MCP). */
export function readTerminalOutput(
    id: string,
    opts: { cursor?: number; bytes?: number },
): ReadResult {
    if (opts.bytes !== undefined) return agentReadBuffer.readTail(id, opts.bytes);
    return agentReadBuffer.readSince(id, opts.cursor);
}

/**
 * Spawn a HEADLESS terminal for an agent (manageTerminals.create / runAgent.start)
 * — a real pty with NO window owner, like the Process runners. It gets a persisted
 * terminal spec (so it shows up in the workspace's terminal list and survives like
 * any other), and — when the workspace has the agent MCP enabled — the
 * GENIE_MCP_URL / GENIE_TERMINAL_ID env so a launched coding agent can
 * itself reach Genie. Returns the new terminal id + its initial scrollback. The
 * APPROVAL GATE is enforced by the caller (background.ts) BEFORE this runs.
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
    /** Marks this terminal as running an agent (surfaced in the list). */
    agentMeta?: { agent: 'claude' | 'codex' | 'custom'; command: string };
    /** Specialized terminals: AgentInbox accessibility to stamp + join with. */
    agentInbox?: {
        purpose?: string;
        scope?: AgentInboxScope;
        scopeWorkspaces?: string[];
        /** Opt-in wake-on-DM (issue #9): a direct message wakes this agent when idle. */
        wakeOnDm?: boolean;
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

    // Agent terminals capture their chat-session id at launch + get an AgentInbox
    // identity so they can coordinate. Render the (possibly session-augmented)
    // launch command from the agent's capture profile; a plain terminal has no
    // agentMeta and gets none of this.
    let launchCommand: string | undefined;
    let chatSessionId: string | null = null;
    let strategy: ReturnType<typeof renderAgentLaunch>['strategy'] | null = null;
    let agentId: string | undefined;
    let meta: TerminalSpecMeta = {};
    if (opts.agentMeta) {
        const rendered = renderAgentLaunch(opts.agentMeta.agent, opts.agentMeta.command);
        launchCommand = rendered.command;
        chatSessionId = rendered.chatSessionId;
        strategy = rendered.strategy;
        agentId = crypto.randomUUID();
        meta = {
            agent: opts.agentMeta.agent,
            agent_command: opts.agentMeta.command,
            agent_id: agentId,
            // BACK-COMPAT: stored `whisper_*` meta keys are kept after the
            // WhisperChat → AgentInbox rename (renaming them needs a data migration).
            whisper_purpose: normalizePurpose(opts.agentInbox?.purpose),
            whisper_scope: opts.agentInbox?.scope ?? 'self',
            ...(opts.agentInbox?.scopeWorkspaces?.length
                ? { whisper_workspaces: opts.agentInbox.scopeWorkspaces }
                : {}),
            ...(opts.agentInbox?.wakeOnDm ? { whisper_wake_on_dm: true } : {}),
            ...(opts.issuewatch?.handle ? { issuewatch_handle: true } : {}),
            ...(opts.issuewatch?.handle && opts.issuewatch.action
                ? { issuewatch_action: opts.issuewatch.action }
                : {}),
            ...(chatSessionId ? { chat_session_id: chatSessionId } : {}),
        };
    }

    // Persist a spec so the terminal is a first-class member of the workspace
    // (appears in lists, can be reattached by a window, killed by the user). A
    // caller-supplied id may ALREADY have a spec (a remote re-open, or a respawn
    // after the host restarted and the pty died) — reuse it rather than duplicate.
    if (!getTerminalSpec(id)) {
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
    let env: Record<string, string> = {};
    const wsRoot = getWorkspace(opts.workspaceId)?.path;
    env = wsRoot ? loadWorkspaceTerminalEnv(wsRoot) : {};
    if (workspaceMcpEnabled(opts.workspaceId)) {
        const mcpUrl = registerTerminalEndpoint(id);
        if (mcpUrl) {
            env = { ...env, GENIE_MCP_URL: mcpUrl, GENIE_TERMINAL_ID: id };
        }
    }

    const createOpts: CreateTerminalOpts = {
        id,
        cwd: opts.cwd,
        shell: opts.shell ?? resolved.command,
        args: opts.args ?? resolved.args,
        env,
    };
    // Idempotent on the id: if a live pty already owns it, this reattaches
    // (existing:true, scrollback replayed) instead of spawning a duplicate.
    const result = terminalManager().create(createOpts);
    noteTerminalActivity(id);
    // Tell every window the spec set changed so the new terminal appears live.
    broadcastTerminalSpecsChanged();

    // AgentInbox: register the fresh agent so peers can discover/DM it. When the
    // session id wasn't captured by a launch flag (detect / a custom wrapper),
    // briefly watch the transcript dir and backfill it.
    if (agentId) {
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
    return { id, scrollback: result.scrollback, existing: result.existing, command: launchCommand, chatSessionId };
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
function agentSessionTranscriptExists(spec: TerminalSpecRow | null, sid: string): boolean {
    const cwd = spec?.live_cwd || spec?.cwd;
    if (!cwd) return false; // can't verify → treat as missing → fall back to -c
    try {
        return fs.existsSync(path.join(transcriptDirFor(cwd), `${sid}.jsonl`));
    } catch {
        return false;
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
    const bytes = buildSubmitBytes(decision.command, true);
    // Let the fresh shell settle (profile load) before submitting the boot command.
    const timer = setTimeout(() => {
        try {
            writeToTerminal(id, bytes);
        } catch {
            /* pty gone — nothing to submit */
        }
    }, 500);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
    }
}

/**
 * Build an AgentInbox join input from a persisted agent spec — resolves the
 * workspace + its display slug (the db/fs I/O the pure broker can't do). Null
 * when the spec isn't an AgentInbox agent (no `agent_id`) or its workspace is gone.
 */
function joinInputFromSpec(spec: TerminalSpecRow | null): AgentInboxJoinInput | null {
    if (!spec || !spec.workspace_id) return null;
    const agentId = spec.meta?.agent_id;
    if (!agentId) return null;
    const ws = getWorkspace(spec.workspace_id);
    if (!ws) return null;
    return {
        agentId,
        terminalId: spec.id,
        workspaceId: ws.id,
        workspaceName: ws.project_name,
        slug: workspaceSlug(ws),
        agentType: (spec.meta?.agent as AgentInboxAgentType) ?? 'custom',
        label: spec.label,
        purpose: normalizePurpose(spec.meta?.whisper_purpose),
        scope: (spec.meta?.whisper_scope as AgentInboxScope) ?? 'self',
        scopeWorkspaces: Array.isArray(spec.meta?.whisper_workspaces)
            ? (spec.meta.whisper_workspaces as string[])
            : [],
        chatSessionId: spec.meta?.chat_session_id ?? null,
        wakeOnDm: spec.meta?.whisper_wake_on_dm === true,
    };
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
    if (pulseWs) agentPulse.note(pulseWs, data.length);
    // Wake-on-DM idle signal (issue #9): any output means the agent is active — so
    // a DM wake fails closed until it's genuinely quiet again. Cheap (a timestamp).
    agentInboxBroker.noteOutput(id);
    // Mirror to any attached mobile /ws/term socket (no-op when off / unwatched).
    mobileTermFanout(id, data);
}

function feedTerminalExit(id: string, payload: { exitCode: number; signal?: number }): void {
    // Supervisor decides a Process runner's fate (no-op for other ids).
    onProcessPtyExit(id, payload);
    // The pty is gone — drop its agent read buffer so it can't leak.
    agentReadBuffer.forget(id);
    // AgentInbox: the pty exited but the spec is retained (revivable) — mark the
    // agent `away` (no-op for a non-agent terminal).
    agentInboxBroker.away(id);
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
            // Load workspace env and reconstruct TYNN_AGENT_TOKEN from the
            // authoritative literal MCP config when `.env` is missing/stale.
            // This path covers restored/resumed terminals; explicit opts.env
            // still wins on any collision.
            const wsRoot = spec?.workspace_id
                ? getWorkspace(spec.workspace_id)?.path
                : undefined;
            const envFileVars = wsRoot ? loadWorkspaceTerminalEnv(wsRoot) : {};
            if (Object.keys(envFileVars).length) {
                opts = { ...opts, env: { ...envFileVars, ...opts.env } };
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
    agentInboxBroker.leaveByTerminal(id);
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
    const orphans = computeOrphans(live, listTerminalSpecs().map((s) => s.id));
    for (const id of orphans) {
        try {
            killTerminalById(id);
        } catch {
            /* best-effort — one stubborn pty shouldn't abort the sweep */
        }
    }
    if (orphans.length) {
        // eslint-disable-next-line no-console
        console.log(`[Genie] reaped ${orphans.length} orphaned host terminal(s): ${orphans.join(', ')}`);
    }

    return { reaped: orphans, live: live.length };
}

/**
 * Push a terminal's "attention" state to every window (agent-integration MCP).
 * The renderer pulses the matching terminal's glow in the rail, the flyout row,
 * and the panel border until it gets focus. Called by the MCP `imDone` tool.
 */
export function broadcastTerminalAttention(id: string, on: boolean): void {
    // LOCAL-only (mirrors broadcastWorkspacePulse): a host terminal's attention
    // arrives via its host's /ws/events, so a LOCAL terminal:attention must not
    // leak into remote-bound windows. Terminal ids are unique UUIDs so it's
    // harmless today, but broadcastLocal is the correct routing discipline.
    broadcastLocal('terminal:attention', { id, on });
    // Mirror to the mobile dashboard push channel (no-op when the server is off).
    mobileEmit('terminal:attention', { id, on });
}

/**
 * Pulse a workspace ROW in the chooser (agent-integration MCP). Fired alongside
 * the per-terminal attention glow when an agent calls imDone, so the user gets a
 * sidebar-level "something finished in workspace X" cue even when the terminal
 * itself isn't visible. The renderer adds a transient `pulsing` class to that
 * workspace's rail button + flyout row, then clears it. `workspaceId` is the
 * synthetic System Workspace id for a System-Workspace terminal.
 */
export function broadcastWorkspacePulse(workspaceId: string): void {
    // LOCAL-only — a host window's pulse arrives via its host's /ws/events; a
    // local pulse carrying a shared project.id / __system__ would false-glow it.
    broadcastLocal('workspace:pulse', { workspaceId });
    mobileEmit('workspace:pulse', { workspaceId });
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
