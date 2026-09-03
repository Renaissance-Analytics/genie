import { resolveWorkstationTui } from './tui';
import type { AgentTui } from './identity';

/**
 * Which TUI a restart relaunches.
 *
 * The workstation operator follows the WORKSTATION's configured TUI rather than
 * whatever it happened to be launched with, so switching the workstation default
 * actually moves it. That is a fact about its ROLE, so it keys on its identity
 * (`agent_id`) — not, as it used to, on `meta.system`, which is a statement about
 * where a spec lives and is worn by System-Workspace panels and global processes
 * that have nothing to do with the operator.
 */
export function restartProviderForSpec(
    meta: { agent?: AgentTui; agent_id?: string },
    settings: { agent_default?: string },
): AgentTui | null {
    if (meta.agent_id === 'genie:workstation') return resolveWorkstationTui(settings);
    return meta.agent ?? null;
}
