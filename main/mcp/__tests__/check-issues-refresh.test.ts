import { describe, expect, it, vi } from 'vitest';
import {
    formatIssueWatchFeed,
    handleMcpMessage,
    type IssueWatchSnapshot,
    type McpContext,
} from '../protocol';

/**
 * `checkIssues(refresh: true)` — the agent-facing half of forcing an IssueWatch
 * refresh.
 *
 * It is an OPTION on the existing tool rather than a second tool, deliberately.
 * Agents already call `checkIssues`; folding refresh into it means the refreshed
 * data comes back in the same round trip, and — the part that matters — there is
 * no way to obtain fresh counts without also being told when the next refresh is
 * allowed. A separate `refreshIssues` tool would let an agent refresh, read the
 * counts from somewhere else, and never learn the cooldown at all.
 */

function snapshot(over: Partial<IssueWatchSnapshot> = {}): IssueWatchSnapshot {
    return {
        connected: true,
        workspaceResolved: true,
        counts: { issue: 1, pr: 0, security: 0, feedback: 0 },
        items: [
            {
                kind: 'issue',
                owner: 'octo-org',
                repo: 'widgets',
                number: 7,
                title: 'Broken',
                url: 'https://github.com/octo-org/widgets/issues/7',
                unread: false,
            },
        ],
        ...over,
    };
}

function ctx(overrides: Partial<McpContext> = {}): McpContext {
    return {
        terminalId: 'term-1',
        serverName: 'genie',
        serverVersion: '0.7.0',
        onImDone: vi.fn(),
        checkIssues: vi.fn().mockResolvedValue(snapshot()),
        onForceQuestion: vi.fn().mockResolvedValue({ cancelled: true, answers: [] }),
        describeWorkspace: vi.fn().mockResolvedValue(null),
        manageProcess: vi.fn().mockResolvedValue({ ok: true, processes: [] }),
        manageSite: vi.fn().mockResolvedValue({ ok: true, sites: [] }),
        provisionWorkspaces: vi.fn().mockResolvedValue({ ok: true, isOps: true, children: [] }),
        manageTerminals: vi.fn().mockResolvedValue({ ok: true, terminals: [] }),
        runAgent: vi.fn().mockResolvedValue({ ok: true }),
        manageWorkspaces: vi.fn().mockResolvedValue({ ok: true, workspaces: [] }),
        agentInbox: vi.fn().mockResolvedValue({ ok: true }),
        knowledge: vi.fn().mockResolvedValue({ ok: true }),
        openFileForUser: vi.fn().mockResolvedValue({ ok: true, reused: false, openedNew: true }),
        setEnv: vi.fn().mockReturnValue({ ok: true, file: '.env' }),
        checkEnv: vi.fn().mockReturnValue({ ok: true, exists: false, file: '.env' }),
        isOpsProject: vi.fn().mockResolvedValue(false),
        ...overrides,
    };
}

async function call(args: Record<string, unknown>, c: McpContext) {
    return (await handleMcpMessage(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'checkIssues', arguments: args } },
        c,
    )) as { result: { content: Array<{ text: string }> } };
}

describe('checkIssues refresh option', () => {
    it('advertises refresh ON checkIssues, and adds no second issue tool', async () => {
        const res = (await handleMcpMessage(
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            ctx(),
        )) as { result: { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }> } };

        const tools = res.result.tools;
        const checkIssues = tools.find((t) => t.name === 'checkIssues');

        expect(checkIssues).toBeDefined();
        expect(checkIssues!.inputSchema.properties).toHaveProperty('refresh');
        // The refusal is part of the contract, so the description has to prepare
        // the agent for it — otherwise a refused refresh reads as a broken tool.
        expect(checkIssues!.description.toLowerCase()).toContain('refresh');
        expect(tools.filter((t) => /refresh/i.test(t.name))).toHaveLength(0);
    });

    it('forwards the requested refresh to the host, and asks for none by default', async () => {
        const asked = ctx();
        await call({ refresh: true }, asked);
        expect(asked.checkIssues).toHaveBeenCalledWith('term-1', { refresh: true });

        const plain = ctx();
        await call({}, plain);
        expect(plain.checkIssues).toHaveBeenCalledWith('term-1', { refresh: false });
    });

    it('says the refresh happened AND when the next one is allowed', async () => {
        const c = ctx({
            checkIssues: vi.fn().mockResolvedValue(
                snapshot({
                    refresh: {
                        refreshed: true,
                        reason: 'refreshed',
                        cooldown: { seconds: 300, nextAllowedAt: '2026-08-24T10:05:00+00:00', label: '5m' },
                    },
                }),
            ),
        });

        const text = (await call({ refresh: true }, c)).result.content[0].text;

        expect(text).toContain('Refreshed');
        expect(text).toContain('5m');
        // The window belongs to the WORKSPACE, so the agent has to know its
        // refresh spent everyone's — otherwise "why was I refused" reads as a bug.
        expect(text.toLowerCase()).toContain('workspace');
        // The feed still comes back in the same answer.
        expect(text).toContain('octo-org/widgets');
    });

    it('reports a REFUSED refresh as a normal answer carrying the remaining time', async () => {
        const c = ctx({
            checkIssues: vi.fn().mockResolvedValue(
                snapshot({
                    refresh: {
                        refreshed: false,
                        reason: 'cooldown',
                        cooldown: { seconds: 192, nextAllowedAt: '2026-08-24T10:03:12+00:00', label: '3m 12s' },
                    },
                }),
            ),
        });

        const res = (await handleMcpMessage(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'checkIssues', arguments: { refresh: true } } },
            c,
        )) as { result: { content: Array<{ text: string }>; isError?: boolean } };
        const text = res.result.content[0].text;

        // A refused refresh is an ordinary successful result — an agent that asked
        // twice in a minute has done nothing wrong.
        expect(res.result.isError).toBeUndefined();
        expect(text).toContain('3m 12s');
        expect(text.toLowerCase()).toContain('not refreshed');
        // ...and the snapshot below it is real, so the call was still worth making.
        expect(text).toContain('octo-org/widgets');
    });

    it('says a FAILED refresh failed, and that the feed shown is the older one', async () => {
        const c = ctx({
            checkIssues: vi.fn().mockResolvedValue(
                snapshot({
                    refresh: {
                        refreshed: false,
                        reason: 'failed',
                        error: 'Tynn POST /api/v1/user/issue-watch/refresh → 503',
                        cooldown: { seconds: 0, nextAllowedAt: null, label: 'now' },
                    },
                }),
            ),
        });

        const text = (await call({ refresh: true }, c)).result.content[0].text;

        expect(text.toLowerCase()).toContain('failed');
        expect(text).toContain('503');
        // A failed attempt cost nothing, so retrying is allowed immediately —
        // and the agent should be told so rather than assuming a 5-minute wait.
        expect(text.toLowerCase()).toContain('again now');
    });

    it('prints no refresh line when none was requested', async () => {
        const text = formatIssueWatchFeed(snapshot());

        expect(text).not.toContain('Refreshed');
        expect(text).not.toContain('next manual refresh');
        // Positive control: the formatter really did produce the feed, so the
        // absences above are absences and not an empty string.
        expect(text).toContain('octo-org/widgets');
    });
});
