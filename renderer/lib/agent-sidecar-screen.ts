import type { AgentRecordSpec, AgentRuntimeSpec } from './ams-grid';
import type { TerminalSpec } from './genie';

export interface AgentSidecarScreen {
    agent: AgentRecordSpec;
    runtime: AgentRuntimeSpec;
    spec: TerminalSpec;
    /** What the target is relative to the screen currently shown. */
    target: 'sidecar' | 'driver';
}

/**
 * The other SCREEN in a driver / `<name>-slave` pair.
 *
 * Pair ownership is resolved by main with `sidecarsOf`; the renderer only joins
 * that fact to the target agent's live runtime and terminal spec. A registered
 * but dormant sidecar has no screen to show, so it deliberately yields null.
 */
export function agentSidecarScreen(input: {
    owner: AgentRecordSpec | null;
    agents: readonly AgentRecordSpec[];
    runtimes: readonly AgentRuntimeSpec[];
    specs: readonly TerminalSpec[];
}): AgentSidecarScreen | null {
    const { owner, agents, runtimes, specs } = input;
    if (!owner) return null;
    const targetAgentId = owner.sidecarAgentId ?? owner.driverAgentId ?? null;
    if (!targetAgentId) return null;
    const agent = agents.find((candidate) => candidate.id === targetAgentId);
    if (!agent) return null;
    const mine = runtimes.filter(
        (runtime) => runtime.agentId === agent.id && !!runtime.terminalSpecId,
    );
    const runtime = mine.find((candidate) => candidate.fronted) ?? mine[0];
    if (!runtime?.terminalSpecId) return null;
    const spec = specs.find((candidate) => candidate.id === runtime.terminalSpecId);
    if (!spec || spec.type !== 'terminal') return null;
    return {
        agent,
        runtime,
        spec,
        target: owner.sidecarAgentId ? 'sidecar' : 'driver',
    };
}
