import { GENIE_MANAGED_MCP, MCP_RECOVERY_ATTEMPTS, McpRecovery, missingServers, type McpServerReport } from '../core/mcp-missing.js';

/**
 * A SERVER GENIE GAVE THE AGENT CAME UP UNUSABLE (genie#1202), recovered by GENIE-HOST (client/host split step 2b-3,
 * Tynn #896). Tynn's tools/list timed out at a restart and the CLI never asked again; no documented reconnect exists, so
 * the session restarts on the same conversation, spaced, and is given up on in words after MCP_RECOVERY_ATTEMPTS, so a
 * server that is really down never makes it loop.
 *
 * The host hears every session's report itself (its own SessionHost), so this runs with no window connected. It used to
 * run only in a window's process, and with every window closed nothing recovered. Each report also adds the servers it
 * named to the agent's record, so its Settings can list them while it is not running (Tynn #628).
 */
export interface HostMcpRecoveryPorts {
    /** A line in the agent's chat. */
    readonly notice: (agentId: string, text: string) => void;
    /** The graceful restart: stop, the old run ended, the same conversation started again. */
    readonly restart: (agentId: string) => Promise<unknown>;
    readonly noteSeen: (agentId: string, names: readonly string[]) => void;
    readonly now: () => number;
    /** Runs `run` after `ms`; returns its cancel. */
    readonly later: (run: () => void, ms: number) => () => void;
}

export interface HostMcpRecovery {
    heard(agentId: string, reports: readonly McpServerReport[]): void;
    dispose(): void;
}

export function hostMcpRecovery(ports: HostMcpRecoveryPorts): HostMcpRecovery {
    const recovery = new McpRecovery();
    const recheck = new Map<string, () => void>();
    /** The latest report per agent: a spaced recheck acts on what is true THEN, never on the report that scheduled it. */
    const latest = new Map<string, readonly McpServerReport[]>();
    const recover = (agentId: string, reports: readonly McpServerReport[]): void => {
        latest.set(agentId, reports);
        const missing = missingServers(reports, GENIE_MANAGED_MCP);
        if (missing.length === 0) {
            recovery.healthy(agentId);
            recheck.get(agentId)?.();
            recheck.delete(agentId);
            return;
        }
        const said = missing.map((m) => `${m.name} (${m.why})`).join(', ');
        const decision = recovery.decide(agentId, ports.now());
        if (decision.action === 'restart') {
            ports.notice(agentId, `This session came up without ${said}. Genie is restarting it on the same conversation to reconnect (attempt ${decision.attempt} of ${MCP_RECOVERY_ATTEMPTS}).`);
            void ports.restart(agentId).catch(() => undefined);
        } else if (decision.action === 'wait') {
            if (!recheck.has(agentId)) {
                recheck.set(agentId, ports.later(() => { recheck.delete(agentId); recover(agentId, latest.get(agentId) ?? []); }, Math.max(0, decision.untilMs - ports.now())));
            }
        } else if (decision.action === 'give-up') {
            ports.notice(agentId, `Still without ${said} after ${decision.attempts} restarts. Genie has stopped retrying; restart this agent once the server answers.`);
        }
    };
    return {
        heard: (agentId, reports) => {
            recover(agentId, reports);
            ports.noteSeen(agentId, reports.map((r) => r.name));
        },
        dispose: () => { for (const cancel of recheck.values()) cancel(); recheck.clear(); },
    };
}

/** The session host's `onMcpServers`: the engine's own (a linked window still hears it), then the host's recovery. */
export function withMcpRecovery(pass: (agentId: string, reports: readonly McpServerReport[]) => void, recovery: HostMcpRecovery): (agentId: string, reports: readonly McpServerReport[]) => void {
    return (agentId, reports) => {
        pass(agentId, reports);
        recovery.heard(agentId, reports);
    };
}
