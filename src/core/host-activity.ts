import { onTheClock } from './tray-only.js';

/**
 * WHAT THIS HOST RUNS NOW, BY ITS OWN COUNT (`engine.activity`, Tynn #1058 L5): the launcher's tray line and its "Shut down
 * everything?" / "Stop this computer's host?" questions name everything that would stop. The same kinds the client's tray
 * counted before L5 (core/tray-only.ts HostActivity): agents (named), terminals, kept processes, services, what waits on the
 * host's clock (armed flows, scheduled tasks), and the Genie Browser's own process.
 */
export interface HostActivityCount {
    readonly agents: number;
    readonly agentNames: readonly string[];
    readonly terminals: number;
    readonly processes: number;
    readonly services: number;
    readonly armedFlows: number;
    readonly scheduledTasks: number;
    /** The Genie Browser's process is linked to this host: somebody may be using it. */
    readonly browser: boolean;
    /**
     * What waits on the person on this host's Deck (core/deck.ts needsYouCount, the Deck badge's own number): the launcher's
     * tray shows its dot and "Needs you: N" (the owner, 2026-10-26: "the mark with a dot while anything waits on the person").
     */
    readonly needsYou: number;
}

export function hostActivityOf(input: {
    readonly running: ReadonlyArray<{ readonly name: string }>;
    readonly summary: { readonly terminals: readonly unknown[]; readonly processes: readonly unknown[]; readonly services: readonly unknown[] };
    readonly flows: ReadonlyArray<{ readonly armed: boolean }>;
    readonly kept: ReadonlyArray<{ readonly wanted: boolean; readonly schedule?: unknown }>;
    readonly browserUp: boolean;
    readonly needsYou: number;
}): HostActivityCount {
    return {
        agents: input.running.length,
        agentNames: input.running.map((a) => a.name),
        terminals: input.summary.terminals.length,
        processes: input.summary.processes.length,
        services: input.summary.services.length,
        ...onTheClock(input.flows, input.kept),
        browser: input.browserUp,
        needsYou: input.needsYou,
    };
}
