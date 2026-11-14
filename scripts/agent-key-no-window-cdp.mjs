#!/usr/bin/env node
/**
 * THE WINDOW PROCESS IS KILLED, THE HOST STARTS AN AGENT, THE AGENT HAS ITS TYNN KEY (genie#1457; plan §13) — on the real app,
 * the real genie-host and the real OS keychain, in a test VM. Refuses anywhere else.
 *
 *   node scripts/smoke-seed.mjs && node scripts/agent-key-no-window-cdp.mjs seed     # before the app launches
 *   (launch with GENIE_PAGE_PROBE=1, --remote-debugging-port=9222 and GENIE2_CODEX_BINARY=scripts/stub-codex.mjs)
 *   node scripts/agent-key-no-window-cdp.mjs run
 *
 * `seed` leaves what a window that minted would leave: the binding in the vault, the key in the keychain, the account on disk.
 * `run` starts agent A through the window (no account in that window, so no Tynn: the POSITIVE CONTROL that the gauge can read
 * "no tynn server"), kills Electron main ONLY, and sends A's real `agentinbox send` to the stopped agent B through the host's real
 * MCP server. The host wakes B. The stub provider records the MCP servers it was really given, the bearer included.
 *
 * THE NEGATIVE: `run --expect-bug`, on a tree scripts/perf-lag/agent-key-bug-back.mjs has broken. Everything up to the mail must still hold,
 * and check 8 inverts: B started by the host with NO Tynn key. A PASS there is this check seen catching the bug.
 *
 * Prints a line per step, then `### agent-key <check>=PASS|FAIL` and `### agent-key=PASS|FAIL`. Every wait has a deadline, the run
 * is capped at 4 min, and every exit ends the providers and the host it found. The key is a test word, never a real one.
 */
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';

const phase = process.argv[2] ?? '';
const expectBug = process.argv.includes('--expect-bug');
if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: this writes a keychain entry and a seeded profile; test machines only'); process.exit(2); }

