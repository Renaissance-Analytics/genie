import { randomBytes } from 'node:crypto';
import type { McpServer } from '@particle-academy/prism-acp';

/**
 * WHO IS CALLING GENIE'S MCP, for an agent SESSION. Every Genie tool identifies its caller by the id a client sends
 * as `Mcp-Param-terminalId`; a Take Over window sends its terminal's id, and an agent session has no terminal. Each
 * agent gets its own key here — random, not derived from its id, stable for the run — and the key resolves back to
 * that agent. A key nobody minted resolves to nothing: Genie never guesses who is calling.
 */
export class CallerBook {
    readonly #byAgent = new Map<string, string>();
    readonly #byKey = new Map<string, string>();

    keyFor(agentId: string): string {
        const known = this.#byAgent.get(agentId);
        if (known) return known;
        const key = `session-${randomBytes(16).toString('hex')}`;
        this.#byAgent.set(agentId, key);
        this.#byKey.set(key, agentId);
        return key;
    }

    agentFor(key: string): string | null {
        return this.#byKey.get(key) ?? null;
    }
}

/**
 * Genie's server as a session's `mcpServers` entry (prism-acp 0.7.0): HTTP on the loopback, the endpoint's bearer
 * token, and the agent's caller key in the header the tools read. No endpoint (the server is not up) = no entry.
 */
export function genieMcpServers(endpoint: { url: string; token: string } | null, callerKey: string): McpServer[] {
    if (!endpoint) return [];
    return [{ type: 'http', name: 'genie', url: endpoint.url, headers: [{ name: 'Authorization', value: `Bearer ${endpoint.token}` }, { name: 'Mcp-Param-terminalId', value: callerKey }] }];
}
