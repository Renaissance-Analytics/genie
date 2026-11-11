import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import { InMemoryTransport } from '@particle-academy/prism-mcp-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHostMcp, type HostMcp, type HostMcpPorts } from '../src/main/host-mcp.js';
import { genieMcpServer } from '../src/main/mcp-server.js';
import type { Registration } from '../src/main/mcp-tools.js';
import { hostPluginTools, PluginsService } from '../src/main/plugins-host.js';

/**
 * ADF A6, THE TOOL LIST IS LIVE (Tynn #450; tynn-slave's C4 finding): host-mcp.ts built the tool registrations once at
 * start and nothing rebuilt them, so a package installed, updated, disabled or removed did not change what agents were
 * offered until Genie restarted. Now the host's server serves the catalog as it is: a package's tools appear, change and
 * go at the moment it does, with no restart and the same endpoint; a call already running finishes on what it started on.
 */
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

describe('genieMcpServer: the served tools can be replaced whole', () => {
    const reg = (name: string, description: string, run: () => Promise<McpToolResult> | McpToolResult = () => ({ text: name, isError: false })): Registration => ({
        definition: new ToolDefinition(name, description, { type: 'object', properties: {} } as JsonObject, name),
        handler: run as never,
    });

    it('a replacement is what is listed and called next; a call already running finishes; the door does not move', async () => {
        const transport = new InMemoryTransport();
        let release: () => void = () => {};
        const held = reg('old', 'the old one', () => new Promise<McpToolResult>((r) => { release = () => r({ text: 'old finished', isError: false }); }));
        const server = genieMcpServer({ registrations: [held, reg('kept', 'v1')], transport });
        const before = await server.start();
        const list = async () => ((await transport.request({ method: 'tools/list', params: { _meta: META } })) as { tools: Array<{ name: string; description: string }> }).tools;
        const call = (name: string) => transport.request({ method: 'tools/call', params: { name, arguments: {}, _meta: META } }) as Promise<{ content: Array<{ text: string }> }>;
        expect((await list()).map((t) => t.name).sort()).toEqual(['kept', 'old']);

        const running = call('old');
        await new Promise((r) => setTimeout(r, 0));
        server.setRegistrations([reg('kept', 'v2'), reg('new', 'the new one')]);

        const after = await list();
        expect(after.map((t) => t.name).sort()).toEqual(['kept', 'new']);
        expect(after.find((t) => t.name === 'kept')?.description).toBe('v2');
        expect((await call('new')).content[0]?.text).toBe('new');
        await expect(call('old')).rejects.toThrow();

        release();
        expect((await running).content[0]?.text).toBe('old finished');
        expect(server.endpoint()).toEqual(before);
        await server.stop();
    });
});

