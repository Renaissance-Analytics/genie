#!/usr/bin/env node
/**
 * A PASSKEY IN GENIE'S REAL WINDOW (Tynn #683, for the passkey lock #677). Run from a BUILT tree on a test machine only
 * (GENIE_TEST_MACHINE=1; it refuses otherwise), never the owner's desktop:
 *   node scripts/passkey-window-cdp.mjs
 * Needs @simplewebauthn/server installed beside the tree (the job installs it with --no-save; Genie does not ship it yet).
 *
 * Launches the built app with its own temporary home and profile, finds the main window, and measures:
 *   1. the window's page is http://genie.localhost:<port>/index.html, a secure context, and the preload's bridge is there;
 *   2. every resource the page loaded answered 200 (no asset the server's allow-list forgot);
 *   3. the window server refuses another Host (127.0.0.1:<port>) and serves its own;
 *   4. with Chrome's virtual authenticator (CDP WebAuthn domain) the page creates and then uses a passkey for rpId
 *      `genie.localhost`, and a server-side verifier accepts both for the window's exact origin, while the same assertion is
 *      refused for another origin, another challenge and another rpId.
 * Exit 0 all PASS; 1 a FAIL.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WIN = process.platform === 'win32';
const started = Date.now();
const PORT = Number(process.env.CDP_PORT ?? 9341);
const OUT = resolve('smoke-out');
const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { if (!Number.isInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const results = [];
let app; let root;

function check(ok, name, detail = '') {
    results.push({ name, ok: !!ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}
async function targets() { return (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3_000) })).json(); }
async function until(label, fn, ms) {
    const end = Date.now() + ms; let last;
    while (Date.now() < end) {
        try { const value = await fn(); if (value) return value; } catch (error) { last = error.message; }
        await sleep(500);
    }
    throw new Error(`${label}: no positive result in ${ms}ms${last ? ` (${last})` : ''}`);
}

/** One CDP session on the page: commands by id. */
async function cdp(url) {
    const socket = new WebSocket(url);
    await new Promise((ok, no) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', () => no(new Error('CDP socket error')), { once: true }); });
    let next = 0; const waiting = new Map();
    socket.addEventListener('message', (event) => {
        const m = JSON.parse(event.data);
        if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); if (m.error) w.no(new Error(`${m.error.message}`)); else w.ok(m.result); }
    });
    const send = (method, params = {}) => new Promise((ok, no) => { const id = ++next; waiting.set(id, { ok, no }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result?.value;
    };
    return { send, evaluate, close: () => socket.close() };
}

function raw(port, path, host) {
    return new Promise((ok, no) => {
        const req = request({ host: '127.0.0.1', port, path, setHost: false, headers: { Host: host } }, (res) => { res.resume(); res.on('end', () => ok({ status: res.statusCode, csp: res.headers['content-security-policy'] ?? null })); });
        req.on('error', no); req.end();
    });
}

async function cleanup() {
    if (app?.pid) { try { if (WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { timeout: 15_000, stdio: 'ignore' }); else process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ } }
    if (root) {
        const hostPid = readJson(join(root, '.genie', 'runtime', 'host.json'))?.pid;
        if (alive(hostPid)) { try { process.kill(hostPid, 'SIGTERM'); } catch { /* gone */ } }
        for (let i = 0; i < 20 && alive(hostPid); i++) await sleep(250);
        if (alive(hostPid)) { try { process.kill(hostPid, 'SIGKILL'); } catch { /* gone */ } }
    }
}

const CREATE = (opts) => `(async () => {
  try { const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(${JSON.stringify(opts)}) }); return { ok: true, json: cred.toJSON() }; }
  catch (e) { return { ok: false, error: String(e && e.name) + ': ' + String(e && e.message) }; }
})()`;
const GET = (opts) => `(async () => {
  try { const cred = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(${JSON.stringify(opts)}) }); return { ok: true, json: cred.toJSON() }; }
  catch (e) { return { ok: false, error: String(e && e.name) + ': ' + String(e && e.message) }; }
})()`;

try {
    if (process.env.GENIE_TEST_MACHINE !== '1') throw new Error('refused: not a test machine (GENIE_TEST_MACHINE=1 says one is); nothing was launched');
    const swa = await import('@simplewebauthn/server');
    let busy = false;
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1_000) }); busy = true; } catch (e) { if (e.name === 'TimeoutError') busy = true; }
    if (busy) throw new Error(`debugger port ${PORT} is occupied; no existing app was touched`);
    root = mkdtempSync(join(tmpdir(), 'genie-passkey-window-'));
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const env = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: join(root, '.genie'), GENIE_PAGE_PROBE: '1' };
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, timeout: 15_000, stdio: 'pipe' });
    mkdirSync(OUT, { recursive: true });
    const fd = openSync(join(OUT, 'passkey-window-electron.log'), 'w');
    const electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron');
    const profile = join(root, 'profile');
    const args = ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`];
    if (!WIN) args.push('--no-sandbox');
    const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    app = spawn(needsXvfb ? 'xvfb-run' : electron, needsXvfb ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', electron, ...args] : args, { env, detached: !WIN, windowsHide: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    log('launched the built app');
    const page = await until('main window target', async () => mainWindow(await targets()), 120_000);
    const m = /^http:\/\/genie\.localhost:(\d+)\/index\.html(?:[?#]|$)/.exec(page.url);
    check(m, '1a the main window loads from http://genie.localhost:<port>/index.html', page.url.split('#')[0]);
    const port = m ? Number(m[1]) : 0;
    const remembered = readJson(join(profile, 'window-origin.json'));
    check(remembered?.port === port, '1b the port is the one kept in <userData>/window-origin.json', JSON.stringify(remembered));
    const s = await cdp(page.webSocketDebuggerUrl);
    await until('preload bridge', () => s.evaluate('typeof window.genie === "object"'), 60_000);
    const facts = await s.evaluate('({ origin: location.origin, secure: window.isSecureContext, bridge: typeof window.genie, pkc: typeof PublicKeyCredential })');
    check(facts.secure === true && facts.bridge === 'object' && facts.pkc === 'function', '1c a secure context with the preload bridge and WebAuthn', JSON.stringify(facts));
    await sleep(3_000);
    const resources = await s.evaluate(`performance.getEntriesByType('resource').map((e) => ({ name: e.name, status: e.responseStatus }))`);
    const own = resources.filter((r) => r.name.startsWith(facts.origin));
    const bad = own.filter((r) => r.status !== 200 && r.status !== 0);
    check(own.length > 0 && bad.length === 0, '2 every resource the page loaded from its origin answered 200', `${own.length} resources; not 200: ${JSON.stringify(bad.slice(0, 10))}`);
    const ours = await raw(port, '/index.html', `genie.localhost:${port}`);
    const other = await raw(port, '/index.html', `127.0.0.1:${port}`);
    check(ours.status === 200 && /frame-ancestors 'none'/.test(ours.csp ?? '') && other.status === 403, '3 the server serves its own Host (with its CSP) and refuses 127.0.0.1', `own ${ours.status}, 127.0.0.1 ${other.status}`);

    await s.send('WebAuthn.enable', { enableUI: false });
    await s.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const rpID = 'genie.localhost';
    const regOpts = await swa.generateRegistrationOptions({ rpName: 'Genie', rpID, userName: 'this device', attestationType: 'none', authenticatorSelection: { residentKey: 'preferred', userVerification: 'required', authenticatorAttachment: 'platform' } });
    const created = await s.evaluate(CREATE(regOpts));
    check(created.ok, '4a navigator.credentials.create in the real window (rpId genie.localhost)', created.error ?? 'created');
    if (created.ok) {
        const reg = await swa.verifyRegistrationResponse({ response: created.json, expectedChallenge: regOpts.challenge, expectedOrigin: facts.origin, expectedRPID: rpID, requireUserVerification: true });
        check(reg.verified, '4b the registration verifies for the window origin', facts.origin);
        const { credential } = reg.registrationInfo;
        const authOpts = await swa.generateAuthenticationOptions({ rpID, allowCredentials: [{ id: credential.id }], userVerification: 'required' });
        const got = await s.evaluate(GET(authOpts));
        check(got.ok, '4c navigator.credentials.get in the real window', got.error ?? 'asserted');
        if (got.ok) {
            const verify = (over = {}) => swa.verifyAuthenticationResponse({ response: got.json, expectedChallenge: authOpts.challenge, expectedOrigin: facts.origin, expectedRPID: rpID, credential, requireUserVerification: true, ...over });
            const auth = await verify();
            check(auth.verified, '4d the assertion verifies', `counter ${auth.authenticationInfo?.newCounter}`);
            for (const [label, over] of [['another origin', { expectedOrigin: 'http://genie.localhost:1' }], ['another challenge', { expectedChallenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }], ['another rpId', { expectedRPID: 'localhost' }]]) {
                let refused = false; let detail = '';
                try { refused = !(await verify(over)).verified; detail = 'verified=false'; } catch (error) { refused = true; detail = String(error.message).slice(0, 120); }
                check(refused, `4e the assertion is refused for ${label}`, detail);
            }
        }
    }
    s.close();
} catch (error) {
    check(false, 'the run', error.message);
} finally {
    await cleanup();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'passkey-window.json'), JSON.stringify(results, null, 2));
}
const failed = results.filter((r) => !r.ok);
log(failed.length === 0 ? `PASS: ${results.length} checks` : `FAIL: ${failed.length} of ${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
