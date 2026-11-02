import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_METHODS } from '../src/core/engine-protocol.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { hostAgentKeys } from '../src/main/host-agent-keys.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import type { TynnSessionPort } from '../src/main/tynn-agent-token.js';
import { fakeKeychain } from './helpers/tynn-storage.js';

/**
 * THE HOST PREPARES ITS AGENTS (P3.4 cut c). With the account in the host, there is one path: the host mints, verifies and holds an agent's
 * Tynn key, whether or not a window is open. So a never-minted agent woken by mail with no window gets its key, and a key is asked after
 * at every start, as the window did. The window prepares nothing: two writers of one vault could mint a key twice.
 */

const PROJECT = 'project-42';
const TOKEN = 'a'.repeat(64);
let dir: string;
let workspace: string;
let vaultFile: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'host-prep-'));
    workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    mkdirSync(join(dir, 'agent-credentials'));
    vaultFile = join(dir, 'agent-credentials', 'agents.json');
    writeFileSync(join(workspace, 'project.json'), JSON.stringify({ tynn: { projectId: PROJECT } }));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const record = (over: Partial<Parameters<typeof agentRecord>[0]> = {}): AgentRecord =>
    agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'atlas', ...over });

/** Tynn, as the agent endpoints answer it, behind an account that is signed in or is not. */
function tynnFake() {
    const remote: Array<{ id: string; name: string; external_id: string | null; status: string; tokens: Array<{ public_id: string; active: boolean }> }> = [];
    const state = { signedIn: true, saved: 'user-7' as string | null, reachable: true, minted: 0, registered: 0, through: null as string | null };
    const answer = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
    const port: TynnSessionPort & { unreachableThrough(): string | null } = {
        status: () => ({ signedIn: state.signedIn }),
        userId: () => (state.signedIn ? 'user-7' : null),
        savedUserId: () => state.saved,
        unreachableThrough: () => state.through,
        request: async (path, init) => {
            if (!state.reachable) throw new Error('Tynn could not be reached.');
            if (path === `/api/v1/projects/${PROJECT}/agents` && init.method === 'GET') return answer(200, { project_id: PROJECT, agents: remote });
            if (path === `/api/v1/projects/${PROJECT}/agents` && init.method === 'POST') {
                state.registered += 1;
                const body = init.body as { name: string; external_id: string };
                const row = { id: `remote-${remote.length + 1}`, name: body.name, external_id: body.external_id, status: 'active', tokens: [] };
                remote.push(row);
                return answer(201, { agent: row });
            }
            if (path === '/api/v1/projects/agent-token' && init.method === 'POST') {
                state.minted += 1;
                const row = remote.find((r) => r.name === (init.body as { agent_name: string }).agent_name)!;
                const publicId = String(state.minted).padStart(26, '0');
                row.tokens.push({ public_id: publicId, active: true });
                return answer(200, { token: `rpk_${publicId}.${'ab'.repeat(32)}`, agent: { id: row.id, name: row.name }, mcp_url: 'https://tynn.ai/mcp/tynn' });
            }
            return answer(404, {});
        },
    };
    return { port, state, remote };
}
const keysFor = (t: ReturnType<typeof tynnFake>, secrets = fakeKeychain()) => ({
    secrets,
    keys: hostAgentKeys({ vaultFile, keychain: secrets, tynn: () => t.port, workspaces: () => [{ id: 'ws', path: workspace }] }),
});
const bearer = (servers: readonly McpServer[]) => {
    const tynn = servers.find((s) => s.name === 'tynn') as { headers?: readonly { name: string; value: string }[] } | undefined;
    return tynn?.headers?.find((h) => h.name === 'Authorization')?.value ?? null;
};
const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5)); };

