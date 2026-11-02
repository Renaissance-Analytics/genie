import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { McpServer } from '@particle-academy/prism-acp';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { hostAgentKeys } from '../src/main/host-agent-keys.js';
import { Keychain, type KeyringModule } from '../src/main/keychain.js';
import { migrateSecrets, type MigrationBook, type MigrationState } from '../src/main/keychain-migration.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { tynnAgentIdentities, type AgentSecrets } from '../src/main/tynn-agent-identities.js';
import { linkedAgentSecrets } from '../src/main/agent-secrets.js';

/**
 * AN AGENT'S TYNN KEY IS THE HOST'S (the owner's decision 3, genie#1457: "this should not happen at all. fix it, don't bandaid
 * it"). A host-started agent with no window used to start silently without its private servers. The window still mints, and
 * that stays until cut c gives the host the account; holding and reading are the host's now, in the keychain.
 */

const TOKEN = 'a'.repeat(64);
const PROJECT = 'project-42';
const USER = 'user-7';
const PUBLIC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const KEY = `rpk_${PUBLIC_ID}.${'ab'.repeat(32)}`;
const ENTRY = `tynn/agent/${PUBLIC_ID}` as const;

function fakeLibrary() {
    const held = new Map<string, string>();
    const failing = { value: false };
    const module: KeyringModule = {
        AsyncEntry: class {
            readonly #name: string;
            constructor(_service: string, name: string) { this.#name = name; }
            async getPassword() { if (failing.value) throw new Error('no secret service'); return held.get(this.#name) ?? null; }
            async setPassword(password: string) { if (failing.value) throw new Error('no secret service'); held.set(this.#name, password); }
            async deletePassword() { return held.delete(this.#name); }
        },
    };
    return { held, failing, keychain: new Keychain(async () => module) };
}

let dir: string;
let workspace: string;
let vaultFile: string;
let accountFile: string;
let lib: ReturnType<typeof fakeLibrary>;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'host-agent-keys-'));
    workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    mkdirSync(join(dir, 'agent-credentials'));
    mkdirSync(join(dir, 'credentials'));
    vaultFile = join(dir, 'agent-credentials', 'agents.json');
    accountFile = join(dir, 'credentials', 'tynn.json');
    writeFileSync(join(workspace, 'project.json'), JSON.stringify({ tynn: { projectId: PROJECT } }));
    writeFileSync(accountFile, JSON.stringify({ version: 1, state: 'signed-in', host: 'https://tynn.ai', userId: USER, scopes: [], tokenEnc: 'c2VhbGVk' }));
    lib = fakeLibrary();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const record = (over: Partial<Parameters<typeof agentRecord>[0]> = {}): AgentRecord =>
    agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'atlas', ...over });

/** What the window leaves behind after minting: the binding in the vault, the key in the keychain. */
function minted(agent: AgentRecord, over: Record<string, unknown> = {}): void {
    const key = JSON.stringify([USER, PROJECT, agent.id]);
    writeFileSync(vaultFile, JSON.stringify({ version: 1, records: { [key]: { userId: USER, projectId: PROJECT, genieId: agent.id, remoteAgentId: 'remote-1', state: 'ready', publicId: PUBLIC_ID, ...over } } }));
    lib.held.set(ENTRY, KEY);
}
const keys = () => hostAgentKeys({ vaultFile, accountFile, tynnHost: 'https://tynn.ai', keychain: lib.keychain });
const bearer = (servers: readonly McpServer[]) => {
    const tynn = servers.find((s) => s.name === 'tynn') as { headers?: readonly { name: string; value: string }[] } | undefined;
    return tynn?.headers?.find((h) => h.name === 'Authorization')?.value ?? null;
};

describe('THE BUG: the window process is killed, the host starts an agent, the agent has its Tynn key', () => {
    const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

    async function world(agentKeys = true) {
        const handed = new Map<string, readonly McpServer[]>();
        const driverFor: DriverFor = (r, _cwd, _thread, options) => {
            handed.set(r.id, (options as { mcpServers?: readonly McpServer[] }).mcpServers ?? []);
            const factory: SessionDriverFactory = () => ({ start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } });
            return factory;
        };
        const server = new SessionEngineServer({
            token: TOKEN, build: 'test',
            mcp: { setView: () => {}, sessionServers: () => [{ type: 'http', name: 'genie', url: 'http://127.0.0.1:1/mcp', headers: [] }], status: () => null, runNative: async () => null } as never,
            ...(agentKeys ? { agentKeys: keys() } : {}),
            keychain: lib.keychain,
        });
        const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree, ...server.hostOptions() });
        server.attach(host);
        return { server, host, handed };
    }
    const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5)); };

    it('it starts with the key, and with the host’s own Genie entry beside it', async () => {
        const agent = record();
        minted(agent);
        const { server, host, handed } = await world();
        // A window was here, and its process died.
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        await new SessionEngineClient().connect(windowSide, TOKEN);
        windowSide.close();
        await until(() => server.clients === 0);
        expect(server.windowConnected()).toBe(false);

        expect(await host.start(agent, workspace)).toEqual({ ok: true });
        await until(() => handed.has(agent.id));
        const servers = handed.get(agent.id) ?? [];
        expect(bearer(servers)).toBe(`Bearer ${KEY}`);
        expect(servers.map((s) => s.name)).toEqual(['genie', 'tynn']);
        await host.stopAll();
    });

    it('CONTROL: with no host-held keys it starts without Tynn: this test can see the bug', async () => {
        const agent = record();
        minted(agent);
        const { host, handed } = await world(false);
        expect(await host.start(agent, workspace)).toEqual({ ok: true });
        await until(() => handed.has(agent.id));
        expect(bearer(handed.get(agent.id) ?? [])).toBeNull();
        await host.stopAll();
    });

    it('never minted, no window: it starts without Tynn, and its chat says why (cut c takes this case away)', async () => {
        const agent = record();
        const { host, handed } = await world();
        expect(await host.start(agent, workspace)).toEqual({ ok: true });
        await until(() => handed.has(agent.id));
        expect(bearer(handed.get(agent.id) ?? [])).toBeNull();
        await until(() => JSON.stringify(host.rowsFor(agent.id)).includes('Tynn unavailable'));
        expect(JSON.stringify(host.rowsFor(agent.id))).toContain('Tynn unavailable');
        await host.stopAll();
    });

    it('with a window connected, the window still prepares it', async () => {
        const agent = record();
        const { server, host, handed } = await world();
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const asked: string[] = [];
        await new SessionEngineClient({ prepareMcpServers: async (r) => { asked.push(r.id); return [{ type: 'http', name: 'tynn', url: 'https://tynn.ai/mcp/tynn', headers: [{ name: 'Authorization', value: 'Bearer from-the-window' }] }]; } }).connect(windowSide, TOKEN);
        expect(await host.start(agent, workspace)).toEqual({ ok: true });
        await until(() => handed.has(agent.id));
        expect(asked).toEqual([agent.id]);
        expect(bearer(handed.get(agent.id) ?? [])).toBe('Bearer from-the-window');
        await host.stopAll();
    });
});

