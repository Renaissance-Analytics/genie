import type { Liveness, RunningCall, StalledReason } from './hung-call.js';

export type { RunningCall } from './hung-call.js';

/**
 * A TURN THAT HAS GONE SILENT (Tynn #754; the owner's logs, 2026-11-16: an agent said nothing for 77 minutes inside one
 * turn, and nothing noticed). A turn in flight that has produced no row for the whole window (setting
 * `turn_stall_minutes`, 20 by default, 0 = off) is told ONCE per silence: flagged in the agent's chat and the host's log
 * for every mode, and — for an `automated` agent — given one prompt into the turn. Any output re-arms it. Never while
 * the agent is waiting on the person (its silence is theirs), never for an agent not in a turn.
 *
 * A HUNG CALL, A HUNG TURN (Tynn #855) — two more rules on the same clock:
 *   - THE CALL: the notice names the foreground call the turn is in (its command, its age), and a call that has produced
 *     nothing for the no-output timeout (`tool_call_timeout_minutes`, 15 by default, 0 = never) is ENDED, once, and the
 *     agent told (`endCall`). lift's az/gh/git call hung 21 minutes and only the whole turn could be stopped.
 *   - THE TURN: told, and no call running, the provider is checked (`checkAlive`: the process, then a ping when the driver
 *     has one). Dead or unresponsive ends the turn as stalled (`stall`); alive or unknown leaves it, and it is asked again
 *     at the next look. prism-engine's turn read Working for hours after its CLI had ended it.
 */

export interface StallState {
    readonly inTurn: boolean;
    readonly mode: 'automated' | 'manual';
    /** Its own open question or a parked approval: silence is the person's to end. */
    readonly waitingOnPerson: boolean;
    /** The foreground call it is in now; `null` (or absent) = none. */
    readonly call?: RunningCall | null;
}

export interface TurnStallPorts {
    readonly now: () => number;
    /** How long a turn may say nothing before it is told; 0 = never. */
    readonly stallMs: () => number;
    readonly agents: () => readonly string[];
    readonly read: (agentId: string) => StallState | null;
    /** Said in the agent's chat and the host's log: every mode. `call`: the call it is in, when one runs. */
    readonly flag: (agentId: string, silentMs: number, call: RunningCall | null) => void;
    /** A prompt into the silent turn: automated agents only. */
    readonly nudge: (agentId: string, silentMs: number) => void;
    /** How long a foreground call may produce nothing before it is ended; 0 = never. Absent = never. */
    readonly toolTimeoutMs?: () => number;
    /** End that call and tell the agent (Tynn #855). */
    readonly endCall?: (agentId: string, toolCallId: string, silentMs: number) => void;
    /** Is its provider still there (Tynn #855)? */
    readonly checkAlive?: (agentId: string) => Promise<Liveness>;
    /** End its turn as stalled: the provider is dead or did not answer. */
    readonly stall?: (agentId: string, silentMs: number, reason: StalledReason) => void;
}

export const DEFAULT_STALL_MINUTES = 20;

const STALL_OPTIONS = [0, 5, 10, 20, 30, 60];

/** The setting `turn_stall_minutes` as milliseconds: 0 = off; anything unreadable = the default. */
export function stallMsFrom(values: Readonly<Record<string, unknown>>): number {
    const n = Number(values.turn_stall_minutes);
    return (STALL_OPTIONS.includes(n) ? n : DEFAULT_STALL_MINUTES) * 60_000;
}

export class TurnStallWatchdog {
    readonly #ports: TurnStallPorts;
    /** Per agent in a turn: when it last produced something (or was first seen mid-turn). */
    readonly #last = new Map<string, number>();
    /** Told for the silence it is in now. */
    readonly #told = new Set<string>();
    /** Per agent, the calls already ended: one end per call. */
    readonly #ended = new Map<string, Set<string>>();
    /** A liveness check in flight: never two at once for one agent. */
    readonly #checking = new Set<string>();

    constructor(ports: TurnStallPorts) {
        this.#ports = ports;
    }

    /** The agent produced something (a row, a tool step). */
    activity(agentId: string): void {
        this.#last.set(agentId, this.#ports.now());
        this.#told.delete(agentId);
    }

    /** One look at every agent. Resolves when the liveness checks it started have answered (a test awaits it). */
    check(): Promise<void> {
        const stallMs = this.#ports.stallMs();
        const toolMs = this.#ports.toolTimeoutMs?.() ?? 0;
        const now = this.#ports.now();
        const checks: Promise<void>[] = [];
        for (const id of this.#ports.agents()) {
            const s = this.#ports.read(id);
            if (s === null || !s.inTurn) { this.#forget(id); continue; }
            if (s.waitingOnPerson) { this.#last.set(id, now); this.#told.delete(id); continue; }
            const last = this.#last.get(id) ?? now;
            this.#last.set(id, last);
            const silent = now - last;
            const call = s.call ?? null;
            // THE CALL (Tynn #855): silent for the timeout, and running at least that long — ended once.
            if (call !== null && toolMs > 0 && silent >= toolMs && now - call.since >= toolMs) {
                const ended = this.#ended.get(id) ?? new Set<string>();
                if (!ended.has(call.toolCallId)) {
                    ended.add(call.toolCallId);
                    this.#ended.set(id, ended);
                    this.#ports.endCall?.(id, call.toolCallId, silent);
                }
            }
            if (stallMs <= 0 || silent < stallMs) continue;
            if (!this.#told.has(id)) {
                this.#told.add(id);
                this.#ports.flag(id, silent, call);
                if (s.mode === 'automated') this.#ports.nudge(id, silent);
            }
            // THE TURN (Tynn #855): told, no call running — is the provider there?
            if (call === null && this.#ports.checkAlive && !this.#checking.has(id)) checks.push(this.#checkAlive(id, silent));
        }
        return Promise.all(checks).then(() => undefined);
    }

    async #checkAlive(id: string, silent: number): Promise<void> {
        this.#checking.add(id);
        try {
            const verdict = await this.#ports.checkAlive!(id);
            if (verdict === 'dead' || verdict === 'unresponsive') {
                this.#forget(id);
                this.#ports.stall?.(id, silent, verdict);
            }
        } catch { /* a check that could not run says nothing: asked again at the next look */ }
        finally { this.#checking.delete(id); }
    }

    #forget(id: string): void {
        this.#last.delete(id);
        this.#told.delete(id);
        this.#ended.delete(id);
    }
}
