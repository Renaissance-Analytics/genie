import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTrustBook } from '../src/core/envelope-sites.js';
import { trustHash, type GitConfigEntry } from '../src/core/workspace-trust.js';
import { configSyncTargets } from '../src/main/config-sync-targets.js';
import { WorkspaceTrust, readTrustList, type TrustListPorts } from '../src/main/workspace-trust-host.js';

/** What a workspace's own files say would run, and the one verdict everything reads. Invented names; the files are a map. */

const W = join('/ws', 'acme');
const at = (...parts: string[]) => join(W, ...parts);
const IMDONE = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"imDone","arguments":{"terminalId":"$GENIE_TERMINAL_ID"}}}';
const genieStop = `curl -s -X POST -H "Authorization: Bearer abc.def" -H "Content-Type: application/json" -H "Mcp-Param-TerminalId: $GENIE_TERMINAL_ID" --data '${IMDONE}' http://127.0.0.1:4123/mcp > /dev/null`;
const stopHook = { hooks: [{ type: 'command', command: genieStop }] };

function ports(files: Record<string, string>, git: Record<string, GitConfigEntry[]> = {}): TrustListPorts & { files: Map<string, string> } {
    const map = new Map(Object.entries(files));
    return { files: map, readText: async (p) => map.get(p) ?? null, gitConfig: async (cwd) => git[cwd] ?? [] };
}

