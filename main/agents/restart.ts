import { resolveWorkstationProvider } from './provider';
import type { AgentProvider } from './identity';

export function restartProviderForSpec(
    meta: { agent?: AgentProvider; system?: boolean },
    settings: { agent_default?: string },
): AgentProvider | null {
    if (meta.system === true) return resolveWorkstationProvider(settings);
    return meta.agent ?? null;
}