describe('what the host may hand out with no window', () => {
    it('its own key, bound to this account, project and agent', async () => {
        const agent = record();
        minted(agent);
        const result = await keys()(agent, workspace);
        expect(bearer(result.servers)).toBe(`Bearer ${KEY}`);
        expect(result.note).toBeNull();
    });

    it('a workspace with no Tynn link: nothing, and nothing to explain', async () => {
        const agent = record();
        writeFileSync(join(workspace, 'project.json'), '{}');
        expect(await keys()(agent, workspace)).toEqual({ servers: [], note: null });
    });

    it.each([
        ['signed out', { version: 1, state: 'signed-out', host: 'https://tynn.ai' }],
        ['another account', { version: 1, state: 'signed-in', host: 'https://tynn.ai', userId: 'user-8' }],
        ['another Tynn host', { version: 1, state: 'signed-in', host: 'https://elsewhere.example', userId: USER }],
    ])('%s: not handed out', async (_label, account) => {
        const agent = record();
        minted(agent);
        writeFileSync(accountFile, JSON.stringify(account));
        const result = await keys()(agent, workspace);
        expect(result.servers).toEqual([]);
        expect(result.note).toContain('Tynn unavailable');
    });

    it('no account file: not handed out', async () => {
        const agent = record();
        minted(agent);
        await rm(accountFile);
        expect((await keys()(agent, workspace)).servers).toEqual([]);
    });

    it('another project’s binding is not this one’s', async () => {
        const agent = record();
        minted(agent);
        writeFileSync(join(workspace, 'project.json'), JSON.stringify({ tynn: { projectId: 'project-43' } }));
        expect((await keys()(agent, workspace)).servers).toEqual([]);
    });

    it('a key that does not match its own public id is refused', async () => {
        const agent = record();
        minted(agent);
        lib.held.set(ENTRY, `rpk_01BX5ZZKBKACTAV9WEVGEMMVRZ.${'cd'.repeat(32)}`);
        expect((await keys()(agent, workspace)).servers).toEqual([]);
    });

    it('a mint still unconfirmed hands out nothing', async () => {
        const agent = record();
        minted(agent, { state: 'pending' });
        const result = await keys()(agent, workspace);
        expect(result.servers).toEqual([]);
        expect(result.note).toContain('unconfirmed');
    });

    it('no keychain: no key, a note, and no value anywhere (decision 3)', async () => {
        const agent = record();
        minted(agent);
        lib.failing.value = true;
        const result = await keys()(agent, workspace);
        expect(result.servers).toEqual([]);
        expect(result.note).toContain('Tynn unavailable');
        expect(JSON.stringify(result)).not.toContain(KEY);
    });

    it('it reads the vault afresh: a key the window minted a moment ago is found, with no restart of the host', async () => {
        const agent = record();
        const read = keys();
        expect((await read(agent, workspace)).servers).toEqual([]);
        minted(agent);
        expect(bearer((await read(agent, workspace)).servers)).toBe(`Bearer ${KEY}`);
    });

    it('it never mints, registers or calls Tynn: it has no account to do it with (until cut c)', () => {
        const code = readFileSync('src/main/host-agent-keys.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
        expect(code).not.toMatch(/fetch\(|\.mint|agent-token|from 'electron'/);
    });
});

describe('the window mints, and the host holds', () => {
    const secrets = (): AgentSecrets & { held: Map<string, string> } => {
        const held = new Map<string, string>();
        return {
            held,
            probe: async () => ({ ok: true }),
            get: async (name) => { const value = held.get(name); return value === undefined ? { kind: 'missing' } : { kind: 'value', value }; },
            set: async (name, value) => { held.set(name, value); return { ok: true }; },
        };
    };

    it('over the link: the secrets a window uses are the host’s keychain', async () => {
        const server = new SessionEngineServer({ token: TOKEN, build: 'test', keychain: lib.keychain });
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        await client.connect(windowSide, TOKEN);
        const port = linkedAgentSecrets(client);
        expect(await port.set(ENTRY, KEY)).toEqual({ ok: true });
        expect(lib.held.get(ENTRY)).toBe(KEY);
        expect(await port.get(ENTRY)).toEqual({ kind: 'value', value: KEY });
        expect(await port.probe()).toEqual({ ok: true });
    });

    it('over the link: nothing but an agent’s key can be asked for (cut c widens this with its reader)', async () => {
        const server = new SessionEngineServer({ token: TOKEN, build: 'test', keychain: lib.keychain });
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        await client.connect(windowSide, TOKEN);
        lib.held.set('tynn/pairing', 'the-pairing');
        const read = await client.call('engine.secretRead', ['tynn/pairing']);
        expect(read.ok).toBe(false);
        expect(JSON.stringify(read)).not.toContain('the-pairing');
    });

    it('a host with no keychain says unavailable, never missing', async () => {
        const server = new SessionEngineServer({ token: TOKEN, build: 'test' });
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        await client.connect(windowSide, TOKEN);
        expect((await linkedAgentSecrets(client).get(ENTRY)).kind).toBe('unavailable');
    });

    it('a window with no link says unavailable: a dead link is not a signed-out agent', async () => {
        const client = new SessionEngineClient();
        expect((await linkedAgentSecrets(client).get(ENTRY)).kind).toBe('unavailable');
        expect((await linkedAgentSecrets(client).set(ENTRY, KEY)).ok).toBe(false);
        expect((await linkedAgentSecrets(client).probe()).ok).toBe(false);
    });

    it('what is already in the vault moves: keychain holds it, the vault holds no token, and the binding keeps working', async () => {
        const agent = record();
        const key = JSON.stringify([USER, PROJECT, agent.id]);
        const sealed = (text: string) => Buffer.from(`sealed:${text}`).toString('base64');
        writeFileSync(vaultFile, JSON.stringify({ version: 1, records: { [key]: { userId: USER, projectId: PROJECT, genieId: agent.id, remoteAgentId: 'remote-1', state: 'ready', publicId: PUBLIC_ID, tokenEnc: sealed(KEY) } } }));
        const port = secrets();
        const vault = tynnAgentIdentities({ file: vaultFile, secrets: port });
        const cipher = { decrypt: (bytes: Buffer) => bytes.toString().replace(/^sealed:/, '') };
        const states: Record<string, MigrationState> = {};
        const book: MigrationBook = { read: async () => ({ ...states }), write: async (name, state) => { states[name] = state; } };
        const moved = await migrateSecrets(await vault.legacyKeys(cipher), {
            store: async (name, value) => port.set(name, value),
            compare: async (name, value) => (port.held.get(name) === value ? 'same' : 'different'),
        }, book);
        expect(moved).toEqual([{ name: ENTRY, status: 'moved' }]);
        expect(port.held.get(ENTRY)).toBe(KEY);
        const after = readFileSync(vaultFile, 'utf8');
        expect(after).not.toContain('tokenEnc');
        expect(after).toContain(PUBLIC_ID);
        // And the off-grid reader finds it where it went.
        const again = await tynnAgentIdentities({ file: vaultFile, secrets: port }).ensure({ projectId: PROJECT, agent, tynn: { status: () => ({ signedIn: false }), savedUserId: () => USER, request: async () => { throw new Error('no network here'); } } });
        expect(again).toMatchObject({ status: 'already', mcp: { token: KEY } });
    });

    it('a sealed key that does not match its record’s public id is not moved, and not deleted', async () => {
        const agent = record();
        const key = JSON.stringify([USER, PROJECT, agent.id]);
        const wrong = `rpk_01BX5ZZKBKACTAV9WEVGEMMVRZ.${'cd'.repeat(32)}`;
        writeFileSync(vaultFile, JSON.stringify({ version: 1, records: { [key]: { userId: USER, projectId: PROJECT, genieId: agent.id, remoteAgentId: 'remote-1', state: 'ready', publicId: PUBLIC_ID, tokenEnc: Buffer.from(wrong).toString('base64') } } }));
        const port = secrets();
        const sources = await tynnAgentIdentities({ file: vaultFile, secrets: port }).legacyKeys({ decrypt: (bytes) => bytes.toString() });
        expect((await sources[0]!.old.read()).kind).toBe('unreadable');
        expect(readFileSync(vaultFile, 'utf8')).toContain('tokenEnc');
    });
});
