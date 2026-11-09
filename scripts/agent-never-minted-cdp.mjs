#!/usr/bin/env node
/**
 * THE WINDOW PROCESS IS KILLED, A NEVER-MINTED AGENT IS WOKEN BY MAIL, AND IT IS MINTED AND HOLDS ITS KEY (genie#1457; plan §13) — the real app,
 * the real genie-host, the real OS keychain, on omarchy-test. Refuses anywhere else.
 *
 *   npm ci && node node_modules/electron/install.js && npm run build
 *   node scripts/smoke-seed.mjs && node scripts/agent-never-minted-cdp.mjs
 *
 * THE NEGATIVE, in a throwaway tree:
 *   npm ci && node node_modules/electron/install.js && node scripts/perf-lag/agent-key-bug-back.mjs && npm run build
 *   node scripts/smoke-seed.mjs && node scripts/agent-never-minted-cdp.mjs --expect-bug
 * `### never-minted=PASS` there means everything up to the mail held and B started with no key.
 *
 * THE OUTAGE, in the same run: Tynn's agent endpoints go down while /me still answers, A mails never-minted C with the window still dead, and C
 * starts without Tynn. The host asks again on its backoff and restarts nobody while that fails. Tynn comes back and C is restarted, by the host, on the
 * same thread, holding its key. Its negative, in a throwaway tree:
 *   node scripts/perf-lag/agent-key-bug-back.mjs recovery && npm run build
 *   node scripts/smoke-seed.mjs && node scripts/agent-never-minted-cdp.mjs --expect-no-recovery
 * `### never-minted=PASS` there means C was still without its key when the time ran out, with Tynn answering.
 *
 * It starts the app itself, because Tynn has to be up before the host opens its account. Tynn here is a small fake that answers the endpoints the
 * host calls and counts them, over real TLS. Nothing reaches the network and nothing needs root: the host reaches it through HTTPS_PROXY, a local
 * CONNECT proxy that sends tynn.ai to it, and trusts its CA through SSL_CERT_FILE, which is what Node reads as the OS store
 * (scripts/perf-lag/host-tls-measure.mjs measured both, under this binary). All keys here are test words.
 *
 * Prints a line per step, `### never-minted <check>=PASS|FAIL  detail`, then `### never-minted=PASS|FAIL`. Capped at 8 min. Every exit ends what it started.
 */
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { connect as netConnect } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: this writes a keychain entry and a seeded profile; test machines only'); process.exit(2); }

