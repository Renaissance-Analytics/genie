import { describe, expect, it, vi } from 'vitest';
import { handleMcpMessage, manageSiteSummary, type McpContext } from '../protocol';
import type { ManageSiteRequest, ManageSiteResult } from '../protocol';

/**
 * The `manageSite` MCP surface (Tynn #234, P2 item 5) — the agent-first
 * administration path for the container Dev Server.
 *
 * Tested at the PURE protocol layer with a stub context: no container runtime,
 * no database, no daemon. What that layer owns is exactly three things, and all
 * three have already been the source of a real bug in a neighbouring tool:
 *
 *   1. **The gate.** A tool an agent cannot possibly succeed with is worse than
 *      an absent one — every call fails with the same install hint and looks
 *      like the agent's mistake. So `manageSite` is listed only where a
 *      container runtime is usable, and the gate FAILS CLOSED.
 *   2. **Argument validation.** A bad `action` must come back as a JSON-RPC
 *      error, not as a call into the host with `undefined`.
 *   3. **The headline.** `manageSiteSummary` is what an agent reads first, and
 *      the one distinction it has to carry is running ≠ ready.
 */

function ctx(over: Partial<McpContext> = {}): McpContext {
    return {
        terminalId: 'term-1',
        serverName: 'genie',
        serverVersion: '0.7.0',
        onImDone: vi.fn(),
        checkIssues: vi.fn().mockResolvedValue({
            connected: true,
            workspaceResolved: true,
            counts: { issue: 0, pr: 0, security: 0 },
            items: [],
        }),
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
        openFileForUser: vi.fn().mockResolvedValue({ ok: true }),
        setEnv: vi.fn().mockReturnValue({ ok: true, file: '.env' }),
        checkEnv: vi.fn().mockReturnValue({ ok: true, exists: false, file: '.env' }),
        isOpsProject: vi.fn().mockResolvedValue(false),
        ...over,
    };
}

const listTools = async (over: Partial<McpContext> = {}): Promise<string[]> => {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx(over));
    return ((res?.result as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
};

const call = (args: Partial<ManageSiteRequest>, over: Partial<McpContext> = {}) =>
    handleMcpMessage(
        {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'manageSite', arguments: args },
        },
        ctx(over),
    );

// --- the gate ---------------------------------------------------------------

describe('tools/list gating', () => {
    it('lists manageSite where a container runtime is usable', async () => {
        expect(await listTools({ devServerAvailable: async () => true })).toContain('manageSite');
    });

    it('OMITS it where none is', async () => {
        expect(await listTools({ devServerAvailable: async () => false })).not.toContain(
            'manageSite',
        );
    });

    it('omits it when the probe THROWS — fail closed', async () => {
        const tools = await listTools({
            devServerAvailable: async () => {
                throw new Error('docker socket exploded');
            },
        });
        expect(tools).not.toContain('manageSite');
        // And the rest of the surface is untouched: a broken probe must never
        // be able to remove a core tool.
        expect(tools).toContain('manageProcess');
        expect(tools).toContain('manageTerminals');
    });

    it('omits it when the seam is not wired at all', async () => {
        expect(await listTools()).not.toContain('manageSite');
    });
});

// --- dispatch ---------------------------------------------------------------

