import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { genieRunningFrom, genieRunningFile } from '../src/core/genie-running.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { DoctorRun } from '../src/main/doctor-run.js';
import { genieToolDeps } from '../src/main/genie-tool-deps.js';
import { allGenieTools } from '../src/main/mcp-registrations.js';
import type { DriverFor } from '../src/main/session-host.js';
import { OS_WORKSPACE } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * DOCTOR MODE RUNS A LOADED AGENT WITH GENIE'S REAL TOOLS (the owner, 2026-10-13: "you should be able to access all
 * genie data and drive the genie agent"; decided: inspect AND run; read-only while normal Genie runs). Bare doctor gave
 * its genie no Genie tools, so it could not see #214 (Claude dropped every tool) or the session-key bug (#228) — both
 * lived in the wiring between a session and Genie's MCP. So a loaded agent starts here with exactly that wiring: the
 * same tool builder normal Genie uses (one copy — today's bug was copies drifting), the same session-key header, served
 * over real HTTP. And never while normal Genie runs: two Genies driving one agent's thread is how a conversation forks.
 */
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
let home: string;
let ws: string;
let runs: DoctorRun[] = [];
const kai = agentRecord({ id: mintAgentId(), workspaceId: 'ws_tynn', provider: 'claude', name: 'kai' });
const osa = agentRecord({ id: mintAgentId(), workspaceId: OS_WORKSPACE, provider: 'claude', name: 'genie' });

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-doctorrun-'));
    ws = join(home, 'projects', 'tynn');
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, 'project.json'), JSON.stringify({ name: 'tynn.ai' }));
    const store = new Store(home);
    await store.writeWorkspaces([{ id: 'ws_tynn', path: ws }]);
    await store.writeAgents([kai, osa]);
});
afterEach(async () => {
    for (const r of runs) await r.stop();
    runs = [];
    await rm(home, { recursive: true, force: true });
});

/** A driver that records what Genie started it with, and never talks to a provider. */
function fakeDrivers() {
    const started: Array<{ name: string; cwd: string; mcpServers: readonly McpServer[] }> = [];
    const driverFor: DriverFor = (record, cwd, _resume, extras) => ((options: { events: DriverEvents }) => {
        void options;
        started.push({ name: record.name, cwd, mcpServers: extras?.mcpServers ?? [] });
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    }) as unknown as SessionDriverFactory;
    return { started, driverFor };
}

function doctorRun(running: { running: true; pid: number; agents: readonly string[] | null } | { running: false }) {
    const drivers = fakeDrivers();
    const prepared: string[] = [];
    // genie's home is written before genie starts (normal Genie's boot writes it; doctor must not depend on that).
    const prepareOsaHome = async () => { await mkdir(join(home, 'osa'), { recursive: true }); prepared.push('osa'); };
    const run = new DoctorRun({ genieHome: home, besideHome: join(home, 'doctor-beside'), genieRunning: () => running, prepareOsaHome, driverFor: drivers.driverFor, processTree: tree });
    runs.push(run);
    const call = async (name: string, args: Record<string, unknown>) => {
        const tool = run.tools().find((t) => t.definition.name === name)!;
        const r = await tool.handler(args as never, { server: 'genie', tool: name, headers: {} });
        return { isError: r.isError, json: JSON.parse(r.text) as Record<string, any> };
    };
    return { run, call, started: drivers.started, prepared };
}

/** A tools/call exactly as Claude makes it: POST to the server's URL with the headers Genie configured for the session. */
async function callAsClaude(server: McpServer, name: string, args: Record<string, unknown>) {
    const s = server as { url: string; headers: ReadonlyArray<{ name: string; value: string }> };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const h of s.headers) headers[h.name] = h.value;
    const res = await fetch(s.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: META } }) });
    const body = (await res.json()) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown };
    return { status: res.status, isError: body.result?.isError ?? true, text: body.result?.content[0]?.text ?? JSON.stringify(body.error) };
}

async function listAsClaude(server: McpServer): Promise<string[]> {
    const s = server as { url: string; headers: ReadonlyArray<{ name: string; value: string }> };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const h of s.headers) headers[h.name] = h.value;
    const res = await fetch(s.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: META } }) });
    return ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
}

describe('is normal Genie running?', () => {
    it('a live pid that is not doctor itself; a dead pid, garbage, no file, or our own pid is not', () => {
        const alive = (pid: number) => pid === 4242 || pid === 7;
        // A Genie that did not say which agents it runs (an older build): `agents: null`, which doctor treats as "it may be any".
        expect(genieRunningFrom(JSON.stringify({ pid: 4242 }), alive, 7)).toEqual({ running: true, pid: 4242, agents: null });
        expect(genieRunningFrom(JSON.stringify({ pid: 4242, agents: ['agent_a'] }), alive, 7)).toEqual({ running: true, pid: 4242, agents: ['agent_a'] });
        expect(genieRunningFrom(JSON.stringify({ pid: 999 }), alive, 7)).toEqual({ running: false });
        expect(genieRunningFrom(JSON.stringify({ pid: 7 }), alive, 7)).toEqual({ running: false });
        expect(genieRunningFrom('not json', alive, 7)).toEqual({ running: false });
        expect(genieRunningFrom(null, alive, 7)).toEqual({ running: false });
        expect(genieRunningFile('/h/.genie').replace(/\\/g, '/')).toBe('/h/.genie/runtime/genie.pid');
    });

    it('normal Genie writes it at boot and removes it at quit', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/markGenieRunning\(/);
        expect(main).toMatch(/clearGenieRunning\(/);
    });
});