// The desktop session's bus, which an ssh shell has none of: the keychain and the window both need it.
process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
const expectBug = process.argv.includes('--expect-bug');
const expectNoRecovery = process.argv.includes('--expect-no-recovery');
const PORT = Number(process.env.CDP_PORT ?? 9222);
const PAIRING = `gpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.${'ab'.repeat(32)}`;
const USER = { id: 'vm-user-1', name: 'VM Person', email: 'vm@example.invalid' };
const PROJECT = 'vm-project-1';
const SCOPES = ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'];
const B_ID = `agent_${'d4e5f6a7'.repeat(4)}`;
const C_ID = `agent_${'e5f6a7b8'.repeat(4)}`;
const home = join(homedir(), '.genie');
const runtime = join(home, 'runtime');
const RECORD = join(tmpdir(), 'genie-stub-codex-record-servers');
const VAULT = join(home, 'agent-credentials', 'agents.json');
const require = createRequire(`${process.cwd()}/`);
const work = mkdtempSync(join(tmpdir(), 'never-minted-'));
const say = (line) => console.log(`--- ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, name, detail = '') => { console.log(`### never-minted ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`); if (!ok) failures.push(name); };
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
const pgrep = (pattern) => { try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number).filter((p) => p !== process.pid); } catch { return []; } };
const records = () => { try { return readFileSync(RECORD, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const given = (record) => Object.entries(record?.servers ?? {}).filter(([, server]) => server.enabled).map(([name]) => name);
const hostRecord = () => { try { return JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8')); } catch { return null; } };

let window = null;
const servers = [];
async function finish() {
    const host = hostRecord();
    for (const pid of pgrep('stub-codex')) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    for (const pid of [window?.pid, host?.pid]) { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
    await sleep(1500);
    for (const pid of [window?.pid, host?.pid]) { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    for (const server of servers) { try { server.closeAllConnections(); server.close(); } catch { /* gone */ } }
    try { rmSync(RECORD, { force: true }); rmSync(work, { recursive: true, force: true }); } catch { /* gone */ }
    if (failures.length > 0) {
        // What the host itself said, so a failure names which part.
        try {
            const log = readFileSync(join(home, 'logs', 'genie-host.log'), 'utf8').split('\n');
            console.log('--- the host: every recovery line, then the end of its log');
            for (const line of log.filter((l) => l.includes('tynn recovery'))) console.log(line.slice(0, 220));
            for (const line of log.slice(-30)) console.log(line.slice(0, 220));
        } catch (error) { console.log(`--- no host log: ${error instanceof Error ? error.message : String(error)}`); }
    }
    console.log(`### never-minted=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
    process.exit(failures.length === 0 ? 0 : 1);
}
setTimeout(() => { check(false, 'the-8-min-cap'); void finish(); }, 480_000).unref();

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

/** What the host calls: who am I, the project's agents, register, mint. Counted, and only by the bearer it was given. */
const tynn = { remote: [], minted: [], lists: 0, me: 0, agentsDown: false };
function tynnAnswers(req, res) {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
        const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        // TYNN ANSWERS EVERY UNAUTHORIZED REQUEST WITH 404 (the owner, 2026-10-26).
        if (req.headers.authorization !== `Bearer ${PAIRING}`) return reply(404, { message: 'Not Found' });
        const path = (req.url ?? '').split('?')[0];
        if (path === '/api/v1/me') { tynn.me += 1; return reply(200, USER); }
        // THE OUTAGE: who you are still answers, and the agent endpoints do not.
        if (tynn.agentsDown) return reply(503, { message: 'Service Unavailable' });
        if (path === `/api/v1/projects/${PROJECT}/agents` && req.method === 'GET') { tynn.lists += 1; return reply(200, { project_id: PROJECT, agents: tynn.remote }); }
        if (path === `/api/v1/projects/${PROJECT}/agents` && req.method === 'POST') {
            const body = JSON.parse(text);
            const row = { id: `remote-${tynn.remote.length + 1}`, name: body.name, external_id: body.external_id, status: 'active', tokens: [] };
            tynn.remote.push(row);
            return reply(201, { created: true, agent: row });
        }
        if (path === '/api/v1/projects/agent-token' && req.method === 'POST') {
            const row = tynn.remote.find((r) => r.name === JSON.parse(text).agent_name);
            if (!row) return reply(404, { message: 'Not Found' });
            const publicId = String(tynn.minted.length + 1).padStart(26, '0');
            const token = `rpk_${publicId}.${'cd'.repeat(32)}`;
            row.tokens.push({ public_id: publicId, active: true });
            tynn.minted.push({ agent: row.external_id, publicId, token });
            return reply(200, { token, agent: { id: row.id, name: row.name }, mcp_url: 'https://tynn.ai/mcp/tynn' });
        }
        return reply(404, { message: 'Not Found' });
    });
}

try {
    // A CA and a leaf for tynn.ai, by Genie's own builder.
    const out = join(work, 'x509.mjs');
    require('esbuild').buildSync({ entryPoints: ['src/main/x509.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
    const { issueCa, issueLeaf } = await import(pathToFileURL(out).href);
    const notBefore = new Date(Date.now() - 86_400_000);
    const notAfter = new Date(Date.now() + 30 * 86_400_000);
    const ca = issueCa({ commonName: 'Never Minted Test CA', organization: 'Genie Test', notBefore, notAfter });
    const leaf = issueLeaf(ca, ['tynn.ai'], notBefore, notAfter);
    const caFile = join(work, 'ca.crt');
    writeFileSync(caFile, ca.certPem);

    const fake = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, tynnAnswers);
    servers.push(fake);
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    const tunnels = [];
    const proxy = createHttpServer();
    servers.push(proxy);
    proxy.on('connect', (req, client, head) => {
        tunnels.push(req.url ?? '');
        if (!(req.url ?? '').startsWith('tynn.ai:')) { client.end('HTTP/1.1 502 Only Tynn Here\r\n\r\n'); return; }
        const up = netConnect(fakePort, '127.0.0.1', () => { client.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(client); client.pipe(up); });
        up.on('error', () => client.destroy());
        client.on('error', () => up.destroy());
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

    // The sign-in a window left, in the keychain and on disk. B has never been started, and nothing is minted.
    const { AsyncEntry } = require('@napi-rs/keyring');
    await new AsyncEntry('Genie', 'tynn/pairing', { linux: { store: 'secret-service' } }).setPassword(PAIRING);
    mkdirSync(join(home, 'credentials'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'credentials', 'tynn.json'), JSON.stringify({ version: 1, state: 'signed-in', host: 'https://tynn.ai', userId: USER.id, scopes: SCOPES }), { mode: 0o600 });
    const agents = JSON.parse(readFileSync(join(runtime, 'agents.json'), 'utf8'));
    const codex = agents.find((a) => a.provider === 'codex');
    if (!codex) throw new Error('smoke-seed.mjs left no codex agent');
    writeFileSync(join(runtime, 'agents.json'), JSON.stringify([...agents.filter((a) => a.id !== B_ID && a.id !== C_ID), { ...codex, id: B_ID, name: 'newcomer', mode: 'automated', threadId: null, accessScope: 'self' }, { ...codex, id: C_ID, name: 'latecomer', mode: 'automated', threadId: null, accessScope: 'self' }], null, 2));
    const manifest = join(process.cwd(), 'project.json');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), tynn: { projectId: PROJECT } }, null, 2));
    writeFileSync(RECORD, '');
    check(!existsSync(VAULT) || !readFileSync(VAULT, 'utf8').includes(B_ID), '1-B-has-never-been-minted');

    chmodSync(join(process.cwd(), 'scripts', 'stub-codex.mjs'), 0o755);
    say('launching');
    const env = { ...process.env, GENIE_PAGE_PROBE: '1', HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, SSL_CERT_FILE: caFile, GENIE2_CODEX_BINARY: join(process.cwd(), 'scripts', 'stub-codex.mjs'), XDG_SESSION_TYPE: 'x11', DISPLAY: process.env.DISPLAY ?? ':0' };
    for (const name of ['https_proxy', 'NO_PROXY', 'no_proxy']) delete env[name];
    window = spawn(require('electron'), ['.', '--no-sandbox', '--ozone-platform=x11', `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });

    const page = await until('a window on the debugger port', 60_000, async () => {
        try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { return null; }
    });
    if (!page) throw new Error('no window on the debugger port');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await until('window.genie', 30_000, () => cdp.evaluate('typeof window.genie === "object"'));
    const signedIn = await until('the account to be signed in', 45_000, () => cdp.evaluate('(window.genieTest ?? window.genie).features.snapshot().then((d) => d?.integrations?.tynn?.user?.name ?? null)'));
    check(signedIn === USER.name, '2-the-host-signed-in-over-real-tls-through-the-proxy', `${signedIn}; /me asked ${tynn.me} time(s); tunnels ${tunnels.length}`);

    const snap = await cdp.evaluate('window.genie.snapshot()');
    const a = snap.agents.find((x) => x.provider === 'codex' && x.id !== B_ID && x.id !== C_ID);
    check(Boolean(a) && snap.agents.some((x) => x.id === B_ID), '3-the-seed-left-both-agents', a?.id ?? 'no agent A');
    say('starting A through the window');
    await waitForPageProbe(cdp);
    await cdp.evaluate(`window.genieTest.agents.restart(${JSON.stringify(a.id)}, "graceful"); true`);
    const first = await until("A's provider", 45_000, () => records()[0] ?? null);
    check(first !== null && given(first).includes('genie'), '4-A-has-the-hosts-genie-server', `given: ${given(first).join(',')}`);
    const mintedBefore = tynn.minted.length;
    check(tynn.minted.every((m) => m.agent !== B_ID), '5-CONTROL-B-is-not-minted-before-the-mail', `mints so far: ${mintedBefore}`);

    const matching = pgrep(`remote-debugging-port=${PORT}`);
    const exeOf = (pid) => { try { return readlinkSync(`/proc/${pid}/exe`); } catch { return ''; } };
    const mains = matching.filter((pid) => { try { return basename(exeOf(pid)) === 'electron' && !readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type='); } catch { return false; } });
    if (mains.length !== 1) { check(false, '6-found-electron-main', mains.join(',')); throw new Error('no single Electron main to kill'); }
    const host = hostRecord();
    say(`killing Electron main ${mains[0]} (not its tree); the host is ${host?.pid}`);
    process.kill(mains[0], 'SIGKILL');
    await until('the window to go', 15_000, () => !alive(mains[0]));
    await sleep(2_000);
    const debuggerAnswers = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3_000) }).then(() => true, () => false);
    check(!alive(mains[0]) && !debuggerAnswers && alive(host.pid) && alive(first.pid), '6-window-dead-host-and-A-alive', `main alive=${alive(mains[0])} debugger answers=${debuggerAnswers} host alive=${alive(host.pid)} A alive=${alive(first.pid)}`);

    say('A mails B, through the host');
    const genie = first.servers.genie;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${genie.bearer}`, ...genie.headers };
    const post = async (body, session) => {
        const response = await fetch(genie.url, { method: 'POST', headers: { ...headers, ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        const answer = await response.text();
        const data = answer.split('\n').find((l) => l.startsWith('data:'));
        let parsed = null;
        try { parsed = JSON.parse(data ? data.slice(5) : answer); } catch { /* a notification's empty answer */ }
        return { session: response.headers.get('mcp-session-id'), parsed, status: response.status };
    };
    const opened = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'never-minted', version: '1' } } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, opened.session);
    const sent = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agentinbox', arguments: { action: 'send', to: 'newcomer', text: 'wake up: this is the never-minted check' } } }, opened.session);
    const words = JSON.stringify(sent.parsed?.result?.content ?? sent.parsed?.error ?? null);
    check(sent.status === 200 && !words.includes('\\"ok\\":false') && sent.parsed?.result?.isError !== true, '7-A-mailed-B-with-no-window', words.slice(0, 180));

    const mail = async (to) => post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agentinbox', arguments: { action: 'send', to, text: 'wake up: this is the outage check' } } }, opened.session);
    const b = await until("B's provider", 60_000, () => records().find((r) => r.pid !== first.pid) ?? null);
    const mine = tynn.minted.find((m) => m.agent === B_ID);
    if (expectBug) {
        check(b !== null && !given(b).includes('tynn') && !b.servers.tynn?.bearer && !mine, '8-NEGATIVE-with-the-bug-back-B-has-no-key-and-none-was-minted', b ? `given: ${given(b).join(',')}; minted for B: ${Boolean(mine)}` : 'B never started');
    } else {
        check(Boolean(mine), '8-the-host-minted-for-B-with-no-window', `mints: ${tynn.minted.length}`);
        check(b?.servers?.tynn?.enabled === true && b.servers.tynn.bearer === mine?.token, '9-B-started-holding-that-key', b ? `given: ${given(b).join(',')}` : 'B never started');
        const held = mine ? await new AsyncEntry('Genie', `tynn/agent/${mine.publicId}`, { linux: { store: 'secret-service' } }).getPassword() : null;
        check(held === mine?.token && Boolean(held), '10-the-keychain-holds-it');
        const vault = existsSync(VAULT) ? readFileSync(VAULT, 'utf8') : '';
        check(vault.includes(B_ID) && !vault.includes('rpk_'), '11-the-vault-binds-it-and-holds-no-key');
        const listsBefore = tynn.lists;
        check(listsBefore > 0, '12-tynn-was-asked-at-start', `agents listed ${listsBefore} time(s)`);

        say('THE OUTAGE: the agent endpoints go down, and /me still answers');
        tynn.agentsDown = true;
        const seen = new Set(records().map((r) => r.pid));
        const asked = await mail('latecomer');
        check(asked.status === 200, '13-A-mailed-C-during-the-outage', `http ${asked.status}`);
        const c = await until("C's provider", 60_000, () => records().find((r) => !seen.has(r.pid)) ?? null);
        check(c !== null && !given(c).includes('tynn'), '14-C-started-without-tynn', c ? `given: ${given(c).join(',')}` : 'C never started');
        const meBefore = tynn.me;
        say('waiting past the first retry, with the outage still on');
        await sleep(45_000);
        const cRuns = () => records().filter((r) => c !== null && (r.pid === c.pid || r.method === 'thread/resume') && !seen.has(r.pid));
        check(tynn.me > meBefore, '15-CONTROL-the-host-asked-again-and-me-answered', `/me ${meBefore} -> ${tynn.me}`);
        check(cRuns().length === 1 && c !== null && alive(c.pid), '16-THREE-OF-NOTHING-no-restart-while-the-endpoint-fails', `${cRuns().length} run(s) of C; C alive=${c !== null && alive(c.pid)}`);
        check(tynn.minted.every((m) => m.agent !== C_ID), '17-nothing-minted-for-C-during-it');
        check(existsSync(VAULT) && !alive(mains[0]), '18-the-window-is-still-dead');

        say('Tynn comes back');
        tynn.agentsDown = false;
        const backAt = Date.now();
        const back = await until('C restarted with its key', 200_000, () => cRuns().find((r) => r.servers?.tynn?.enabled === true) ?? null);
        console.log(`### never-minted recovery-took=${Math.round((Date.now() - backAt) / 1000)}s  from Tynn answering to C holding its key, on the host's own backoff${back ? '' : ' (it never came)'}`);
        const mintedC = tynn.minted.find((m) => m.agent === C_ID);
        if (expectNoRecovery) {
            check(back === null && c !== null && alive(c.pid), '19-NEGATIVE-with-recovery-broken-C-stays-without-its-key', `${cRuns().length} run(s) of C`);
        } else {
            check(Boolean(mintedC), '19-the-host-minted-for-C', `mints: ${tynn.minted.length}`);
            check(back?.servers?.tynn?.bearer === mintedC?.token && Boolean(back), '20-C-restarted-holding-that-key', back ? `given: ${given(back).join(',')}` : 'C was not restarted');
            check(back?.method === 'thread/resume' && typeof back?.threadId === 'string' && back.threadId.length > 0, '21-on-the-same-conversation', back ? `${back.method} ${back.threadId}` : 'none');
            check(!alive(mains[0]), '22-and-no-window-ever-came-back');
            check(pgrep(`remote-debugging-port=${PORT}`).filter((pid) => basename(exeOf(pid)) === 'electron').length === 0, '23-no-window-process-at-all');
        }
    }
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
