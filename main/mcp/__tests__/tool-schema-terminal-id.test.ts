import { describe, expect, it, vi } from 'vitest';
import { handleMcpMessage, type McpContext } from '../protocol';

/**
 * Every advertised tool must DECLARE the `terminalId` it can be required to accept.
 *
 * Terminal resolution is not per-tool — `server.ts` reads `arguments.terminalId`
 * on EVERY `tools/call` and, when the workspace has more than one terminal,
 * refuses the call outright with "pass `terminalId`". Meanwhile each tool
 * publishes `additionalProperties: false`.
 *
 * So a tool that omits the property advertises a contract the server contradicts:
 * it demands an argument its own schema forbids. A lenient client forwards the
 * extra argument anyway and never notices; a client that validates against the
 * advertised schema — or strips undeclared arguments — can NEVER satisfy the
 * server, and the tool is permanently unusable in any multi-terminal workspace.
 * That is not a documentation nit: it silently removes AgentInbox (and the guide,
 * and terminal/workspace management) from strict agents, which then look like
 * they are simply ignoring their inbox.
 *
 * Eight tools spread the shared TERMINAL_ID_PROP; six were missed. Pinning the
 * rule to the ADVERTISED schema means the next tool added cannot forget it.
 */

/** Read the REAL advertised tool list, exactly as a client receives it. */
async function advertisedTools(): Promise<
    Array<{
        name: string;
        inputSchema?: {
            properties?: Record<string, unknown>;
            additionalProperties?: boolean;
        };
    }>
> {
    const ctx = {
        terminalId: 'term-1',
        serverName: 'genie',
        serverVersion: '0.0.0-test',
        onImDone: vi.fn(),
        checkIssues: vi.fn(),
        onForceQuestion: vi.fn(),
        describeWorkspace: vi.fn(),
        manageProcess: vi.fn(),
        provisionWorkspaces: vi.fn(),
        manageTerminals: vi.fn(),
        runAgent: vi.fn(),
        manageWorkspaces: vi.fn(),
        agentInbox: vi.fn(),
        knowledge: vi.fn(),
        openFileForUser: vi.fn(),
        setEnv: vi.fn(),
        checkEnv: vi.fn(),
        isOpsProject: vi.fn().mockResolvedValue(false),
    } as unknown as McpContext;

    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx);
    return (res?.result as { tools: ReturnType<typeof Array> }).tools as never;
}

describe('advertised tool schemas admit the terminalId the server requires', () => {
    it('advertises a non-empty tool list', async () => {
        expect((await advertisedTools()).length).toBeGreaterThan(0);
    });

    it('declares terminalId on every tool that is strict about its arguments', async () => {
        const offenders: string[] = [];
        for (const tool of await advertisedTools()) {
            const schema = tool.inputSchema;
            if (!schema || schema.additionalProperties !== false) continue;
            if (!schema.properties?.terminalId) offenders.push(tool.name);
        }
        expect(
            offenders,
            `these tools forbid extra arguments yet the server can demand \`terminalId\`, ` +
                `so a schema-validating client can never call them in a multi-terminal ` +
                `workspace: ${offenders.join(', ')}`,
        ).toEqual([]);
    });

    it('types terminalId as a string and points at GENIE_TERMINAL_ID', async () => {
        // The description is the only place an agent learns WHERE to get the value.
        // A declared-but-unexplained property just moves the dead end.
        for (const tool of await advertisedTools()) {
            const prop = tool.inputSchema?.properties?.terminalId as
                | { type?: string; description?: string }
                | undefined;
            if (!prop) continue;
            expect(prop.type, `${tool.name}.terminalId must be a string`).toBe('string');
            expect(
                prop.description ?? '',
                `${tool.name}.terminalId must name the env var that supplies it`,
            ).toContain('GENIE_TERMINAL_ID');
        }
    });
});
