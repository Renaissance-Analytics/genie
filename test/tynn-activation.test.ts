import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { OS_WORKSPACE } from '../src/core/os-agent.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { SessionHost } from '../src/main/session-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { TYNN_TOML_BEGIN, TYNN_TOML_END } from '../src/main/tynn-agent-token.js';

let dir: string;
let services: ComposedServices | undefined;
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-activation-')); });
afterEach(async () => {
    for (const host of hosts.splice(0)) { host.stopAll(); await host.drained(0); await host.settled(); }
    await services?.shutdown(); services = undefined;
    await rm(dir, { recursive: true, force: true });
});
const pty: PtyPort = { open: () => { throw new Error('No terminal expected'); }, write: () => false, resize: () => false, kill: () => false, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
const legacy = 'synthetic-shared-credential';
const entry = { type: 'http', url: 'https://tynn.ai/mcp/tynn', headers: { Authorization: `Bearer ${legacy}` } };
type Activated = ComposedServices & { prepareAgentMcp(agent: AgentRecord, signal: AbortSignal): Promise<readonly McpServer[]> };
function deferred() {
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}

async function fixture() {
    const workspace = join(dir, 'workspace'); await mkdir(workspace);
    await writeFile(join(workspace, 'project.json'), JSON.stringify({ tynn: { projectId: 'project-42' } }));
    const state = { online: true, encryption: true, signedIn: true, userId: 'user-7', minted: 0, lists: 0, requests: 0, gate: Promise.resolve() };
    const rows: Array<{ id: string; name: string; external_id: string; status: string; tokens: Array<{ public_id: string; active: boolean }> }> = [];
    const requestEntered = deferred();
    const account = { status: () => ({ signedIn: state.signedIn }), userId: () => state.userId,
        request: async (path: string, init: { method: string; body?: any }) => {
            state.requests++;
            requestEntered.resolve();
            await state.gate;
            if (!state.online) throw new Error(`untrusted upstream message ${legacy}`);
            const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
            if (init.method === 'GET') { state.lists++; return answer({ project_id: 'project-42', agents: rows }); }
            if (path.endsWith('/agents')) {
                const row = { id: `remote-${rows.length}`, name: init.body.name, external_id: init.body.external_id, status: 'active', tokens: [] };
                rows.push(row); return answer({ agent: row });
            }
            state.minted++;
            const row = rows.find((r) => r.name === init.body.agent_name);
            // A legacy mint is still answered so RED observes the wrong production behavior, rather than an API error.
            if (!row) return answer({ token: legacy, mcp_url: entry.url });
            const publicId = String(state.minted).padStart(26, '0'); row.tokens.push({ public_id: publicId, active: true });
            return answer({ token: `rpk_${publicId}.${'a'.repeat(64)}`, mcp_url: entry.url, agent: { id: row.id } });
        } };
    const input = { userData: join(dir, 'home'), pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0,
        mcpEndpoint: () => ({ url: 'http://127.0.0.1:1/mcp', token: 'synthetic-genie' }),
        workspaces: () => [{ id: 'workspace', path: workspace }], tynn: () => account,
        tynnCipher: { isAvailable: () => state.encryption, encrypt: (s: string) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)), decrypt: (b: Buffer) => Buffer.from([...b].map((v) => v ^ 0x5a)).toString() } };
    const boot = async () => { await services?.shutdown(); services = await composeServices(input); return services as Activated; };
    const s = await boot();
    const agent = (provider: 'claude' | 'codex' = 'codex') => agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider, name: `agent-${rows.length}-${provider}` });
    const prepare = (a: AgentRecord, signal = new AbortController().signal) => {
        expect(typeof s.prepareAgentMcp, 'production composition must expose private preparation').toBe('function');
        const pending = s.prepareAgentMcp(a, signal);
        void pending.catch(requestEntered.reject);
        return pending;
    };
    const seed = async () => {
        await mkdir(join(workspace, '.cursor')); await mkdir(join(workspace, '.codex'));
        for (const file of ['.mcp.json', '.cursor/mcp.json']) await writeFile(join(workspace, file), JSON.stringify({ other: 7, mcpServers: { tynn: entry, keep: { command: 'user-server' } } }));
        await writeFile(join(workspace, '.codex/config.toml'), `model = "user-model"\n${TYNN_TOML_BEGIN}\n[mcp_servers.tynn]\nurl = "${entry.url}"\nhttp_headers = { Authorization = "Bearer ${legacy}" }\n${TYNN_TOML_END}\n[mcp_servers.keep]\ncommand = "user-server"\n`);
    };
    return { s, workspace, state, rows, agent, prepare, seed, boot, requestEntered: requestEntered.promise };
}

