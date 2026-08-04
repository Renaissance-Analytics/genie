/**
 * AgentPulse — per-workspace real-time terminal-activity tracker.
 *
 * The workspace side-rail icon GLOWS while a workspace has live agent work, and a
 * 1-minute sparkline draws behind each bar. Two independent signals drive the glow:
 *
 *   1. **pty OUTPUT bytes** — every output byte flows through the single choke
 *      point `feedTerminalData` (terminal/ipc.ts) into {@link AgentPulse.note},
 *      giving a byte-active flag (bytes within {@link ACTIVE_WINDOW_MS}) + the
 *      60×1s byte ring the sparkline reads ({@link AgentPulse.snapshot}); and
 *   2. **agent TURN state** — an agent terminal is "working" from when it produces
 *      output until it calls `imDone` (turn end) or exits. {@link noteAgentWorking}
 *      / {@link noteAgentIdle} carry that in, so a mid-turn agent that goes QUIET
 *      (waiting on a tool/API call) keeps its workspace lit. Byte-activity alone
 *      darkened it after 1.5s — the reason a user couldn't tell agents were still
 *      running, and an upgrade killed them silently.
 *
 * A workspace reads as ACTIVE when EITHER signal is live; the emitted `active`
 * flag is that OR. The sparkline stays byte-only (it shows real output, not the
 * glow). A never-signalling agent can't glow forever: a mid-turn agent with no
 * output and no imDone decays after {@link AGENT_WORK_WINDOW_MS}.
 *
 * PUSH-first (no idle polling): a coalesced `agent-pulse` event pushes on activity
 * (throttled to {@link COALESCE_MS}) and once on each active↔idle transition. PURE:
 * no electron/db/fs — the emitter is injected (tests pass a spy) and the clock is
 * injectable, so bucketing/window/turn logic is deterministically testable.
 */

/** Bytes seen within this window ⇒ the workspace reads as byte-ACTIVE (icon glows). */
export const ACTIVE_WINDOW_MS = 1500;
/**
 * A mid-turn agent with NO output and NO `imDone` for this long decays to idle — a
 * backstop so an agent that never signals its turn end can't glow forever. Generous
 * (5 min) so an ordinary wait-on-a-tool gap never trips it; `imDone`/exit clear it
 * immediately in the normal case.
 */
export const AGENT_WORK_WINDOW_MS = 5 * 60_000;
/** Sparkline span: 60 one-second buckets = the last minute. */
export const BUCKET_COUNT = 60;
export const BUCKET_MS = 1000;
/** Max cadence of the live `agent-pulse` push per workspace during activity. */
export const COALESCE_MS = 250;

export interface AgentPulseEvent {
    workspaceId: string;
    /** Whether the workspace currently reads as active (drives the rail glow). */
    active: boolean;
    /** Bytes accumulated since the previous emit (for the live sparkline tick). */
    bytes: number;
}

interface WsState {
    /** absolute-second → byte count, pruned to the last BUCKET_COUNT seconds. */
    buckets: Map<number, number>;
    lastByteTs: number;
    /** Whether pty bytes arrived within ACTIVE_WINDOW_MS (the byte half of active). */
    byteActive: boolean;
    /** Agent terminals currently MID-TURN in this workspace (the turn half of active). */
    workingAgents: Set<string>;
    /** Per-agent backstop decay timer (id → timer) — cleared/re-armed by turn signals. */
    workBackstop: Map<string, ReturnType<typeof setTimeout>>;
    /** Bytes accrued since the last coalesced emit. */
    pendingBytes: number;
    lastEmitTs: number;
    idleTimer: ReturnType<typeof setTimeout> | null;
    coalesceTimer: ReturnType<typeof setTimeout> | null;
}

type Clock = () => number;

export class AgentPulse {
    private ws = new Map<string, WsState>();
    private emit: (ev: AgentPulseEvent) => void = () => {};

    constructor(private now: Clock = Date.now) {}

    /** Wire the outbound event sink (presence installs the real broadcast at boot). */
    setEmitter(fn: (ev: AgentPulseEvent) => void): void {
        this.emit = fn;
    }

    private state(workspaceId: string): WsState {
        let s = this.ws.get(workspaceId);
        if (!s) {
            s = {
                buckets: new Map(),
                lastByteTs: 0,
                byteActive: false,
                workingAgents: new Set(),
                workBackstop: new Map(),
                pendingBytes: 0,
                lastEmitTs: 0,
                idleTimer: null,
                coalesceTimer: null,
            };
            this.ws.set(workspaceId, s);
        }
        return s;
    }

    /** Combined active: byte-activity OR any agent mid-turn. This is what glows. */
    private combinedActive(s: WsState): boolean {
        return s.byteActive || s.workingAgents.size > 0;
    }

