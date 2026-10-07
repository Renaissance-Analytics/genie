import { engineFor, type AgentEngine } from './engine';

/**
 * What starting an agent MEANS, for each engine.
 *
 * The pure half of the one branch in `createAgentTerminal` — the single chokepoint every
 * launch path bottoms out in, by design: a renderer click, `runAgent start`, mobile,
 * revival. Its own comment explains why it is the chokepoint ("owning the launch here
 * means no entry point can create an agent terminal that never starts"), and that is
 * exactly why the ACP branch belongs there and nowhere else.
 *
 * It lives in a 115 KB file that imports electron and the database and ships with no test,
 * so the decision is here and the file gets two lines.
 */
export type LaunchPlan =
    /** Type the TUI's launch line into the pty, as today. */
    | { kind: 'pty'; command: string }
    /** Start a structured session. No command: an ACP adapter takes bare argv. */
    | { kind: 'acp'; provider: string };

export interface LaunchPlanInput {
    provider: string | null;
    /** See the note on `EngineInput.acpEnabled` — held until ACP can resume. */
    acpEnabled: boolean;
    /** The TUI launch line, when there is one. */
    command: string | null;
    agentOverride?: AgentEngine;
}

export function launchPlan(input: LaunchPlanInput): LaunchPlan | null {
    const engine = engineFor({
        provider: input.provider,
        acpEnabled: input.acpEnabled,
        agentOverride: input.agentOverride,
    });

    // ACP does not use the launch line at all — the adapter is spawned with bare argv and
    // everything travels in the environment — so a missing command is not a reason to
    // refuse, where for the pty it means there is nothing to type.
    if (engine === 'acp' && input.provider) return { kind: 'acp', provider: input.provider };
    if (!input.command) return null;
    return { kind: 'pty', command: input.command };
}
