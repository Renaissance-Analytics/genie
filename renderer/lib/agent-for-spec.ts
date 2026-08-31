import type { AgentRecordSpec, AgentRuntimeSpec } from './ams-grid';

/**
 * The agent a terminal panel belongs to, via its RUNTIME.
 *
 * A terminal belongs to an agent through `runtime.terminalSpecId` and through
 * nothing else. Not `meta.agent` — that names the TUI, and an agent outliving
 * its TUI is the entire model — and not the label, which two agents may share.
 *
 * PURE, so the orphan and ghost cases are testable without a window.
 */
export function agentForSpec({
    agents,
    runtimes,
    specId,
}: {
    agents: AgentRecordSpec[];
    runtimes: AgentRuntimeSpec[];
    specId: string;
}): AgentRecordSpec | null {
    // A dormant runtime carries `terminalSpecId: null`. Without this guard an
    // empty specId would match it and hand every panel the first dormant agent.
    if (!specId) return null;
    const owner = runtimes.find((r) => r.terminalSpecId === specId);
    if (!owner) return null;
    return agents.find((a) => a.id === owner.agentId) ?? null;
}
