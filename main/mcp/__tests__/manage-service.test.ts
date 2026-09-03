import { describe, expect, it, vi } from 'vitest';
import { handleMcpMessage, manageServiceSummary, type McpContext } from '../protocol';
import type { ManageServiceRequest, ManageServiceResult } from '../protocol';

/**
 * The `manageService` MCP surface (Tynn #234, P3) — the agent-first
 * administration path for the Dev Server's backing services.
 *
 * Tested at the PURE protocol layer with a stub context: no container runtime,
 * no database, no engine. The same three things that layer owns for
 * `manageSite`, plus the one that is new here:
 *
 *   4. **The CONNECTION surface is two-sided.** A container on the workspace
 *      network dials the engine by NAME on its real port; a person or an agent
 *      on this machine dials LOOPBACK on the published one. The headline has to
 *      make that difference impossible to miss, because handing an agent the
 *      wrong one produces a connection string that works in a terminal and
 *      fails inside every container.
 */

function ctx(over: Partial<McpContext> = {}): McpContext {
    return {
        terminalId: 'term-1',
        serverName: 'genie',
        serverVersion: '0.7.0',
        onImDone: vi.fn().mockReturnValue({ attention: 1 }),
        checkIssues: vi.fn().mockResolvedValue({
            connected: true,
            workspaceResolved: true,
            counts: { issue: 0, pr: 0, security: 0, feedback: 0 },
            items: [],
        }),
        onForceQuestion: vi.fn().mockResolvedValue({ cancelled: true, answers: [] }),
        describeWorkspace: vi.fn().mockResolvedValue(null),
        manageProcess: vi.fn().mockResolvedValue({ ok: true, processes: [] }),
        manageSite: vi.fn().mockResolvedValue({ ok: true, sites: [] }),
        manageService: vi.fn().mockResolvedValue({ ok: true, services: [] }),
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

const call = (args: Partial<ManageServiceRequest>, over: Partial<McpContext> = {}) =>
    handleMcpMessage(
        {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'manageService', arguments: args },
        },
        ctx(over),
    );

// --- the gate ---------------------------------------------------------------

describe('tools/list gating', () => {
    it('lists manageService where a container runtime is usable', async () => {
        expect(await listTools({ devServerAvailable: async () => true })).toContain(
            'manageService',
        );
    });

    it('lists it without Docker because WebSockets are Host-native', async () => {
        expect(await listTools({ devServerAvailable: async () => false })).toContain(
            'manageService',
        );
    });

    it('does not let a failing Docker probe hide Host-native services', async () => {
        const tools = await listTools({
            devServerAvailable: async () => {
                throw new Error('docker socket exploded');
            },
        });
        expect(tools).toContain('manageService');
        expect(tools).toContain('manageProcess');
    });

    it('omits it when the seam is not wired at all', async () => {
        expect(await listTools({ manageService: undefined })).not.toContain('manageService');
    });
});

// --- dispatch ---------------------------------------------------------------

describe('tools/call dispatch', () => {
    it('rejects a missing or unknown action as a JSON-RPC error', async () => {
        const manageService = vi.fn();
        expect((await call({}, { manageService })) as { error?: unknown }).toHaveProperty('error');
        expect(
            (await call({ action: 'drop' as never }, { manageService })) as { error?: unknown },
        ).toHaveProperty('error');
        expect(manageService).not.toHaveBeenCalled();
    });

    it('passes every field through verbatim', async () => {
        const manageService = vi.fn().mockResolvedValue({ ok: true, services: [] });
        await call(
            {
                action: 'add',
                engine: 'postgres',
                version: '16',
                dedicated: true,
                image: 'ghcr.io/acme/thing:1',
                port: 9999,
                env: { THING: '1' },
                enabled: false,
                tail: 50,
            },
            { manageService },
        );
        expect(manageService).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({
                action: 'add',
                engine: 'postgres',
                version: '16',
                dedicated: true,
                image: 'ghcr.io/acme/thing:1',
                port: 9999,
                env: { THING: '1' },
                enabled: false,
                tail: 50,
            }),
        );
    });

    it('accepts every action the tool advertises', async () => {
        const manageService = vi.fn().mockResolvedValue({ ok: true, services: [] });
        for (const action of [
            'catalog',
            'list',
            'add',
            'start',
            'stop',
            'status',
            'logs',
            'remove',
            'connection',
            'dedicated',
        ] as const) {
            const res = await call({ action, id: 'svc' }, { manageService });
            expect(res).not.toHaveProperty('error');
        }
        expect(manageService).toHaveBeenCalledTimes(10);
    });

    it('returns the headline followed by the full JSON result', async () => {
        const result: ManageServiceResult = {
            ok: true,
            services: [
                {
                    id: 'svc',
                    engine: 'postgres',
                    version: '16',
                    engineKey: 'postgres-16',
                    dedicated: false,
                    enabled: true,
                    state: 'running',
                    ready: true,
                    holders: 2,
                    endpoints: [
                        {
                            name: 'postgres',
                            kind: 'tcp',
                            host: 'genie-svc-postgres-16',
                            port: 5432,
                            hostPort: 49_801,
                            localAddress: '127.0.0.1:49801',
                        },
                    ],
                    namespace: { identifier: 'ws_acme', dnsName: 'ws-acme' },
                    envKeys: ['DATABASE_URL'],
                },
            ],
            affectedId: 'svc',
        };
        const res = await call({ action: 'status', id: 'svc' }, { manageService: async () => result });
        const text = (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
        expect(text.split('\n')[0]).toContain('genie-svc-postgres-16:5432');
        expect(JSON.parse(text.slice(text.indexOf('{')))).toEqual(result);
    });
});

// --- the headline -----------------------------------------------------------

describe('manageServiceSummary', () => {
    const service = (over: Partial<ManageServiceResult['services'][number]> = {}) => ({
        id: 'svc',
        engine: 'postgres',
        version: '16',
        engineKey: 'postgres-16',
        dedicated: false,
        enabled: true,
        state: 'running',
        ready: true,
        endpoints: [
            {
                name: 'postgres',
                kind: 'tcp' as const,
                host: 'genie-svc-postgres-16',
                port: 5432,
                hostPort: 49_801,
                localAddress: '127.0.0.1:49801',
            },
        ],
        ...over,
    });

    it('gives BOTH surfaces, and says which is which', async () => {
        const text = manageServiceSummary({
            ok: true,
            affectedId: 'svc',
            services: [service()],
        });
        // From a container in the workspace…
        expect(text).toContain('genie-svc-postgres-16:5432');
        // …and from this machine.
        expect(text).toContain('127.0.0.1:49801');
    });

    it('says how many workspaces share the engine — the point of the model', () => {
        const text = manageServiceSummary({
            ok: true,
            affectedId: 'svc',
            services: [service({ holders: 3 })],
        });
        expect(text).toMatch(/3 workspaces/);
    });

    it('does not claim a service is usable when it is not ready', () => {
        const text = manageServiceSummary({
            ok: true,
            affectedId: 'svc',
            services: [service({ ready: false })],
        });
        expect(text).not.toContain('127.0.0.1:49801');
        expect(text).toMatch(/not ready|never became ready|still starting/i);
    });

    it('leads with the reason a service failed', () => {
        const text = manageServiceSummary({
            ok: true,
            affectedId: 'svc',
            services: [service({ state: 'failed', error: 'no such image' })],
        });
        expect(text).toContain('no such image');
    });

    it('carries the install hint when there is no container runtime', () => {
        const text = manageServiceSummary({
            ok: false,
            error: 'No container runtime is available.',
            services: [],
            runtime: { kind: 'none', installHint: 'Install Docker Desktop from …' },
        });
        expect(text).toContain('Install Docker Desktop');
    });

    it('counts the workspace when no single service was targeted', () => {
        expect(
            manageServiceSummary({
                ok: true,
                services: [service(), service({ id: 'b', state: 'stopped' })],
            }),
        ).toBe('2 services in this workspace, 1 running.');
    });

    it('lists the catalog when that is what was asked for', () => {
        const text = manageServiceSummary({
            ok: true,
            services: [],
            catalog: [
                {
                    engine: 'postgres',
                    label: 'Postgres',
                    summary: 'PostgreSQL.',
                    versions: ['17', '16'],
                    defaultVersion: '17',
                    shared: true,
                    provision: 'sql-database-role',
                },
            ],
        });
        expect(text).toContain('postgres');
    });
});

/**
 * A CONSEQUENCE the caller must be told about (Tynn #250, step 4).
 *
 * `ManageServiceResult.note` exists for the case where the action succeeded but
 * something the caller cares about did NOT happen — the shape a declined purge
 * takes. It was never rendered, so it reached an agent only if that agent read
 * the JSON body, and `remove` in particular falls through every branch of the
 * summary (the service it names is gone from the list by then). A refusal
 * nobody is shown is indistinguishable from the purge having worked.
 */
describe('manageServiceSummary — a note is not optional reading', () => {
    it('LEADS with the note rather than burying it under a count', () => {
        const text = manageServiceSummary({
            ok: true,
            affectedId: 'svc',
            services: [],
            note: 'Purging would delete genie-svc-postgres-16-data, which also holds ws_notes_1a2b3c4d.',
        });
        expect(text.startsWith('Purging would delete')).toBe(true);
        expect(text).toContain('ws_notes_1a2b3c4d');
    });

    it('keeps the note when the action also has a service to report', () => {
        const text = manageServiceSummary({
            ok: true,
            affectedId: 'svc',
            services: [
                {
                    id: 'svc',
                    engine: 'postgres',
                    version: '17',
                    engineKey: 'postgres-17',
                    dedicated: false,
                    enabled: true,
                    state: 'running',
                    ready: true,
                },
            ],
            note: 'The newly active version starts empty — the old one keeps its own volume.',
        });
        expect(text).toContain('starts empty');
        expect(text).toContain('postgres 17');
    });
});
