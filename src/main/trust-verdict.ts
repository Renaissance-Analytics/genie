import type { AgentId } from '../core/identity.js';

/** A workspace's verdict changes while its agent runs. Skeleton: the tests come first. */

export const NOW_TRUSTED = '';
export const UNTRUSTED_AT_TURN_END = '';
export const UNTRUSTED_NOW = '';
export const TRUSTED_AGAIN = '';

export interface TrustVerdictPorts {
    agentsOf(workspaceId: string): readonly AgentId[];
    untrustedNow(agentId: AgentId): boolean;
    launchedUntrusted(agentId: AgentId): boolean | null;
    quiet(agentId: AgentId): boolean;
    runOf(agentId: AgentId): number | null;
    tell(agentId: AgentId, text: string): boolean;
    notice(agentId: AgentId, text: string): void;
    restart(agentId: AgentId): Promise<{ ok: true } | { ok: false; reason: string | null }>;
}

export class TrustVerdicts {
    constructor(_ports: TrustVerdictPorts) {}
    changed(_workspaceId: string): void {}
    check(_agentId: AgentId): void {}
}
