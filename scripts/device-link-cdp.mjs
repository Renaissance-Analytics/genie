#!/usr/bin/env node
/**
 * ANOTHER MACHINE'S DEVICE TOKEN IS THE HOST'S (P3.4 cut e, audit M-e): the real app, the real genie-host, the real OS keychain, on omarchy-test. Refuses anywhere else.
 *
 *   npm ci && node node_modules/electron/install.js && npm run build
 *   node scripts/smoke-seed.mjs && node scripts/device-link-cdp.mjs
 *
 * The other machines here are small fakes over real sockets, which answer Genie's hello and write down what they were told. All tokens are test words.
 *
 * What it measures, past the unit tests:
 * - a token an earlier Genie left in localStorage moves to the keychain when a window opens, and leaves localStorage;
 * - a remote window, opened the real way, connects with no PIN and the machine hears that token, on a socket the HOST's process holds;
 * - a PIN pairing leaves the window with a welcome and no token, and the keychain with the token;
 * - a wss:// machine whose root is ONLY in the OS store (SSL_CERT_FILE, which is what this Node reads as that store: scripts/perf-lag/host-tls-measure.mjs measured it, and
 *   measures Windows' real store through the alias) connects, and one nobody vouches for hears nothing;
 * - the window dying takes its sockets with it, and the host lives;
 * - a whole restart, host included: still paired, still no PIN.
 *
 * Prints `### device-link <check>=PASS|FAIL  detail`, then `### device-link=PASS|FAIL`. Capped at 6 min. Every exit ends what it started, and removes what it wrote to the keychain.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: this writes keychain entries and a seeded profile; test machines only'); process.exit(2); }

process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
const PORT = Number(process.env.CDP_PORT ?? 9222);
const home = join(homedir(), '.genie');
const runtime = join(home, 'runtime');
const INDEX = join(runtime, 'device-hosts.json');
const OLD_TOKEN = 'tok_left_by_an_earlier_genie';
const MINTED = 'tok_minted_by_a_pin_pairing';
const PIN = '246810';
const require = createRequire(`${process.cwd()}/`);
const work = mkdtempSync(join(tmpdir(), 'device-link-'));
const say = (line) => console.log(`--- ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, name, detail = '') => { console.log(`### device-link ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`); if (!ok) failures.push(name); };
const until = async (what, ms, read) => {
    const end = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > end) { say(`gave up waiting for ${what} after ${ms / 1000} s`); return null; }
        await sleep(300);
    }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pgrep = (pattern) => { try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number).filter((p) => p !== process.pid); } catch { return []; } };
const hostRecord = () => { try { return JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8')); } catch { return null; } };
const { AsyncEntry } = require('@napi-rs/keyring');
const entry = (url) => new AsyncEntry('Genie', `device/${url}`, { linux: { store: 'secret-service' } });
const held = async (url) => { try { return (await entry(url).getPassword()) ?? null; } catch { return null; } };

let window = null;
const servers = [];
const written = new Set();
async function finish() {
    const host = hostRecord();
    for (const pid of [window?.pid, host?.pid]) { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
    await sleep(1500);
    for (const pid of [window?.pid, host?.pid]) { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    for (const server of servers) { try { server.close(); server.closeAllConnections?.(); } catch { /* gone */ } }
    for (const url of written) { try { await entry(url).deletePassword(); } catch { /* not there */ } }
    try { rmSync(INDEX, { force: true }); rmSync(work, { recursive: true, force: true }); } catch { /* gone */ }
    if (failures.length > 0) {
        try {
            console.log('--- the end of the host log');
            for (const line of readFileSync(join(home, 'logs', 'genie-host.log'), 'utf8').split('\n').slice(-30)) console.log(line.slice(0, 220));
        } catch (error) { console.log(`--- no host log: ${error instanceof Error ? error.message : String(error)}`); }
    }
    console.log(`### device-link=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
    process.exit(failures.length === 0 ? 0 : 1);
}
setTimeout(() => { check(false, 'the-6-min-cap'); void finish(); }, 360_000).unref();

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
        if (f.result?.exceptionDetails) throw new Error(f.result.exceptionDetails.exception?.description ?? f.result.exceptionDetails.text);
        return f.result?.result?.value;
    }
    close() { try { this.#ws.close(); } catch { /* gone */ } }
}

/** Another machine: it answers Genie's hello, and writes down every hello and every socket. */
function machine(server) {
    const { WebSocketServer } = require('ws');
    const heard = { hellos: [], sockets: [], ports: [] };
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket, req) => {
        heard.sockets.push(socket);
        heard.ports.push(req.socket.remotePort);
        socket.on('message', (data) => {
            const frame = JSON.parse(String(data));
            if (frame.kind !== 'hello') return;
            heard.hellos.push(frame);
            const welcome = { kind: 'welcome', connectionId: `c${heard.hellos.length}`, host: 'fake-machine', isOwner: true, workspaceId: null };
            const auth = frame.auth ?? {};
            if (auth.kind === 'pin' && auth.code === PIN) socket.send(JSON.stringify({ ...welcome, token: MINTED }));
            else if (auth.kind === 'token' && (auth.token === OLD_TOKEN || auth.token === MINTED)) socket.send(JSON.stringify(welcome));
            else socket.send(JSON.stringify({ kind: 'refused', reason: 'not paired' }));
        });
    });
    return heard;
}
const listen = async (server) => { servers.push(server); await new Promise((r) => server.listen(0, '127.0.0.1', r)); return server.address().port; };

async function launch(env) {
    window = spawn(require('electron'), ['.', '--no-sandbox', '--ozone-platform=x11', `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
    const page = await until('a window on the debugger port', 60_000, async () => {
        try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { return null; }
    });
    if (!page) throw new Error('no window on the debugger port');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await until('window.genie', 30_000, () => cdp.evaluate('typeof window.genie === "object"'));
    return cdp;
}
const mainPid = () => {
    const exeOf = (pid) => { try { return readlinkSync(`/proc/${pid}/exe`); } catch { return ''; } };
    return pgrep(`remote-debugging-port=${PORT}`).find((pid) => { try { return basename(exeOf(pid)) === 'electron' && !readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type='); } catch { return false; } }) ?? null;
};
/** Which process holds the socket whose local port this is: `ss` names it. */
const pidOfPort = (port) => {
    try {
        const line = execFileSync('ss', ['-tnpH', `sport = :${port}`], { encoding: 'utf8' });
        return Number(/pid=(\d+)/.exec(line)?.[1] ?? 0) || null;
    } catch (error) { say(`ss: ${error instanceof Error ? error.message : String(error)}`); return null; }
};
/** Say a hello through the real bridge, on a real channel, and collect what comes back. */
const dialFrom = (cdp, url, auth) => cdp.evaluate(`(async () => {
    const opened = await window.genie.deviceLink.open(${JSON.stringify(url)});
    if (!opened.ok) return { opened };
    const net = window.genie.tynnNetwork;
    const frames = [];
    let closed = null;
    const offM = net.onMessage((c, t) => { if (c === opened.channel) frames.push(t); });
    const offC = net.onClosed((c, r) => { if (c === opened.channel) closed = { reason: r }; });
    net.send(opened.channel, JSON.stringify({ kind: 'hello', auth: ${JSON.stringify(auth)}, label: 'vm' }));
    await new Promise((r) => setTimeout(r, 2500));
    offM(); offC();
    if (!closed) net.close(opened.channel);
    return { opened, frames, closed };
})()`);

try {
    const out = join(work, 'x509.mjs');
    require('esbuild').buildSync({ entryPoints: ['src/main/x509.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
    const { issueCa, issueLeaf } = await import(pathToFileURL(out).href);
    const notBefore = new Date(Date.now() - 86_400_000);
    const notAfter = new Date(Date.now() + 30 * 86_400_000);
    const trustedCa = issueCa({ commonName: 'Device Link Trusted CA', organization: 'Genie Test', notBefore, notAfter });
    const strangerCa = issueCa({ commonName: 'Device Link Stranger CA', organization: 'Genie Test', notBefore, notAfter });
    const trustedLeaf = issueLeaf(trustedCa, ['localhost'], notBefore, notAfter);
    const strangerLeaf = issueLeaf(strangerCa, ['localhost'], notBefore, notAfter);
    const caFile = join(work, 'ca.crt');
    writeFileSync(caFile, trustedCa.certPem);

    const plainServer = createHttpServer();
    const plain = machine(plainServer);
    const plainPort = await listen(plainServer);
    const trustedServer = createHttpsServer({ key: trustedLeaf.keyPem, cert: trustedLeaf.certPem });
    const trusted = machine(trustedServer);
    const trustedPort = await listen(trustedServer);
    const strangerServer = createHttpsServer({ key: strangerLeaf.keyPem, cert: strangerLeaf.certPem });
    const stranger = machine(strangerServer);
    const strangerPort = await listen(strangerServer);

    const URL_OLD = `ws://127.0.0.1:${plainPort}/genie`;
    const URL_PIN = `ws://127.0.0.1:${plainPort}/paired`;
    const URL_TRUSTED = `wss://localhost:${trustedPort}/genie`;
    const URL_STRANGER = `wss://localhost:${strangerPort}/genie`;
    for (const url of [URL_OLD, URL_PIN, URL_TRUSTED, URL_STRANGER]) written.add(url);

    const env = { ...process.env, SSL_CERT_FILE: caFile, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_EXTRA_CA_CERTS;
    const cdp = await launch(env);
    // Main is a drone until Tynn's first answer (fail closed), and signed out that answer is "not on the network".
    const dialable = await until('main to allow a dial', 30_000, async () => (await cdp.evaluate(`window.genie.deviceLink.open(${JSON.stringify(URL_OLD)}).then((o) => { if (o.ok) window.genie.tynnNetwork.close(o.channel); return o.ok; })`)) === true);
    check(Boolean(dialable), '1-a-window-can-open-a-channel');

    say('an earlier Genie left a token in localStorage');
    await cdp.evaluate(`window.localStorage.setItem('genie.remote.tokens', ${JSON.stringify(JSON.stringify({ [URL_OLD]: OLD_TOKEN }))}); true`);
    const before = await cdp.evaluate(`window.localStorage.getItem('genie.remote.tokens')`);
    check(String(before).includes(OLD_TOKEN), '2-CONTROL-the-token-is-readable-in-localStorage-before');
    await cdp.evaluate('location.reload(); true').catch(() => {});
    await sleep(1_000);
    await until('window.genie again', 30_000, () => cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"').catch(() => false));
    const moved = await until('the token to move', 20_000, async () => (await held(URL_OLD)) === OLD_TOKEN);
    check(Boolean(moved), '3-the-keychain-holds-it', `read back ${(await held(URL_OLD)) === OLD_TOKEN}`);
    const left = await until('localStorage to let go', 10_000, async () => (await cdp.evaluate(`window.localStorage.getItem('genie.remote.tokens')`)) === null);
    check(Boolean(left), '4-localStorage-no-longer-has-it');
    const index = existsSync(INDEX) ? readFileSync(INDEX, 'utf8') : '';
    check(index.includes(URL_OLD) && !index.includes('tok_'), '5-the-index-names-the-address-and-holds-no-token', index.replace(/\s+/g, ' ').slice(0, 120));

    say('a remote window, opened the real way, with no PIN');
    const hellosBefore = plain.hellos.length;
    await cdp.evaluate(`window.genie.remoteWindows.open(${JSON.stringify(URL_OLD)}, 'fake machine'); true`);
    const said = await until('the machine to hear a hello', 30_000, () => plain.hellos.slice(hellosBefore).find((h) => h.auth?.kind === 'token') ?? null);
    check(said?.auth?.token === OLD_TOKEN, '6-the-machine-heard-the-saved-token', said ? `auth kind ${said.auth.kind}` : 'no hello');
    const host = hostRecord();
    const port = plain.ports.at(-1);
    const owner = port ? pidOfPort(port) : null;
    check(owner !== null && owner === host?.pid, '7-the-socket-is-the-hosts', `socket held by ${owner}, host is ${host?.pid}`);

    say('a PIN pairing');
    const pair = await dialFrom(cdp, URL_PIN, { kind: 'pin', code: PIN, label: 'vm' });
    const welcome = (pair.frames ?? []).map((f) => JSON.parse(f)).find((f) => f.kind === 'welcome');
    check(Boolean(welcome), '8-the-window-heard-a-welcome', JSON.stringify(pair.opened));
    check(Boolean(welcome) && !('token' in welcome) && !JSON.stringify(pair.frames ?? []).includes(MINTED), '9-with-no-token-in-it');
    check((await held(URL_PIN)) === MINTED, '10-the-keychain-holds-what-the-machine-minted');
    const hosts = await cdp.evaluate('window.genie.deviceLink.hosts()');
    check(Array.isArray(hosts) && hosts.includes(URL_PIN) && !JSON.stringify(hosts).includes('tok_'), '11-the-host-lists-it-as-paired', JSON.stringify(hosts));
    check(!(await cdp.evaluate(`JSON.stringify({ ...window.localStorage })`)).includes(MINTED), '12-localStorage-never-saw-it');

    say('saying a token from the window');
    const hellos = plain.hellos.length;
    const claimed = await dialFrom(cdp, URL_PIN, { kind: 'token', token: 'made-up', label: 'vm' });
    check(claimed.closed !== null && plain.hellos.length === hellos, '13-a-window-cannot-say-a-token', `closed: ${JSON.stringify(claimed.closed)}; hellos ${hellos} -> ${plain.hellos.length}`);

    say('wss://, through the host, with the host trust set');
    const seenTrusted = await dialFrom(cdp, URL_TRUSTED, { kind: 'pin', code: PIN, label: 'vm' });
    check(seenTrusted.opened?.ok === true && trusted.hellos.length === 1, '14-a-machine-whose-root-is-only-in-the-os-store-connects', JSON.stringify(seenTrusted.opened));
    const seenStranger = await dialFrom(cdp, URL_STRANGER, { kind: 'pin', code: PIN, label: 'vm' });
    check(seenStranger.opened?.ok === false && stranger.hellos.length === 0, '15-a-machine-nobody-vouches-for-hears-nothing', JSON.stringify(seenStranger.opened));

    say('the window dies');
    const live = plain.sockets.filter((s) => s.readyState === 1);
    check(live.length > 0, '16-CONTROL-the-remote-window-still-holds-a-socket', `${live.length} open`);
    const main = mainPid();
    if (main === null) throw new Error('no Electron main to kill');
    cdp.close();
    process.kill(main, 'SIGKILL');
    await until('the window to go', 15_000, () => !alive(main));
    const allGone = await until('its sockets to close', 20_000, () => plain.sockets.every((s) => s.readyState !== 1));
    check(Boolean(allGone), '17-its-sockets-went-with-it', `${plain.sockets.filter((s) => s.readyState === 1).length} still open`);
    check(host?.pid !== undefined && alive(host.pid), '18-and-the-host-lived');

    say('a whole restart, host included');
    if (host?.pid) { try { process.kill(host.pid, 'SIGTERM'); } catch { /* gone */ } }
    await until('the host to go', 15_000, () => !host?.pid || !alive(host.pid));
    const again = await launch(env);
    const stillListed = await until('the list', 30_000, async () => { const l = await again.evaluate('window.genie.deviceLink.hosts()'); return Array.isArray(l) && l.includes(URL_PIN) && l.includes(URL_OLD); });
    check(Boolean(stillListed), '19-still-paired-after-the-restart');
    const hellosThen = plain.hellos.length;
    const saved = await until('a dial that main allows', 30_000, async () => { const r = await dialFrom(again, URL_PIN, { kind: 'saved', label: 'vm' }); return r.opened?.ok ? r : null; });
    const heardAfter = plain.hellos.slice(hellosThen).find((h) => h.auth?.kind === 'token');
    check(heardAfter?.auth?.token === MINTED && (saved?.frames ?? []).some((f) => JSON.parse(f).kind === 'welcome'), '20-and-no-pin-is-needed', heardAfter ? 'token hello' : 'no token hello');
    again.close();
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
