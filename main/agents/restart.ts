import { resolveWorkstationTui } from './tui';
import type { AgentTui } from './identity';

export function restartProviderForSpec(
    meta: { agent?: AgentTui; system?: boolean },
    settings: { agent_default?: string },
): AgentTui | null {
    if (meta.system === true) return resolveWorkstationTui(settings);
    return meta.agent ?? null;
}
