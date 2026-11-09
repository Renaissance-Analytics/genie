#!/usr/bin/env node
/**
 * THE OS'S PROXY, FROM A REAL WINDOW TO THE REAL HOST (P3.4 cut c; the owner: "Yes, cover it."), on omarchy-test. Refuses anywhere else.
 *
 *   npm ci && node node_modules/electron/install.js && npm run build
 *   node scripts/smoke-seed.mjs && node scripts/proxy-os-answer-cdp.mjs
 *
 * It starts the app itself, twice, and never leaves anything running. GNOME's proxy settings are what it sets (`gsettings`), and Chromium
 * reads them only under a GNOME desktop name, so the window runs with XDG_CURRENT_DESKTOP=GNOME; Omarchy itself is Hyprland. If `gsettings`
 * cannot set them here, that is said (`### proxy-os gsettings=UNAVAILABLE <why>`) and the run stops: nothing else here measures anything
 * without it.
 *
 *   CONTROL: mode none  -> session.resolveProxy says DIRECT -> the host remembers DIRECT -> the local proxy is not touched.
 *   THE CLAIM: mode manual -> resolveProxy names the local proxy -> the host remembers it (0600) -> the host's Tynn call goes through it.
 *   DEAD: the proxy goes away -> Settings says Tynn is out of reach through that proxy, and the sign-in record is untouched.
 *
 * The local proxy records CONNECTs and refuses them, so nothing here reaches the network. The account holds a test word for a key. Prints
 * `### proxy-os <check>=PASS|FAIL  detail`, then `### proxy-os=PASS|FAIL`. Capped at 5 min.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
// The feature snapshot is read on the page's own bridge now (P4 family 11): window.genieTest needs this.
process.env.GENIE_PAGE_PROBE ??= '1';

if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: this changes GNOME settings and a seeded profile; test machines only'); process.exit(2); }

// The desktop session's bus, which an ssh shell has none of: the keychain and the window both need it.
process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
const PORT = Number(process.env.CDP_PORT ?? 9222);
const home = join(homedir(), '.genie');
const runtime = join(home, 'runtime');
const MEMORY = join(runtime, 'host-proxy.json');
const TOKEN = `gpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.${'ab'.repeat(32)}`;
const USER = 'vm-user-1';
const SCOPES = ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'];
const require = createRequire(`${process.cwd()}/`);
const say = (line) => console.log(`--- ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(ok, name, detail = '') { console.log(`### proxy-os ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`); if (!ok) failures.push(name); }
const until = async (what, ms, read) => {
    const end = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > end) { say(`gave up waiting for ${what} after ${ms / 1000} s`); return null; }
        await sleep(500);
    }
};
const gsettings = (...args) => execFileSync('gsettings', args, { encoding: 'utf8', timeout: 10_000 }).trim();

let window = null;
let proxy = null;
const hostPid = () => { try { return JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8')).pid; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function stopAll() {
    const host = hostPid();
    for (const pid of [window?.pid, host]) { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
    await sleep(1500);
    for (const pid of [window?.pid, host]) { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    window = null;
    await until('the window and host to go', 15_000, async () => !(await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)));
}
async function finish() {
    await stopAll().catch(() => {});
    try { gsettings('set', 'org.gnome.system.proxy', 'mode', 'none'); } catch { /* unavailable */ }
    try { proxy?.closeAllConnections(); proxy?.close(); } catch { /* gone */ }
    console.log(`### proxy-os=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
    process.exit(failures.length === 0 ? 0 : 1);
}
setTimeout(() => { check(false, 'the-5-min-cap'); void finish(); }, 300_000).unref();

function launch() {
    const electron = require('electron');
    const env = { ...process.env, XDG_CURRENT_DESKTOP: 'GNOME', DESKTOP_SESSION: 'gnome', XDG_SESSION_TYPE: 'x11', DISPLAY: process.env.DISPLAY ?? ':0' };
    // The OS's settings are the thing measured: nothing explicit may answer first, in the window or the host it starts.
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete env[name];
    window = spawn(electron, ['.', '--no-sandbox', '--ozone-platform=x11', `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
}
const remembered = () => { try { return JSON.parse(readFileSync(MEMORY, 'utf8')).origins?.['https://tynn.ai'] ?? null; } catch { return null; } };

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
        return f.result?.result?.value;
    }
}

