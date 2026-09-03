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
    it('lists manageSite whenever the host wires it — host-native dev hosting needs NO Docker', async () => {
        expect(await listTools({ devServerAvailable: async () => true })).toContain('manageSite');
        // No container runtime: manageSite is STILL listed — dev sites run host-native
        // (story #238); only the opt-in production recipe needs a runtime, per-action.
        expect(await listTools({ devServerAvailable: async () => false })).toContain('manageSite');
    });

    it('a broken/absent Docker probe never removes manageSite (host-native is fail-open)', async () => {
        const tools = await listTools({
            devServerAvailable: async () => {
                throw new Error('docker socket exploded');
            },
        });
        expect(tools).toContain('manageSite');
        expect(tools).toContain('manageProcess');
        expect(tools).toContain('manageTerminals');
    });

    it('keeps manageService available without a container runtime for Host-native engines', async () => {
        const svc = vi.fn().mockResolvedValue({ ok: true });
        expect(await listTools({ devServerAvailable: async () => true, manageService: svc })).toContain('manageService');
        expect(await listTools({ devServerAvailable: async () => false, manageService: svc })).toContain(
            'manageService',
        );
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
                command: ['npm', 'run', 'dev'],
                port: 5173,
                kind: 'http',
                exposed: [
                    { name: 'live', port: 6001, protocol: 'ws', reason: 'the client subscribes' },
                ],
                upstreamHost: 'localhost',
                env: { NODE_ENV: 'production' },
                enabled: false,
                browserExposed: true,
            },
            { manageSite },
        );
        expect(manageSite).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({
                action: 'create',
                name: 'web',
                repo: 'app',
                // The USER-CONTROLLED startup argv reaches the host verbatim.
                command: ['npm', 'run', 'dev'],
                port: 5173,
                exposed: [
                    { name: 'live', port: 6001, protocol: 'ws', reason: 'the client subscribes' },
                ],
                upstreamHost: 'localhost',
                env: { NODE_ENV: 'production' },
                enabled: false,
                // The external-browser opt-in (story #238) rides through verbatim.
                browserExposed: true,
            }),
        );
    });

    it('forwards a `hostServe` static site — the agent declares a mode, not a server config', async () => {
        // The owner's screenshot: an agent hand-rolled nginx to serve a built SPA.
        // Now `hostServe` rides through so Genie serves it; no command/port needed.
        const manageSite = vi.fn().mockResolvedValue({ ok: true, sites: [] });
        await call(
            {
                action: 'create',
                name: 'wallet',
                repo: 'imp-wallet',
                hostServe: { mode: 'static', root: 'dist', spa: true },
            },
            { manageSite },
        );
        expect(manageSite).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({
                action: 'create',
                name: 'wallet',
                hostServe: { mode: 'static', root: 'dist', spa: true },
            }),
        );
    });

    it('forwards a PINNED php version, and the schema tells an agent what omitting it means', async () => {
        // genie#207: the agent-facing half of "which PHP does this site run on".
        // A pin the tool accepts but drops would be worse than none — the site would
        // silently follow the machine default while its config claims otherwise.
        const manageSite = vi.fn().mockResolvedValue({ ok: true, sites: [] });
        await call(
            {
                action: 'create',
                name: 'moic',
                repo: 'moicsuite',
                hostServe: { mode: 'php', root: '.', version: '8.3' },
            },
            { manageSite },
        );
        expect(manageSite).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({ hostServe: { mode: 'php', root: '.', version: '8.3' } }),
        );

        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 3, method: 'tools/list' },
            ctx({ devServerAvailable: async () => true }),
        );
        const tool = (
            res?.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }
        ).tools.find((t) => t.name === 'manageSite');
        const props = (tool?.inputSchema.properties ?? {}) as Record<string, { properties?: Record<string, { description?: string }> }>;
        const version = props.hostServe?.properties?.version?.description ?? '';
        // The two facts an agent cannot guess: what omitting it does, and that a
        // missing pinned version FAILS the start rather than falling back.
        expect(version).toMatch(/machine default/i);
        expect(version).toMatch(/fail/i);
    });

    it('forwards `hostPort` — pointing .gen at a dev server the agent already runs (was silently dropped)', async () => {
        const manageSite = vi.fn().mockResolvedValue({ ok: true, sites: [] });
        await call(
            { action: 'create', name: 'api', repo: 'app', hostPort: 3000 },
            { manageSite },
        );
        expect(manageSite).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({ action: 'create', name: 'api', hostPort: 3000 }),
        );
    });

    it('accepts and forwards the `update` action with only the changed fields', async () => {
        const manageSite = vi.fn().mockResolvedValue({ ok: true, sites: [] });
        await call(
            { action: 'update', id: 'abc', port: 9000, env: { LOG_LEVEL: 'debug' } },
            { manageSite },
        );
        expect(manageSite).toHaveBeenCalledWith(
            'term-1',
            expect.objectContaining({
                action: 'update',
                id: 'abc',
                port: 9000,
                env: { LOG_LEVEL: 'debug' },
            }),
        );
    });

    it('returns the headline followed by the full JSON result', async () => {
        const result: ManageSiteResult = {
            ok: true,
            sites: [
                {
                    id: 'abc',
                    workspaceId: 'acme',
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
        // Split on the blank line the formatter writes, not on the first `{`: a
        // headline may itself quote a call (`manageSite {action:'status', …}`).
        expect(JSON.parse(text.slice(text.indexOf('\n\n') + 2))).toEqual(result);
    });
});

// --- what the tool ADVERTISES ----------------------------------------------

describe('the manageSite description matches what the tool does', () => {
    const description = async (): Promise<string> => {
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 7, method: 'tools/list' },
            ctx({ devServerAvailable: async () => true }),
        );
        const tools = (res?.result as { tools: Array<{ name: string; description: string }> }).tools;
        return tools.find((t) => t.name === 'manageSite')?.description ?? '';
    };

    it('never advertises the production recipe it refuses (genie#191)', async () => {
        // An agent picks its arguments from this text. While it still offered
        // `runMode:'recipe'` as an opt-in, every agent that took the offer got a
        // site that reported `running` and built nothing — and now gets a refusal.
        const text = await description();
        expect(text).not.toMatch(/opt-in production recipe/i);
        expect(text).not.toMatch(/production build\+serve is OPT-IN/i);
        expect(text).toMatch(/REFUSED/);
        // The schema offers only the two modes that run.
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 8, method: 'tools/list' },
            ctx({ devServerAvailable: async () => true }),
        );
        const tool = (
            res?.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }
        ).tools.find((t) => t.name === 'manageSite');
        const props = (tool?.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
        expect(props.runMode?.enum).toEqual(['host', 'explicit']);
    });

    it('tells an agent how to curl a site, and that a start can come back pending', async () => {
        const text = await description();
        // genie#195 — the two facts that turn a wrong label into a working command.
        expect(text).toContain('localCurl');
        expect(text).toContain('--resolve');
        // genie#194 — the handle, named where the arguments are chosen.
        expect(text).toContain('pending');
    });

    /**
     * genie#226, and CONTRIBUTING.md: "A tool DESCRIPTION in `protocol.ts` is read
     * by an agent as a promise about behaviour; if the code does not do what the
     * description says, the description is a bug of exactly this kind."
     *
     * The list read `start` / `stop` / `restart` / `status` (by `id` from a prior
     * list) with no qualification — while for a site defined with `hostPort`,
     * `start` "spawns NOTHING" (it registers a `.gen` route and probes it) and
     * `stop` only drops that route. So the tool advertises four lifecycle verbs
     * that, for that whole class of site, do not do what they are named.
     */
    it('does not promise start/stop/restart for a site whose server Genie does not run', async () => {
        const text = await description();
        expect(text).toContain('hostPort');
        // The caveat has to be attached to the ACTIONS, in words an agent can act
        // on — not left to be inferred from the SERVICES paragraph.
        expect(text).toMatch(/NOT restart|does not restart|never restarts/i);
        expect(text).toMatch(/genie#226|#226/);
    });
});

