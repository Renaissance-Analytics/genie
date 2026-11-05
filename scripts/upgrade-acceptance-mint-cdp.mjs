#!/usr/bin/env node
import { waitForPageProbe } from './page-probe-cdp.mjs';
/**
 * REAL KEYS FROM A REAL TYNN, ACROSS THE UPGRADE (P3.4; plan §13, the beta.56 acceptance): S7, S5 and S6, against tynn.gen. On omarchy-test, with tynn.ai aliased. Refuses anywhere else.
 *
 *   bash vm-tynn-alias-linux.sh <dir>
 *   npm ci && node node_modules/electron/install.js && npm run build
 *   node scripts/smoke-seed.mjs && node scripts/upgrade-acceptance-mint-cdp.mjs
 *
 *   S7. An agent minted by the real beta.56 starts on this build with that same key, and no new token is minted.
 *   S5. A never-minted agent, the window dead, woken by mail, holds a key tynn.gen issued, and tynn.gen's MCP answers it.
 *   S6. That key revoked on tynn.gen is not handed out at the next start, and no replacement is minted.
 *
 * The account is `admin@example.com`, because the seeded member maintains no project. The provider is scripts/stub-codex.mjs in record mode, which writes down the servers it was
 * really given, for beta.56 as for this build. Everything goes to tynn.gen through the alias; `/dev/quick-login` answers only where APP_ENV is local or development, so against
 * production this fails closed. Keys are compared and never printed.
 *
 * Prints `### mint <check>=PASS|FAIL  detail`, then `### mint=PASS|FAIL`. Capped at 12 min.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';

if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: this replaces a profile; test machines only'); process.exit(2); }
process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;

const PORT = Number(process.env.CDP_PORT ?? 9222);
const APPIMAGE_URL = process.env.BETA56_APPIMAGE ?? 'https://github.com/Renaissance-Analytics/genie/releases/download/v2.0.0-beta.56/Genie-2.0.0-beta.56.AppImage';
const TYNN = 'https://tynn.ai';
const ACCOUNT = process.env.TYNN_TEST_ACCOUNT ?? 'admin@example.com';
const B_ID = `agent_${'d4e5f6a7'.repeat(4)}`;
const home = join(homedir(), '.genie');
const runtime = join(home, 'runtime');
const RECORD = join(tmpdir(), 'genie-stub-codex-record-servers');
const require = createRequire(`${process.cwd()}/`);
const work = mkdtempSync(join(tmpdir(), 'mint-'));
const jar = join(work, 'jar');
const say = (line) => console.log(`--- ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, name, detail = '') => { console.log(`### mint ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`); if (!ok) failures.push(name); };
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
const hostPid = () => { try { return JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8')).pid; } catch { return null; } };
const records = () => { try { return readFileSync(RECORD, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const pgrep = (pattern) => { try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number).filter((p) => p !== process.pid); } catch { return []; } };

// Windows' curl is schannel: it asks for a revocation answer the alias's local certificate cannot give, and refuses without one (batch II: CRYPT_E_NO_REVOCATION_CHECK). Only that check is off; the chain and the name are still checked (0a, 0b). And it has no /dev/null.
const CURL_OS = process.platform === 'win32' ? ['--ssl-no-revoke'] : [];
const NOWHERE = process.platform === 'win32' ? 'NUL' : '/dev/null';

const curlSafely = (args, options) => {
    try { return execFileSync('curl', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], ...options }); } catch (error) {
        const url = args.findLast((a) => a.startsWith('http')) ?? 'an address';
        throw new Error(`curl ${url.split('?')[0]}: ${String(error.stderr ?? 'no answer').trim().split(/\r?\n/)[0].slice(0, 200)}`);
    }
};

// tynn.gen as the same person, by curl, which reads the OS store the alias CA is in.
const curl = (...args) => curlSafely(['-sS', ...CURL_OS, '-A', 'Genie-upgrade-acceptance', '-c', jar, '-b', jar, ...args]);
const xsrf = () => { const v = readFileSync(jar, 'utf8').split('\n').map((l) => l.split('\t')).find((f) => f[5] === 'XSRF-TOKEN')?.[6]; if (!v) throw new Error('no XSRF cookie'); return decodeURIComponent(v); };
function logIn() {
    curl('-o', NOWHERE, `${TYNN}/login`);
    const status = curl('-o', NOWHERE, '-w', '%{http_code}', '-H', `X-XSRF-TOKEN: ${xsrf()}`, '-H', 'Accept: text/html', '--data-urlencode', `email=${ACCOUNT}`, `${TYNN}/dev/quick-login`);
    if (status !== '302') throw new Error(`quick login answered ${status}: not a local Tynn, or no such seeded account`);
}
function signInCode() {
    const code = /token=([A-Za-z0-9]{64})/.exec(curl(`${TYNN}/genie/callback?return=genie%3A%2F%2Foauth%2Fcallback`))?.[1];
    if (!code) throw new Error('no 64-character code on the callback page');
    return code;
}
const api = (path) => JSON.parse(curl('-H', 'Accept: application/json', `${TYNN}${path}`));
/** Every token on the project's agents, live or not: a mint adds a row, whichever agent it is for. */
const tokensOf = (project) => {
    const rows = [];
    for (const agent of api(`/api/v1/projects/${project}/agents`).agents ?? []) {
        for (const token of api(`/api/v1/projects/${project}/agents/${agent.id}/tokens`).tokens ?? []) rows.push({ agent: agent.id, id: token.id, publicId: token.public_id, active: token.active ?? token.revoked_at === null });
    }
    return rows;
};
const publicIdOf = (key) => /^rpk_([0-9A-Za-z]{26})\./.exec(key ?? '')?.[1] ?? null;
const mcpAnswers = (key) => curl('-o', NOWHERE, '-w', '%{http_code}', '-X', 'POST', '-H', 'Content-Type: application/json', '-H', 'Accept: application/json, text/event-stream', '-H', `Authorization: Bearer ${key}`, '--data', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mint-check', version: '1' } } }), `${TYNN}/mcp/tynn`);

let window = null;
async function stopApp() {
    const host = hostPid();
    for (const pid of pgrep('stub-codex')) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    for (const pid of [window?.pid, host]) { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
    await sleep(2000);
    for (const pid of [window?.pid, host]) { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    window = null;
    await sleep(500);
}
async function finish() {
    await stopApp();
    if (failures.length > 0) {
        try {
            console.log('--- the end of the host log');
            for (const line of readFileSync(join(home, 'logs', 'genie-host.log'), 'utf8').split('\n').slice(-30)) console.log(line.slice(0, 220));
        } catch (error) { console.log(`--- no host log: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try { rmSync(RECORD, { force: true }); rmSync(work, { recursive: true, force: true }); } catch { /* gone */ }
    console.log(`### mint=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
    process.exit(failures.length === 0 ? 0 : 1);
}
setTimeout(() => { check(false, 'the-12-min-cap'); void finish(); }, 720_000).unref();

class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect(url) {
        const c = new Cdp();
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (r) { c.#pending.delete(f.id); r(f); } });
        await new Promise((res, rej) => { c.#ws.addEventListener('open', res, { once: true }); c.#ws.addEventListener('error', () => rej(new Error('CDP socket error')), { once: true }); });
        return c;
    }
    async evaluate(expression) {
        const id = this.#id++;
        const f = await new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
        if (f.result?.exceptionDetails) throw new Error(`page threw: ${f.result.exceptionDetails.exception?.description ?? '?'}`);
        return f.result?.result?.value;
    }
    close() { try { this.#ws.close(); } catch { /* gone */ } }
}
async function launch(command, args) {
    const env = { ...process.env, GENIE_PAGE_PROBE: '1', GENIE2_CODEX_BINARY: join(process.cwd(), 'scripts', 'stub-codex.mjs'), XDG_SESSION_TYPE: 'x11', DISPLAY: process.env.DISPLAY ?? ':0' };
    delete env.ELECTRON_RUN_AS_NODE;
    window = spawn(command, [...args, '--no-sandbox', '--ozone-platform=x11', `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
    const page = await until('a window on the debugger port', 90_000, async () => {
        try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { return null; }
    });
    if (!page) throw new Error(`no window on the debugger port from ${command}`);
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await until('window.genie', 30_000, () => cdp.evaluate('typeof window.genie === "object"'));
    return cdp;
}
const signedIn = (cdp) => cdp.evaluate('window.genie.features.snapshot().then((d) => d?.integrations?.tynn?.user?.name ?? null)');
const start = async (cdp, id) => { await waitForPageProbe(cdp); return cdp.evaluate(`window.genieTest.agents.restart(${JSON.stringify(id)}, "graceful"); true`); };
const newRun = (seen) => until('a new run of the provider', 60_000, () => records().find((r) => !seen.has(r.pid)) ?? null);

try {
    const resolved = execFileSync('getent', ['hosts', 'tynn.ai'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (resolved !== '127.0.0.1' && resolved !== '::1') throw new Error(`tynn.ai resolves to ${resolved}: the alias is not up, and this would reach production`);
    check(true, '0-tynn-ai-is-the-alias', resolved);
    logIn();
    const listed = api('/api/v1/projects');
    const projects = Array.isArray(listed) ? listed : listed.projects ?? listed.data ?? [];
    const project = projects.find((p) => p.slug === 'mcp-workflow-testing') ?? projects[0];
    check(Boolean(project), '1-the-account-has-a-project', project ? String(project.slug ?? project.id) : JSON.stringify(listed).slice(0, 120));
    if (!project) throw new Error('no project to mint in');

    const manifest = join(process.cwd(), 'project.json');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), tynn: { projectId: String(project.id) } }, null, 2));
    const agentsFile = join(runtime, 'agents.json');
    const agents = JSON.parse(readFileSync(agentsFile, 'utf8'));
    const codex = agents.find((a) => a.provider === 'codex');
    if (!codex) throw new Error('smoke-seed.mjs left no codex agent');
    writeFileSync(agentsFile, JSON.stringify([...agents.filter((a) => a.id !== B_ID), { ...codex, id: B_ID, name: 'newcomer', mode: 'automated', threadId: null, accessScope: 'self' }]));
    writeFileSync(RECORD, '');
    chmodSync(join(process.cwd(), 'scripts', 'stub-codex.mjs'), 0o755);

    say('the real beta.56 mints for A');
    const image = join(work, 'beta56.AppImage');
    if (process.env.BETA56_APPIMAGE && existsSync(process.env.BETA56_APPIMAGE)) cpSync(process.env.BETA56_APPIMAGE, image);
    else execFileSync('curl', ['-fsSL', '-o', image, APPIMAGE_URL], { timeout: 300_000 });
    chmodSync(image, 0o755);
    execFileSync(image, ['--appimage-extract'], { cwd: work, stdio: 'ignore', timeout: 180_000 });
    const root = join(work, 'squashfs-root');
    const binary = ['genie', 'Genie', 'ai.tynn.genie'].map((name) => join(root, name)).find((file) => existsSync(file));
    if (!binary) throw new Error(`no Genie binary in ${root}: ${readdirSync(root).slice(0, 30).join(', ')}`);
    const old = await launch(binary, []);
    const said = await old.evaluate(`window.genie.features.act({ kind: 'integrations.tynnCode', code: ${JSON.stringify(signInCode())} }).then((r) => r.tynnMessage ?? null)`);
    if (said) say(`Tynn said: ${String(said).slice(0, 160)}`);
    check(Boolean(await until('beta.56 to be signed in', 60_000, () => signedIn(old))), '2-beta56-signed-in');
    const seenOld = new Set(records().map((r) => r.pid));
    await start(old, codex.id);
    const first = await until('A with its key, under beta.56', 90_000, () => records().find((r) => !seenOld.has(r.pid) && r.servers?.tynn?.bearer) ?? null);
    const keyA = first?.servers?.tynn?.bearer ?? null;
    check(Boolean(publicIdOf(keyA)), '3-beta56-minted-a-real-key-for-A');
    if (!keyA) throw new Error('beta.56 gave A no key, so nothing below would prove anything');
    check(mcpAnswers(keyA) === '200', '4-CONTROL-tynn-gen-answers-that-key');
    const tokensBefore = tokensOf(project.id);
    check(tokensBefore.some((t) => t.publicId === publicIdOf(keyA)), '5-CONTROL-tynn-gen-lists-it', `${tokensBefore.length} token(s)`);
    const vault = readFileSync(join(home, 'agent-credentials', 'agents.json'), 'utf8');
    check(vault.includes('"tokenEnc"'), '6-CONTROL-beta56-sealed-it-in-the-vault');
    old.close();
    await stopApp();

    say('S7: this build, the same key, no new mint');
    const cdp = await launch(require('electron'), ['.']);
    check(Boolean(await until('the account', 60_000, () => signedIn(cdp))), 'S7.0-still-signed-in');
    const seen = new Set(records().map((r) => r.pid));
    await start(cdp, codex.id);
    const afterMove = await newRun(seen);
    check(afterMove?.servers?.tynn?.bearer === keyA, 'S7.1-A-starts-on-its-old-key');
    const tokensAfter = tokensOf(project.id);
    check(tokensAfter.length === tokensBefore.length, 'S7.2-no-new-mint', `${tokensBefore.length} -> ${tokensAfter.length}`);
    const moved = readFileSync(join(home, 'agent-credentials', 'agents.json'), 'utf8');
    check(!moved.includes('"tokenEnc"'), 'S7.3-the-seal-left-the-vault');

    say('S5: the window dies, A mails a never-minted agent, and tynn.gen mints');
    const exeOf = (pid) => { try { return readlinkSync(`/proc/${pid}/exe`); } catch { return ''; } };
    const main = pgrep(`remote-debugging-port=${PORT}`).find((pid) => { try { return basename(exeOf(pid)) === 'electron' && !readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type='); } catch { return false; } });
    if (!main) throw new Error('no Electron main to kill');
    const genie = afterMove?.servers?.genie;
    if (!genie) throw new Error('A has no genie server to mail through');
    const seenMail = new Set(records().map((r) => r.pid));
    cdp.close();
    process.kill(main, 'SIGKILL');
    await until('the window to go', 15_000, () => !alive(main));
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${genie.bearer}`, ...genie.headers };
    const post = async (body, session) => {
        const response = await fetch(genie.url, { method: 'POST', headers: { ...headers, ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        await response.text();
        return { session: response.headers.get('mcp-session-id'), status: response.status };
    };
    const opened = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mint-check', version: '1' } } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, opened.session);
    const mailed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agentinbox', arguments: { action: 'send', to: 'newcomer', text: 'wake up: this is the mint check' } } }, opened.session);
    check(mailed.status === 200, 'S5.0-A-mailed-B-with-no-window', `http ${mailed.status}`);
    const woken = await until("B with its key", 90_000, () => records().find((r) => !seenMail.has(r.pid) && r.servers?.tynn?.bearer) ?? null);
    const keyB = woken?.servers?.tynn?.bearer ?? null;
    check(Boolean(publicIdOf(keyB)) && keyB !== keyA, 'S5.1-B-holds-a-key-of-its-own');
    const tokensMinted = tokensOf(project.id);
    const rowB = tokensMinted.find((t) => t.publicId === publicIdOf(keyB));
    check(Boolean(rowB) && tokensMinted.length === tokensAfter.length + 1, 'S5.2-tynn-gen-issued-exactly-that-one', `${tokensAfter.length} -> ${tokensMinted.length}`);
    check(keyB !== null && mcpAnswers(keyB) === '200', 'S5.3-tynn-gen-answers-it');
    await stopApp();

    say('S6: that key revoked on tynn.gen');
    if (!rowB) throw new Error('no token row for B to revoke');
    const revoked = curl('-o', NOWHERE, '-w', '%{http_code}', '-X', 'DELETE', '-H', 'Accept: application/json', '-H', `X-XSRF-TOKEN: ${xsrf()}`, `${TYNN}/api/v1/projects/${project.id}/agents/${rowB.agent}/tokens/${rowB.id}`);
    check(revoked.startsWith('2'), 'S6.0-revoked-on-tynn-gen', `http ${revoked}`);
    const again = await launch(require('electron'), ['.']);
    await until('the account', 60_000, () => signedIn(again));
    const seenRevoked = new Set(records().map((r) => r.pid));
    await start(again, B_ID);
    const restarted = await newRun(seenRevoked);
    check(Boolean(restarted) && restarted.servers?.tynn?.bearer !== keyB, 'S6.1-the-revoked-key-is-not-handed-out', restarted ? `tynn given: ${Boolean(restarted.servers?.tynn?.enabled)}` : 'B did not start');
    await sleep(5_000);
    const tokensLast = tokensOf(project.id);
    check(tokensLast.length === tokensMinted.length, 'S6.2-no-replacement-was-minted', `${tokensMinted.length} -> ${tokensLast.length}`);
    const detail = await again.evaluate(`window.genie.agentDetail(${JSON.stringify(B_ID)}).then((d) => JSON.stringify(d?.rows ?? []).slice(-4000))`);
    check(/Tynn/.test(String(detail)), 'S6.3-B-says-so', String(detail).match(/[^"]{0,60}Tynn[^"]{0,100}/)?.[0] ?? 'nothing about Tynn in its rows');
    again.close();
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