describe('the list', () => {
    it('a folder with nothing in it says nothing', async () => {
        expect(await readTrustList(W, ports({}))).toEqual({ sites: [], hooks: [], servers: [], gitKeys: [], approvals: [] });
    });

    it('names each hook, in each settings file, and any other setting those files hold', async () => {
        const list = await readTrustList(W, ports({
            [at('.claude', 'settings.json')]: JSON.stringify({ hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'one' }] }] }, apiKeyHelper: 'two' }),
            [at('.claude', 'settings.local.json')]: JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'three' }] }] } }),
        }));
        expect(list.hooks).toEqual(expect.arrayContaining([
            { file: '.claude/settings.json', event: 'SessionStart', command: 'one' },
            { file: '.claude/settings.json', event: 'apiKeyHelper', command: '"two"' },
            { file: '.claude/settings.local.json', event: 'PreToolUse', command: 'three' },
        ]));
    });

    it("leaves out what Genie itself wrote, or it would ask every time: its Stop hook, and its genie and tynn servers", async () => {
        const list = await readTrustList(W, ports({
            [at('.claude', 'settings.local.json')]: JSON.stringify({ hooks: { Stop: [stopHook] } }),
            [at('.mcp.json')]: JSON.stringify({ mcpServers: { genie: { url: 'http://x.invalid' }, tynn: { url: 'http://y.invalid' }, theirs: { command: 'node', args: ['server.js'] } } }),
        }));
        expect(list.hooks).toEqual([]);
        expect(list.servers).toEqual([{ file: '.mcp.json', name: 'theirs', command: 'node server.js' }]);
    });

    it("what merely looks like Genie's stays on the list: a hook that adds to its command, one pointed elsewhere, and a server named genie that starts a program", async () => {
        const list = await readTrustList(W, ports({
            [at('.claude', 'settings.json')]: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `${genieStop}; other-thing imDone GENIE_MCP_URL` }] }, { hooks: [{ type: 'command', command: genieStop.replace('127.0.0.1', 'x.invalid') }] }] } }),
            [at('.mcp.json')]: JSON.stringify({ mcpServers: { genie: { command: 'node', args: ['theirs.js'] } } }),
            [at('.codex', 'config.toml')]: '[mcp_servers.tynn]\ncommand = "node"\nargs = ["theirs.js"]\n',
        }));
        expect(list.hooks).toHaveLength(2);
        expect(list.servers).toEqual([{ file: '.mcp.json', name: 'genie', command: 'node theirs.js' }, { file: '.codex/config.toml', name: 'tynn', command: 'node theirs.js' }]);
    });

    it("everything Genie's real writer puts in a workspace is left off, with a token and without: Genie's own files never make it ask", async () => {
        for (const GENIE_MCP_TOKEN of ['aB3-_.~+/=', '']) {
            const files = new Map<string, string>();
            const targets = configSyncTargets({ workspacePath: W, fs: { read: async (p) => files.get(p) ?? null, write: async (p, text) => { files.set(p, text); } }, flags: { mcp_sync_claude: true, mcp_sync_cursor: true, mcp_sync_codex: true, mcp_sync_hooks: true } });
            for (const target of targets) await target.write({ GENIE_MCP_URL: 'http://127.0.0.1:43127/mcp', GENIE_MCP_TOKEN });
            expect(files.has(at('.claude', 'settings.local.json'))).toBe(true);
            expect(files.has(at('.mcp.json'))).toBe(true);
            expect(await readTrustList(W, { readText: async (p) => files.get(p) ?? null, gitConfig: async () => [] })).toEqual({ sites: [], hooks: [], servers: [], gitKeys: [], approvals: [] });
        }
    });

    describe('settings', () => {
        const local = (permissions: Record<string, unknown>, tracked = false) => readTrustList(W, { ...ports({ [at('.claude', 'settings.local.json')]: JSON.stringify({ permissions }) }), isTracked: async () => tracked });
        const shared = (settings: Record<string, unknown>) => readTrustList(W, ports({ [at('.claude', 'settings.json')]: JSON.stringify(settings) }));

        it.each(['apiKeyHelper', 'statusLine', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'env', 'fileSuggestion', 'enabledPlugins', 'extraKnownMarketplaces', 'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'sandbox', 'disableAllHooks', 'model', 'outputStyle', 'agent', 'processWrapper', 'a-key-nobody-has-listed'])('%s is on the list', async (key) => {
            expect((await shared({ [key]: 'x' })).hooks).toEqual([{ file: '.claude/settings.json', event: key, command: '"x"' }]);
        });

        it.each(['$schema', 'theme', 'spinnerTipsEnabled', 'terminalProgressBarEnabled', 'showTurnDuration', 'prefersReducedMotion', 'viewMode', 'editorMode', 'syntaxHighlightingDisabled', 'verbose'])('%s changes how it looks and nothing else', async (key) => {
            expect((await shared({ [key]: 'x' })).hooks).toEqual([]);
        });

        it('the committed file: every part of permissions is on the list', async () => {
            expect((await shared({ permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(npm test:*)'] } })).hooks).toEqual([{ file: '.claude/settings.json', event: 'permissions', command: JSON.stringify({ defaultMode: 'bypassPermissions', allow: ['Bash(npm test:*)'] }) }]);
        });

        it('settings.local.json that git tracks is the repository speaking: all of it counts', async () => {
            expect((await local({ allow: ['Bash(npm test:*)'] }, true)).hooks).toEqual([{ file: '.claude/settings.local.json', event: 'permissions', command: JSON.stringify({ allow: ['Bash(npm test:*)'] }) }]);
        });

        it('untracked: a narrow allow is a person approving a command, so it is shown and not hashed, and more of them never ask', async () => {
            const before = await local({ allow: ['Bash(npm test:*)'] });
            const after = await local({ allow: ['Bash(npm test:*)', 'Bash(git status:*)'] });
            expect(before.approvals).toEqual(['Bash(npm test:*)']);
            expect(after.approvals).toEqual(['Bash(npm test:*)', 'Bash(git status:*)']);
            expect(trustHash(before)).toBe(trustHash(after));
        });

        it.each([['defaultMode', { defaultMode: 'bypassPermissions' }], ['additionalDirectories', { additionalDirectories: ['/'] }], ['deny', { deny: ['Bash'] }], ['ask', { ask: ['Bash'] }]])('untracked: %s still counts', async (_key, permissions) => {
            expect(trustHash(await local(permissions))).not.toBe(trustHash(await local({})));
        });

        it.each(['Bash', 'Bash(*)', 'Bash(:*)', 'PowerShell(*)', '*', 'mcp__x', 'Write', 'Edit(**)', 'Bash(*:*)'])('untracked: an allow as wide as %s is no person approving one command: it counts', async (rule) => {
            expect(trustHash(await local({ allow: [rule] }))).not.toBe(trustHash(await local({})));
        });

        it('a tracked check that cannot answer counts as tracked', async () => {
            const list = await readTrustList(W, { ...ports({ [at('.claude', 'settings.local.json')]: JSON.stringify({ permissions: { allow: ['Bash(x:*)'] } }) }), isTracked: async () => { throw new Error('no answer'); } });
            expect(list.hooks).toHaveLength(1);
        });
    });

    it('reads a server from Codex config too', async () => {
        const list = await readTrustList(W, ports({ [at('.codex', 'config.toml')]: '[mcp_servers.theirs]\ncommand = "node"\nargs = ["server.js"]\n\n[mcp_servers.genie]\nurl = "http://x.invalid"\n' }));
        expect(list.servers).toEqual([{ file: '.codex/config.toml', name: 'theirs', command: 'node server.js' }]);
    });

    it('names each site by what it runs, and an npm command by the script it names', async () => {
        const list = await readTrustList(W, ports({
            [at('project.json')]: JSON.stringify({ name: 'Acme', sites: { k1: { repo: '', runMode: 'host', kind: 'http', enabled: true, name: 'web', genName: 'web.gen', command: ['npm', 'run', 'dev', '--port=1'] } } }),
            [at('package.json')]: JSON.stringify({ scripts: { dev: 'vite' } }),
        }));
        expect(list.sites).toHaveLength(1);
        expect(list.sites[0]).toMatchObject({ key: 'k1', folder: '.', npmScript: 'vite' });
        expect(list.sites[0]!.runs).toContain('npm run dev');
    });

    it('takes the git keys that could run something, from the folder and each of its repos', async () => {
        const list = await readTrustList(W, ports(
            { [at('project.json')]: JSON.stringify({ name: 'Acme', repos: [{ name: 'shop', slug: 'shop', path: 'repos/shop' }] }) },
            { [W]: [{ key: 'core.bare', value: 'false' }], [at('repos', 'shop')]: [{ key: 'core.fsmonitor', value: 'x' }] },
        ));
        expect(list.gitKeys).toEqual([{ key: 'core.fsmonitor', value: 'x' }]);
    });

    it('a settings file that cannot be read as JSON is on the list, whole, rather than skipped', async () => {
        const list = await readTrustList(W, ports({ [at('.claude', 'settings.json')]: '{ not json' }));
        expect(list.hooks).toEqual([{ file: '.claude/settings.json', event: 'unreadable', command: '{ not json' }]);
    });
});

function trust(files: Record<string, string>, over: { carried?: string[]; workspaces?: Record<string, string> } = {}) {
    const p = ports(files);
    const record = { carried: over.carried ?? [], workspaces: { ...(over.workspaces ?? {}) } };
    const approved: string[] = [];
    const saved: Array<Record<string, string>> = [];
    const host = new WorkspaceTrust({
        ...p,
        workspaces: () => [{ id: 'acme', path: W }],
        record: () => record,
        recordWorkspace: async (id, hash) => { record.workspaces[id] = hash; saved.push({ ...record.workspaces }); },
        approveSites: async (id) => { approved.push(id); },
    });
    return { host, p, record, approved, saved };
}
const hooked = (command: string) => ({ [at('.claude', 'settings.json')]: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }) });