    private unref(timer: ReturnType<typeof setTimeout>): void {
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
            (timer as { unref: () => void }).unref();
        }
    }

    /** Drop bucket entries older than the 60s window. */
    private prune(s: WsState, sec: number): void {
        const cutoff = sec - BUCKET_COUNT + 1;
        for (const k of s.buckets.keys()) {
            if (k < cutoff) s.buckets.delete(k);
        }
    }

    /**
     * Record `bytes` of pty output for `workspaceId`. Updates the ring, flips the
     * workspace byte-active (emitting on the transition), coalesces live pushes
     * during sustained output, and (re)arms the byte idle timer.
     */
    note(workspaceId: string, bytes: number): void {
        if (!workspaceId || bytes <= 0) return;
        const t = this.now();
        const sec = Math.floor(t / BUCKET_MS);
        const s = this.state(workspaceId);

        s.buckets.set(sec, (s.buckets.get(sec) ?? 0) + bytes);
        this.prune(s, sec);
        s.lastByteTs = t;
        s.pendingBytes += bytes;

        // Transition byte-idle→byte-active: emit immediately so the glow is instant.
        if (!s.byteActive) {
            s.byteActive = true;
            this.flush(workspaceId, s, t);
        } else if (t - s.lastEmitTs >= COALESCE_MS) {
            // Sustained output: push a coalesced tick (feeds the live sparkline)
            // at most every COALESCE_MS.
            this.flush(workspaceId, s, t);
        } else if (!s.coalesceTimer) {
            // Schedule a trailing flush so the final bytes in a burst still push.
            s.coalesceTimer = setTimeout(() => {
                s.coalesceTimer = null;
                this.flush(workspaceId, s, this.now());
            }, COALESCE_MS);
            this.unref(s.coalesceTimer);
        }

        // (Re)arm the byte idle timer — byteActive drops ACTIVE_WINDOW_MS after the
        // last byte if nothing more arrives (the glow may still hold on agent work).
        if (s.idleTimer) clearTimeout(s.idleTimer);
        s.idleTimer = setTimeout(() => this.checkIdle(workspaceId), ACTIVE_WINDOW_MS);
        this.unref(s.idleTimer);
    }

    /**
     * Mark an agent terminal as MID-TURN in its workspace — call on agent output.
     * Keeps the workspace lit through byte-silence until {@link noteAgentIdle}
     * (imDone / exit) or the backstop decay. Re-arming on continued output keeps a
     * long active turn from decaying early.
     */
    noteAgentWorking(workspaceId: string, terminalId: string): void {
        if (!workspaceId || !terminalId) return;
        const s = this.state(workspaceId);
        const wasActive = this.combinedActive(s);
        s.workingAgents.add(terminalId);

        const prev = s.workBackstop.get(terminalId);
        if (prev) clearTimeout(prev);
        const timer = setTimeout(
            () => this.noteAgentIdle(workspaceId, terminalId),
            AGENT_WORK_WINDOW_MS,
        );
        this.unref(timer);
        s.workBackstop.set(terminalId, timer);

        // Newly lit (was fully idle) → emit the glow-on immediately.
        if (!wasActive) this.emit({ workspaceId, active: true, bytes: 0 });
    }

    /**
     * Clear an agent terminal's MID-TURN state — call on `imDone` (turn end) or on
     * the agent terminal's exit. Emits glow-off only when this drops the LAST live
     * signal (no other working agent AND no byte activity).
     */
    noteAgentIdle(workspaceId: string, terminalId: string): void {
        if (!workspaceId || !terminalId) return;
        const s = this.ws.get(workspaceId);
        if (!s) return;
        const timer = s.workBackstop.get(terminalId);
        if (timer) {
            clearTimeout(timer);
            s.workBackstop.delete(terminalId);
        }
        if (!s.workingAgents.delete(terminalId)) return; // wasn't marked working
        if (!this.combinedActive(s)) this.emit({ workspaceId, active: false, bytes: 0 });
    }

    /** Emit the pending bytes + combined active state; reset the coalesce accrual. */
    private flush(workspaceId: string, s: WsState, t: number): void {
        if (s.coalesceTimer) {
            clearTimeout(s.coalesceTimer);
            s.coalesceTimer = null;
        }
        const bytes = s.pendingBytes;
        s.pendingBytes = 0;
        s.lastEmitTs = t;
        this.emit({ workspaceId, active: this.combinedActive(s), bytes });
    }

    /** Byte idle-timer callback: drop byteActive after the window. The glow only
     *  goes off if no agent is still mid-turn (combinedActive handles that). */
    private checkIdle(workspaceId: string): void {
        const s = this.ws.get(workspaceId);
        if (!s || !s.byteActive) return;
        if (this.now() - s.lastByteTs < ACTIVE_WINDOW_MS) return; // more bytes arrived
        s.byteActive = false;
        s.idleTimer = null;
        this.flush(workspaceId, s, this.now());
    }

    /** Whether a workspace currently reads as active (byte activity OR agent mid-turn). */
    isActive(workspaceId: string): boolean {
        const s = this.ws.get(workspaceId);
        if (!s) return false;
        if (s.workingAgents.size > 0) return true;
        return s.byteActive && this.now() - s.lastByteTs < ACTIVE_WINDOW_MS;
    }

    /**
     * Last-60s byte buckets per workspace, oldest→newest (index 0 = 59s ago,
     * index 59 = the current second). Fetched once when the workspace menu opens
     * to backfill each sparkline; live pushes advance it from there.
     */
    snapshot(): Record<string, number[]> {
        const nowSec = Math.floor(this.now() / BUCKET_MS);
        const out: Record<string, number[]> = {};
        for (const [wsId, s] of this.ws) {
            const arr = new Array<number>(BUCKET_COUNT).fill(0);
            for (const [sec, bytes] of s.buckets) {
                const idx = BUCKET_COUNT - 1 - (nowSec - sec);
                if (idx >= 0 && idx < BUCKET_COUNT) arr[idx] = bytes;
            }
            out[wsId] = arr;
        }
        return out;
    }

    /** Test/diagnostic reset. */
    _reset(): void {
        for (const s of this.ws.values()) {
            if (s.idleTimer) clearTimeout(s.idleTimer);
            if (s.coalesceTimer) clearTimeout(s.coalesceTimer);
            for (const t of s.workBackstop.values()) clearTimeout(t);
        }
        this.ws.clear();
    }
}

/** Process-wide singleton — the terminal fan-out notes into it; presence wires
 *  the emitter; IPC reads its snapshot. */
export const agentPulse = new AgentPulse();
