import { describe, expect, it } from 'vitest';
import { configSyncTargets, type SyncFs } from '../src/main/config-sync-targets.js';

/**
 * A GENIE 1 WORKSPACE IS UPGRADED, NOT LEFT STRANDED (the owner: "it needs to be able to upgrade workspace files if that
 * is needed. workspace agents cannot be left stranded"). Genie 1 wrote its own entries into every workspace; Genie 2's
 * sync wrote its endpoint beside them and left the rest, so a Genie 1 workspace kept a `genie-agentinbox-channel`
 * server whose bridge Genie 2 does not run, a second `[mcp_servers.genie]` table in Codex's config (invalid TOML — two
 * tables of one name), Genie 1's SessionStart hook, and a second imDone Stop hook (Genie 1 escapes the JSON in its
 * command, so Genie 2's match missed it). The sync now upgrades: one current `genie` entry per harness, Genie 1's
 * channel entry and bridge script gone, Genie 1's Codex blocks gone, one Stop hook — and every other server, block
 * and hook a person or another tool wrote is left exactly as it was.
 */
function memFs(files: Record<string, string>) {
    const store = new Map(Object.entries(files));
    const removed: string[] = [];
    const fs: SyncFs = { read: async (p) => store.get(p) ?? null, write: async (p, t) => { store.set(p, t); }, remove: async (p) => { if (store.delete(p)) removed.push(p); } };
    return { fs, store, removed };
}
const W = '/w/moic';
const payload = { GENIE_MCP_URL: 'http://127.0.0.1:4100/mcp', GENIE_MCP_TOKEN: 'tok-new' };
const flags = { mcp_sync_claude: true, mcp_sync_cursor: true, mcp_sync_codex: true, mcp_sync_hooks: true };
const run = async (fs: SyncFs) => { for (const t of configSyncTargets({ workspacePath: W, fs, flags })) await t.write(payload); };

const V1_HOOK = `curl -s -X POST "$GENIE_MCP_URL" -H 'Content-Type: application/json' -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"imDone\\",\\"arguments\\":{\\"terminalId\\":\\"$GENIE_TERMINAL_ID\\"}}}" >/dev/null 2>&1 || true`;

describe('Claude Code (.mcp.json)', () => {
    it('the genie entry is current; Genie 1\'s channel entry and its bridge script are gone; other servers stay', async () => {
        const { fs, store, removed } = memFs({
            [`${W}/.mcp.json`]: JSON.stringify({ mcpServers: {
                genie: { type: 'http', url: 'http://127.0.0.1:51717/mcp/oldtoken' },
                'genie-agentinbox-channel': { command: 'node', args: ['.agents/_genie/agentinbox-claude-channel.cjs'] },
                tynn: { type: 'http', url: 'https://tynn.ai/mcp' },
            } }),
            [`${W}/.agents/_genie/agentinbox-claude-channel.cjs`]: '// genie 1 bridge',
        });
        await run(fs);
        const servers = JSON.parse(store.get(`${W}/.mcp.json`)!).mcpServers;
        expect(Object.keys(servers).sort()).toEqual(['genie', 'tynn']);
        expect(servers.genie).toEqual({ type: 'http', url: 'http://127.0.0.1:4100/mcp', headers: { Authorization: 'Bearer tok-new' } });
        expect(servers.tynn).toEqual({ type: 'http', url: 'https://tynn.ai/mcp' });
        expect(removed).toEqual([`${W}/.agents/_genie/agentinbox-claude-channel.cjs`]);
    });
});

describe('Codex (.codex/config.toml)', () => {
    it('Genie 1\'s genie block and session hook are gone, ONE genie table remains, a person\'s own lines stay', async () => {
        const v1 = [
            'model = "gpt-5"',
            '# BEGIN GENIE MCP: genie',
            '[mcp_servers.genie]',
            "url = 'http://127.0.0.1:51717/mcp/oldtoken'",
            '# END GENIE MCP: genie',
            '# BEGIN GENIE MCP: tynn',
            '[mcp_servers.tynn]',
            "url = 'https://tynn.ai/mcp'",
            '# END GENIE MCP: tynn',
            '# BEGIN GENIE CODEX SESSION HOOK',
            '[[hooks.SessionStart]]',
            'matcher = "startup|resume|clear"',
            '# END GENIE CODEX SESSION HOOK',
            '',
        ].join('\n');
        const { fs, store } = memFs({ [`${W}/.codex/config.toml`]: v1 });
        await run(fs);
        const toml = store.get(`${W}/.codex/config.toml`)!;
        expect(toml.match(/\[mcp_servers\.genie\]/g)).toHaveLength(1);
        expect(toml).toContain('url = "http://127.0.0.1:4100/mcp"');
        expect(toml).not.toContain('51717');
        expect(toml).not.toContain('GENIE CODEX SESSION HOOK');
        expect(toml).not.toContain('[[hooks.SessionStart]]');
        expect(toml).toContain('model = "gpt-5"');
        expect(toml).toContain('[mcp_servers.tynn]');
    });
});

describe('the Stop hook (.claude/settings.local.json)', () => {
    it('Genie 1\'s escaped imDone hook is REPLACED, not joined by a second; a person\'s own Stop hook stays', async () => {
        const { fs, store } = memFs({ [`${W}/.claude/settings.local.json`]: JSON.stringify({ enableAllProjectMcpServers: true, hooks: { Stop: [
            { hooks: [{ type: 'command', command: V1_HOOK }] },
            { hooks: [{ type: 'command', command: 'say done' }] },
        ] } }) });
        await run(fs);
        const stop = JSON.parse(store.get(`${W}/.claude/settings.local.json`)!).hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
        const commands = stop.flatMap((s) => s.hooks.map((h) => h.command));
        expect(commands.filter((c) => c.includes('imDone'))).toHaveLength(1);
        expect(commands).toContain('say done');
        expect(commands.join('\n')).not.toContain('\\"name\\"');
    });
});