const PORT = Number(process.env.CDP_PORT ?? 9222);
const PUBLIC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const KEY = `rpk_${PUBLIC_ID}.${'ab'.repeat(32)}`;
const USER = 'vm-user-1';
const PROJECT = 'vm-project-1';
const B_ID = `agent_${'c3d4e5f6'.repeat(4)}`;
const home = join(homedir(), '.genie');
const runtime = join(home, 'runtime');
const RECORD = join(tmpdir(), 'genie-stub-codex-record-servers');
const say = (line) => console.log(`--- ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (phase === 'seed') {
    const { AsyncEntry } = createRequire(`${process.cwd()}/`)('@napi-rs/keyring');
    await new AsyncEntry('Genie', `tynn/agent/${PUBLIC_ID}`, { linux: { store: 'secret-service' } }).setPassword(KEY);
    say('the key is in the keychain');
    const agents = JSON.parse(readFileSync(join(runtime, 'agents.json'), 'utf8'));
    const codex = agents.find((a) => a.provider === 'codex');
    if (!codex) throw new Error('smoke-seed.mjs left no codex agent');
    writeFileSync(join(runtime, 'agents.json'), JSON.stringify([...agents.filter((a) => a.id !== B_ID), { ...codex, id: B_ID, name: 'keyholder', mode: 'automated', threadId: null, accessScope: 'self' }], null, 2));
    const manifest = join(process.cwd(), 'project.json');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), tynn: { projectId: PROJECT } }, null, 2));
    mkdirSync(join(home, 'agent-credentials'), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'credentials'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'agent-credentials', 'agents.json'), JSON.stringify({ version: 1, records: { [JSON.stringify([USER, PROJECT, B_ID])]: { userId: USER, projectId: PROJECT, genieId: B_ID, remoteAgentId: 'remote-1', state: 'ready', publicId: PUBLIC_ID } } }), { mode: 0o600 });
    // The record a sign-in leaves, with no pairing token in the keychain: the account knows whose it is, is not signed in, and mints nothing.
    writeFileSync(join(home, 'credentials', 'tynn.json'), JSON.stringify({ version: 1, state: 'signed-in', host: 'https://tynn.ai', userId: USER, scopes: ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'] }), { mode: 0o600 });
    writeFileSync(RECORD, '');
    say('seeded');
    process.exit(0);
}
if (phase !== 'run') { console.error('usage: agent-key-no-window-cdp.mjs seed|run'); process.exit(2); }

const failures = [];
function check(ok, name, detail = '') {
    console.log(`### agent-key ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures.push(name);
}
const until = async (what, ms, read) => {
    const end = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > end) { say(`gave up waiting for ${what} after ${ms / 1000} s`); return null; }
        await sleep(500);
    }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const records = () => { try { return readFileSync(RECORD, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const pgrep = (pattern) => { try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number).filter((p) => p !== process.pid); } catch { return []; } };
function finish() {
    let host = null;
    try { host = JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8')); } catch { /* none */ }
    for (const pid of pgrep('stub-codex')) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    if (host?.pid) { try { process.kill(host.pid, 'SIGTERM'); } catch { /* gone */ } }
    try { rmSync(RECORD, { force: true }); } catch { /* gone */ }
    console.log(`### agent-key=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
    process.exit(failures.length === 0 ? 0 : 1);
}
setTimeout(() => { check(false, 'the-4-min-cap'); finish(); }, 240_000).unref();

class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect(url) {
        const c = new Cdp();
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (typeof r === 'function') { c.#pending.delete(f.id); r(f); } });
        await new Promise((res, rej) => { c.#ws.addEventListener('open', res, { once: true }); c.#ws.addEventListener('error', () => rej(new Error('CDP socket error')), { once: true }); });
        return c;
    }
    async evaluate(expression) {
        const id = this.#id++;
        const f = await new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
        if (f.result?.exceptionDetails) throw new Error(`page threw: ${f.result.exceptionDetails.exception?.description ?? '?'}`);
        return f.result?.result?.value;
    }
}

/** One MCP tool call, as a provider makes it, with what A was really given. */
async function callTool(server, name, args) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${server.bearer}`, ...server.headers };
    const post = async (body, session) => {
        const response = await fetch(server.url, { method: 'POST', headers: { ...headers, ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        const text = await response.text();
        const data = text.split('\n').find((l) => l.startsWith('data:'));
        let parsed = null;
        try { parsed = JSON.parse(data ? data.slice(5) : text); } catch { /* a notification's empty answer */ }
        return { session: response.headers.get('mcp-session-id'), parsed, status: response.status };
    };
    const opened = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-key-no-window', version: '1' } } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, opened.session);
    return post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, opened.session);
}

function logsHolding(value, dir = home, depth = 0) {
    const found = [];
    if (depth > 4 || !existsSync(dir)) return found;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...logsHolding(value, path, depth + 1));
        else if (/\.(log|txt)$/.test(entry.name) && statSync(path).size < 50_000_000 && readFileSync(path, 'utf8').includes(value)) found.push(path);
    }
    return found;
}

try {
    say('finding the window');
    const page = await until('a window on the debugger port', 60_000, async () => {
        try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { return null; }
    });
    if (!page) throw new Error('no window on the debugger port');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await until('window.genie', 30_000, () => cdp.evaluate('typeof window.genie === "object"'));

    const snap = await cdp.evaluate('window.genieTest.snapshot()');
    const a = snap.agents.find((x) => x.provider === 'codex' && x.id !== B_ID);
    check(Boolean(a) && snap.agents.some((x) => x.id === B_ID), '1-the-seed-left-both-agents', a?.id ?? 'no agent A');
    check(!pgrep('stub-codex').length, '2-no-provider-before-anything-starts');

    say('starting A through the window');
    await waitForPageProbe(cdp);
    await cdp.evaluate(`window.genieTest.agents.restart(${JSON.stringify(a.id)}, "graceful"); true`);
    const first = await until('A\'s provider', 45_000, () => records()[0] ?? null);
    const genie = first?.servers?.genie;
    check(Boolean(genie?.url && genie?.bearer), '3-A-has-the-hosts-genie-server', genie?.url ?? 'none');
    // POSITIVE CONTROL: this gauge can read "no tynn server", from a real start. The window here has no account.
    const given = (record) => Object.entries(record?.servers ?? {}).filter(([, server]) => server.enabled).map(([name]) => name);
    check(first?.servers !== undefined && !given(first).includes('tynn') && !first.servers.tynn?.bearer, '4-CONTROL-the-gauge-reads-no-tynn-server', `given: ${given(first).join(',')}; disabled so none is inherited: ${first?.servers?.tynn?.enabled === false}`);

    const host = JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8'));
    const matching = pgrep(`remote-debugging-port=${PORT}`);
    const exeOf = (pid) => { try { return readlinkSync(`/proc/${pid}/exe`); } catch { return ''; } };
    const mains = matching.filter((pid) => { try { return basename(exeOf(pid)) === 'electron' && !readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type='); } catch { return false; } });
    check(mains.length === 1, '5-found-electron-main', `main ${mains.join(',')}; everything with the flag: ${matching.map((pid) => `${pid}=${basename(exeOf(pid))}`).join(' ')}`);
    if (mains.length !== 1) throw new Error('no single Electron main to kill');
    say(`killing Electron main ${mains[0]} (not its tree); the host is ${host.pid}`);
    process.kill(mains[0], 'SIGKILL');
    await until('the window to go', 15_000, () => !alive(mains[0]));
    await sleep(2_000);
    const debuggerAnswers = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3_000) }).then(() => true, () => false);
    check(!alive(mains[0]) && !debuggerAnswers && alive(host.pid) && alive(first.pid), '6-window-dead-host-and-A-alive', `main alive=${alive(mains[0])} debugger answers=${debuggerAnswers} host alive=${alive(host.pid)} A alive=${alive(first.pid)}`);

    say('A mails B, through the host');
    const sent = await callTool(genie, 'agentinbox', { action: 'send', to: 'keyholder', text: 'wake up: this is the no-window key check' });
    check(sent.status === 200 && sent.parsed?.result?.isError !== true && sent.parsed?.error === undefined, '7-A-mailed-B-with-no-window', `http ${sent.status} ${JSON.stringify(sent.parsed?.result?.content ?? sent.parsed?.error ?? null).slice(0, 200)}`);

    const b = await until('B\'s provider', 60_000, () => records().find((r) => r.pid !== first.pid) ?? null);
    if (expectBug) {
        check(b !== null && !given(b).includes('tynn') && !b.servers.tynn?.bearer, '8-NEGATIVE-with-the-bug-back-B-has-no-tynn-key', b ? `given: ${given(b).join(',')}` : 'B never started');
    } else {
        check(b?.servers?.tynn?.enabled === true && b.servers.tynn.bearer === KEY, '8-B-started-by-the-host-has-its-tynn-key', b ? `given: ${given(b).join(',')}` : 'B never started');
        check(b?.servers?.tynn?.url === 'https://tynn.ai/mcp/tynn', '9-the-tynn-server-is-tynns', b?.servers?.tynn?.url ?? 'none');
    }
    check(b?.servers?.genie?.enabled === true && Boolean(b.servers.genie.url), '10-and-the-hosts-genie-server-beside-it');
    check(!readFileSync(join(home, 'agent-credentials', 'agents.json'), 'utf8').includes('rpk_'), '11-the-vault-holds-no-key');
    const leaks = logsHolding(KEY);
    check(leaks.length === 0, '12-no-log-holds-the-key', leaks.join(','));
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
finish();
