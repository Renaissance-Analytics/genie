import type { AgentRecord } from '../core/identity.js';
import { tynnConfigOf } from './tynn-agent-identities.js';

/**
 * AN AGENT'S SETTINGS FOLLOW IT TO TYNN (Tynn #1001; the owner, 2026-11-21: "agents created and updated in genie need to auto
 * sync with tynn"). Whatever door changed an agent — its settings page, a remote window, an MCP tool — the registry is
 * written, and this looks at every agent after each write: one whose Tynn settings (tynnConfigOf: provider, model, persona
 * path, tool setting, mode, autoApprove, accessScope) changed is sent to its Tynn agent. An agent seen for the first time is
 * only noted: its first start registers it with its settings. A send that failed (signed out, Tynn unreachable) is tried
 * again at the next look. What is not a setting (its thread, when it was used) sends nothing.
 */
export interface AgentTynnSyncPorts {
    agents(): readonly AgentRecord[];
    push(agent: AgentRecord): Promise<'sent' | 'unbound' | 'failed' | 'unlinked'>;
    log?(line: string): void;
}

export function agentTynnSync(ports: AgentTynnSyncPorts) {
    const seen = new Map<string, string>();
    const retry = new Set<string>();
    let running: Promise<void> = Promise.resolve();
    const signature = (agent: AgentRecord) => JSON.stringify(tynnConfigOf(agent));

    const pass = async (): Promise<void> => {
        const now = ports.agents();
        const ids = new Set(now.map((a) => a.id));
        for (const id of [...seen.keys()]) if (!ids.has(id)) { seen.delete(id); retry.delete(id); }
        for (const agent of now) {
            const sig = signature(agent);
            const before = seen.get(agent.id);
            seen.set(agent.id, sig);
            if (before === undefined && !retry.has(agent.id)) continue;
            if (before === sig && !retry.has(agent.id)) continue;
            const result = await ports.push(agent).catch(() => 'failed' as const);
            if (result === 'failed') retry.add(agent.id); else retry.delete(agent.id);
            ports.log?.(`tynn agent settings agent=${agent.id} ${result}`);
        }
    };

    return {
        /** What each agent's settings are now, sending nothing: the starting point. */
        prime(): void { for (const agent of ports.agents()) seen.set(agent.id, signature(agent)); },
        /** Look again (after a registry write, a sign-in): send what changed, and what failed before. One look at a time. */
        changed(): Promise<void> { const work = running.then(pass, pass); running = work.catch(() => {}); return work; },
    };
}