it('config sync removes workspace token provisioning altogether', async () => {
    const t = await fixture(); await t.s.syncConfig(t.workspace);
    expect(t.state.minted, 'config sync must never mint a shared token').toBe(0);
    expect(t.state.requests).toBe(0);
});

it('config sync removes the legacy shared credential from all three files without requesting any credential', async () => {
    const t = await fixture(); await t.seed(); await t.s.syncConfig(t.workspace);
    expect(t.state.minted, 'config sync must never mint a shared token').toBe(0);
    for (const file of ['.mcp.json', '.cursor/mcp.json', '.codex/config.toml']) {
        const text = await readFile(join(t.workspace, file), 'utf8');
        expect(text.includes(legacy), `${file} must not contain the shared credential`).toBe(false);
        expect(text.includes('user-server')).toBe(true);
    }
});

it('reconciles legacy entries even when each harness sync is disabled', async () => {
    const t = await fixture(); await t.seed();
    for (const key of ['mcp_sync_claude', 'mcp_sync_cursor', 'mcp_sync_codex']) await t.s.settings.set(key, false);
    await t.s.syncConfig(t.workspace);
    for (const file of ['.mcp.json', '.cursor/mcp.json', '.codex/config.toml']) expect((await readFile(join(t.workspace, file), 'utf8')).includes(legacy), file).toBe(false);
    expect(t.state.minted).toBe(0);
});

for (const provider of ['claude', 'codex'] as const) it(`${provider} launches only after composition supplies its own private key`, async () => {
    const t = await fixture(); await t.seed();
    let release!: () => void; t.state.gate = new Promise<void>((yes) => { release = yes; });
    const launched = deferred();
    const seen: Array<readonly McpServer[]> = [];
    const host = new SessionHost({ userData: join(dir, 'session'), processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) },
        prepareMcpServers: (record, _cwd, signal) => t.prepare(record, signal).catch((error: unknown) => { launched.reject(error); throw error; }),
        driverFor: (_record, _cwd, _resume, extras) => () => ({ start: () => { seen.push(extras?.mcpServers ?? []); launched.resolve(); }, kill: () => {}, prompt: () => {}, cliSessionId: null, ready: Promise.resolve() }) });
    hosts.push(host); const agent = t.agent(provider); host.start(agent, t.workspace);
    await t.requestEntered; expect(t.state.requests).toBe(1); expect(seen).toHaveLength(0);
    release(); await launched.promise; expect(seen).toHaveLength(1);
    expect(seen[0]?.map((s) => s.name)).toEqual(['tynn']);
    expect(JSON.stringify(seen).includes(legacy)).toBe(false);
    expect(t.rows[0]?.external_id).toBe(agent.id);
    expect(JSON.stringify(host.probe(agent.id)).includes('rpk_')).toBe(false);
});

it('uses distinct keys for two agents, restores them after restart, and writes only encrypted private vault data', async () => {
    const t = await fixture(); const a = t.agent(); const b = agentRecord({ ...t.agent('claude'), name: 'second-agent' });
    const [first, second] = await Promise.all([t.prepare(a), t.prepare(b)]);
    expect(JSON.stringify(first) === JSON.stringify(second)).toBe(false); expect(t.state.minted).toBe(2);
    const vault = await readFile(join(dir, 'home/agent-credentials/agents.json'), 'utf8');
    expect(vault.includes('rpk_')).toBe(false);
    const restarted = await t.boot();
    expect(JSON.stringify(await restarted.prepareAgentMcp(a, new AbortController().signal)) === JSON.stringify(first)).toBe(true);
    expect(t.state.minted).toBe(2);
    expect((await readFile(join(t.workspace, 'project.json'), 'utf8')).includes('rpk_')).toBe(false);
});

