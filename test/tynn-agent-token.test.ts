import { expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { secureMcpUrl, tynnAgentTokens } from '../src/main/tynn-agent-token.js';
import { configSyncTargets } from '../src/main/config-sync-targets.js';

const agent = agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'codex', name: 'atlas' });
const cipher = { isAvailable: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString() };

it('refuses a legacy caller without an agent before reading a shared credential or making an API request', async () => {
    let reads = 0; let requests = 0;
    const result = await tynnAgentTokens({ file: '/unused/agents.json', cipher }).ensure({
        workspacePath: '/workspace', fs: { read: async () => { reads++; return '{}'; }, write: async () => { throw new Error('No workspace credential writes'); } },
        tynn: { status: () => ({ signedIn: true }), request: async () => { requests++; throw new Error('No legacy mint'); } },
    } as never);
    expect(result).toMatchObject({ status: 'failed', code: 'refused' }); expect(reads).toBe(0); expect(requests).toBe(0);
});

it('requires private vault configuration for an agent instead of falling back to workspace configs', async () => {
    let reads = 0;
    const result = await tynnAgentTokens().ensure({ workspacePath: '/workspace', agent, tynn: null,
        fs: { read: async () => { reads++; return '{}'; }, write: async () => {} } });
    expect(result).toMatchObject({ status: 'failed', code: 'storage' }); expect(reads).toBe(0);
});

it('does not provision an unlinked workspace or expose a project read error', async () => {
    const vault = tynnAgentTokens({ file: '/unused/agents.json', cipher });
    const base = { workspacePath: '/workspace', agent, tynn: null, fs: { read: async () => '{}', write: async () => {} } };
    expect(await vault.ensure(base)).toEqual({ status: 'unlinked' });
    const result = await vault.ensure({ ...base, fs: { ...base.fs, read: async () => { throw new Error('synthetic-sensitive-error'); } } });
    expect(result).toMatchObject({ status: 'failed', code: 'storage' }); expect(JSON.stringify(result).includes('synthetic-sensitive-error')).toBe(false);
});

it('config targets ignore a stale caller’s Tynn credential payload, while still writing Genie', async () => {
    const files = new Map<string, string>();
    const fs = { read: async (p: string) => files.get(p) ?? null, write: async (p: string, text: string) => { files.set(p, text); } };
    const targets = configSyncTargets({ workspacePath: '/workspace', fs,
        flags: { mcp_sync_claude: true, mcp_sync_cursor: true, mcp_sync_codex: true, mcp_sync_hooks: false } });
    for (const target of targets) await target.write({ GENIE_MCP_URL: 'http://127.0.0.1:1/mcp', TYNN_MCP_URL: 'https://tynn.ai/mcp/tynn', TYNN_MCP_TOKEN: 'synthetic-private' });
    expect(files.size).toBe(3);
    expect([...files.values()].every((text) => !text.includes('synthetic-private'))).toBe(true);
    expect([...files.values()].every((text) => text.includes('genie'))).toBe(true);
});

it('upgrades remote plaintext MCP addresses while preserving loopback and HTTPS', () => {
    expect(secureMcpUrl('http://tynn.ai/mcp/tynn')).toBe('https://tynn.ai/mcp/tynn');
    expect(secureMcpUrl('http://127.0.0.1:1/mcp')).toBe('http://127.0.0.1:1/mcp');
    expect(secureMcpUrl('https://tynn.ai/mcp/tynn')).toBe('https://tynn.ai/mcp/tynn');
});
