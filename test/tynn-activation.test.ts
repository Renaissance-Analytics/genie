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
type Activated = ComposedServices & { prepareAgentMcp(agent: AgentRecord, signal: AbortSignal): Promise<readonly McpServer[]>; tynnNote(agentId: string): string | null; tynnRecovery(): Promise<string[]> };
function deferred() {
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}

async function fixture() {
    const workspace = join(dir, 'workspace'); await mkdir(workspace);
    await writeFile(join(workspace, 'project.json'), JSON.stringify({ tynn: { projectId: 'project-42' } }));
    const state = { online: true, encryption: true, signedIn: true, userId: 'user-7', saved: null as string | null, accountLate: false, minted: 0, lists: 0, requests: 0, gate: Promise.resolve() };
    const rows: Array<{ id: string; name: string; external_id: string; status: string; tokens: Array<{ public_id: string; active: boolean }> }> = [];
    const requestEntered = deferred();
    const account = { status: () => ({ signedIn: state.signedIn }), userId: () => state.signedIn ? state.userId : null, savedUserId: () => state.saved,
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
        workspaces: () => [{ id: 'workspace', path: workspace }], tynn: () => { if (state.accountLate) { state.accountLate = false; return null; } return account; },
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

/*
 * OFF GRID (genie#1234, the owner 2026-10-26): Genie signed itself out of Tynn and every agent in a Tynn-linked workspace
 * showed Broken. Tynn being signed out, down or unreachable must never stop an agent from starting: it starts without
 * the `tynn` server, says so in a note that blocks nothing, and still never borrows a shared workspace credential.
 */
it('Tynn unreachable: the agent STILL STARTS, without the tynn server, with a note instead of a failure (genie#1234)', async () => {
    const t = await fixture(); await t.seed(); t.state.online = false;
    const launched = deferred();
    const seen: Array<readonly McpServer[]> = [];
    const host = new SessionHost({ userData: join(dir, 'off-grid-session'), processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) },
        prepareMcpServers: (record, _cwd, signal) => t.prepare(record, signal).catch((error: unknown) => { launched.reject(error); throw error; }),
        driverFor: (_record, _cwd, _resume, extras) => () => ({ start: () => { seen.push(extras?.mcpServers ?? []); launched.resolve(); }, kill: () => {}, prompt: () => {}, cliSessionId: null, ready: Promise.resolve() }) });
    hosts.push(host); const agent = t.agent(); host.start(agent, t.workspace);
    await launched.promise;
    expect(seen).toEqual([[]]);
    expect(host.probe(agent.id)?.failure ?? null, 'not Broken').toBeNull();
    const note = t.s.tynnNote(agent.id);
    expect(note, 'a non-blocking note says why the Tynn tools are missing').toMatch(/Tynn/);
    expect(note!.includes(legacy)).toBe(false);
    expect(JSON.stringify(seen).includes(legacy)).toBe(false);
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

it.each(['offline', 'signed-out', 'locked', 'revoked'] as const)('%s starts without Tynn and never uses the legacy credential (genie#1234)', async (mode) => {
    const t = await fixture(); await t.seed(); const a = t.agent();
    if (mode === 'revoked') { await t.prepare(a); t.rows[0]!.tokens[0]!.active = false; }
    if (mode === 'offline') t.state.online = false;
    if (mode === 'signed-out') t.state.signedIn = false;
    if (mode === 'locked') t.state.encryption = false;
    expect(await t.prepare(a)).toEqual([]);
    expect(t.s.tynnNote(a.id)).toMatch(/Tynn/);
    expect(t.state.minted).toBe(mode === 'revoked' ? 1 : 0);
});

it('CONTROL: an agent that got its key carries no Tynn note', async () => {
    const t = await fixture(); const a = t.agent();
    expect((await t.prepare(a)).map((s) => s.name)).toEqual(['tynn']);
    expect(t.s.tynnNote(a.id)).toBeNull();
});

it('a stored key is used off grid: signed out, or Tynn down, the agent keeps its own Tynn tools (genie#1234)', async () => {
    const t = await fixture(); const a = t.agent(); const first = await t.prepare(a);
    t.state.online = false;
    expect(await t.prepare(a)).toEqual(first);
    t.state.online = true; t.state.signedIn = false; t.state.saved = 'user-7';
    const requests = t.state.requests;
    expect(await t.prepare(a)).toEqual(first);
    expect(t.state.requests, 'signed out: no request before the stored key is used').toBe(requests);
    expect(t.state.minted).toBe(1);
});

/*
 * NOTHING RETRIED (genie#1234): after signing back in the agents stayed broken until Genie restarted. Now the agents that
 * started without Tynn because of the account (signed out, or unreachable) are named for a restart when the account
 * signs in, and an agent that started on an unverified stored key is checked then and named if Tynn refuses that key.
 */
it('the account arriving signed in while an agent prepares is not missed (no change event is left to recover it)', async () => {
    const t = await fixture(); const a = t.agent();
    t.state.accountLate = true;
    expect((await t.prepare(a)).map((s) => s.name)).toEqual(['tynn']);
    expect(t.s.tynnNote(a.id)).toBeNull();
});

it('signing in to Tynn names the agents that started without it, and only those (genie#1234)', async () => {
    const t = await fixture(); const out = t.agent(); const fine = t.agent('claude');
    expect((await t.prepare(fine)).map((s) => s.name)).toEqual(['tynn']);
    t.state.signedIn = false;
    expect(await t.prepare(out)).toEqual([]);
    expect(await t.s.tynnRecovery(), 'still signed out: nothing to do yet').toEqual([]);
    t.state.signedIn = true;
    expect(await t.s.tynnRecovery()).toEqual([out.id]);
    expect((await t.prepare(out)).map((s) => s.name), 'the restart gets its key').toEqual(['tynn']);
    expect(t.s.tynnNote(out.id)).toBeNull();
    expect(await t.s.tynnRecovery(), 'once recovered, it is not restarted again').toEqual([]);
});

it('signing in does not churn an agent whose Tynn identity is refused for a reason sign-in cannot fix', async () => {
    const t = await fixture(); const a = t.agent(); await t.prepare(a);
    t.rows[0]!.status = 'suspended';
    expect(await t.prepare(a)).toEqual([]);
    expect(t.s.tynnNote(a.id)).toMatch(/Tynn/);
    expect(await t.s.tynnRecovery()).toEqual([]);
});

it('an agent started on an unverified stored key is checked once Tynn answers, and named only if Tynn refuses it (genie#1234)', async () => {
    const t = await fixture(); const keep = t.agent(); const lose = agentRecord({ ...t.agent('claude'), name: 'second-agent' });
    await t.prepare(keep); await t.prepare(lose);
    t.state.online = false;
    expect((await t.prepare(keep)).map((s) => s.name)).toEqual(['tynn']);
    expect((await t.prepare(lose)).map((s) => s.name)).toEqual(['tynn']);
    t.state.online = true;
    t.rows.find((r) => r.external_id === lose.id)!.tokens[0]!.active = false;
    const requests = t.state.requests;
    expect(await t.s.tynnRecovery()).toEqual([lose.id]);
    expect(t.state.requests, 'each unverified key was checked with Tynn').toBeGreaterThan(requests);
    expect(await t.s.tynnRecovery(), 'the verified one is settled; the refused one waits for its restart').toEqual([lose.id]);
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

it('production main restarts the agents Tynn recovery names when the account changes, and notes a missing Tynn (genie#1234)', async () => {
    const main = await readFile('src/main/main.ts', 'utf8');
    expect(/tynnAccount\.onChange\(\s*recoverTynnAgents\s*\)/.test(main), 'an account change asks for recovery').toBe(true);
    expect(/\n\s*recoverTynnAgents\(\);/.test(main), 'and once after the account opens, signed in before anyone listened').toBe(true);
    expect(/function recoverTynnAgents[\s\S]*?tynnRecovery\(\)[\s\S]*?restartForMcp/.test(main), 'with the existing graceful restart').toBe(true);
    expect(/prepareAgentMcp\(record,\s*signal\)[\s\S]*?tynnNote\(record\.id\)[\s\S]*?notice\(/.test(main), 'the note reaches the chat').toBe(true);
});

it('production main wires preparation for both providers and safeStorage without the on-disk fallback', async () => {
    const main = await readFile('src/main/main.ts', 'utf8');
    expect(main.includes('tynnMcpServersOnDisk')).toBe(false);
    expect(/prepareMcpServers:\s*async[\s\S]*?prepareAgentMcp\(record,\s*signal\)/.test(main), 'main must prepare each session').toBe(true);
    expect(/tynnCipher:\s*\{[\s\S]*?safeStorage\.encryptString\(text\)[\s\S]*?safeStorage\.decryptString\(bytes\)/.test(main), 'production encryption must use safeStorage').toBe(true);
});
