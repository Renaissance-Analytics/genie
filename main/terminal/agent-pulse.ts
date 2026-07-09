/**
 * AgentPulse — per-workspace real-time terminal-activity tracker.
 *
 * Every pty OUTPUT byte (an agent "doing something") flows through the single
 * choke point `feedTerminalData` (terminal/ipc.ts), which calls {@link AgentPulse.note}
 * with the byte count and the owning workspace. From that one signal this tracker
 * derives two things the UI needs:
 *
 *   - a real-time `active` flag per workspace (bytes seen within the last
 *     {@link ACTIVE_WINDOW_MS}) → the workspace side-rail icon glows live; and
 *   - a rolling 60×1s byte-count ring per workspace ({@link AgentPulse.snapshot})
 *     → the 1-minute sparkline drawn behind each bar when the workspace menu is open.
 *
 * PUSH-first (no idle polling): the tracker pushes a coalesced `agent-pulse`
 * event on activity (throttled to {@link COALESCE_MS}) and exactly once when a
 * workspace goes idle. The sparkline's decay animation runs client-side only
 * while the menu is open. PURE: no electron/db/fs — the emitter is injected
 * (presence wiring installs the real broadcast; tests pass a spy), and the clock
 * is injectable so the bucketing/window logic is deterministically testable.
 */

/** Bytes seen within this window ⇒ the workspace reads as ACTIVE (icon glows). */
export const ACTIVE_WINDOW_MS = 1500;
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
    active: boolean;
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
                active: false,
                pendingBytes: 0,
                lastEmitTs: 0,
                idleTimer: null,
                coalesceTimer: null,
            };
            this.ws.set(workspaceId, s);
        }
        return s;
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
     * workspace active (emitting on the transition), coalesces live pushes during
     * sustained output, and (re)arms the idle timer that emits `active:false` once
     * output stops for {@link ACTIVE_WINDOW_MS}.
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

        // Transition idle→active: emit immediately so the glow is instant.
        if (!s.active) {
            s.active = true;
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
            if (typeof (s.coalesceTimer as { unref?: () => void }).unref === 'function') {
                (s.coalesceTimer as { unref: () => void }).unref();
            }
        }

        // (Re)arm the idle timer — active:false fires ACTIVE_WINDOW_MS after the
        // last byte if nothing more arrives.
        if (s.idleTimer) clearTimeout(s.idleTimer);
        s.idleTimer = setTimeout(() => this.checkIdle(workspaceId), ACTIVE_WINDOW_MS);
        if (typeof (s.idleTimer as { unref?: () => void }).unref === 'function') {
            (s.idleTimer as { unref: () => void }).unref();
        }
    }

    /** Emit the pending bytes + current active state; reset the coalesce accrual. */
    private flush(workspaceId: string, s: WsState, t: number): void {
        if (s.coalesceTimer) {
            clearTimeout(s.coalesceTimer);
            s.coalesceTimer = null;
        }
        const bytes = s.pendingBytes;
        s.pendingBytes = 0;
        s.lastEmitTs = t;
        this.emit({ workspaceId, active: s.active, bytes });
    }

    /** Idle-timer callback: if no bytes for the active window, go inactive + emit. */
    private checkIdle(workspaceId: string): void {
        const s = this.ws.get(workspaceId);
        if (!s || !s.active) return;
        if (this.now() - s.lastByteTs < ACTIVE_WINDOW_MS) return; // more bytes arrived
        s.active = false;
        s.idleTimer = null;
        this.flush(workspaceId, s, this.now());
    }

    /** Whether a workspace currently reads as active. */
    isActive(workspaceId: string): boolean {
        const s = this.ws.get(workspaceId);
        if (!s) return false;
        return s.active && this.now() - s.lastByteTs < ACTIVE_WINDOW_MS;
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
        }
        this.ws.clear();
    }
}

/** Process-wide singleton — the terminal fan-out notes into it; presence wires
 *  the emitter; IPC reads its snapshot. */
export const agentPulse = new AgentPulse();