describe('starting a loaded agent', () => {
    // Changed 2026-10-14 (the owner: "doctor should be able to profile an agent even while we have genie open. It should
    // be able to load any Active workspace that has no started agents"). Refused now only when the running Genie cannot
    // say what it runs (an older build) — the beside-Genie rules are in doctor-beside.test.ts.
    it('is refused while a Genie that does not say which agents it runs is running — says why, starts nothing (the control: with Genie closed it starts exactly one)', async () => {
        const blocked = doctorRun({ running: true, pid: 4242, agents: null });
        const r = await blocked.call('startAgent', { workspace: 'tynn.ai', agent: 'kai' });
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/Genie is running/);
        expect(r.json.error).toMatch(/restart Genie|close/i);
        expect(blocked.started).toHaveLength(0);

        const free = doctorRun({ running: false });
        expect((await free.call('startAgent', { workspace: 'tynn.ai', agent: 'kai' })).isError).toBe(false);
        expect(free.started.map((s) => s.name)).toEqual(['kai']);
        expect(free.started[0]!.cwd).toBe(ws);
    });

    it('starts it with Genie’s tools behind the session-key header — and a call made as Claude makes it, with an INVENTED terminalId, is answered as that agent', async () => {
        const d = doctorRun({ running: false });
        await d.call('startAgent', { workspace: 'tynn.ai', agent: 'kai' });
        const [genie] = d.started[0]!.mcpServers;
        expect(genie).toBeDefined();
        const names = ((genie as unknown as { headers: Array<{ name: string }> }).headers).map((h) => h.name);
        expect(names).toContain('Mcp-Param-Genie-Session');

        const r = await callAsClaude(genie!, 'lists', { action: 'show', terminalId: 'genie' });
        expect(r.status).toBe(200);
        expect(r.isError).toBe(false);
        expect(r.text).not.toMatch(/not one Genie knows/);
    });

    it('serves the very tool list normal Genie builds (one builder; the control: that list is not empty)', async () => {
        const d = doctorRun({ running: false });
        await d.call('startAgent', { workspace: 'tynn.ai', agent: 'kai' });
        const never = (() => { throw new Error('not exercised'); }) as never;
        const normal = allGenieTools(genieToolDeps({
            inbox: never, attention: never, knowledge: never, settings: never, approve: never, roster: () => [], resolveCaller: () => null,
            userActive: () => true, glow: () => false, thumbsUp: () => {}, openFile: never, terminals: never,
            plugins: { tools: () => [], guard: () => null, run: never },
        })).map((r) => r.definition.name).sort();
        expect(normal.length).toBeGreaterThan(5);
        expect((await listAsClaude(d.started[0]!.mcpServers[0]!)).sort()).toEqual(normal);
    });

    it('the workstation agent too: no workspace, genie, in its own home', async () => {
        const d = doctorRun({ running: false });
        const started = await d.call('startAgent', { agent: 'genie' });
        expect(started.json.error ?? null).toBeNull();
        expect(d.prepared).toEqual(['osa']);
        expect(d.started[0]!.cwd.replace(/\\/g, '/')).toBe(`${home.replace(/\\/g, '/')}/osa`);
        // The owner's case: genie belongs to no workspace record, and its session must still be somebody to Genie's tools.
        const r = await callAsClaude(d.started[0]!.mcpServers[0]!, 'lists', { action: 'show', terminalId: 'genie' });
        expect(r.isError).toBe(false);
        expect(r.text).not.toMatch(/does not know this session|not one Genie knows/);
    });

    it('one agent at a time: a second is refused until the first is stopped', async () => {
        const d = doctorRun({ running: false });
        await d.call('startAgent', { workspace: 'tynn.ai', agent: 'kai' });
        const second = await d.call('startAgent', { agent: 'genie' });
        expect(second.isError).toBe(true);
        expect(second.json.error).toMatch(/kai/);
        expect((await d.call('stopAgent', {})).isError).toBe(false);
        expect((await d.call('startAgent', { agent: 'genie' })).isError).toBe(false);
        expect(d.started.map((s) => s.name)).toEqual(['kai', 'genie']);
    });
});

describe('one copy of the wiring', () => {
    it('normal Genie and doctor both build their tools with genieToolDeps — main keeps no mapping of its own', () => {
        for (const file of ['src/main/main.ts', 'src/main/doctor-run.ts']) expect(readFileSync(file, 'utf8')).toMatch(/allGenieTools\(genieToolDeps\(/);
        expect(readFileSync('src/main/main.ts', 'utf8')).not.toMatch(/workspaceSetting:/);
        expect(readFileSync('src/main/genie-tool-deps.ts', 'utf8')).toMatch(/workspaceSetting:/);
    });
});

describe('the workstation agent is a caller like any other', () => {
    it('its session key resolves with its own home as the workspace path — normal Genie and doctor share the one lookup', async () => {
        const { CallerBook, sessionCallerOf } = await import('../src/main/mcp-callers.js');
        const book = new CallerBook();
        const look = { find: (id: string) => [kai, osa].find((a) => a.id === id) ?? null, workspace: (id: string) => (id === 'ws_tynn' ? { path: ws } : null) };
        expect(sessionCallerOf(book, book.keyFor(osa.id), look as never, '/h/.genie/osa')).toEqual({ agentId: osa.id, agentName: 'genie', workspaceId: OS_WORKSPACE, workspacePath: '/h/.genie/osa' });
        expect(sessionCallerOf(book, book.keyFor(kai.id), look as never, '/h/.genie/osa')).toMatchObject({ agentName: 'kai', workspacePath: ws });
        expect(sessionCallerOf(book, 'session-nobody', look as never, '/h/.genie/osa')).toBeNull();
        expect(readFileSync('src/main/main.ts', 'utf8')).toMatch(/sessionCallerOf\(/);
    });
});
