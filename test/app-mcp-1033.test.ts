import { describe, expect, it } from 'vitest';
import { APP_MCP_WORDS, appMcpCandidates, appMcpServersFor, parseAppMcpEntry, withAppMcp, withoutAppMcp, type AppMcpEntry } from '../src/core/app-mcp.js';

/**
 * AN AGENT'S APP MCP SERVERS (Tynn #1033; the owner, 2026-11-22: "Genie agents need to be able to use mcp connections
 * locally made by apps they are building on a per agent basis that is configurable in the agent settings").
 *
 * Per agent, on its record (`appMcp`): an MCP server an app in its workspace serves. Either one of the workspace's Genie
 * sites and a path (`/mcp`), resolved at each session start through Genie's own router (the target the `.gen` front door
 * proxies to), or a loopback URL the person entered. Local addresses only; no secrets (keys belong in the vault, #1024).
 */

const SITES = [
    { id: 's1', name: 'shop', host: 'shop.gen' },
    { id: 's2', name: 'blog', host: 'blog.gen' },
];

describe('what may be added', () => {
    it('a site of this workspace, by id, name or host: kept by its id, with /mcp when no path is given', () => {
        for (const site of ['s1', 'shop', 'shop.gen']) {
            expect(parseAppMcpEntry({ site }, SITES)).toEqual({ ok: true, entry: { name: 'shop', site: 's1', path: '/mcp' } });
        }
        expect(parseAppMcpEntry({ name: 'shop-api', site: 'shop', path: '/api/mcp' }, SITES)).toEqual({ ok: true, entry: { name: 'shop-api', site: 's1', path: '/api/mcp' } });
    });

    it('a .gen URL of one of its sites becomes that site, with the URL’s path', () => {
        expect(parseAppMcpEntry({ url: 'https://blog.gen/mcp/v1' }, SITES)).toEqual({ ok: true, entry: { name: 'blog', site: 's2', path: '/mcp/v1' } });
        expect(parseAppMcpEntry({ url: 'https://blog.gen/' }, SITES)).toEqual({ ok: true, entry: { name: 'blog', site: 's2', path: '/mcp' } });
    });

    it('a loopback URL is kept as it is (localhost, 127.0.0.1, [::1]); its name from its port unless given', () => {
        expect(parseAppMcpEntry({ url: 'http://127.0.0.1:8000/mcp' }, SITES)).toEqual({ ok: true, entry: { name: 'app-8000', url: 'http://127.0.0.1:8000/mcp' } });
        expect(parseAppMcpEntry({ name: 'vite', url: 'http://localhost:5173/mcp' }, SITES)).toEqual({ ok: true, entry: { name: 'vite', url: 'http://localhost:5173/mcp' } });
        expect(parseAppMcpEntry({ url: 'http://[::1]:9000/mcp' }, SITES)).toMatchObject({ ok: true, entry: { url: 'http://[::1]:9000/mcp' } });
    });

    it('REFUSED: an address that is not local, or a .gen host that is not one of this workspace’s sites', () => {
        expect(parseAppMcpEntry({ url: 'https://mcp.example.com/mcp' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.localOnly });
        expect(parseAppMcpEntry({ url: 'http://10.0.0.5:8000/mcp' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.localOnly });
        expect(parseAppMcpEntry({ url: 'http://127.0.0.1.example.com/mcp' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.localOnly });
        expect(parseAppMcpEntry({ url: 'https://other.gen/mcp' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.noSite('other.gen') });
        expect(parseAppMcpEntry({ site: 'nope' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.noSite('nope') });
        expect(parseAppMcpEntry({ url: 'file:///etc/passwd' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.localOnly });
        expect(parseAppMcpEntry({ url: 'not a url' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.localOnly });
    });

    it('REFUSED: anything that carries a secret (credentials in the URL, a query, headers, a token): the vault is for keys', () => {
        for (const input of [
            { url: 'http://user:pass@127.0.0.1:8000/mcp' },
            { url: 'http://127.0.0.1:8000/mcp?token=abc' },
            { url: 'http://127.0.0.1:8000/mcp#k=1' },
            { site: 'shop', path: '/mcp?key=1' },
            { site: 'shop', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
            { url: 'http://127.0.0.1:8000/mcp', token: 'x' },
        ]) expect(parseAppMcpEntry(input, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.noSecrets });
    });

    it('REFUSED: neither a site nor a URL; a bad path; a name Genie keeps for its own servers', () => {
        expect(parseAppMcpEntry({}, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.what });
        expect(parseAppMcpEntry(null, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.what });
        expect(parseAppMcpEntry({ site: 'shop', url: 'http://127.0.0.1:1/mcp' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.what });
        expect(parseAppMcpEntry({ site: 'shop', path: 'mcp' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.path });
        expect(parseAppMcpEntry({ site: 'shop', path: '/a b' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.path });
        for (const name of ['genie', 'tynn', 'fancy-ui']) expect(parseAppMcpEntry({ name, site: 'shop' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.reserved(name) });
        expect(parseAppMcpEntry({ name: 'has space', site: 'shop' }, SITES)).toEqual({ ok: false, reason: APP_MCP_WORDS.name });
    });
});

describe('the agent’s list', () => {
    const shop: AppMcpEntry = { name: 'shop', site: 's1', path: '/mcp' };
    it('adds one; refuses a second of the same name; removes by name; refuses a name it does not have', () => {
        const one = withAppMcp([], shop);
        expect(one).toEqual({ ok: true, list: [shop] });
        expect(withAppMcp([shop], { name: 'shop', url: 'http://127.0.0.1:1/mcp' })).toEqual({ ok: false, reason: APP_MCP_WORDS.taken('shop') });
        expect(withoutAppMcp([shop], 'shop')).toEqual({ ok: true, list: [] });
        expect(withoutAppMcp([shop], 'blog')).toEqual({ ok: false, reason: APP_MCP_WORDS.unknown('blog') });
    });
});

describe('what Genie offers to add (the workspace’s sites and processes)', () => {
    it('each site at /mcp; a process whose port Genie can read (PORT, --port); none for a process without one; marks what is added', () => {
        const got = appMcpCandidates(SITES, [
            { id: 'p1', name: 'api', command: 'node server.js', env: { PORT: '7000' } },
            { id: 'p2', name: 'artisan', command: 'php artisan serve --port=8001' },
            { id: 'p3', name: 'vite', command: 'npx vite --port 5173' },
            { id: 'p4', name: 'worker', command: 'php artisan queue:work' },
        ], [{ name: 'shop', site: 's1', path: '/mcp' }]);
        expect(got).toEqual([
            { kind: 'site', name: 'shop', site: 's1', label: 'shop.gen', url: 'https://shop.gen/mcp', added: true },
            { kind: 'site', name: 'blog', site: 's2', label: 'blog.gen', url: 'https://blog.gen/mcp', added: false },
            { kind: 'process', name: 'api', label: 'api', url: 'http://127.0.0.1:7000/mcp', added: false },
            { kind: 'process', name: 'artisan', label: 'artisan', url: 'http://127.0.0.1:8001/mcp', added: false },
            { kind: 'process', name: 'vite', label: 'vite', url: 'http://127.0.0.1:5173/mcp', added: false },
        ]);
    });
});

describe('what a session is handed', () => {
    const routes = [{ host: 'shop.gen', target: '127.0.0.1:41001' }];
    const list: AppMcpEntry[] = [
        { name: 'shop', site: 's1', path: '/mcp' },
        { name: 'blog', site: 's2', path: '/mcp' },
        { name: 'gone', site: 's9', path: '/mcp' },
        { name: 'app-8000', url: 'http://127.0.0.1:8000/mcp' },
    ];

    it('a running site through the router’s target; a loopback URL as it is; no headers; a stopped or gone site is not handed, and says why', () => {
        const got = appMcpServersFor({ appMcp: list }, { sites: SITES, routes, trusted: true });
        expect(got.servers).toEqual([
            { type: 'http', name: 'shop', url: 'http://127.0.0.1:41001/mcp', headers: [] },
            { type: 'http', name: 'app-8000', url: 'http://127.0.0.1:8000/mcp', headers: [] },
        ]);
        expect(got.skipped).toEqual([
            { name: 'blog', reason: APP_MCP_WORDS.notRunning('blog.gen') },
            { name: 'gone', reason: APP_MCP_WORDS.siteGone },
        ]);
    });

    it('one switched off for the agent, or off in its workspace without the agent’s own on, is not handed', () => {
        expect(appMcpServersFor({ appMcp: list, mcpOff: ['shop'] }, { sites: SITES, routes, trusted: true }).servers.map((s) => s.name)).toEqual(['app-8000']);
        expect(appMcpServersFor({ appMcp: list }, { sites: SITES, routes, trusted: true, workspaceOff: ['app-8000'] }).servers.map((s) => s.name)).toEqual(['shop']);
        expect(appMcpServersFor({ appMcp: list, mcpOn: ['app-8000'] }, { sites: SITES, routes, trusted: true, workspaceOff: ['app-8000'] }).servers.map((s) => s.name)).toEqual(['shop', 'app-8000']);
    });

    it('a workspace that is not trusted is handed none (its app’s code would be the agent’s tools)', () => {
        const got = appMcpServersFor({ appMcp: list }, { sites: SITES, routes, trusted: false });
        expect(got.servers).toEqual([]);
        expect(got.skipped.map((s) => s.reason)).toEqual(list.map(() => APP_MCP_WORDS.untrusted));
    });

    it('a stored entry that was tampered with (not local, a reserved name, a query) is never handed', () => {
        const bad = [
            { name: 'x', url: 'https://evil.example.com/mcp' },
            { name: 'genie', url: 'http://127.0.0.1:1/mcp' },
            { name: 'q', url: 'http://127.0.0.1:1/mcp?token=1' },
            { name: 'p', site: 's1', path: 'http://evil' },
        ] as unknown as AppMcpEntry[];
        expect(appMcpServersFor({ appMcp: bad }, { sites: SITES, routes, trusted: true }).servers).toEqual([]);
    });

    it('CONTROL: an agent with none is handed none, and nothing is skipped', () => {
        expect(appMcpServersFor({}, { sites: SITES, routes, trusted: true })).toEqual({ servers: [], skipped: [] });
    });
});
