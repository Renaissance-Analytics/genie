import { randomBytes } from 'node:crypto';
import type { McpServer } from '@particle-academy/prism-acp';
import type { AgentId, AgentRecord } from '../core/identity.js';
import type { Caller } from './mcp-tools.js';
import { OS_WORKSPACE } from './registry.js';

/**
 * WHO IS CALLING GENIE'S MCP, for an agent SESSION. A Take Over window passes its terminal's id as `terminalId`; an
 * agent session has no terminal, so Genie configures its session with a key in its own header (`SESSION_HEADER`). Each
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
 * The agent a session key belongs to, as a caller of Genie's tools: its workspace's path, or — for genie, the workstation
 * agent, which belongs to no workspace record — its own home. `null` for a key nobody minted or an agent that is gone.
 * Normal Genie and doctor mode both resolve sessions through this one function: the first version lived in main.ts,
 * required a workspace record, and so answered "Genie does not know this session" to every call genie itself made.
 */
export function sessionCallerOf(book: CallerBook, key: string, look: { find(id: AgentId): AgentRecord | null; workspace(id: string): { path: string } | null }, osaDir: string): Caller | null {
    const id = book.agentFor(key);
    const record = id ? look.find(id as AgentId) : null;
    if (!record) return null;
    const path = record.workspaceId === OS_WORKSPACE ? osaDir : look.workspace(record.workspaceId)?.path ?? null;
    return path === null ? null : { agentId: record.id, agentName: record.name, workspaceId: record.workspaceId, workspacePath: path };
}

/**
 * The header that carries a session's key. NOT `Mcp-Param-terminalId`: that is the header the spec's `x-mcp-header`
 * mirror fills from the model's own `terminalId` argument, and Claude wrote an invented id over Genie's key there
 * (measured 2026-10-13: "terminal genie is not one Genie knows"). No tool declares this one as a mirror, so the model
 * cannot write it. prism-mcp-server hands every `Mcp-Param-*` header to a handler unprefixed and lower-cased (README):
 * the handler reads it as `genie-session`.
 */
export const SESSION_HEADER = 'Mcp-Param-Genie-Session';

/**
 * Genie's server as a session's `mcpServers` entry (prism-acp 0.7.0): HTTP on the loopback, the endpoint's bearer
 * token, and the agent's caller key in `SESSION_HEADER`. No endpoint (the server is not up) = no entry.
 */
export function genieMcpServers(endpoint: { url: string; token: string } | null, callerKey: string): McpServer[] {
    if (!endpoint) return [];
    return [{ type: 'http', name: 'genie', url: endpoint.url, headers: [{ name: 'Authorization', value: `Bearer ${endpoint.token}` }, { name: SESSION_HEADER, value: callerKey }] }];
}

/**
 * Who is calling, for EVERY Genie tool — the one check (five copies had drifted three ways). A session key, when the
 * request carries one, IS the caller and whatever `terminalId` the model sent is ignored; otherwise the `terminalId` a
 * plain terminal passes (prism has already moved a mirrored `Mcp-Param-terminalId` into it). The caller, or the
 * error to answer with.
 */
export function callerFrom<C>(args: Readonly<Record<string, unknown>>, headers: Readonly<Record<string, string>>, resolve: (id: string) => C | null): C | string {
    const session = headers['genie-session'];
    if (typeof session === 'string') {
        return resolve(session) ?? 'Genie does not know this session: it was started by an earlier run of Genie, or its agent is gone. Restart the agent; nothing was done';
    }
    const terminalId = typeof args.terminalId === 'string' ? args.terminalId : headers.terminalid;
    if (!terminalId) return 'Genie could not tell who is calling: a Genie session is known by its session (leave terminalId out); an agent in a plain terminal passes the value of GENIE_TERMINAL_ID';
    return resolve(terminalId) ?? `terminal ${terminalId} is not one Genie knows; nothing was done`;
}
