/**
 * A TURN THAT HAS GONE SILENT (Tynn #754; the owner's logs, 2026-11-16: an agent said nothing for 77 minutes inside one
 * turn, and nothing noticed). A turn in flight that has produced no row for the whole window (setting
 * `turn_stall_minutes`, 20 by default, 0 = off) is told ONCE per silence: flagged in the agent's chat and the host's log
 * for every mode, and — for an `automated` agent — given one prompt into the turn. Any output re-arms it. Never while
 * the agent is waiting on the person (its silence is theirs), never for an agent not in a turn.
 */

export interface StallState {
    readonly inTurn: boolean;
    readonly mode: 'automated' | 'manual';
    /** Its own open question or a parked approval: silence is the person's to end. */
    readonly waitingOnPerson: boolean;
}

export interface TurnStallPorts {
    readonly now: () => number;
    /** How long a turn may say nothing before it is told; 0 = never. */
    readonly stallMs: () => number;
    readonly agents: () => readonly string[];
    readonly read: (agentId: string) => StallState | null;
    /** Said in the agent's chat and the host's log: every mode. */
    readonly flag: (agentId: string, silentMs: number) => void;
    /** A prompt into the silent turn: automated agents only. */
    readonly nudge: (agentId: string, silentMs: number) => void;
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

    constructor(ports: TurnStallPorts) {
        this.#ports = ports;
    }

    /** The agent produced something (a row, a tool step). */
    activity(agentId: string): void {
        this.#last.set(agentId, this.#ports.now());
        this.#told.delete(agentId);
    }

    /** One look at every agent. */
    check(): void {
        const stallMs = this.#ports.stallMs();
        const now = this.#ports.now();
        for (const id of this.#ports.agents()) {
            const s = this.#ports.read(id);
            if (s === null || !s.inTurn) { this.#last.delete(id); this.#told.delete(id); continue; }
            if (s.waitingOnPerson) { this.#last.set(id, now); this.#told.delete(id); continue; }
            if (stallMs <= 0) continue;
            const last = this.#last.get(id) ?? now;
            this.#last.set(id, last);
            if (this.#told.has(id) || now - last < stallMs) continue;
            this.#told.add(id);
            this.#ports.flag(id, now - last);
            if (s.mode === 'automated') this.#ports.nudge(id, now - last);
        }
    }
}
