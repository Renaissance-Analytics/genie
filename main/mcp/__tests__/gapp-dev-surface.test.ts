import { describe, expect, it, vi } from 'vitest';
import { formatWorkspaceMap, handleMcpMessage, type McpContext, type WorkspaceMap } from '../protocol';
import type { GappDevStatus } from '../../workspace/gapp-dev-status';

/**
 * CAN AN AGENT TELL IT IS IN A GApp DEVELOPMENT WORKSPACE? (genie#245 follow-on)
 *
 * GDW detection shipped with the column, the convergence rules, the chrome and
 * two buttons in Workspace Settings — and `git grep gapp_dev -- main/mcp` came
 * back empty. An agent working inside a real GDW searched the tool registry,
 * read the whole guide and opened `project.json`, and found no trace of any of
 * it. Every unit test passed the entire time, because they all tested the half
 * that worked.
 *
 * That is the same shape as the four memory classes, which sat unreachable for
 * six days because `class` never reached the MCP layer while 4440 tests were
 * green. So these tests deliberately assert the AGENT-VISIBLE surface — what
 * `tools/list` advertises, what a `tools/call` returns, what orientation says —
 * rather than the state behind it. A flag in the database that no agent can
 * reach is not a feature.
 */

const GDW: GappDevStatus = {
    isGdw: true,
    root: 'C:/work/weather',
    workspaceName: 'Weather',
    tynnProjectId: '01JX',
    app: { name: 'Weather', slug: 'weather', version: '1.2.0' },
    previews: [],
    previewAvailable: true,
};

const PLAIN: GappDevStatus = {
    isGdw: false,
    root: 'C:/work/other',
    workspaceName: 'Other',
    tynnProjectId: '01JY',
    app: null,
    previews: [],
    previewAvailable: true,
};

function ctx(overrides: Partial<McpContext> = {}): McpContext {
    return {
        terminalId: 'term-1',
        serverName: 'genie',
        serverVersion: '0.7.0-test',
        onImDone: vi.fn().mockReturnValue({ attention: 1 }),
        checkIssues: vi.fn(),
        onForceQuestion: vi.fn(),
        describeWorkspace: vi.fn().mockResolvedValue(null),
        manageProcess: vi.fn(),
        manageSite: vi.fn(),
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
        manageGappDev: vi.fn().mockResolvedValue({ ok: true, action: 'status', status: GDW }),
        ...overrides,
    } as unknown as McpContext;
}

async function toolNames(context: McpContext): Promise<string[]> {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, context);
    return (res?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
}

async function callText(
    context: McpContext,
    args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
    const res = await handleMcpMessage(
        {
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'manageGappDev', arguments: args },
        },
        context,
    );
    const result = res?.result as
        | { content: Array<{ type: string; text: string }>; isError?: boolean }
        | undefined;
    if (!result) throw new Error(`no result: ${JSON.stringify(res)}`);
    return { text: result.content[0]!.text, isError: result.isError };
}

describe('the GDW tool is on the agent surface at all', () => {
    it('advertises manageGappDev in tools/list', async () => {
        expect(await toolNames(ctx())).toContain('manageGappDev');
    });

    it('says in its DESCRIPTION what a GDW is — agents pick tools by description', async () => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            ctx(),
        );
        const tools = (res?.result as { tools: Array<{ name: string; description: string }> }).tools;
        const tool = tools.find((t) => t.name === 'manageGappDev');
        if (!tool) throw new Error('manageGappDev not advertised');

        expect(tool.description).toMatch(/GApp Development Workspace|GDW/);
        expect(tool.description).toMatch(/preview/i);
        expect(tool.description).toMatch(/check/i);
    });

    it('rejects a missing action by NAMING the actions, not with a bare schema error', async () => {
        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'manageGappDev', arguments: {} },
            },
            ctx(),
        );
        expect(res?.error?.code).toBe(-32602);
        expect(res?.error?.message).toContain('status');
        expect(res?.error?.message).toContain('check');
        expect(res?.error?.message).toContain('preview');
    });
});