describe('the verdict, as a workspace changes', () => {
    it('new, with something that would run: untrusted, and the list is there to show', async () => {
        const { host } = trust(hooked('x'));
        const view = await host.refresh('acme');
        expect(view).toMatchObject({ trusted: false, changed: false });
        expect(view?.list.hooks).toHaveLength(1);
        expect(host.isTrustedPath(W)).toBe(false);
    });

    it('the person says yes: trusted, recorded, and its sites lifted with it', async () => {
        const { host, record, approved } = trust(hooked('x'));
        await host.refresh('acme');
        const view = await host.trust('acme');
        expect(view).toMatchObject({ trusted: true, changed: false });
        expect(record.workspaces['acme']).toBeDefined();
        expect(approved).toEqual(['acme']);
        expect(host.isTrustedPath(at('repos', 'shop'))).toBe(true);
    });

    it('then the list changes: it asks again, and says it changed', async () => {
        const { host, p } = trust(hooked('x'));
        await host.trust('acme');
        p.files.set(at('.claude', 'settings.json'), hooked('y')[at('.claude', 'settings.json')]!);
        expect(await host.refresh('acme')).toMatchObject({ trusted: false, changed: true });
        expect(host.isTrustedPath(W)).toBe(false);
    });

    it('carried over at the upgrade: trusted once, its list recorded, and a change after that asks', async () => {
        const { host, p, record } = trust(hooked('x'), { carried: ['acme'] });
        expect(await host.refresh('acme')).toMatchObject({ trusted: true });
        expect(record.workspaces['acme']).toBeDefined();
        p.files.set(at('.claude', 'settings.json'), hooked('y')[at('.claude', 'settings.json')]!);
        expect(await host.refresh('acme')).toMatchObject({ trusted: false, changed: true });
    });

    it('nothing would run: trusted without asking, and nothing recorded', async () => {
        const { host, record } = trust({});
        expect(await host.refresh('acme')).toMatchObject({ trusted: true });
        expect(record.workspaces).toEqual({});
    });

    it('a folder Genie knows nothing about, or one merely named alike, is not trusted', async () => {
        const { host } = trust(hooked('x'));
        await host.trust('acme');
        expect(host.isTrustedPath(join('/ws', 'acme-other'))).toBe(false);
        expect(host.isTrustedPath(join('/elsewhere'))).toBe(false);
    });

    it('before the first read, nothing is called trusted', () => {
        const { host } = trust({}, { workspaces: { acme: 'x' } });
        expect(host.isTrustedPath(W)).toBe(false);
    });

    it('trust that fails to save says so, and leaves it untrusted', async () => {
        const { host } = trust(hooked('x'));
        const failing = new WorkspaceTrust({ ...ports(hooked('x')), workspaces: () => [{ id: 'acme', path: W }], record: () => ({ carried: [], workspaces: {} }), recordWorkspace: async () => { throw new Error('EROFS'); }, approveSites: async () => {} });
        await expect(failing.trust('acme')).rejects.toThrow(/EROFS/);
        expect(failing.isTrustedPath(W)).toBe(false);
        expect(host.isTrustedPath(W)).toBe(false);
    });
});

describe('the record', () => {
    it('one written before this existed reads with no workspaces, and its carried list stands', () => {
        expect(parseTrustBook({ version: 1, carried: ['acme'], pendingCarry: [], sites: {} })).toMatchObject({ carried: ['acme'], workspaces: {} });
    });
    it('workspaces that are not hashes make the whole record unbelievable', () => {
        expect(parseTrustBook({ version: 1, carried: [], pendingCarry: [], sites: {}, workspaces: { acme: 1 } })).toBeNull();
    });
});
