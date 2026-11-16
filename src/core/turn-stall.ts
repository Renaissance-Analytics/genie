/**
 * A TURN THAT HAS GONE SILENT (Tynn #754). Not implemented: the RED commit's inert stubs.
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

/** The setting `turn_stall_minutes` as milliseconds: 0 = off; anything unreadable = the default. */
export function stallMsFrom(_values: Readonly<Record<string, unknown>>): number {
    return 0;
}

export class TurnStallWatchdog {
    readonly #ports: TurnStallPorts;

    constructor(ports: TurnStallPorts) {
        this.#ports = ports;
    }

    /** The agent produced something (a row, a tool step). */
    activity(_agentId: string): void {
        void this.#ports;
    }

    /** One look at every agent. */
    check(): void {
        // not implemented
    }
}