it('explains a failed Tynn preparation in session status and never constructs a provider or exposes upstream text', async () => {
    const t = await fixture(); await t.seed(); t.state.online = false;
    let created = 0;
    const host = new SessionHost({ userData: join(dir, 'failed-session'), processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) },
        prepareMcpServers: (record, _cwd, signal) => t.prepare(record, signal),
        driverFor: () => { created++; return null; } });
    hosts.push(host); const agent = t.agent(); host.start(agent, t.workspace);
    await t.requestEntered;
    await vi.waitFor(() => expect(host.probe(agent.id)?.failure).toBeTruthy());
    const status = JSON.stringify(host.probe(agent.id));
    expect(status.includes('Tynn could not be reached'), 'show an actionable, sanitized failure').toBe(true);
    expect(status.includes(legacy)).toBe(false); expect(created).toBe(0);
});

it('refuses a credential for a workspace link changed during preparation', async () => {
    const t = await fixture(); let release!: () => void;
    t.state.gate = new Promise<void>((yes) => { release = yes; });
    const pending = t.prepare(t.agent());
    const outcome = pending.catch((error: unknown) => error);
    await t.requestEntered; expect(t.state.requests).toBe(1);
    await writeFile(join(t.workspace, 'project.json'), JSON.stringify({ tynn: { projectId: 'another-project' } }));
    release();
    expect(await outcome).toBeInstanceOf(Error);
});

it('does not register or mint after Stop cancels an in-flight identity lookup', async () => {
    const t = await fixture(); let release!: () => void;
    t.state.gate = new Promise<void>((yes) => { release = yes; });
    const cancel = new AbortController(); const outcome = t.prepare(t.agent(), cancel.signal).catch((error: unknown) => error);
    await t.requestEntered; expect(t.state.requests).toBe(1);
    cancel.abort(); release();
    expect(await outcome).toBeInstanceOf(Error); expect(t.rows, 'cancelled lookup must not register an identity').toHaveLength(0); expect(t.state.minted).toBe(0);
});

it.each(['offline', 'signed-out', 'locked', 'revoked'] as const)('refuses %s without using the legacy credential', async (mode) => {
    const t = await fixture(); await t.seed(); const a = t.agent();
    if (mode === 'revoked') { await t.prepare(a); t.rows[0]!.tokens[0]!.active = false; }
    if (mode === 'offline') t.state.online = false;
    if (mode === 'signed-out') t.state.signedIn = false;
    if (mode === 'locked') t.state.encryption = false;
    await expect(t.prepare(a)).rejects.toThrow(/Tynn.*(credential|agent|sign|encryption|reached|key)/i);
    expect(t.state.minted).toBe(mode === 'revoked' ? 1 : 0);
});

it('refuses a malformed config or an unrecognized Tynn entry without overwriting it or minting', async () => {
    const t = await fixture(); const file = join(t.workspace, '.mcp.json');
    for (const text of ['{bad-json', JSON.stringify({ mcpServers: { tynn: { command: 'user-server' } } })]) {
        await writeFile(file, text); await expect(t.prepare(t.agent())).rejects.toThrow(/Tynn.*config/i);
        expect((await readFile(file, 'utf8')) === text).toBe(true);
    }
    expect(t.state.minted).toBe(0);
});

it('does not provision an unlinked or OS agent, refuses unknown workspace binding, and respects cancellation', async () => {
    const t = await fixture(); const a = t.agent();
    await writeFile(join(t.workspace, 'project.json'), '{}'); expect(await t.prepare(a)).toEqual([]);
    expect(await t.prepare(agentRecord({ ...a, workspaceId: OS_WORKSPACE }))).toEqual([]);
    await expect(t.prepare(agentRecord({ ...a, workspaceId: 'missing' }))).rejects.toThrow(/workspace/i);
    const abort = new AbortController(); abort.abort(); await expect(t.prepare(a, abort.signal)).rejects.toThrow(/cancel/i);
    expect(t.state.minted).toBe(0);
});

it('production main wires preparation for both providers and safeStorage without the on-disk fallback', async () => {
    const main = await readFile('src/main/main.ts', 'utf8');
    expect(main.includes('tynnMcpServersOnDisk')).toBe(false);
    expect(/prepareMcpServers:\s*async[\s\S]*?prepareAgentMcp\(record,\s*signal\)/.test(main), 'main must prepare each session').toBe(true);
    expect(/tynnCipher:\s*\{[\s\S]*?safeStorage\.encryptString\(text\)[\s\S]*?safeStorage\.decryptString\(bytes\)/.test(main), 'production encryption must use safeStorage').toBe(true);
});
