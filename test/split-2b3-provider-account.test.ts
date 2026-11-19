import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ENGINE_METHODS } from '../src/core/engine-protocol.js';
import { WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { memoryPair } from '../src/core/line-transport.js';
import { MCP_RECOVERY_ATTEMPTS, MCP_RECOVERY_SPACING_MS, type McpServerReport } from '../src/core/mcp-missing.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';

/*
 * CLIENT/HOST SPLIT STEP 2b-3 (Tynn #898, story #896, task #1428): main's engine use `providerAccount` goes, and with it
 * main's DUPLICATE provider health and agent operations (the coordinator's ruling, 2026-11-19, from the survey):
 *  - RECOVERY OF A MISSING GENIE-MANAGED MCP SERVER (genie#1202) is genie-host's: it hears every session's MCP report
 *    itself, so an agent that came up without its `genie` or `tynn` server is restarted on the same conversation with
 *    NO window connected. Until now only main recovered, so with every window closed nothing did. The record keeps the
 *    servers it saw (Tynn #628) on genie-host too.
 *  - The tray's Try again for a paused account is `accountRetry` over main's own protocol client.
 *  - main's providerHealth, agentOps, settingApplier, startOnDemand, the flows' agentSessions and wakeAgent are gone (dead).
 *  - The engine routes engine.providerAccount, engine.login, engine.cancelLogin and engine.switchAccount are retired.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const TOKEN = 'f'.repeat(64);

interface Recovery { heard(agentId: string, reports: readonly McpServerReport[]): void; dispose(): void }
interface RecoveryPorts {
    notice(agentId: string, text: string): void;
    restart(agentId: string): Promise<unknown>;
    noteSeen(agentId: string, names: readonly string[]): void;
    now(): number;
    later(run: () => void, ms: number): () => void;
}
/** Dynamic: new in this step, so each case goes red on its own. */
const recoveryModule = async () => { const file: string = '../src/main/host-mcp-recovery.js'; return import(file) as Promise<{ hostMcpRecovery: (ports: RecoveryPorts) => Recovery; withMcpRecovery: (pass: (agentId: string, reports: readonly McpServerReport[]) => void, recovery: Recovery) => (agentId: string, reports: readonly McpServerReport[]) => void }>; };

const ok = (name: string): McpServerReport => ({ name, status: 'connected', toolCount: 4 } as McpServerReport);
const failed = (name: string): McpServerReport => ({ name, status: 'failed', error: 'tools/list timed out' } as McpServerReport);

function fixture() {
    let clock = 1_000_000;
    const notices: Array<[string, string]> = [];
    const restarts: string[] = [];
    const seen: Array<[string, readonly string[]]> = [];
    const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
    const ports: RecoveryPorts = {
        notice: (id, text) => { notices.push([id, text]); },
        restart: async (id) => { restarts.push(id); },
        noteSeen: (id, names) => { seen.push([id, names]); },
        now: () => clock,
        later: (run, ms) => { const t = { at: clock + ms, run, live: true }; timers.push(t); return () => { t.live = false; }; },
    };
    const advance = (ms: number) => { clock += ms; for (const t of timers) if (t.live && t.at <= clock) { t.live = false; t.run(); } };
    return { ports, notices, restarts, seen, timers, advance };
}

describe('genie-host recovers a session that came up without its genie or tynn server (genie#1202)', () => {
    it('a missing tynn server: said in the agent’s chat, restarted once on the same conversation, and the servers it saw kept', async () => {
        const { hostMcpRecovery } = await recoveryModule();
        const f = fixture();
        const r = hostMcpRecovery(f.ports);
        r.heard('agent_a', [ok('genie'), failed('tynn')]);
        expect(f.restarts).toEqual(['agent_a']);
        expect(f.notices).toHaveLength(1);
        expect(f.notices[0]![1]).toMatch(/without tynn \(failed: tools\/list timed out\)[\s\S]*restarting it on the same conversation[\s\S]*attempt 1 of 2/);
        expect(f.seen).toEqual([['agent_a', ['genie', 'tynn']]]);
    });

    it('a second report inside the spacing waits; the recheck acts on the LATEST report, and restarts again only if still missing', async () => {
        const { hostMcpRecovery } = await recoveryModule();
        const f = fixture();
        const r = hostMcpRecovery(f.ports);
        r.heard('agent_a', [failed('genie')]);
        r.heard('agent_a', [failed('genie')]);
        expect(f.restarts).toEqual(['agent_a']);
        expect(f.timers.filter((t) => t.live)).toHaveLength(1);
        f.advance(MCP_RECOVERY_SPACING_MS);
        expect(f.restarts).toEqual(['agent_a', 'agent_a']);
        expect(f.notices.at(-1)![1]).toMatch(/attempt 2 of 2/);
    });

    it('a healthy report in the meantime cancels the recheck and starts over', async () => {
        const { hostMcpRecovery } = await recoveryModule();
        const f = fixture();
        const r = hostMcpRecovery(f.ports);
        r.heard('agent_a', [failed('genie')]);
        r.heard('agent_a', [failed('genie')]);
        r.heard('agent_a', [ok('genie'), ok('tynn')]);
        f.advance(MCP_RECOVERY_SPACING_MS);
        expect(f.restarts).toEqual(['agent_a']);
        r.heard('agent_a', [failed('tynn')]);
        expect(f.restarts).toEqual(['agent_a', 'agent_a']);
        expect(f.notices.at(-1)![1]).toMatch(/attempt 1 of 2/);
    });

    it(`gives up once, in words, after ${MCP_RECOVERY_ATTEMPTS} restarts, and never loops`, async () => {
        const { hostMcpRecovery } = await recoveryModule();
        const f = fixture();
        const r = hostMcpRecovery(f.ports);
        for (let i = 0; i < 4; i++) { r.heard('agent_a', [failed('tynn')]); f.advance(MCP_RECOVERY_SPACING_MS); }
        expect(f.restarts).toHaveLength(MCP_RECOVERY_ATTEMPTS);
        expect(f.notices.filter(([, t]) => /stopped retrying/.test(t))).toHaveLength(1);
    });

    it('CONTROL: a server Genie does not manage failing restarts nothing, and a pending one is not missing', async () => {
        const { hostMcpRecovery } = await recoveryModule();
        const f = fixture();
        const r = hostMcpRecovery(f.ports);
        r.heard('agent_a', [ok('genie'), ok('tynn'), failed('someone-elses')]);
        r.heard('agent_b', [{ name: 'tynn', status: 'pending' } as McpServerReport]);
        expect({ restarts: f.restarts, notices: f.notices }).toEqual({ restarts: [], notices: [] });
        expect(f.seen.map(([id]) => id)).toEqual(['agent_a', 'agent_b']);
    });

    it('dispose cancels a waiting recheck', async () => {
        const { hostMcpRecovery } = await recoveryModule();
        const f = fixture();
        const r = hostMcpRecovery(f.ports);
        r.heard('agent_a', [failed('genie')]);
        r.heard('agent_a', [failed('genie')]);
        r.dispose();
        f.advance(MCP_RECOVERY_SPACING_MS);
        expect(f.restarts).toEqual(['agent_a']);
    });
});

describe('with NO window connected, the host still recovers (the gap this closes)', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => { for (const c of cleanups.splice(0)) c(); });

    it('the engine server’s own onMcpServers, passed through with no window linked, and the host’s recovery runs', async () => {
        const { hostMcpRecovery, withMcpRecovery } = await recoveryModule();
        const server = new SessionEngineServer({ token: TOKEN, build: 't' });
        const f = fixture();
        const onMcpServers = withMcpRecovery(server.hostOptions().onMcpServers, hostMcpRecovery(f.ports));
        expect(() => onMcpServers('agent_a', [failed('tynn')])).not.toThrow();
        expect(f.restarts).toEqual(['agent_a']);
    });

    it('a window linked still hears the report (passed through), and the host recovers once, not twice', async () => {
        const { hostMcpRecovery, withMcpRecovery } = await recoveryModule();
        const server = new SessionEngineServer({ token: TOKEN, build: 't' });
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide, { local: true });
        const heard: string[] = [];
        const client = new SessionEngineClient({ onMcpServers: (id) => { heard.push(id); } });
        expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
        cleanups.push(() => windowSide.close());
        const f = fixture();
        withMcpRecovery(server.hostOptions().onMcpServers, hostMcpRecovery(f.ports))('agent_a', [failed('tynn')]);
        for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
        expect({ heard, restarts: f.restarts }).toEqual({ heard: ['agent_a'], restarts: ['agent_a'] });
    });

    it('genie-host’s session host is built with the recovery, restarting through its own graceful restart', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/onMcpServers: withMcpRecovery\(engineHostOptions\.onMcpServers, mcpRecovery\)/);
        expect(host).toMatch(/const mcpRecovery = hostMcpRecovery\(\{[\s\S]{0,900}restart: \(id\) => trustRestart\(id as AgentId\)/);
        expect(host).toMatch(/const mcpRecovery = hostMcpRecovery\(\{[\s\S]{0,900}noteSeen: [^\n]*noteMcpSeen\(/);
    });
});

describe('main keeps no duplicate of the host’s agent operations (source guards)', () => {
    const main = code(src('src/main/main.ts'));

    it('no MCP recovery, provider health, agent operations, setting applier or start-on-demand of its own', () => {
        const gone = ['McpRecovery', 'recoverMissingMcp', 'restartForMcp', 'onMcpServers', 'ProviderHealthBook', 'providerHealth', 'agentOpsPorts', 'SettingApplier', 'settingApplier', 'startForWork', 'startForYourMessage', 'startOnDemand', 'retryPausedAgents', 'retryPausedAccount', 'wakeAgent', 'agentSessions'];
        expect(gone.filter((name) => new RegExp(`\\b${name}\\b`).test(main))).toEqual([]);
    });

    it('the tray’s Try again is accountRetry over main’s own protocol client', () => {
        expect(main).toMatch(/onAccountRetry:[\s\S]{0,300}ownProtocol\.call\('accountRetry'/);
    });

    it('main asks the host for its Tynn recovery after secrets move, and restarts nothing itself', () => {
        expect(main).toMatch(/tynn\(\)\.recovery\(\{ secretsMoved: true \}\)/);
    });
});

describe('the engine routes main no longer uses are retired', () => {
    const RETIRED = ['engine.providerAccount', 'engine.login', 'engine.cancelLogin', 'engine.switchAccount'];

    it('ENGINE_METHODS no longer lists them, and the window’s engine client has no method for them', () => {
        expect(RETIRED.filter((m) => (ENGINE_METHODS as readonly string[]).includes(m))).toEqual([]);
        const proto = SessionEngineClient.prototype as unknown as Record<string, unknown>;
        expect(['providerAccount', 'login', 'cancelLogin', 'switchAccount'].filter((m) => typeof proto[m] === 'function')).toEqual([]);
    });

    it('the engine server answers none of them', () => {
        const server = code(src('src/main/session-engine-server.ts'));
        expect(RETIRED.filter((m) => server.includes(`'${m}'`))).toEqual([]);
    });

    it('CONTROL: a route still in use is still listed and answered', () => {
        expect(ENGINE_METHODS as readonly string[]).toContain('engine.accountsAct');
        expect(code(src('src/main/session-engine-server.ts'))).toContain("'engine.accountsAct'");
    });

    it('providerAccount has left the guard’s inventory and its frozen list', () => {
        expect(WINDOW_ENGINE_INVENTORY.map(([use]) => use)).not.toContain('providerAccount');
        expect(src('test/split-2e-window-guard.test.ts')).not.toMatch(/\bproviderAccount: '2b'/);
    });
});
