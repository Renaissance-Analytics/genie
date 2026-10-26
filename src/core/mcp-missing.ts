/**
 * AN AGENT THAT CAME UP WITHOUT A SERVER GENIE GAVE IT (genie#1202).
 *
 * Measured after the owner's restart into beta.44 (Claude Code's own MCP logs): 7 of 9 workspaces' agents connected to
 * Tynn, `tools/list` got a Cloudflare 504 then a 429, and the CLI never asked again — the session ran with Tynn's
 * instructions and NO Tynn tools. prism-acp 0.27.0 reports each server under `particle.academy/mcp_servers`; measured by
 * the prism agent against the real CLIs: Claude says such a server is `connected` with ZERO tools, Codex says `failed`.
 * There is no documented reconnect, so the recovery is a restart of the session on the same conversation (main.ts),
 * spaced and given up on in words.
 */

export const META_MCP_SERVERS = 'particle.academy/mcp_servers';

/** The servers Genie gives every session it starts (its own, and the workspace's Tynn): the only ones it recovers. */
export const GENIE_MANAGED_MCP: readonly string[] = ['genie', 'tynn'];

export interface McpServerReport {
    readonly name: string;
    readonly status: 'connected' | 'pending' | 'failed' | 'needs-auth' | 'disabled';
    /** `null` = unknown (Codex's startup updates carry no tools) — never read as 0. */
    readonly toolCount: number | null;
    readonly error?: string;
}

const STATUSES = new Set(['connected', 'pending', 'failed', 'needs-auth', 'disabled']);

/** The report in a session update's `_meta`; `null` when there is none; `[]` when it is not a shape Genie knows. */
export function mcpReportsFromMeta(meta: Readonly<Record<string, unknown>>): McpServerReport[] | null {
    if (!(META_MCP_SERVERS in meta)) return null;
    const value = meta[META_MCP_SERVERS];
    if (!Array.isArray(value)) return [];
    const out: McpServerReport[] = [];
    for (const item of value) {
        if (typeof item !== 'object' || item === null) return [];
        const r = item as Record<string, unknown>;
        if (typeof r.name !== 'string' || typeof r.status !== 'string' || !STATUSES.has(r.status)) return [];
        if (r.toolCount !== null && typeof r.toolCount !== 'number') return [];
        out.push({ name: r.name, status: r.status as McpServerReport['status'], toolCount: r.toolCount as number | null, ...(typeof r.error === 'string' ? { error: r.error } : {}) });
    }
    return out;
}

/**
 * The servers among `managed` (the ones Genie gives a session) that came up unusable: failed, needing auth, or connected
 * with no tools. `pending` is not yet missing, and a server Genie does not manage is not its business.
 */
export function missingServers(reports: readonly McpServerReport[], managed: readonly string[]): Array<{ name: string; why: string }> {
    const out: Array<{ name: string; why: string }> = [];
    for (const r of reports) {
        if (!managed.includes(r.name)) continue;
        if (r.status === 'failed' || r.status === 'needs-auth') out.push({ name: r.name, why: r.error ? `${r.status}: ${r.error}` : r.status });
        else if (r.status === 'connected' && r.toolCount === 0) out.push({ name: r.name, why: 'connected, but it listed no tools' });
    }
    return out;
}

/** The time between two restarts of one agent for a missing server. */
export const MCP_RECOVERY_SPACING_MS = 10 * 60_000;
/** Restarts per agent before Genie stops and says so. */
export const MCP_RECOVERY_ATTEMPTS = 2;

export type RecoveryDecision =
    | { action: 'restart'; attempt: number }
    | { action: 'wait'; untilMs: number }
    | { action: 'give-up'; attempts: number }
    | { action: 'none' };

/** Per agent: restart, spaced; after `MCP_RECOVERY_ATTEMPTS`, give up ONCE in words; healthy again starts over. */
export class McpRecovery {
    readonly #state = new Map<string, { attempts: number; lastMs: number; gaveUp: boolean }>();

    decide(agentId: string, nowMs: number): RecoveryDecision {
        const s = this.#state.get(agentId);
        if (!s) {
            this.#state.set(agentId, { attempts: 1, lastMs: nowMs, gaveUp: false });
            return { action: 'restart', attempt: 1 };
        }
        if (s.gaveUp) return { action: 'none' };
        if (nowMs < s.lastMs + MCP_RECOVERY_SPACING_MS) return { action: 'wait', untilMs: s.lastMs + MCP_RECOVERY_SPACING_MS };
        if (s.attempts >= MCP_RECOVERY_ATTEMPTS) {
            s.gaveUp = true;
            return { action: 'give-up', attempts: s.attempts };
        }
        s.attempts += 1;
        s.lastMs = nowMs;
        return { action: 'restart', attempt: s.attempts };
    }

    healthy(agentId: string): void {
        this.#state.delete(agentId);
    }
}
