import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHostMcp, type HostMcp, type HostMcpPorts } from '../src/main/host-mcp.js';
import { hostPluginTools, PluginsService } from '../src/main/plugins-host.js';
import { PluginsReplica } from '../src/main/plugins-replica.js';

/**
 * ADF A3 (Tynn #447; spec .ai/plans/specs/adf-sdk.md, story A3): THE PLUGINS AND THE CATALOG ARE GENIE-HOST'S. The plugin
 * host was opened in the WINDOW's composition (compose.ts) and the host's MCP server waited for a window to say which
 * plugin tools there were (host-mcp.ts `WindowView`), so with no window an agent had no plugin tools — and no server.
 * Now genie-host opens the plugins, serves their tools itself, and starts its MCP server with no window; a window reads
 * the plugins through a replica, and closing it unregisters nothing.
 */

const SHEET = 'ai.genie.spreadsheet.createWorkbook';
let dir: string;
let mcp: HostMcp | null = null;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-host-catalog-')); });
afterEach(async () => { await mcp?.stop(); mcp = null; await rm(dir, { recursive: true, force: true }); });

const never = () => { throw new Error('not exercised'); };
function ports(plugins: NonNullable<HostMcpPorts['plugins']>, windowConnected: () => boolean): HostMcpPorts {
    return {
        stores: { inbox: never, attention: never, knowledge: never, approvals: { gate: async () => 'denied' } } as never,
        settings: { snapshot: () => ({}), snapshotFor: () => ({}) } as never,
        records: () => [],
        registry: { workspace: () => null, workspaceSlugs: () => new Map(), defaultAgentOf: () => null, setNames: () => {} } as never,
        probe: never as never,
        lastRowAt: () => null,
        reportPlan: () => true,
        window: { connected: windowConnected, call: async () => ({ text: 'forwarded to a window', isError: true }) },
        openFileLater: () => {},
        signal: () => {},
        endpointFile: join(dir, 'mcp-endpoint.json'),
        osaDir: join(dir, 'osa'),
        log: () => {},
        plugins,
    };
}
const until = async (ok: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); }
};

describe('genie-host serves the plugin tools with no window', () => {
    it('lists and CALLS ai.genie.spreadsheet.createWorkbook with no window ever attached (no WindowView sent)', async () => {
        const service = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, developerMode: () => false });
        mcp = startHostMcp(ports(hostPluginTools(service, { sandboxDir: join(dir, 'sandbox'), api: async () => { throw new Error('none'); } }), () => false));
        await until(() => mcp!.endpoint() !== null);
        expect(mcp.status().tools.map((t) => t.name)).toContain(SHEET);
        const workspace = join(dir, 'ws');
        const answer = await mcp.runNative({ name: SHEET, args: { title: 'Q3', rows: [['a', 1]], headers: ['k', 'v'] }, headers: {}, caller: { agentId: 'a1', agentName: 'atlas', workspaceId: 'w', workspacePath: workspace } as never });
        expect(answer.isError, answer.text).toBe(false);
        expect(await readdir(workspace)).toContain('q3.xlsx');
    });

    it('the plugin tool is the host’s own: run here, never forwarded to a window (CONTROL: a window tool still is)', async () => {
        const service = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, developerMode: () => false });
        mcp = startHostMcp(ports(hostPluginTools(service, { sandboxDir: join(dir, 'sandbox'), api: async () => { throw new Error('none'); } }), () => true));
        await until(() => mcp!.endpoint() !== null);
        const sheet = mcp.registrations().find((r) => r.definition.name === SHEET)!;
        const forwarded = mcp.registrations().find((r) => r.definition.name === 'openFileForUser')!;
        const headers = { 'genie-session': 'nobody' };
        const viaWindow = await forwarded.handler({ path: 'x' } as never, { server: 'genie', tool: 'openFileForUser', headers } as never);
        expect(viaWindow.text).toContain('forwarded to a window');
        const own = await sheet.handler({} as never, { server: 'genie', tool: SHEET, headers } as never);
        expect(own.text).not.toContain('forwarded to a window');
    });
});

describe('the plugins are the host’s; a window reads them through a replica', () => {
    it('the host’s dump carries the plugins, their panels and editors — with no window, and the same after one closes', async () => {
        const service = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, developerMode: () => false });
        const dump = service.dump();
        expect(dump.entries.map((e) => e.id)).toEqual(['ai.genie.document', 'ai.genie.spreadsheet', 'ai.genie.presentation', 'ai.genie.repository', 'ai.genie.artboard']);
        expect(dump.editors.map((e) => `${e.pluginId}.${e.id}`)).toEqual(['ai.genie.document.document', 'ai.genie.spreadsheet.sheet', 'ai.genie.presentation.deck']);
        expect(dump.panels.map((p) => `${p.pluginId}.${p.id}`)).toEqual(['ai.genie.repository.changes', 'ai.genie.artboard.board']);
    });

    it('a replica answers what the window asks (list, panels, editors, an editor’s bytes) from the host’s dump, and asks the host to change', async () => {
        const service = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, developerMode: () => false });
        const asked: string[] = [];
        const replica = new PluginsReplica(async (method, args) => { asked.push(`${method} ${JSON.stringify(args)}`); return service.call(method, args); });
        expect(replica.list()).toEqual([]);
        service.onEvent((d) => replica.rebase(d));
        replica.rebase(service.dump());
        expect(replica.list().map((e) => e.id)).toContain('ai.genie.spreadsheet');
        expect(replica.editors().map((e) => e.id)).toEqual(['document', 'sheet', 'deck']);
        expect(replica.editorBytes('ai.genie.spreadsheet', '/w/a.xlsx')).toMatchObject({ allowed: true });
        expect(replica.editorBytes('ai.genie.spreadsheet', '/w/a.exe')).toMatchObject({ allowed: false });
        expect(await replica.setEnabled('ai.genie.spreadsheet', false)).toBe(true);
        expect(asked).toEqual(['setEnabled ["ai.genie.spreadsheet",false]']);
        // The host changed, and said so: the replica's view follows the host's, not its own guess.
        expect(replica.list().find((e) => e.id === 'ai.genie.spreadsheet')?.state).toBe('disabled');
        expect(replica.editors().map((e) => e.id)).toEqual(['document', 'deck']);
        expect(service.dump().entries.find((e) => e.id === 'ai.genie.spreadsheet')?.state).toBe('disabled');
    });
});

describe('the wiring: composed in genie-host, not in the window', () => {
    const code = (path: string) => readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    it('genie-host opens the plugins and hands their tools to its MCP server', () => {
        const host = code('src/main/genie-host.ts');
        expect(host).toMatch(/await PluginsService\.open\(\{/);
        expect(host).toMatch(/plugins: hostPluginTools\(/);
    });

    it('the window’s compose opens no plugin host; it reads the host’s through the replica', () => {
        const compose = code('src/main/compose.ts');
        expect(compose).not.toMatch(/PluginHost\.open\(/);
        expect(code('src/main/main.ts')).toMatch(/plugins: agentEngineLink\.client\.plugins\(\)/);
    });

    it('the host’s MCP server starts without waiting for a window; the window no longer sends plugin tools', () => {
        const hostMcp = code('src/main/host-mcp.ts');
        expect(hostMcp).not.toMatch(/pluginTools/);
        expect(code('src/main/main.ts')).not.toMatch(/pluginTools: composed\.plugins\.tools\(\)/);
    });
});
