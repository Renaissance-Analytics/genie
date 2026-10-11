import { describe, expect, it } from 'vitest';
import { configSync } from '../src/core/integrations.js';
import { configSyncTargets, type SyncFs } from '../src/main/config-sync-targets.js';

/**
 * CONFIG SYNC (§6.9) — Genie's MCP endpoint written into FOUR independent targets in a workspace, so
 * every harness a person opens there finds Genie: Claude Code's `.mcp.json`, Cursor's
 * `.cursor/mcp.json`, Codex's `.codex/config.toml`, and the imDone Stop hook in
 * `.claude/settings.local.json`. Each merges into what is there (other servers and a person's own
 * entries stay), each is gated by its own setting, and one failing never hides the others.
 */

function memFs(initial: Record<string, string> = {}) {
    const files = new Map(Object.entries(initial));
    const fs: SyncFs = {
        read: async (p) => files.get(p) ?? null,
        write: async (p, text) => { if (p.endsWith('/.cursor/mcp.json') && files.has('__cursor_fails__')) throw new Error('EACCES: .cursor is read-only'); files.set(p, text); },
    };
    return { fs, files };
}

const payload = { GENIE_MCP_URL: 'http://127.0.0.1:51717/mcp/abc', GENIE_MCP_TOKEN: 'tok' };
const flags = { mcp_sync_claude: true, mcp_sync_cursor: true, mcp_sync_codex: true, mcp_sync_hooks: true };

describe('the four targets', () => {
    it('are four, in a fixed order, each named for a person', () => {
        const targets = configSyncTargets({ workspacePath: '/w/tynn', fs: memFs().fs, flags });
        expect(targets.map((t) => t.id)).toEqual(['claude', 'cursor', 'codex', 'hooks']);
        expect(targets.map((t) => t.label)).toEqual(['Claude Code (.mcp.json)', 'Cursor (.cursor/mcp.json)', 'Codex (.codex/config.toml)', 'Claude Code Stop hook (.claude/settings.local.json)']);
    });

    it('JSON targets MERGE: Genie’s server entry is added or replaced, other servers and keys stay; a missing file is created', async () => {
        const m = memFs({ '/w/tynn/.mcp.json': JSON.stringify({ mcpServers: { tynn: { url: 'https://tynn.ai/mcp' } }, other: 1 }) });
        const results = await configSync(configSyncTargets({ workspacePath: '/w/tynn', fs: m.fs, flags }), payload);
        expect(results.every((r) => r.ok)).toBe(true);
        const claude = JSON.parse(m.files.get('/w/tynn/.mcp.json')!);
        expect(claude.other).toBe(1);
        expect(claude.mcpServers.tynn).toEqual({ url: 'https://tynn.ai/mcp' });
        expect(claude.mcpServers.genie).toEqual({ type: 'http', url: 'http://127.0.0.1:51717/mcp/abc', headers: { Authorization: 'Bearer tok' } });
        const cursor = JSON.parse(m.files.get('/w/tynn/.cursor/mcp.json')!);
        expect(cursor.mcpServers.genie.url).toBe('http://127.0.0.1:51717/mcp/abc');
    });

    it('the Codex target writes one marked TOML block and replaces it on the next sync rather than appending twice', async () => {
        const m = memFs({ '/w/tynn/.codex/config.toml': 'model = "o3"\n' });
        const targets = configSyncTargets({ workspacePath: '/w/tynn', fs: m.fs, flags });
        await configSync(targets, payload);
        await configSync(targets, { ...payload, GENIE_MCP_URL: 'http://127.0.0.1:60000/mcp/def' });
        const toml = m.files.get('/w/tynn/.codex/config.toml')!;
        expect(toml.startsWith('model = "o3"\n')).toBe(true);
        expect(toml.match(/# >>> genie/g)).toHaveLength(1);
        expect(toml).toContain('[mcp_servers.genie]');
        expect(toml).toContain('url = "http://127.0.0.1:60000/mcp/def"');
        expect(toml).not.toContain('51717');
    });

    it('the hooks target seeds the imDone Stop hook once, keeping a person’s other hooks', async () => {
        const m = memFs({ '/w/tynn/.claude/settings.local.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }) });
        const targets = configSyncTargets({ workspacePath: '/w/tynn', fs: m.fs, flags });
        await configSync(targets, payload);
        await configSync(targets, payload);
        const settings = JSON.parse(m.files.get('/w/tynn/.claude/settings.local.json')!);
        expect(settings.hooks.PreToolUse).toHaveLength(1);
        expect(settings.hooks.Stop).toHaveLength(1);
        expect(JSON.stringify(settings.hooks.Stop[0])).toMatch(/imDone/);
        expect(JSON.stringify(settings.hooks.Stop[0])).toContain('http://127.0.0.1:51717/mcp/abc');
    });

    it('a target whose setting is off writes nothing and does not remove what is there; a failing target reports alone', async () => {
        const m = memFs({ '/w/tynn/.cursor/mcp.json': JSON.stringify({ mcpServers: { genie: { url: 'http://old' } } }), __cursor_fails__: '1' });
        const off = await configSync(configSyncTargets({ workspacePath: '/w/tynn', fs: m.fs, flags: { ...flags, mcp_sync_cursor: false } }), payload);
        expect(off.find((r) => r.id === 'cursor')).toEqual({ id: 'cursor', label: 'Cursor (.cursor/mcp.json)', ok: true });
        expect(JSON.parse(m.files.get('/w/tynn/.cursor/mcp.json')!).mcpServers.genie.url).toBe('http://old');

        const failing = await configSync(configSyncTargets({ workspacePath: '/w/tynn', fs: m.fs, flags }), payload);
        expect(failing.find((r) => r.id === 'cursor')).toMatchObject({ ok: false, error: 'EACCES: .cursor is read-only' });
        expect(failing.filter((r) => r.ok).map((r) => r.id)).toEqual(['claude', 'codex', 'hooks']);
    });
});