describe('what a `status` call actually tells the agent', () => {
    it('answers that this IS a GDW, with the folder and the app', async () => {
        const { text } = await callText(ctx(), { action: 'status' });

        expect(text).toMatch(/GApp Development Workspace/);
        expect(text).toContain('C:/work/weather');
        expect(text).toContain('Weather');
    });

    it('answers plainly when it is NOT one, and says who sets the flag', async () => {
        const context = ctx({
            manageGappDev: vi
                .fn()
                .mockResolvedValue({ ok: true, action: 'status', status: PLAIN }),
        } as Partial<McpContext>);

        const { text } = await callText(context, { action: 'status' });

        expect(text).toMatch(/not a GApp Development Workspace/i);
        expect(text).toMatch(/is_gapp/);
    });

    it('re-states WHERE the agent is on every action, not only on `status`', async () => {
        // An agent that ran `check` and got only findings back still does not know
        // it is in a GDW. Every answer carries the status for that reason.
        const context = ctx({
            manageGappDev: vi.fn().mockResolvedValue({
                ok: true,
                action: 'check',
                status: GDW,
                check: { ok: true, ran: ['manifest', 'files'], findings: [] },
            }),
        } as Partial<McpContext>);

        const { text } = await callText(context, { action: 'check' });

        expect(text).toMatch(/GApp Development Workspace/);
        expect(text).toContain('2 checks ran');
    });

    it('surfaces check FINDINGS with their fix, not just a pass/fail', async () => {
        const context = ctx({
            manageGappDev: vi.fn().mockResolvedValue({
                ok: true,
                action: 'check',
                status: GDW,
                check: {
                    ok: false,
                    ran: ['manifest'],
                    findings: [
                        {
                            check: 'manifest.slug',
                            severity: 'error',
                            where: 'gapp.json',
                            problem: 'The slug is missing.',
                            fix: 'Add a `slug`.',
                        },
                    ],
                },
            }),
        } as Partial<McpContext>);

        const { text } = await callText(context, { action: 'check' });

        expect(text).toContain('The slug is missing.');
        expect(text).toContain('Add a `slug`.');
        expect(text).toContain('gapp.json');
    });

    it('reports where a preview opened, so the agent can drive it', async () => {
        const context = ctx({
            manageGappDev: vi.fn().mockResolvedValue({
                ok: true,
                action: 'preview',
                status: GDW,
                preview: { appId: 'weather.preview', homeUrl: 'https://weather.preview.gen/' },
            }),
        } as Partial<McpContext>);

        const { text } = await callText(context, { action: 'preview' });

        expect(text).toContain('https://weather.preview.gen/');
    });

    it('reports a REFUSAL as an error the agent can read, not as a silent ok', async () => {
        const context = ctx({
            manageGappDev: vi.fn().mockResolvedValue({
                ok: false,
                action: 'preview',
                status: PLAIN,
                error: 'This workspace is not a GApp Development Workspace, so there is no app here to preview.',
            }),
        } as Partial<McpContext>);

        const { text, isError } = await callText(context, { action: 'preview' });

        expect(isError).toBe(true);
        expect(text).toContain('not a GApp Development Workspace');
    });

    it('says the tool is unavailable rather than throwing when nothing is wired', async () => {
        const context = ctx({ manageGappDev: undefined } as Partial<McpContext>);

        const { text, isError } = await callText(context, { action: 'status' });

        expect(isError).toBe(true);
        expect(text).toMatch(/not available/i);
    });
});

describe('orientation tells a fresh agent it landed in a GDW', () => {
    const base: WorkspaceMap = {
        root: 'C:/work/weather',
        isAgiEnvelope: true,
        hasProjectJson: true,
        hasGitmodules: true,
        knowledgeDir: null,
        envelopeAgents: 'C:/work/weather/AGENTS.md',
        envelopeClaude: null,
        repos: [
            {
                name: 'weather',
                path: 'C:/work/weather/repos/weather',
                owner: 'acme',
                repo: 'weather',
                orientation: { readme: true, agents: false, claude: false, manifests: [] },
            },
        ],
    };

    it('announces the GDW in the map an agent reads FIRST', () => {
        const text = formatWorkspaceMap({ ...base, gappDev: GDW });

        expect(text).toMatch(/GApp Development Workspace/);
        expect(text).toContain('manageGappDev');
    });

    it('leaves an ordinary workspace alone — POSITIVE CONTROL', () => {
        const text = formatWorkspaceMap({ ...base, gappDev: PLAIN });

        // The negative: no GDW claim on a workspace that is not one.
        expect(text).not.toMatch(/GApp Development Workspace/);
        // The control: the SAME call still produced a real orientation, so the
        // assertion above is not passing on an empty or thrown-away render.
        expect(text).toContain('C:/work/weather/repos/weather');
        expect(text).toContain('How to learn this workspace');
    });

    it('says nothing at all when the map carries no GDW answer', () => {
        // An older host, or a workspace whose link could not be resolved. Silence
        // is right; inventing "not a GDW" would be reporting an answer nobody has.
        const text = formatWorkspaceMap(base);

        expect(text).not.toMatch(/GApp Development Workspace/);
        expect(text).toContain('How to learn this workspace');
    });
});
