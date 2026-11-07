#!/usr/bin/env node
/**
 * GENIE 1'S GITHUB LOGIN MOVES, ONCE (plan §13, S10). A second profile holding only a `genie.db`: `github.json` is written with `source: 'genie-1'` and the tokens are in the keychain; signed out
 * afterwards, it is not carried over again. Its tokens are test words, so this proves the move and not GitHub's answer. On omarchy-test, with tynn.ai aliased to tynn.gen. Refuses anywhere else.
 *
 *   bash vm-tynn-alias-linux.sh <dir>            # the alias: nothing here may reach production
 *   npm ci && node node_modules/electron/install.js && npm run build
 *   node scripts/upgrade-v1-github-acceptance-cdp.mjs
 *
 * THE PROFILE. No real Genie 1 runs here: the rows are what `v1:main/github/storage.ts` wrote (scripts/seed-v1-db.mjs, test/seed-v1-github.test.ts), sealed by a small app on this tree's Electron under
 * this tree's name, which is what a real Genie 1 shares with this one ("both packages are named genie", src/main/github-account.ts). The owner's real profile is the release's gate, not this script's.
 *
 * It removes ~/.genie and the userData folder first, so run it on a clean VM, on its own.
 *
 * Prints `### v1-github <check>=PASS|FAIL  detail`, then `### v1-github=PASS|FAIL`. Capped at 8 min. No value is printed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: this removes a profile; test machines only'); process.exit(2); }
process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;

const PORT = Number(process.env.CDP_PORT ?? 9222);
const home = join(homedir(), '.genie');
const runtime = join(home, 'runtime');
const require = createRequire(`${process.cwd()}/`);
const work = mkdtempSync(join(tmpdir(), 'v1-github-'));
const say = (line) => console.log(`--- ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, name, detail = '') => { console.log(`### v1-github ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`); if (!ok) failures.push(name); };
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
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const hostPid = () => { try { return json(join(runtime, 'host.json')).pid; } catch { return null; } };
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const { AsyncEntry } = require('@napi-rs/keyring');
const PIN = { linux: { store: 'secret-service' } };
const entry = (name) => new AsyncEntry('Genie', name, PIN);
const held = async (name) => { try { return (await entry(name).getPassword()) ?? null; } catch { return null; } };
const forget = async (name) => { try { await entry(name).deletePassword(); } catch { /* it was not there */ } };

const ACCESS = 'github/access';
const REFRESH = 'github/refresh';
const LOGIN = 'vm-genie-one';
const githubFile = join(home, 'github.json');
const githubRow = () => { try { return json(githubFile); } catch { return null; } };

let window = null;
async function stopApp() {
    const host = hostPid();
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
            console.log('--- what the lifecycle log says about the keychain');
            for (const line of readFileSync(join(runtime, 'lifecycle.log'), 'utf8').split('\n').filter((l) => l.includes('keychain'))) console.log(line.slice(0, 220));
        } catch (error) { console.log(`--- no lifecycle log: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* gone */ }
    console.log(`### v1-github=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
    process.exit(failures.length === 0 ? 0 : 1);
}
setTimeout(() => { check(false, 'the-8-min-cap'); void finish(); }, 480_000).unref();

const electronEnv = (extra = {}) => { const env = { ...process.env, XDG_SESSION_TYPE: 'x11', DISPLAY: process.env.DISPLAY ?? ':0', ...extra }; delete env.ELECTRON_RUN_AS_NODE; return env; };

/** Seals with this tree's Electron under this tree's name, and says where that name's userData is. */
function seal(texts) {
    const own = JSON.parse(readFileSync('package.json', 'utf8'));
    const app = join(work, 'sealer');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: own.name, ...(own.productName ? { productName: own.productName } : {}), version: own.version, main: 'main.cjs' }));
    writeFileSync(join(app, 'main.cjs'), `
const { app, safeStorage } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
app.whenReady().then(() => {
    let out;
    try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('no encryption here: backend ' + safeStorage.getSelectedStorageBackend());
        out = { ok: true, userData: join(app.getPath('appData'), app.getName()), results: JSON.parse(readFileSync(process.env.SEALER_IN, 'utf8')).map((text) => safeStorage.encryptString(text).toString('base64')) };
    } catch (error) { out = { ok: false, reason: String(error && error.message || error) }; }
    writeFileSync(process.env.SEALER_OUT, JSON.stringify(out), { mode: 0o600 });
    app.exit(0);
});
`);
    const input = join(work, 'sealer-in.json');
    const output = join(work, 'sealer-out.json');
    writeFileSync(input, JSON.stringify(texts), { mode: 0o600 });
    execFileSync(require('electron'), [app, '--no-sandbox', '--ozone-platform=x11', '--password-store=gnome-libsecret', `--user-data-dir=${join(work, 'sealer-data')}`], { env: electronEnv({ SEALER_IN: input, SEALER_OUT: output }), stdio: 'ignore', timeout: 60_000 });
    const result = json(output);
    rmSync(input, { force: true });
    rmSync(output, { force: true });
    if (!result.ok) throw new Error(`the sealer: ${result.reason}`);
    return result;
}

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
async function launch() {
    window = spawn(require('electron'), ['.', '--no-sandbox', '--ozone-platform=x11', `--remote-debugging-port=${PORT}`], { env: electronEnv(), stdio: 'ignore' });
    const page = await until('a window on the debugger port', 90_000, async () => {
        try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { return null; }
    });
    if (!page) throw new Error('no window on the debugger port');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await until('window.genie', 30_000, () => cdp.evaluate('typeof window.genie === "object"'));
    return cdp;
}

