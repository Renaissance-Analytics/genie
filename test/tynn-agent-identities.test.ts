import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { tynnAgentTokens, type TynnAgentToken } from '../src/main/tynn-agent-token.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-agent-keys-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const PROJECT = 'project-42';
const HOST = 'https://tynn.ai';
const mcp = (result: TynnAgentToken) => 'mcp' in result ? result.mcp : null;

function fixture() {
    type Remote = { id: string; name: string; external_id: string | null; status: string; config: unknown; tokens: Array<{ id: string; public_id: string; active: boolean }> };
    const agents: Remote[] = [];
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const state = { userId: 'user-7' as string | null, encryption: true, minted: 0, registered: 0, wrongProject: false, wrongMint: false, lostResponse: false, shared: false, error: '', ignoreCalls: 0 };
    const file = join(dir, 'agent-keys.json');
    const storage = { file, cipher: { isAvailable: () => state.encryption, encrypt: (s: string) => Buffer.from(`sealed:${s}`), decrypt: (b: Buffer) => b.toString().slice(7) } };
    const local = (name = 'atlas') => agentRecord({ id: mintAgentId(), workspaceId: 'workspace', name, provider: 'codex', mode: 'automated', instructions: `.agents/${name}/AGENT.md` });
    const add = (name: string, external_id: string | null, status = 'active'): Remote => {
        const row = { id: `remote-${agents.length + 1}`, name, external_id, status, config: {}, tokens: [] };
        agents.push(row); return row;
    };
    const tynn = {
        status: () => ({ signedIn: true }), userId: () => state.userId,
        request: async (path: string, init: { method: string; body?: any }) => {
            calls.push({ path, method: init.method, body: init.body });
            if (state.error) throw new Error(state.error);
            const answer = (status: number, body: unknown) => { const text = JSON.stringify(body); return { ok: status < 300, status, json: async () => JSON.parse(text) as unknown }; };
            if (path === `/api/v1/projects/${PROJECT}/agents` && init.method === 'GET') return answer(200, { project_id: state.wrongProject ? 'another-project' : PROJECT, agents });
            if (path === `/api/v1/projects/${PROJECT}/agents` && init.method === 'POST') {
                state.registered++;
                // Match Tynn's case-insensitive upsert, including its replacement of supplied external_id/config.
                const row = agents.find((a) => a.name.toLowerCase() === init.body.name.toLowerCase()) ?? add(init.body.name, init.body.external_id);
                row.external_id = init.body.external_id; row.config = init.body.config;
                return answer(201, { created: true, agent: row });
            }
            if (path === '/api/v1/projects/agent-token' && init.method === 'POST') {
                const name = init.body.agent_name ?? 'Genie';
                const row = agents.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? add(name, null);
                state.minted++;
                const publicId = String(state.minted).padStart(26, '0');
                row.tokens.push({ id: `key-${state.minted}`, public_id: publicId, active: true });
                if (state.lostResponse) throw new Error('response lost after mint');
                return answer(200, { token: `rpk_${publicId}.${state.minted.toString(16).repeat(64)}`, agent: state.wrongMint ? { id: 'another-agent', name } : { id: row.id, name: row.name }, mcp_url: `${HOST}/mcp/tynn` });
            }
            return answer(404, {});
        },
    };
    // Exercise the existing public entry point. Before this feature it ignores the agent and vault ports and mints a
    // shared workspace key; regressions fail on that behavior, rather than a missing import/new module.
    const open = () => (tynnAgentTokens as unknown as (p: typeof storage) => ReturnType<typeof tynnAgentTokens>)(storage);
    const ensure = (vault: ReturnType<typeof open>, agent: ReturnType<typeof local>, allFlags = true) => vault.ensure({
        workspacePath: '/workspace', agent, tynn,
        fs: { read: async (path: string) => path.endsWith('project.json') ? JSON.stringify({ tynn: { projectId: PROJECT } }) : state.shared && path.endsWith('.mcp.json') ? JSON.stringify({ mcpServers: { tynn: { url: `${HOST}/mcp/tynn`, headers: { Authorization: 'Bearer shared-workspace-secret' } } } }) : null, write: async () => { throw new Error('agent credentials must not be written into the project'); } },
        flags: { mcp_sync_claude: allFlags, mcp_sync_codex: allFlags, mcp_sync_cursor: allFlags, mcp_sync_hooks: false },
        ignore: async () => { state.ignoreCalls++; },
    } as never);
    return { agents, calls, state, file, local, add, open, ensure };
}

