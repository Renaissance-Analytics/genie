import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHostMcp, type HostMcp, type HostMcpPorts } from '../src/main/host-mcp.js';
import { hostPluginTools, PluginsService } from '../src/main/plugins-host.js';
import { PluginsReplica } from '../src/main/plugins-replica.js';
import { composeServices } from '../src/main/compose.js';
import type { PtyPort } from '../src/main/terminal-host.js';

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
/**
 * The MCP server remembers its endpoint in a PRIVATE file it writes without waiting (host-mcp.ts `remember.write`), and on
 * Windows that write ends by restricting the file's ACL. A test that removes its folder at once races that ACL step, which
 * then fails on a file that is gone (test/helpers/acl-guard.ts counts it). The endpoint files live in a folder kept for
 * the whole file, removed once every write has long finished.
 */
let endpoints: string;
beforeAll(async () => { endpoints = await mkdtemp(join(tmpdir(), 'genie-host-catalog-endpoints-')); });
afterAll(async () => { await rm(endpoints, { recursive: true, force: true }); });
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
        endpointFile: join(endpoints, `mcp-endpoint-${Math.random().toString(36).slice(2)}.json`),
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
        const service = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, publisherChecksOff: () => false });
        mcp = startHostMcp(ports(hostPluginTools(service, { sandboxDir: join(dir, 'sandbox'), api: async () => { throw new Error('none'); } }), () => false));
        await until(() => mcp!.endpoint() !== null);
        expect(mcp.status().tools.map((t) => t.name)).toContain(SHEET);
        const workspace = join(dir, 'ws');
        const answer = await mcp.runNative({ name: SHEET, args: { title: 'Q3', rows: [['a', 1]], headers: ['k', 'v'] }, headers: {}, caller: { agentId: 'a1', agentName: 'atlas', workspaceId: 'w', workspacePath: workspace } as never });
        expect(answer.isError, answer.text).toBe(false);
        expect(await readdir(workspace)).toContain('q3.xlsx');
    });

    it('the plugin tool is the host’s own: run here, never forwarded to a window (CONTROL: a window tool still is)', async () => {
        const service = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, publisherChecksOff: () => false });
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
        const service = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, publisherChecksOff: () => false });
        const dump = service.dump();
        expect(dump.entries.map((e) => e.id)).toEqual(['ai.genie.document', 'ai.genie.spreadsheet', 'ai.genie.presentation', 'ai.genie.repository', 'ai.genie.artboard']);
        expect(dump.editors.map((e) => `${e.pluginId}.${e.id}`)).toEqual(['ai.genie.document.document', 'ai.genie.spreadsheet.sheet', 'ai.genie.presentation.deck']);
        expect(dump.panels.map((p) => `${p.pluginId}.${p.id}`)).toEqual(['ai.genie.repository.changes', 'ai.genie.artboard.board']);
    });

    it('a replica answers what the window asks (list, panels, editors, an editor’s bytes) from the host’s dump, and asks the host to change', async () => {
        const service = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, publisherChecksOff: () => false });
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
        expect(host).toMatch(/await openMarketplacePlugins\(\{/);
        expect(code('src/main/marketplace-client.ts')).toMatch(/await PluginsService\.open\(\{/);
        expect(host).toMatch(/const pluginsService = marketplacePlugins\.plugins/);
        expect(host).toMatch(/const clocks: Array<\{ stop\(\): void \}> = \[marketplacePlugins\]/);
        expect(host).toMatch(/maxResponseBytes: MARKETPLACE_PAGE_BYTES/);
        expect(host).toMatch(/plugins: hostPluginTools\(/);
    });

    it('the window’s compose opens a plugin host ONLY when no genie-host gave it the plugins; with one it reads the replica', () => {
        const compose = code('src/main/compose.ts');
        expect(compose.match(/PluginHost\.open\(/g) ?? []).toHaveLength(1);
        expect(compose).toMatch(/const ownPlugins = input\.plugins \? null : await openOwnPlugins\(\)/);
        expect(code('src/main/main.ts')).toMatch(/plugins: agentEngineLink\.client\.plugins\(\)/);
    });

    it('with no genie-host the window serves its own plugins’ tools, as before; with one it serves none', () => {
        expect(code('src/main/main.ts')).toMatch(/plugins: composed\.ownPlugins \? localPluginTools\(composed\.ownPlugins,/);
    });

    it('the host’s MCP server starts without waiting for a window; the window no longer sends plugin tools', () => {
        const hostMcp = code('src/main/host-mcp.ts');
        expect(hostMcp).not.toMatch(/pluginTools/);
        expect(code('src/main/main.ts')).not.toMatch(/pluginTools: composed\.plugins\.tools\(\)/);
    });
});

/**
 * THE EMERGENCY PATH KEEPS ITS PLUGINS (the coordinator's ruling for the owner, 2026-11-08: "a window with no genie-host
 * still loads plugins itself, as today, so there's no regression. genie-host owns them whenever it's present").
 */
describe('a window with no genie-host still has its plugins', () => {
    const pty: PtyPort = {
        open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };

    it('composed with no host: it opens its own plugin host — the list, the editors, a change, and the plugins’ tools', async () => {
        const services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
        try {
            expect(services.plugins.list().map((e) => e.id)).toEqual(['ai.genie.document', 'ai.genie.spreadsheet', 'ai.genie.presentation', 'ai.genie.repository', 'ai.genie.artboard']);
            expect(services.plugins.editors().map((e) => e.id)).toEqual(['document', 'sheet', 'deck']);
            expect(services.plugins.editorBytes('ai.genie.spreadsheet', '/w/a.xlsx')).toMatchObject({ allowed: true });
            expect(await services.plugins.setEnabled('ai.genie.document', false)).toBe(true);
            expect(services.plugins.editors().map((e) => e.id)).toEqual(['sheet', 'deck']);
            expect(services.ownPlugins?.tools().map((t) => `${t.pluginId}.${t.tool.name}`)).toContain(SHEET);
        } finally {
            await services.shutdown();
        }
    });

    it('CONTROL: composed with the host’s replica it opens none — the host owns them', async () => {
        const replica = new PluginsReplica(async () => true);
        const services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, plugins: replica });
        try {
            expect(services.ownPlugins).toBeNull();
            expect(services.plugins).toBe(replica);
        } finally {
            await services.shutdown();
        }
    });
});
