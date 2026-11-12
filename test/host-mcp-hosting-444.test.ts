import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { startHostMcp, type HostMcp } from '../src/main/host-mcp.js';

// Actual authenticated HTTP tools/call through genie-host. No window, provider, container or command is started.
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
let dir: string;
let host: HostMcp | null = null;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-host-tools-444-')); });
afterEach(async () => { await host?.stop(); host = null; await rm(dir, { recursive: true, force: true }); });

async function rig(connected: boolean) {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'work', provider: 'claude', name: 'fixture' });
    const forwarded: string[] = [];
    const never = () => { throw new Error('unexpected store operation'); };
    host = startHostMcp({
        stores: { inbox: never, knowledge: never, attention: { imDone: async () => ({ handoff: 'saved', checklist: [] }) }, approvals: { gate: async () => 'allowed' } } as never,
        settings: { snapshot: () => ({}), snapshotFor: () => ({}) } as never,
        records: () => [record],
        registry: { workspace: () => ({ id: 'work', path: dir }), workspaceSlugs: () => new Map(), defaultAgentOf: () => record.id, setNames: () => {} } as never,
        probe: () => null, lastRowAt: () => null, reportPlan: () => true,
        hosting: { sites: { list: () => [] }, engines: { list: () => [], choices: () => [], envFor: () => ({}) }, engineStatuses: async () => [] } as never,
        window: { connected: () => connected, call: async (call) => { forwarded.push(call.name); throw new Error('this window runs no tools'); } },
        openFileLater: () => {}, signal: () => {}, endpointFile: join(dir, 'mcp-endpoint.json'), osaDir: join(dir, 'osa'), log: () => {},
    });
    await vi.waitFor(() => expect(host!.endpoint()).not.toBeNull());
    const server = host.sessionServers(record)[0];
    if (!server || server.type === 'stdio') throw new Error('expected the host HTTP MCP entry');
    const call = async (name: string, args: Record<string, unknown>) => {
        const response = await fetch(host!.endpoint()!.url, {
            method: 'POST', headers: { 'content-type': 'application/json', ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])) },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: META } }),
        });
        expect(response.status).toBe(200);
        const envelope = await response.json() as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: unknown };
        expect(envelope.error).toBeUndefined();
        return { error: envelope.result?.isError === true, text: envelope.result?.content.map((c) => c.text).join('\n') ?? '' };
    };
    return { call, forwarded };
}

describe.each([false, true])('host-owned tools with a non-answering window (connected: %s), Tynn #444', (connected) => {
    it('sites list and services list already answer through the real MCP path without forwarding', async () => {
        const w = await rig(connected);
        const sites = await w.call('sites', { action: 'list' });
        expect(sites.error).toBe(false); expect(JSON.parse(sites.text)).toMatchObject({ ok: true, sites: [] });
        const services = await w.call('services', { action: 'list' });
        expect(services.error).toBe(false); expect(JSON.parse(services.text)).toMatchObject({ ok: true, services: [] });
        expect(w.forwarded).toEqual([]);
    });

    it('services exec reaches host validation, even without a command, rather than a window', async () => {
        const w = await rig(connected);
        const result = await w.call('services', { action: 'exec' });
        expect(result.error).toBe(true);
        expect(result.text).toContain('exec needs');
        expect(w.forwarded).toEqual([]);
    });

    it('imDone saves and answers even though the optional issue count has no window provider', async () => {
        const w = await rig(connected);
        const result = await w.call('imDone', { handoff: 'checkpoint' });
        expect(result.error).toBe(false);
        expect(JSON.parse(result.text)).toMatchObject({ ok: true, handoff: 'saved' });
        expect(w.forwarded).toEqual([]);
    });
});

it('the production host wires its own service command executor into the host MCP', async () => {
    const source = (await readFile(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8')).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(source).toMatch(/serviceExec:\s*makeServiceExec\(/);
});