function world(keys: ReturnType<typeof hostAgentKeys>) {
    const handed = new Map<string, readonly McpServer[]>();
    const driverFor: DriverFor = (r, _cwd, _thread, options) => {
        handed.set(r.id, (options as { mcpServers?: readonly McpServer[] }).mcpServers ?? []);
        const factory: SessionDriverFactory = () => ({ start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } });
        return factory;
    };
    const server = new SessionEngineServer({
        token: TOKEN, build: 'test', agentKeys: keys,
        mcp: { setView: () => {}, sessionServers: () => [{ type: 'http', name: 'genie', url: 'http://127.0.0.1:1/mcp', headers: [] }], status: () => null, runNative: async () => null } as never,
    });
    const host = new SessionHost({ userData: dir, driverFor, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
    server.attach(host);
    return { server, host, handed };
}

describe('THE BUG: the window process is dead, a never-minted agent is woken, and it gets minted and has its key', () => {
    it('minted by the host, held in the keychain, bound in the vault, and handed to the provider beside Genie', async () => {
        const t = tynnFake();
        const { keys, secrets } = keysFor(t);
        const { server, host, handed } = world(keys);
        expect(server.windowConnected()).toBe(false);
        const agent = record();
        expect(await host.start(agent, workspace)).toEqual({ ok: true });
        await until(() => handed.has(agent.id));
        const servers = handed.get(agent.id) ?? [];
        const key = `rpk_${'1'.padStart(26, '0')}.${'ab'.repeat(32)}`;
        expect(bearer(servers)).toBe(`Bearer ${key}`);
        expect(servers.map((s) => s.name)).toEqual(['genie', 'tynn']);
        expect(t.state.minted).toBe(1);
        expect(secrets.held.get(`tynn/agent/${'1'.padStart(26, '0')}`)).toBe(key);
        expect(readFileSync(vaultFile, 'utf8')).not.toContain('rpk_');
        expect(JSON.stringify(host.rowsFor(agent.id))).not.toContain('Tynn unavailable');
        await host.stopAll();
    });

    it('its next start uses that key: no second mint', async () => {
        const t = tynnFake();
        const { keys } = keysFor(t);
        const agent = record();
        await keys(agent, workspace);
        const again = await keys(agent, workspace);
        expect(bearer(again.servers)).toContain('rpk_');
        expect(t.state.minted).toBe(1);
    });

    it('CONTROL: signed out, with nothing minted, it starts without Tynn and says why', async () => {
        const t = tynnFake();
        t.state.signedIn = false;
        t.state.saved = null;
        const { keys } = keysFor(t);
        const result = await keys(record(), workspace);
        expect(result.servers).toEqual([]);
        expect(result.note).toContain('Tynn unavailable');
        expect(t.state.minted).toBe(0);
    });
});

describe('a key is asked after at every start, as the window did', () => {
    it('a key Tynn revoked is not handed out, and no replacement is minted', async () => {
        const t = tynnFake();
        const { keys } = keysFor(t);
        const agent = record();
        await keys(agent, workspace);
        t.remote[0]!.tokens[0]!.active = false;
        const result = await keys(agent, workspace);
        expect(result.servers).toEqual([]);
        expect(result.note).toMatch(/inactive/);
        expect(t.state.minted).toBe(1);
    });

    it('a suspended agent gets nothing', async () => {
        const t = tynnFake();
        const { keys } = keysFor(t);
        const agent = record();
        await keys(agent, workspace);
        t.remote[0]!.status = 'suspended';
        expect((await keys(agent, workspace)).servers).toEqual([]);
    });

    it('TYNN OUT OF REACH: its own stored key, unverified, and checked once Tynn answers', async () => {
        const t = tynnFake();
        const { keys } = keysFor(t);
        const agent = record();
        await keys(agent, workspace);
        t.state.reachable = false;
        expect(bearer((await keys(agent, workspace)).servers)).toContain('rpk_');
        expect(t.state.minted).toBe(1);
    });

    it('out of reach and never minted: no key, a note, no mint; through a proxy, the note names it', async () => {
        const t = tynnFake();
        t.state.reachable = false;
        t.state.through = 'proxy.example:8080';
        const { keys } = keysFor(t);
        const result = await keys(record(), workspace);
        expect(result.servers).toEqual([]);
        expect(result.note).toContain('proxy.example:8080');
        expect(t.state.minted).toBe(0);
    });

    it('signed out with a key already held: its own key, off grid, no call to Tynn', async () => {
        const t = tynnFake();
        const { keys } = keysFor(t);
        const agent = record();
        await keys(agent, workspace);
        t.state.signedIn = false;
        t.state.reachable = false;
        expect(bearer((await keys(agent, workspace)).servers)).toContain('rpk_');
    });
});

describe('one path, one writer', () => {
    it('with a window connected the HOST still prepares: the window is asked nothing', async () => {
        const t = tynnFake();
        const { keys } = keysFor(t);
        const { server, host, handed } = world(keys);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        await new SessionEngineClient().connect(windowSide, TOKEN);
        const agent = record();
        expect(await host.start(agent, workspace)).toEqual({ ok: true });
        await until(() => handed.has(agent.id));
        expect(bearer(handed.get(agent.id) ?? [])).toContain('rpk_');
        await host.stopAll();
    });

    it('the host→window preparation call is gone from the protocol', () => {
        expect(ENGINE_METHODS as readonly string[]).not.toContain('client.prepareMcpServers');
    });

    it('a workspace with no Tynn link: nothing, and nothing to explain', async () => {
        writeFileSync(join(workspace, 'project.json'), '{}');
        const t = tynnFake();
        expect(await keysFor(t).keys(record(), workspace)).toEqual({ servers: [], note: null });
        expect(t.state.minted).toBe(0);
    });

    it('THE VAULT IS READ AFRESH: what another writer put there is kept, not overwritten from a cache', async () => {
        const t = tynnFake();
        const { keys } = keysFor(t);
        const first = record({ name: 'first' });
        await keys(first, workspace);
        // The window's one-time move rewrites this file.
        const data = JSON.parse(readFileSync(vaultFile, 'utf8'));
        data.records['["user-7","project-42","elsewhere"]'] = { userId: 'user-7', projectId: PROJECT, genieId: 'elsewhere', remoteAgentId: 'remote-9', state: 'pending' };
        writeFileSync(vaultFile, JSON.stringify(data));
        await keys(record({ name: 'second' }), workspace);
        expect(Object.keys(JSON.parse(readFileSync(vaultFile, 'utf8')).records)).toContain('["user-7","project-42","elsewhere"]');
    });
});

describe('recovery, from the host', () => {
    it('agents that went without Tynn are named once it can be had, once', async () => {
        const t = tynnFake();
        t.state.signedIn = false;
        t.state.saved = null;
        const { keys } = keysFor(t);
        const agent = record();
        await keys(agent, workspace);
        t.state.signedIn = true;
        expect(await keys.recovery()).toEqual([agent.id]);
    });

    it('still signed out: nobody', async () => {
        const t = tynnFake();
        t.state.signedIn = false;
        t.state.saved = null;
        const { keys } = keysFor(t);
        await keys(record(), workspace);
        expect(await keys.recovery()).toEqual([]);
    });

    it('after the one-time move, an agent that could not find its key is named too', async () => {
        const t = tynnFake();
        const secrets = fakeKeychain();
        const { keys } = keysFor(t, secrets);
        const agent = record();
        await keys(agent, workspace);
        // Keychain says nothing for its key: an older Genie's copy has not moved yet.
        secrets.held.clear();
        const result = await keys(agent, workspace);
        expect(result.note).toContain('Tynn unavailable');
        expect(await keys.recovery()).toEqual([]);
        expect(await keys.recovery({ secretsMoved: true })).toEqual([agent.id]);
    });
});