describe('tools/call dispatch', () => {
    it('rejects a missing or unknown action as a JSON-RPC error', async () => {
        const manageSite = vi.fn();
        expect((await call({}, { manageSite })) as { error?: unknown }).toHaveProperty('error');
        expect(
            (await call({ action: 'nuke' as never }, { manageSite })) as { error?: unknown },
        ).toHaveProperty('error');
        // Never reached the host with junk.
        expect(manageSite).not.toHaveBeenCalled();
    });

    it('passes every field through verbatim', async () => {
        const manageSite = vi.fn().mockResolvedValue({ ok: true, sites: [] });
        await call(
            {
                action: 'create',
                name: 'web',
                repo: 'app',
                runMode: 'explicit',
                build: [{ label: 'Build', command: ['npm', 'run', 'build'] }],
                serve: ['node', 'server.js'],
                port: 5173,
                kind: 'http',
                exposed: [
                    { name: 'live', port: 6001, protocol: 'ws', reason: 'the client subscribes' },
                ],
                upstreamHost: 'localhost',
                env: { NODE_ENV: 'production' },
                enabled: false,
            },
            { manageSite },
        );
        expect(manageSite).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({
                action: 'create',
                name: 'web',
                repo: 'app',
                build: [{ label: 'Build', command: ['npm', 'run', 'build'] }],
                serve: ['node', 'server.js'],
                port: 5173,
                exposed: [
                    { name: 'live', port: 6001, protocol: 'ws', reason: 'the client subscribes' },
                ],
                upstreamHost: 'localhost',
                env: { NODE_ENV: 'production' },
                enabled: false,
            }),
        );
    });

    it('returns the headline followed by the full JSON result', async () => {
        const result: ManageSiteResult = {
            ok: true,
            sites: [
                {
                    id: 'abc',
                    name: 'web',
                    genName: 'web.acme.gen',
                    repo: 'app',
                    runMode: 'detected',
                    kind: 'http',
                    enabled: true,
                    state: 'running',
                    ready: true,
                    port: 5173,
                    hostPort: 49_812,
                    origin: 'https://web.acme.gen',
                    localOrigin: 'http://127.0.0.1:49812',
                },
            ],
            affectedId: 'abc',
        };
        const res = await call({ action: 'start', id: 'abc' }, { manageSite: async () => result });
        const text = (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
        expect(text.split('\n')[0]).toContain('https://web.acme.gen');
        // The whole result is there too, so an agent never has to parse prose.
        expect(JSON.parse(text.slice(text.indexOf('{')))).toEqual(result);
    });
});

// --- the headline -----------------------------------------------------------

describe('manageSiteSummary', () => {
    const site = (over: Partial<ManageSiteResult['sites'][number]> = {}) => ({
        id: 'abc',
        name: 'web',
        genName: 'web.acme.gen',
        repo: '',
        runMode: 'detected',
        kind: 'http' as const,
        enabled: true,
        state: 'running',
        ...over,
    });

    it('reports where a READY site is serving', () => {
        const text = manageSiteSummary({
            ok: true,
            affectedId: 'abc',
            sites: [site({ ready: true, origin: 'https://web.acme.gen' })],
        });
        expect(text).toContain('https://web.acme.gen');
    });

    it('does NOT hand back an origin for a site that is up but not listening', () => {
        // THE distinction. A container being `running` is not a dev server
        // having bound its port, and an agent that reports the first as the
        // second sends a user to a dead socket.
        const text = manageSiteSummary({
            ok: true,
            affectedId: 'abc',
            sites: [site({ ready: false, port: 5173, origin: 'https://web.acme.gen' })],
        });
        expect(text).not.toContain('https://web.acme.gen');
        expect(text).toMatch(/nothing is listening/i);
        expect(text).toMatch(/logs/);
    });

    it('leads with the reason a site failed', () => {
        const text = manageSiteSummary({
            ok: true,
            affectedId: 'abc',
            sites: [site({ state: 'failed', error: 'no such image' })],
        });
        expect(text).toContain('no such image');
    });

    it('carries the install hint when there is no container runtime', () => {
        const text = manageSiteSummary({
            ok: false,
            error: 'No container runtime is available.',
            sites: [],
            runtime: { kind: 'none', installHint: 'Install Docker Desktop from …' },
        });
        expect(text).toContain('Install Docker Desktop');
    });

    it('counts the workspace when no single site was targeted', () => {
        expect(
            manageSiteSummary({
                ok: true,
                sites: [site({ state: 'running' }), site({ id: 'b', state: 'stopped' })],
            }),
        ).toBe('2 sites in this workspace, 1 running.');
    });
});