try {
    say('the alias: tynn.ai must be tynn.gen on this machine');
    const resolved = execFileSync('getent', ['hosts', 'tynn.ai'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (resolved !== '127.0.0.1' && resolved !== '::1') throw new Error(`tynn.ai resolves to ${resolved}: the alias is not up, and this would reach production`);
    check(true, '0-tynn-ai-is-the-alias', resolved);

    say('a profile with only a genie.db');
    const access = `ghu_${randomBytes(18).toString('hex')}`;
    const refresh = `ghr_${randomBytes(18).toString('hex')}`;
    const { userData, results: [tokenEnc, refreshEnc] } = seal([access, refresh]);
    if (!userData.endsWith('/genie') && !userData.endsWith('/Genie')) throw new Error(`not removing ${userData}: it does not look like Genie's`);
    await stopApp();
    rmSync(home, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    await forget(ACCESS);
    await forget(REFRESH);
    mkdirSync(userData, { recursive: true });
    const db = join(userData, 'genie.db');
    execFileSync(process.execPath, ['--no-warnings', 'scripts/seed-v1-db.mjs', db, '--github', tokenEnc, refreshEnc, LOGIN], { stdio: 'ignore' });
    const dbBefore = sha(db);
    check(existsSync(db) && !existsSync(githubFile) && (await held(ACCESS)) === null, '1-CONTROL-only-the-database', userData);

    say('the first launch: it moves');
    let cdp = await launch();
    const moved = await until('both tokens in the keychain', 120_000, async () => (await held(ACCESS)) === access && (await held(REFRESH)) === refresh);
    check(Boolean(moved), 'S10.1-the-tokens-are-in-the-keychain-byte-for-byte');
    const row = await until('github.json', 30_000, () => githubRow());
    check(row?.source === 'genie-1', 'S10.2-github-json-says-genie-1', String(row?.source));
    check(row?.state === 'signed-in' && row?.login === LOGIN, 'S10.3-as-that-login', `${row?.state} ${row?.login}`);
    check(row !== null && row.tokenEnc === undefined && row.refreshEnc === undefined && !JSON.stringify(row).includes(access), 'S10.4-no-token-in-the-file', Object.keys(row ?? {}).join(','));
    const book = await until('the book', 30_000, () => { try { const s = json(join(home, 'keychain-migration.json')).secrets; return s[ACCESS] === 'done' && s[REFRESH] === 'done' ? s : null; } catch { return null; } });
    check(Boolean(book), 'S10.5-the-book-says-done');

    say('signed out');
    await cdp.evaluate(`window.genie.features.act({ kind: 'integrations.githubSignOut' }).then(() => true)`);
    const out = await until('the sign-out to reach the file', 30_000, () => githubRow()?.state === 'signed-out');
    check(Boolean(out), 'S10.6-signed-out-is-on-disk', JSON.stringify(githubRow()));
    check((await held(ACCESS)) === null && (await held(REFRESH)) === null, 'S10.7-and-the-keychain-holds-neither');
    cdp.close();
    await stopApp();

    say('the next launch: it is not carried over again');
    cdp = await launch();
    // The positive control for "nothing happened": the same launch that moved it, over the same database, given the same time.
    await sleep(15_000);
    check(githubRow()?.state === 'signed-out', 'S10.8-still-signed-out', JSON.stringify(githubRow()));
    check((await held(ACCESS)) === null && (await held(REFRESH)) === null, 'S10.9-nothing-came-back');
    check(sha(db) === dbBefore, 'S10.10-genie-1s-database-was-never-written');
    cdp.close();
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