describe('the host’s MCP server follows the plugins with no restart', () => {
    let dir: string;
    let mcp: HostMcp | null = null;
    let endpoints: string;
    beforeAll(async () => { endpoints = await mkdtemp(join(tmpdir(), 'genie-live-tools-endpoints-')); });
    afterAll(async () => { await rm(endpoints, { recursive: true, force: true }); });
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-live-tools-')); });
    afterEach(async () => { await mcp?.stop(); mcp = null; await rm(dir, { recursive: true, force: true }); });

    const never = () => { throw new Error('not exercised'); };
    const ports = (plugins: NonNullable<HostMcpPorts['plugins']>): HostMcpPorts => ({
        stores: { inbox: never, attention: never, knowledge: never, approvals: { gate: async () => 'denied' } } as never,
        settings: { snapshot: () => ({}), snapshotFor: () => ({}) } as never,
        records: () => [],
        registry: { workspace: () => null, workspaceSlugs: () => new Map(), defaultAgentOf: () => null, setNames: () => {} } as never,
        probe: never as never,
        lastRowAt: () => null,
        reportPlan: () => true,
        window: { connected: () => false, call: async () => ({ text: 'forwarded', isError: true }) },
        openFileLater: () => {},
        signal: () => {},
        endpointFile: join(endpoints, `mcp-endpoint-${Math.random().toString(36).slice(2)}.json`),
        osaDir: join(dir, 'osa'),
        log: () => {},
        plugins,
    });
    const writePlugin = async (version: string, tools: string[]) => {
        await mkdir(join(dir, 'plugins', 'acme-lint'), { recursive: true });
        await writeFile(join(dir, 'plugins', 'acme-lint', 'genie-package.json'), JSON.stringify({
            id: 'acme.lint', name: 'Acme Lint', version, publisher: { name: 'Acme', keyId: 'k' },
            mcpTools: tools.map((name) => ({ name, description: `Run ${name}`, inputSchema: { type: 'object' }, run: 'tools/x.js', process: 'subprocess', gated: false })),
        }));
    };
    const SHEET = 'ai.genie.spreadsheet.createWorkbook';

    /** Over the real door, as an agent asks. */
    const listed = async () => {
        const { url, token } = mcp!.endpoint()!;
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }) });
        return ((await res.json()) as { result: { tools: Array<{ name: string; description: string }> } }).result.tools;
    };
    const names = async () => (await listed()).map((t) => t.name);
    const started = async (): Promise<PluginsService> => {
        const service = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, publisherChecksOff: () => true });
        mcp = startHostMcp(ports(hostPluginTools(service, { sandboxDir: join(dir, 'sandbox'), api: async () => { throw new Error('none'); } })));
        const end = Date.now() + 10_000;
        while (mcp.endpoint() === null) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); }
        return service;
    };

    it('a package installed after the server started is offered at once, on the same endpoint', async () => {
        const service = await started();
        const at = mcp!.endpoint();
        expect(await names()).not.toContain('acme.lint.lint');
        await writePlugin('1.0.0', ['lint']);
        await service.call('refresh', []);
        mcp!.refreshTools();
        expect(await names()).toContain('acme.lint.lint');
        expect(mcp!.status().tools.map((t) => t.name)).toContain('acme.lint.lint');
        expect(mcp!.registrations().map((r) => r.definition.name)).toContain('acme.lint.lint');
        expect(mcp!.endpoint()).toEqual(at);
    });

    it('an update changes what is offered: the new tool appears, the dropped one goes, the words are the new version’s', async () => {
        await writePlugin('1.0.0', ['lint', 'fix']);
        const service = await started();
        expect(await names()).toEqual(expect.arrayContaining(['acme.lint.lint', 'acme.lint.fix']));
        await writePlugin('2.0.0', ['lint', 'check']);
        await service.call('refresh', []);
        mcp!.refreshTools();
        const now = await listed();
        expect(now.map((t) => t.name)).toContain('acme.lint.check');
        expect(now.map((t) => t.name)).not.toContain('acme.lint.fix');
        expect(now.find((t) => t.name === 'acme.lint.lint')?.description).toContain('2.0.0');
    });

    it('disabled, then enabled: its tools go and come back, Genie’s own included; uninstalled: gone', async () => {
        await writePlugin('1.0.0', ['lint']);
        const service = await started();
        expect(await names()).toEqual(expect.arrayContaining([SHEET, 'acme.lint.lint']));
        await service.call('setEnabled', ['ai.genie.spreadsheet', false]);
        mcp!.refreshTools();
        expect(await names()).not.toContain(SHEET);
        expect(await names()).toContain('imDone');
        await service.call('setEnabled', ['ai.genie.spreadsheet', true]);
        mcp!.refreshTools();
        expect(await names()).toContain(SHEET);
        await service.call('uninstall', ['acme.lint']);
        mcp!.refreshTools();
        expect(await names()).not.toContain('acme.lint.lint');
    });

    it('genie-host rebuilds the tools whenever the catalog changes', () => {
        const host = readFileSync('src/main/genie-host.ts', 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(host).toMatch(/catalogService\.onEvent\(\(\) => mcp\?\.refreshTools\(\)\)/);
    });
});
