import { expect, it } from 'vitest';
import type { SyncFs } from '../src/main/config-sync-targets.js';
import { TYNN_TOML_BEGIN, TYNN_TOML_END } from '../src/main/tynn-agent-token.js';

const token = 'synthetic-obsolete-key';
const managed = { type: 'http', url: 'https://tynn.ai/mcp/tynn', headers: { Authorization: `Bearer ${token}` } };
const json = (entry: unknown) => JSON.stringify({ keep: 42, mcpServers: { tynn: entry, other: { command: 'keep-server' } } });
function fixture(seed: Record<string, string>) {
    const files = new Map(Object.entries(seed)); const writes: string[] = [];
    const fs: SyncFs = { read: async (p) => files.get(p.replace(/\\/g, '/')) ?? null,
        write: async (p, text) => { writes.push(p); files.set(p.replace(/\\/g, '/'), text); } };
    const run = async () => {
        const module = await import('../src/main/tynn-config-cleanup.js');
        return module.reconcileLegacyTynnConfig({ workspacePath: '/workspace', fs });
    };
    return { files, writes, fs, run };
}

it('removes the JSON entries and both generations of marked Codex block while preserving unrelated data', async () => {
    const t = fixture({ '/workspace/.mcp.json': json(managed), '/workspace/.cursor/mcp.json': json(managed),
        '/workspace/.codex/config.toml': `model = "keep-model"\r\n${TYNN_TOML_BEGIN}\r\n[mcp_servers.tynn]\r\nurl = "https://tynn.ai/mcp/tynn"\r\n${TYNN_TOML_END}\r\n# BEGIN GENIE MCP: tynn\r\n[mcp_servers.tynn]\r\nbearer_token_env_var = "TYNN_AGENT_TOKEN"\r\n# END GENIE MCP: tynn\r\n[mcp_servers.other]\r\ncommand = "keep-server"\r\n` });
    await t.run();
    for (const file of ['/workspace/.mcp.json', '/workspace/.cursor/mcp.json']) {
        const parsed = JSON.parse(t.files.get(file)!);
        expect(parsed.mcpServers.tynn).toBeUndefined(); expect(parsed.mcpServers.other.command).toBe('keep-server'); expect(parsed.keep).toBe(42);
    }
    const toml = t.files.get('/workspace/.codex/config.toml')!;
    expect(toml.includes('tynn')).toBe(false); expect(toml.includes('keep-model')).toBe(true); expect(toml.includes('keep-server')).toBe(true);
    const count = t.writes.length; await t.run(); expect(t.writes).toHaveLength(count);
});

it.each([
    '{invalid-json',
    JSON.stringify({ mcpServers: [] }),
    json({ command: 'custom-tynn' }),
    json({ ...managed, url: 'https://custom.example/mcp' }),
    json({ ...managed, headers: { Authorization: 'Bearer synthetic', 'X-Custom': 'keep' } }),
])('refuses ambiguous JSON without overwriting any file', async (text) => {
    const t = fixture({ '/workspace/.mcp.json': json(managed), '/workspace/.cursor/mcp.json': text });
    await expect(t.run()).rejects.toThrow(/Tynn.*config/i); expect(t.writes).toEqual([]);
    expect(t.files.get('/workspace/.cursor/mcp.json') === text).toBe(true);
});

it.each([
    `${TYNN_TOML_BEGIN}\n[mcp_servers.tynn]\n`,
    `${TYNN_TOML_END}\n`,
    '# BEGIN GENIE MCP: tynn\n[mcp_servers.tynn]\n',
    '[mcp_servers.tynn]\ncommand = "custom-server"\n',
    '[mcp_servers."tynn"]\ncommand = "custom-server"\n',
])('refuses ambiguous Codex ownership without discarding a custom table', async (text) => {
    const t = fixture({ '/workspace/.codex/config.toml': text });
    await expect(t.run()).rejects.toThrow(/Tynn.*config/i); expect(t.writes).toEqual([]);
});

it('refuses read and write errors using fixed words, without exposing upstream error text', async () => {
    const t = fixture({ '/workspace/.mcp.json': json(managed) });
    const error = () => { throw new Error(`untrusted error ${token}`); };
    t.fs.read = error;
    const first = await t.run().catch((e: Error) => e);
    expect(first).toBeInstanceOf(Error); expect(String(first).includes(token)).toBe(false);
    t.fs.read = async (p) => t.files.get(p.replace(/\\/g, '/')) ?? null; t.fs.write = error;
    const second = await t.run().catch((e: Error) => e);
    expect(second).toBeInstanceOf(Error); expect(String(second).includes(token)).toBe(false);
});

it('preserves marker-like text inside a TOML string instead of deleting user instructions', async () => {
    const text = `developer_instructions = """\n${TYNN_TOML_BEGIN}\nexample text for a user\n${TYNN_TOML_END}\n"""\n`;
    const t = fixture({ '/workspace/.codex/config.toml': text });
    await expect(t.run()).rejects.toThrow(/Tynn.*config/i);
    expect(t.files.get('/workspace/.codex/config.toml') === text).toBe(true); expect(t.writes).toEqual([]);
});