describe('one Tynn principal and encrypted key per Genie agent', () => {
    it.skipIf(process.platform === 'win32')('credential permissions restrict an existing permissive vault directory', async () => {
        const t = fixture(); await chmod(dir, 0o755);
        expect(mcp(await t.ensure(t.open(), t.local()))).toBeTruthy();
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        expect((await stat(t.file)).mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === 'win32')('credential permissions restrict an existing key file before restoration', async () => {
        const t = fixture(); const agent = t.local();
        const first = await t.ensure(t.open(), agent); await chmod(t.file, 0o644);
        expect(mcp(await t.ensure(t.open(), agent))).toEqual(mcp(first));
        expect((await stat(t.file)).mode & 0o777).toBe(0o600);
        expect(t.state.minted).toBe(1);
    });

    it.skipIf(process.platform === 'win32')('credential permissions refuse a symlinked key file before sending a request', async () => {
        const t = fixture(); const agent = t.local(); await t.ensure(t.open(), agent);
        const before = t.calls.length; await rename(t.file, `${t.file}.original`); await symlink(`${t.file}.original`, t.file);
        expect(await t.ensure(t.open(), agent)).toMatchObject({ status: 'failed', code: 'storage' });
        expect(t.state.minted).toBe(1); expect(t.calls).toHaveLength(before);
    });

    it('serializes the project name namespace so concurrent case-colliding identities cannot overwrite each other', async () => {
        const t = fixture(); const vault = t.open(); const a = t.local(); const b = t.local('ATLAS');
        const results = await Promise.all([t.ensure(vault, a), t.ensure(vault, b)]);
        expect(results.filter((r) => mcp(r))).toHaveLength(1);
        expect(results.filter((r) => r.status === 'failed')).toHaveLength(1);
        expect(t.state.registered).toBe(1); expect(t.state.minted).toBe(1);
        expect(t.agents).toHaveLength(1);
        expect([a.id, b.id]).toContain(t.agents[0]?.external_id);
    });

    it('rejects a padded name before it can overwrite an identity after server-side trimming', async () => {
        const t = fixture(); t.add('atlas', 'someone-else');
        expect(await t.ensure(t.open(), t.local(' atlas '))).toMatchObject({ status: 'failed' });
        expect(t.state.registered).toBe(0); expect(t.state.minted).toBe(0);
    });

    it('treats a null stored binding as corruption rather than permission to mint again', async () => {
        const t = fixture(); const a = t.local();
        const key = JSON.stringify(['user-7', PROJECT, a.id]);
        await writeFile(t.file, JSON.stringify({ version: 1, records: { [key]: null } }));
        expect(await t.ensure(t.open(), a)).toMatchObject({ status: 'failed' });
        expect(t.state.minted).toBe(0);
    });

    it('a different signed-in account never receives the prior accounts cached secret', async () => {
        const t = fixture(); const a = t.local(); const vault = t.open();
        const first = await t.ensure(vault, a); t.state.userId = 'user-8';
        const second = await t.ensure(vault, a);
        expect(mcp(second)?.token).toBeTruthy(); expect(mcp(second)?.token).not.toBe(mcp(first)?.token);
        expect(t.state.minted).toBe(2);
    });

    it('preserves explicit manual and ask settings in the registered config', async () => {
        const t = fixture(); const a = { ...t.local(), mode: 'manual' as const, permissions: 'ask' as const };
        expect(mcp(await t.ensure(t.open(), a))?.token).toBeTruthy();
        expect(t.agents[0]?.config).toMatchObject({ mode: 'manual', permissions: ['ask'] });
    });

    it('two agents in one workspace register distinct stable identities and get distinct keys', async () => {
        const t = fixture(); const vault = t.open(); const a = t.local(); const b = t.local('nova');
        const [first, second] = await Promise.all([t.ensure(vault, a), t.ensure(vault, b)]);
        expect(mcp(first)?.token).toBeTruthy(); expect(mcp(second)?.token).toBeTruthy();
        expect(mcp(first)?.token).not.toBe(mcp(second)?.token);
        expect(t.agents.map((a) => a.external_id).sort()).toEqual([a.id, b.id].sort());
        expect(t.calls.filter((c) => c.path.endsWith('/agent-token')).map((c) => c.body.agent_name).sort()).toEqual(['atlas', 'nova']);
    });

    it('simultaneous requests for one agent register and mint once', async () => {
        const t = fixture(); const vault = t.open(); const a = t.local();
        const answers = await Promise.all([t.ensure(vault, a), t.ensure(vault, a)]);
        expect(answers.every((r) => mcp(r)?.token)).toBe(true);
        expect(t.state.registered).toBe(1); expect(t.state.minted).toBe(1);
        expect(t.agents[0]?.external_id).toBe(a.id);
    });

    it('restart reuses the encrypted key after verifying that exact remote identity and key are still active', async () => {
        const t = fixture(); const a = t.local(); const first = await t.ensure(t.open(), a);
        expect(mcp(await t.ensure(t.open(), a))).toEqual(mcp(first));
        expect(t.state.minted).toBe(1);
        const disk = await readFile(t.file, 'utf8');
        expect(disk).not.toContain(mcp(first)!.token);
        expect(JSON.stringify(a)).not.toContain(mcp(first)!.token);
    });

    it('does not adopt the legacy shared credential from project config', async () => {
        const t = fixture(); t.state.shared = true;
        const result = await t.ensure(t.open(), t.local());
        expect(mcp(result)).toMatchObject({ token: expect.stringMatching(/^rpk_/) });
        expect(mcp(result)?.token).not.toBe('shared-workspace-secret');
        expect(t.state.minted).toBe(1);
    });

    it('has no project-config or gitignore dependency when provisioning the private launch credential', async () => {
        const t = fixture(); const result = await t.ensure(t.open(), t.local(), false);
        expect(mcp(result)).toMatchObject({ token: expect.stringMatching(/^rpk_/) });
        expect(t.state.ignoreCalls).toBe(0);
    });

    it('refuses to mint before OS encryption is available', async () => {
        const t = fixture(); t.state.encryption = false;
        expect(await t.ensure(t.open(), t.local())).toMatchObject({ status: 'failed' });
        expect(t.state.minted).toBe(0); expect(t.state.registered).toBe(0);
    });

    it('requires the authenticated account id rather than only an optimistic signed-in flag', async () => {
        const t = fixture(); t.state.userId = null;
        expect(await t.ensure(t.open(), t.local())).toMatchObject({ status: 'failed' });
        expect(t.state.minted).toBe(0);
    });

    it('refuses a suspended remote agent before minting', async () => {
        const t = fixture(); const a = t.local(); t.add(a.name, a.id, 'suspended');
        expect(await t.ensure(t.open(), a)).toMatchObject({ status: 'failed' });
        expect(t.state.minted).toBe(0);
    });

    it('keeps case-insensitive name collisions from overwriting another identity', async () => {
        const t = fixture(); t.add('ATLAS', 'someone-else');
        expect(await t.ensure(t.open(), t.local())).toMatchObject({ status: 'failed' });
        expect(t.state.registered).toBe(0); expect(t.state.minted).toBe(0);
        expect(t.agents[0]?.external_id).toBe('someone-else');
    });

    it('refuses a project-mismatched agent list', async () => {
        const t = fixture(); t.state.wrongProject = true;
        expect(await t.ensure(t.open(), t.local())).toMatchObject({ status: 'failed' });
        expect(t.state.registered).toBe(0); expect(t.state.minted).toBe(0);
    });

    it('does not use a mint response naming another agent', async () => {
        const t = fixture(); t.state.wrongMint = true;
        expect(await t.ensure(t.open(), t.local())).toMatchObject({ status: 'failed' });
    });

    it('checks remote suspension even when a cached key exists', async () => {
        const t = fixture(); const a = t.local(); const vault = t.open(); await t.ensure(vault, a);
        t.agents[0]!.status = 'suspended';
        expect(await t.ensure(vault, a)).toMatchObject({ status: 'failed' });
        expect(t.state.minted).toBe(1);
    });

    it('does not silently replace a revoked key with another credential', async () => {
        const t = fixture(); const a = t.local(); const vault = t.open(); await t.ensure(vault, a);
        t.agents[0]!.tokens[0]!.active = false;
        expect(await t.ensure(vault, a)).toMatchObject({ status: 'failed' });
        expect(t.state.minted).toBe(1);
    });

    it('a lost mint response leaves a durable pending marker that prevents another mint after restart', async () => {
        const t = fixture(); const a = t.local(); t.state.lostResponse = true;
        expect(await t.ensure(t.open(), a)).toMatchObject({ status: 'failed' });
        t.state.lostResponse = false;
        expect(await t.ensure(t.open(), a)).toMatchObject({ status: 'failed' });
        expect(t.state.minted).toBe(1);
    });

    it('sends the persona path and singleton execution permission, never persona contents', async () => {
        const t = fixture(); const a = t.local(); await t.ensure(t.open(), a);
        expect(t.agents[0]).toMatchObject({ external_id: a.id, config: { provider: 'codex', instructions: '.agents/atlas/AGENT.md', permissions: ['all'], mode: 'automated' } });
    });

    it('keeps bearer-looking strings from a network exception out of the result', async () => {
        const t = fixture(); const secret = `gpk_${'0'.repeat(26)}.${'a'.repeat(64)}`; t.state.error = `request failed ${secret}`;
        expect(JSON.stringify(await t.ensure(t.open(), t.local()))).not.toContain(secret);
    });
});
