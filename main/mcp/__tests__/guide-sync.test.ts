import { describe, expect, it, vi } from 'vitest';
import { GENIE_MCP_GUIDE } from '../guide';
import { handleMcpMessage, type McpContext } from '../protocol';

/**
 * The agent-facing GUIDE must not drift from what the tools actually do.
 *
 * `GENIE_MCP_GUIDE` is served by `genieGuide` + the initialize instructions, and
 * its brief is written into every workspace's AGENTS.md/CLAUDE.md — so for most
 * agents it IS the documentation. When it drifts it doesn't just go vague, it
 * actively misinstructs: it told agents delivery was poll-only after server-push
 * shipped, omitted the `hidden` scope, and described `none` as "hidden" when
 * `none` had become listed-but-unreachable. Every unit test passed throughout.
 *
 * These pin the guide to the SCHEMA, so adding a scope (or changing what one
 * means) fails here instead of silently shipping instructions that lie.
 */

/** Read the REAL advertised agentinbox schema via tools/list. */
async function agentInboxScopeEnum(): Promise<string[]> {
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
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema?: unknown }> }).tools;
    const tool = tools.find((t) => t.name === 'agentinbox');
    if (!tool) throw new Error('agentinbox tool not advertised');
    const props = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> })
        .properties;
    return props?.scope?.enum ?? [];
}

describe('the agent guide stays in sync with the agentinbox schema', () => {
    it('documents every accessibility scope the tool accepts', async () => {
        const scopeEnum = await agentInboxScopeEnum();
        expect(scopeEnum.length).toBeGreaterThan(0);
        for (const scope of scopeEnum) {
            expect(
                GENIE_MCP_GUIDE,
                `the guide never mentions the \`${scope}\` scope — an agent cannot use what it is not told about`,
            ).toContain(`\`${scope}\``);
        }
    });

    it('does not claim delivery is poll-only', () => {
        // The old text ("Delivery is PULL-based — you POLL for messages") predates
        // both wake-on-DM and server-push, and taught agents to busy-loop.
        expect(GENIE_MCP_GUIDE).not.toMatch(/you POLL for messages/i);
        expect(GENIE_MCP_GUIDE).not.toMatch(/nothing is ever injected/i);
    });

    it('tells agents to block ONCE rather than loop', () => {
        // The whole point of the 240s long-poll: one blocking call, not a loop.
        expect(GENIE_MCP_GUIDE).toMatch(/ONE blocking/i);
    });

    it('explains the two access tiers, so an unreachable peer is diagnosable', () => {
        // A peer can be visible-but-unreachable via EITHER the workspace tier or
        // the agent's own scope; an agent that isn't told this cannot act on it.
        expect(GENIE_MCP_GUIDE).toMatch(/reachable/i);
        expect(GENIE_MCP_GUIDE).toMatch(/WORKSPACE/);
    });
});