try {
    // Can GNOME's settings be set here at all?
    let usable = '';
    try {
        gsettings('set', 'org.gnome.system.proxy', 'mode', 'none');
        gsettings('set', 'org.gnome.system.proxy.https', 'host', '127.0.0.1');
        gsettings('set', 'org.gnome.system.proxy', 'mode', 'manual');
        usable = gsettings('get', 'org.gnome.system.proxy', 'mode');
        gsettings('set', 'org.gnome.system.proxy', 'mode', 'none');
    } catch (error) { usable = `threw: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`; }
    if (!usable.includes('manual')) { console.log(`### proxy-os gsettings=UNAVAILABLE  ${usable}`); failures.push('gsettings'); await finish(); }
    check(true, 'gsettings-can-set-the-proxy');

    // The sign-in a window left: the key in the keychain, the record on disk. The token is a test word.
    const { AsyncEntry } = require('@napi-rs/keyring');
    await new AsyncEntry('Genie', 'tynn/pairing', { linux: { store: 'secret-service' } }).setPassword(TOKEN);
    mkdirSync(join(home, 'credentials'), { recursive: true, mode: 0o700 });
    const record = JSON.stringify({ version: 1, state: 'signed-in', host: 'https://tynn.ai', userId: USER, scopes: SCOPES });
    writeFileSync(join(home, 'credentials', 'tynn.json'), record, { mode: 0o600 });

    const tunnels = [];
    proxy = createServer();
    proxy.on('connect', (req, client) => { tunnels.push(req.url ?? ''); client.end('HTTP/1.1 502 Not Going Anywhere\r\n\r\n'); });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = proxy.address().port;
    say(`local proxy on ${proxyPort}`);

    say('CONTROL: mode none');
    launch();
    const direct = await until('the host to remember an answer', 90_000, remembered);
    check(direct === 'DIRECT', '1-CONTROL-the-os-says-direct', String(direct));
    await sleep(3_000);
    check(tunnels.length === 0, '2-CONTROL-the-proxy-is-not-touched', `${tunnels.length} tunnel(s)`);
    await stopAll();

    say('THE CLAIM: mode manual');
    gsettings('set', 'org.gnome.system.proxy.https', 'host', '127.0.0.1');
    gsettings('set', 'org.gnome.system.proxy.https', 'port', String(proxyPort));
    gsettings('set', 'org.gnome.system.proxy', 'mode', 'manual');
    launch();
    const named = await until('the answer to name the proxy', 90_000, () => { const a = remembered(); return a && a.includes(String(proxyPort)) ? a : null; });
    check(Boolean(named), '3-session-resolveProxy-named-it-and-the-host-remembered', String(named ?? remembered()));
    check((statSync(MEMORY).mode & 0o777) === 0o600, '4-the-file-is-0600', (statSync(MEMORY).mode & 0o777).toString(8));
    const through = await until('the host to call Tynn through it', 45_000, () => tunnels.find((t) => t.startsWith('tynn.ai')) ?? null);
    check(Boolean(through), '5-the-hosts-tynn-call-went-through-the-proxy', tunnels.join(' '));

    say('DEAD: the proxy goes away');
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    const page = await until('the window', 30_000, async () => { try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { return null; } });
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    // The account asks again on its own backoff (30 s first); that call meets a port with nothing on it.
    const message = await until('Settings to name the proxy', 60_000, async () => {
        const text = await cdp.evaluate('(window.genieTest ?? window.genie).features.snapshot().then((d) => d?.integrations?.tynn?.message ?? null)');
        return typeof text === 'string' && text.includes(String(proxyPort)) ? text : null;
    });
    check(Boolean(message), '6-settings-names-the-dead-proxy', String(message));
    check(readFileSync(join(home, 'credentials', 'tynn.json'), 'utf8').includes(USER), '7-the-sign-in-record-stands');
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