// --- the headline -----------------------------------------------------------

describe('manageSiteSummary', () => {
    const site = (over: Partial<ManageSiteResult['sites'][number]> = {}) => ({
        id: 'abc',
        workspaceId: 'acme',
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
            // This call PROBED — the unqualified 'is serving' is only ever said
            // by one that did (CONTRIBUTING.md, genie#305).
            probed: true,
            affectedId: 'abc',
            sites: [site({ ready: true, origin: 'https://web.acme.gen' })],
        });
        expect(text).toContain('https://web.acme.gen');
    });

    it('names the LOCAL form that actually works, so nobody curls the http one (genie#195)', () => {
        // The published port of a container site is the sandbox's Caddy — TLS,
        // routed by SNI — so an agent that dials `http://127.0.0.1:<port>` gets
        // "Client sent an HTTP request to an HTTPS server" and reports an app bug.
        // The headline is where that is prevented, because it is what gets read.
        const text = manageSiteSummary({
            ok: true,
            probed: true,
            affectedId: 'abc',
            sites: [
                site({
                    ready: true,
                    origin: 'https://web.acme.gen',
                    hostPort: 49_800,
                    localOrigin: 'https://web.acme.gen:49800',
                    localCurl:
                        'curl -sk --resolve web.acme.gen:49800:127.0.0.1 https://web.acme.gen:49800/',
                }),
            ],
        });
        expect(text).toContain('https://web.acme.gen');
        expect(text).toContain(
            'curl -sk --resolve web.acme.gen:49800:127.0.0.1 https://web.acme.gen:49800/',
        );
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
        // Wording changed with genie#227 — "nothing is ANSWERING on port <n>, the
        // port Genie allocated". The distinction this test guards is unchanged:
        // running is not listening, and no origin is handed back either way.
        expect(text).toMatch(/nothing is answering on port 5173/i);
        expect(text).toMatch(/logs/);
    });

    it('says a PENDING action is still going, and never reads the stale row as the outcome (genie#194)', () => {
        // A start that outlives the tool call comes back early with `pending`. The
        // row still says `stopped`, because that is what it was before the start
        // finished — leading with it would report the opposite of what happened.
        const text = manageSiteSummary({
            ok: true,
            pending: true,
            affectedId: 'abc',
            sites: [site({ state: 'stopped', ready: undefined, phase: 'pulling' })],
        });
        expect(text).toMatch(/still coming up/i);
        expect(text).toContain('pulling');
        // The exact call that reads the outcome, so nobody has to invent a poll.
        expect(text).toContain("manageSite {action:'status', id:'abc'}");
        expect(text).not.toMatch(/^web is stopped/);
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
