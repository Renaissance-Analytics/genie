#!/usr/bin/env node
/**
 * THE UPGRADE FROM A REAL BETA.56 (P3.4; plan §13, the beta.56 acceptance): S1, S2, S3, S8 and S9, and the first half of S11. The real beta.56 AppImage signs in to tynn.gen and
 * seals with Electron's real safeStorage; this tree's build then opens those seals. On omarchy-test, with tynn.ai aliased to tynn.gen. Refuses anywhere else.
 *
 *   bash vm-tynn-alias-linux.sh <dir>            # the alias: tynn.ai is tynn.gen here
 *   npm ci && node node_modules/electron/install.js && npm run build
 *   node scripts/smoke-seed.mjs && node scripts/upgrade-acceptance-cdp.mjs
 *
 * THE PROFILE. Beta.56 writes what it can by itself: the Tynn sign-in, and the workstation's key if it registers. What it cannot be made to write here is sealed by a small helper
 * run on beta.56's OWN binary (its Electron, its name, so its key): the older tynn.json, a GitHub login, agents' keys, with test words only. Its control opens beta.56's real
 * seal first: a helper with the wrong key cannot pass, so what it seals is what beta.56 would have sealed.
 *
 * THE ORDER. S8 runs first, because no keychain must leave the seals for the next launch to finish: the Secret Service made un-activatable (scripts/keyring-card-cdp.mjs says
 * why stopping it is not enough), the new build launched, nothing moved, the card up. Then it is put back and the new build moves everything: S1, S2, S9. A second launch: S3.
 *
 * Getting a sign-in code changes nothing in repos/tynn: `/dev/quick-login` then `/genie/callback`. That route exists only where APP_ENV is local or development, so against
 * production this fails closed, and the alias is checked first as well. No token is printed.
 *
 * THE RELAY HALF OF S11 runs only with UPGRADE_RELAY=<the local relay's ws:// endpoint>, and needs that relay up with tynn.gen's WORKSTATION_SHARED_RELAY_ENDPOINT set to it (without that line tynn.gen hands out
 * the PRODUCTION relay; .ai/knowledge/test-vm.md). The moved key signs the relay hello and the ticket's request; its control puts another key under the same id, which must not get through.
 *
 * NOT HERE: S4 (scripts/upgrade-crash-acceptance.mjs), S5-S7 (scripts/upgrade-acceptance-mint-cdp.mjs), S10 (scripts/upgrade-v1-github-acceptance-cdp.mjs), S12 and A1-A5 (scripts/github-live-cdp.mjs).
 *
 * ON WINDOWS (scripts/vm-acceptance-windows.sh in the envelope; plan §13): S1, S2, S3 and S9, the real beta.56 installer run silently, in the logged-on session (over SSH Credential Manager answers
 * ERROR_NO_SUCH_LOGON_SESSION). S8 does not run: nothing here can make Credential Manager go away while a person is logged on, and with nobody logged on there is no Genie to look at. S9's modes are read as
 * ACLs: owner-only, against the inherited SYSTEM and Administrators those files started with. safeStorage's key is in userData's Local State there, so the sealer runs in the real userData.
 *
 * Prints `### upgrade <check>=PASS|FAIL  detail`, then `### upgrade=PASS|FAIL`. Capped at 12 min. Every exit puts back what it hid.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
// The feature snapshot is read on the page's own bridge now (P4 family 11): window.genieTest needs this.
process.env.GENIE_PAGE_PROBE ??= '1';

if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: this replaces a profile and hides system files; test machines only'); process.exit(2); }
process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;

const PORT = Number(process.env.CDP_PORT ?? 9222);
const WINDOWS = process.platform === 'win32';
const WINDOW_ARGS = WINDOWS ? [] : ['--no-sandbox', '--ozone-platform=x11'];
const RELEASE = 'https://github.com/Renaissance-Analytics/genie/releases/download/v2.0.0-beta.56';
const APPIMAGE_URL = process.env.BETA56_APPIMAGE ?? (WINDOWS ? `${RELEASE}/Genie-2.0.0-beta.56-setup.exe` : `${RELEASE}/Genie-2.0.0-beta.56.AppImage`);
const TYNN = 'https://tynn.ai';
const ACCOUNT = process.env.TYNN_TEST_ACCOUNT ?? 'member@example.com';
const home = join(homedir(), '.genie');
const runtime = join(home, 'runtime');
const require = createRequire(`${process.cwd()}/`);
const work = mkdtempSync(join(tmpdir(), 'upgrade-'));
const say = (line) => console.log(`--- ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, name, detail = '') => { console.log(`### upgrade ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`); if (!ok) failures.push(name); };
const until = async (what, ms, read) => {
    const end = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > end) { say(`gave up waiting for ${what} after ${ms / 1000} s`); return null; }
        await sleep(500);
    }
};
const quiet = (command, ...args) => { try { execFileSync(command, args, { stdio: 'ignore', timeout: 20_000 }); return true; } catch { return false; } };
const sudo = (...args) => quiet('sudo', '-n', ...args);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hostPid = () => { try { return JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8')).pid; } catch { return null; } };
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
/** On Windows a mode means nothing: who the ACL names does. SYSTEM and Administrators are what such a file inherited (src/main/private-credentials.ts). */
const openToOthers = (file) => /\b(SYSTEM|Administrators|Everyone|Users|Authenticated Users)\b/.test(execFileSync('icacls', [file], { encoding: 'utf8' }).split(/\r?\n/).filter((line) => !/^Successfully/.test(line)).join('\n').replaceAll(file, ''));
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// The keychain, read the way the host reads it. With nothing on the bus the library throws from its constructor.
const { AsyncEntry } = require('@napi-rs/keyring');
const PIN = { linux: { store: 'secret-service' } };
const held = async (name) => { try { return (await new AsyncEntry('Genie', name, PIN).getPassword()) ?? null; } catch { return null; } };
const keep = (name, value) => new AsyncEntry('Genie', name, PIN).setPassword(value);

// The Secret Service, as in scripts/keyring-card-cdp.mjs.
const bus = () => {
    try {
        const line = execFileSync('busctl', ['--user', 'list', '--no-legend', '--no-pager'], { encoding: 'utf8', timeout: 10_000 }).split('\n').find((l) => l.startsWith('org.freedesktop.secrets ')) ?? '';
        const pid = line.trim().split(/\s+/)[1] ?? '';
        return { owned: /^\d+$/.test(pid), activatable: pid === '-', line: line.replace(/\s+/g, ' ').slice(0, 90) };
    } catch (error) { return { owned: false, activatable: false, line: `busctl: ${error instanceof Error ? error.message : String(error)}` }; }
};
const stopKeyring = () => { quiet('systemctl', '--user', 'stop', 'gnome-keyring-daemon.socket', 'gnome-keyring-daemon.service'); quiet('pkill', '-f', '^(/usr/bin/)?gnome-keyring-daemon'); };
const reloadBus = () => quiet('busctl', '--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ReloadConfig');
const SERVICES = '/usr/share/dbus-1/services';
const HIDDEN = '.hidden-by-upgrade-acceptance';
const hiddenFiles = new Set();
const activationFiles = () => { try { return readdirSync(SERVICES).map((name) => `${SERVICES}/${name}`).filter((file) => /^Name=org\.freedesktop\.secrets\s*$/m.test(readFileSync(file, 'utf8'))); } catch { return []; } };
function hideActivation() { for (const file of activationFiles()) if (sudo('mv', file, `${file}${HIDDEN}`)) hiddenFiles.add(file); reloadBus(); }
function putBack() { for (const file of [...hiddenFiles]) if (sudo('mv', `${file}${HIDDEN}`, file)) hiddenFiles.delete(file); reloadBus(); }

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
    putBack();
    quiet('systemctl', '--user', 'start', 'gnome-keyring-daemon.socket');
    check(hiddenFiles.size === 0, 'Z-everything-hidden-was-put-back', [...hiddenFiles].join(', ') || 'none left');
    if (failures.length > 0) {
        try {
            console.log('--- what the lifecycle log says about the keychain');
            for (const line of readFileSync(join(runtime, 'lifecycle.log'), 'utf8').split('\n').filter((l) => l.includes('keychain'))) console.log(line.slice(0, 220));
        } catch (error) { console.log(`--- no lifecycle log: ${error instanceof Error ? error.message : String(error)}`); }
        try {
            console.log('--- the end of the host log');
            for (const line of readFileSync(join(home, 'logs', 'genie-host.log'), 'utf8').split('\n').slice(-30)) console.log(line.slice(0, 220));
        } catch (error) { console.log(`--- no host log: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* gone */ }
    console.log(`### upgrade=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
    process.exit(failures.length === 0 ? 0 : 1);
}
setTimeout(() => { check(false, 'the-12-min-cap'); void finish(); }, 720_000).unref();

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
    close() { try { this.#ws.close(); } catch { /* gone */ } }
}

async function launch(command, args) {
    const env = { ...process.env, XDG_SESSION_TYPE: 'x11', DISPLAY: process.env.DISPLAY ?? ':0' };
    delete env.ELECTRON_RUN_AS_NODE;
    window = spawn(command, [...args, ...WINDOW_ARGS, `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
    const page = await until('a window on the debugger port', 90_000, async () => {
        try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { return null; }
    });
    if (!page) throw new Error(`no window on the debugger port from ${command}`);
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await until('window.genie', 30_000, () => cdp.evaluate('typeof window.genie === "object"'));
    return cdp;
}
const launchNew = () => launch(require('electron'), ['.']);
const features = (cdp) => cdp.evaluate('(window.genieTest ?? window.genie).features.snapshot().then((d) => ({ user: d?.integrations?.tynn?.user?.name ?? null, keyring: d?.integrations?.keyring ?? null }))');

// Windows' curl is schannel: it asks for a revocation answer the alias's local certificate cannot give, and refuses without one (batch II: CRYPT_E_NO_REVOCATION_CHECK). Only that check is off; the chain and the name are still checked (0a, 0b). And it has no /dev/null.
const CURL_OS = process.platform === 'win32' ? ['--ssl-no-revoke'] : [];
const NOWHERE = process.platform === 'win32' ? 'NUL' : '/dev/null';

const curlSafely = (args, options) => {
    try { return execFileSync('curl', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], ...options }); } catch (error) {
        const url = args.findLast((a) => a.startsWith('http')) ?? 'an address';
        throw new Error(`curl ${url.split('?')[0]}: ${String(error.stderr ?? 'no answer').trim().split(/\r?\n/)[0].slice(0, 200)}`);
    }
};

/**
 * A sign-in code from tynn.gen, on Windows through Node's HTTPS client (scripts/tynn-alias-request.mjs): Windows' curl refuses the alias's answer to the login. Only the alias's CA is trusted there, and the name is checked. Never printed.
 */
function signInCodeWindows() {
    const jar = join(work, 'jar.json');
    const ca = join(homedir(), 'tynn-alias', 'tynn-ca.crt');
    const ask = (path, extra = {}) => {
        let out;
        try {
            out = execFileSync(process.execPath, [join('scripts', 'tynn-alias-request.mjs')], { input: JSON.stringify({ url: `${TYNN}${path}`, jar, ca, ...extra }), encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (error) { throw new Error(`the alias: ${String(error.stderr ?? 'no answer').trim().split(/\r?\n/)[0].slice(0, 200)}`); }
        return JSON.parse(out);
    };
    const first = ask('/login');
    say(`/login answered ${first.status}, ${first.framing}`);
    const xsrf = JSON.parse(readFileSync(jar, 'utf8'))['XSRF-TOKEN'];
    if (!xsrf) throw new Error('no XSRF cookie from /login');
    const login = ask('/dev/quick-login', { method: 'POST', headers: { 'X-XSRF-TOKEN': decodeURIComponent(xsrf), Accept: 'text/html' }, form: { email: ACCOUNT } });
    say(`/dev/quick-login answered ${login.status}, ${login.framing}`);
    if (login.status !== 302) throw new Error(`quick login answered ${login.status}: not a local Tynn, or no such seeded account`);
    const code = /token=([A-Za-z0-9]{64})/.exec(ask('/genie/callback?return=genie%3A%2F%2Foauth%2Fcallback').body)?.[1];
    if (!code) throw new Error('no 64-character code on the callback page');
    return code;
}

/** A sign-in code from tynn.gen, by curl, which reads the OS store this VM's alias CA is in. Never printed. */
function signInCode() {
    if (WINDOWS) return signInCodeWindows();
    const jar = join(work, 'jar');
    const curl = (...args) => curlSafely(['-sS', ...CURL_OS, '-A', 'Genie-upgrade-acceptance', '-c', jar, '-b', jar, ...args]);
    curl('-o', NOWHERE, `${TYNN}/login`);
    const xsrf = readFileSync(jar, 'utf8').split('\n').map((l) => l.split('\t')).find((f) => f[5] === 'XSRF-TOKEN')?.[6];
    if (!xsrf) throw new Error('no XSRF cookie from /login');
    // The account goes to curl in a file (`name@file` is url-encoded as name=<the file's content>), so it is never on curl's command line.
    const account = join(work, 'account');
    writeFileSync(account, ACCOUNT);
    const status = curl('-o', NOWHERE, '-w', '%{http_code}', '-H', `X-XSRF-TOKEN: ${decodeURIComponent(xsrf)}`, '-H', 'Accept: text/html', '--data-urlencode', `email@${account}`, `${TYNN}/dev/quick-login`);
    if (status !== '302') throw new Error(`quick login answered ${status}: not a local Tynn, or no such seeded account`);
    const code = /token=([A-Za-z0-9]{64})/.exec(curl(`${TYNN}/genie/callback?return=genie%3A%2F%2Foauth%2Fcallback`))?.[1];
    if (!code) throw new Error('no 64-character code on the callback page');
    return code;
}

/**
 * A small app run on beta.56's own binary, so its safeStorage holds beta.56's key. Each op: `{ open: base64 }` or `{ seal: text }`.
 * On Linux that key is kept in the Secret Service under the app's NAME (batch BB: a helper with another name got a key of its own, and could not open beta.56's seal). So it takes its name
 * from beta.56's own package.json, and `known`, a seal beta.56 made, picks between the names that could be it: the first that opens it is the one that has the key.
 */
function sealer(root, known) {
    const helperRoot = join(work, 'sealer');
    cpSync(root, helperRoot, { recursive: true, verbatimSymlinks: true });
    rmSync(join(helperRoot, 'resources', 'app.asar'), { force: true });
    rmSync(join(helperRoot, 'resources', 'app.asar.unpacked'), { recursive: true, force: true });
    const app = join(helperRoot, 'resources', 'app');
    mkdirSync(app, { recursive: true });
    const names = (() => {
        try {
            const own = JSON.parse(require('@electron/asar').extractFile(join(root, 'resources', 'app.asar'), 'package.json').toString());
            say(`beta.56's package.json: name ${own.name}, productName ${own.productName ?? 'none'}`);
            return [{ name: own.name, ...(own.productName ? { productName: own.productName } : {}) }, { name: own.name }];
        } catch (error) { say(`could not read beta.56's package.json: ${error instanceof Error ? error.message : String(error)}`); return []; }
    })();
    const candidates = [...names, { name: 'genie' }, { name: 'genie', productName: 'Genie' }, { name: 'Genie' }];
    writeFileSync(join(app, 'main.cjs'), `
const { app, safeStorage } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
app.whenReady().then(() => {
    let out;
    try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('no encryption here: backend ' + safeStorage.getSelectedStorageBackend());
        const ops = JSON.parse(readFileSync(process.env.SEALER_IN, 'utf8'));
        out = { ok: true, backend: safeStorage.getSelectedStorageBackend(), results: ops.map((op) => ('seal' in op ? safeStorage.encryptString(op.seal).toString('base64') : safeStorage.decryptString(Buffer.from(op.open, 'base64')))) };
    } catch (error) { out = { ok: false, reason: String(error && error.message || error) }; }
    writeFileSync(process.env.SEALER_OUT, JSON.stringify(out), { mode: 0o600 });
    app.exit(0);
});
`);
    const binary = binaryIn(helperRoot);
    const useName = (candidate) => writeFileSync(join(app, 'package.json'), JSON.stringify({ ...candidate, version: '2.0.0-beta.56', main: 'main.cjs' }));
    const run = (ops) => {
        const input = join(work, 'sealer-in.json');
        const output = join(work, 'sealer-out.json');
        writeFileSync(input, JSON.stringify(ops), { mode: 0o600 });
        rmSync(output, { force: true });
        const env = { ...process.env, SEALER_IN: input, SEALER_OUT: output, XDG_SESSION_TYPE: 'x11', DISPLAY: process.env.DISPLAY ?? ':0' };
        delete env.ELECTRON_RUN_AS_NODE;
        execFileSync(binary, [...WINDOW_ARGS, ...(WINDOWS ? [] : ['--password-store=gnome-libsecret', `--user-data-dir=${join(work, 'sealer-data')}`])], { env, stdio: 'ignore', timeout: 60_000 });
        const result = json(output);
        rmSync(input, { force: true });
        rmSync(output, { force: true });
        if (!result.ok) throw new Error(`the sealer: ${result.reason}`);
        return result.results;
    };
    const tried = [];
    for (const candidate of candidates) {
        useName(candidate);
        try {
            run([{ open: known }]);
            say(`the sealer has beta.56's key as ${JSON.stringify(candidate)}`);
            return run;
        } catch (error) { tried.push(`${JSON.stringify(candidate)}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    throw new Error(`no name opened beta.56's seal: ${tried.join('; ')}`);
}
function binaryIn(root) {
    const found = ['genie', 'Genie', 'ai.tynn.genie', 'Genie.exe', 'genie.exe'].map((name) => join(root, name)).find((file) => existsSync(file));
    if (!found) throw new Error(`no Genie binary in ${root}: ${readdirSync(root).slice(0, 30).join(', ')}`);
    return found;
}

/** Every file under the home, each read once. Absence claims below ride on the same walk finding the seals before the upgrade. */
function walk(dir, found = []) {
    if (!existsSync(dir)) return found;
    for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        const info = lstatSync(file);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) walk(file, found);
        else if (info.isFile() && info.size < 50 * 1024 * 1024) found.push(file);
    }
    return found;
}
const scan = (pattern) => walk(home).filter((file) => { try { return pattern.test(readFileSync(file, 'utf8')); } catch { return false; } }).map((file) => file.slice(home.length + 1));
const SEALS = /"(tokenEnc|refreshEnc|keyEnc)"\s*:/;
const TOKENS = /gpk_[0-9A-Za-z]{26}|rpk_[0-9A-Za-z]{26}|ghu_[0-9A-Za-z]{8}|ghr_[0-9A-Za-z]{8}/;

try {
    say('the alias: tynn.ai must be tynn.gen on this machine');
    const { address: resolved } = await lookup('tynn.ai');
    if (resolved !== '127.0.0.1' && resolved !== '::1') throw new Error(`tynn.ai resolves to ${resolved}: the alias is not up, and this would reach production`);
    check(true, '0-tynn-ai-is-the-alias', resolved);
    if (WINDOWS) {
        // What the flag changes, and what it must not. The output of a refusal is curl's own words; nothing here carries a value.
        const tryCurl = (...args) => { try { execFileSync('curl', ['-sS', '-o', NOWHERE, ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: true, words: '' }; } catch (error) { return { ok: false, words: String(error.stderr ?? error.message).trim().split(/\r?\n/)[0].slice(0, 200) }; } };
        const plain = tryCurl(`${TYNN}/login`);
        console.log(`### upgrade measure-curl-with-no-flag answered=${plain.ok ? 'yes' : `no  ${plain.words}`}`);
        const flagged = tryCurl(...CURL_OS, `${TYNN}/login`);
        check(flagged.ok, '0a-with-only-revocation-off-the-alias-answers', flagged.words);
        const otherName = tryCurl(...CURL_OS, '--connect-to', 'other.example:443:127.0.0.1:443', 'https://other.example/');
        check(!otherName.ok, '0b-a-wrong-name-is-still-refused', otherName.ok ? 'it was accepted: this flag turned off more than it should' : otherName.words);
    }

    say('the real beta.56');
    const image = join(work, WINDOWS ? 'beta56-setup.exe' : 'beta56.AppImage');
    if (process.env.BETA56_APPIMAGE && existsSync(process.env.BETA56_APPIMAGE)) cpSync(process.env.BETA56_APPIMAGE, image);
    else execFileSync('curl', ['-fsSL', '-o', image, APPIMAGE_URL], { timeout: 300_000 });
    chmodSync(image, 0o755);
    let root;
    if (WINDOWS) {
        // One-click and per-user: `/S` installs under %LOCALAPPDATA%\\Programs, as a person's would, and runs nothing.
        execFileSync(image, ['/S'], { stdio: 'ignore', timeout: 300_000 });
        root = await until('the installed app', 60_000, () => ['genie', 'Genie'].map((name) => join(process.env.LOCALAPPDATA, 'Programs', name)).find((dir) => existsSync(dir)) ?? null);
        if (!root) throw new Error('the installer left nothing under Programs');
    } else {
        execFileSync(image, ['--appimage-extract'], { cwd: work, stdio: 'ignore', timeout: 180_000 });
        root = join(work, 'squashfs-root');
    }
    check(existsSync(binaryIn(root)), '1-beta56-unpacked', statSync(image).size + ' bytes');
    const before = await launch(binaryIn(root), []);
    const version = await before.evaluate('window.genie.updates?.state?.().then((s) => s?.currentVersion ?? s?.version ?? null).catch(() => null)');
    say(`beta.56 window up, it says ${version}`);
    const code = signInCode();
    const signed = await before.evaluate(`(window.genieTest ?? window.genie).features.act({ kind: 'integrations.tynnCode', code: ${JSON.stringify(code)} }).then((r) => r.tynnMessage ?? null)`);
    if (signed) say(`Tynn said: ${String(signed).slice(0, 160)}`);
    const who = await until('beta.56 to be signed in', 60_000, async () => (await features(before)).user);
    check(Boolean(who), '2-beta56-signed-in-to-tynn-gen', String(who));
    const tynnFile = join(home, 'credentials', 'tynn.json');
    const tynnRow = existsSync(tynnFile) ? json(tynnFile) : {};
    check(typeof tynnRow.tokenEnc === 'string', '3-beta56-sealed-it', Object.keys(tynnRow).join(','));
    const workstationFile = join(home, 'workstation.json');
    const registered = await until('beta.56 to register this machine', 45_000, () => { try { return Object.values(json(workstationFile)).some((row) => typeof row?.keyEnc === 'string' && row.keyEnc); } catch { return false; } });
    check(Boolean(registered), '4-beta56-registered-this-workstation');
    before.close();
    await stopApp();

    say('what beta.56 cannot be made to write, sealed by its own binary');
    const seal = sealer(root, tynnRow.tokenEnc);
    const [pairing] = seal([{ open: tynnRow.tokenEnc }]);
    check(/^gpk_/.test(pairing), '5-CONTROL-the-sealer-opens-beta56s-real-seal');
    const expected = new Map([['tynn/pairing', pairing]]);
    const before11 = {};
    if (existsSync(workstationFile)) {
        for (const [host, row] of Object.entries(json(workstationFile))) {
            if (typeof row?.keyEnc !== 'string' || !row.keyEnc) continue;
            expected.set(`workstation/${host}`, seal([{ open: row.keyEnc }])[0]);
            before11[host] = row.workstationId;
        }
    }
    const ulid = (fill) => fill.repeat(26);
    const agentKey = (publicId) => `rpk_${publicId}.${randomBytes(32).toString('hex')}`;
    const ids = { first: ulid('A'), second: ulid('B') };
    const keys = { first: agentKey(ids.first), second: agentKey(ids.second) };
    const github = { access: `ghu_${randomBytes(18).toString('hex')}`, refresh: `ghr_${randomBytes(18).toString('hex')}` };
    const [firstEnc, secondEnc, accessEnc, refreshEnc] = seal([{ seal: keys.first }, { seal: keys.second }, { seal: github.access }, { seal: github.refresh }]);
    expected.set(`tynn/agent/${ids.first}`, keys.first);
    expected.set(`tynn/agent/${ids.second}`, keys.second);
    expected.set('github/access', github.access);
    expected.set('github/refresh', github.refresh);
    const write = (file, value) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 }); };
    // The older sign-in file, at the top of the home: the same pairing, sealed by its own run.
    write(join(home, 'tynn.json'), tynnRow);
    const record = (agent, publicId, tokenEnc) => ({ userId: 'vm-user', projectId: 'vm-project', genieId: agent, remoteAgentId: `remote-${agent}`, state: 'ready', publicId, tokenEnc });
    write(join(home, 'agent-credentials', 'agents.json'), { version: 1, records: {
        [JSON.stringify(['vm-user', 'vm-project', 'agent_one'])]: record('agent_one', ids.first, firstEnc),
        [JSON.stringify(['vm-user', 'vm-project', 'agent_two'])]: record('agent_two', ids.second, secondEnc),
        [JSON.stringify(['vm-user', 'vm-project', 'agent_pending'])]: { userId: 'vm-user', projectId: 'vm-project', genieId: 'agent_pending', remoteAgentId: 'remote-pending', state: 'pending' },
    } });
    write(join(home, 'github.json'), { version: 1, state: 'signed-in', login: 'vm-person', name: null, source: 'sign-in', tokenEnc: accessEnc, refreshEnc });
    // Scrollback an older Genie left, and the modes it left.
    write(join(home, 'terminal-snapshots.json'), { note: 'a pasted secret could be here' });
    mkdirSync(join(home, 'terminal-snapshots'), { recursive: true });
    writeFileSync(join(home, 'terminal-snapshots', 'one.txt'), 'pasted-in-a-terminal');
    const loose = ['services.json', 'remote-devices.json', 'app-inbox.json'].map((name) => join(runtime, name)).filter((file) => existsSync(file));
    if (WINDOWS) check(loose.length > 0 && loose.every(openToOthers), '6-CONTROL-the-loose-files-are-open-to-others', loose.map((f) => f.slice(home.length + 1)).join(', ') || 'none of the three existed');
    else for (const file of loose) chmodSync(file, 0o644);
    say(`${WINDOWS ? 'inherited ACL' : '0644'} on: ${loose.map((f) => f.slice(home.length + 1)).join(', ') || 'none of the three existed'}`);
    const sealsBefore = scan(SEALS);
    check(sealsBefore.includes(join('credentials', 'tynn.json')) && sealsBefore.includes('github.json'), '6-CONTROL-the-scan-finds-the-seals', sealsBefore.join(', '));

    if (WINDOWS) say('S8 does not run on Windows: see the header');
    else {
        say('S8: no keychain. The new build, with the Secret Service unable to start');
        stopKeyring();
        await until('the daemon to go', 15_000, () => !bus().owned);
        hideActivation();
        const gone = await until('the bus to forget it', 15_000, () => { const b = bus(); return !b.owned && !b.activatable; });
        check(Boolean(gone), 'S8.0-CONTROL-the-bus-cannot-start-it', bus().line || 'not listed');
        {
            const cdp = await launchNew();
            const carded = await until('the card', 60_000, async () => (await features(cdp)).keyring);
            check(carded?.state === 'not-running', 'S8.1-settings-offers-the-keyring', JSON.stringify(carded));
            await sleep(5_000);
            cdp.close();
            await stopApp();
        }
        const sealsDuring = scan(SEALS);
        check(sealsBefore.every((file) => sealsDuring.includes(file)), 'S8.2-the-seals-stayed', sealsDuring.join(', '));
        putBack();
        quiet('systemctl', '--user', 'start', 'gnome-keyring-daemon.socket');
        check((await held('tynn/pairing')) === null, 'S8.3-and-nothing-moved', 'tynn/pairing is not in the keychain');
    }

    say('the upgrade: the new build, with the keychain answering');
    const cdp = await launchNew();
    const everything = await until('every secret to move', 120_000, async () => { for (const [name, value] of expected) { if ((await held(name)) !== value) return false; } return scan(SEALS).length === 0; });
    const missing = [];
    for (const [name, value] of expected) if ((await held(name)) !== value) missing.push(name);
    check(missing.length === 0, 'S2.1-every-sealed-secret-is-in-the-keychain-byte-for-byte', missing.length ? `not: ${missing.join(', ')}` : `${expected.size} secrets`);
    const sealsLeft = scan(SEALS);
    check(Boolean(everything) && sealsLeft.length === 0, 'S2.2-no-seal-is-left-on-disk', sealsLeft.join(', ') || 'none');
    const tokensLeft = scan(TOKENS);
    check(tokensLeft.length === 0, 'S2.3-no-token-anywhere-under-the-home', tokensLeft.join(', ') || 'none');
    const name = await until('the account', 60_000, async () => (await features(cdp)).user);
    check(name === who, 'S1-the-sign-in-survived-with-no-pairing', `${name}; beta.56 said ${who}`);
    const scrollback = ['terminal-snapshots.json', 'terminal-snapshots'].filter((file) => existsSync(join(home, file)));
    check(scrollback.length === 0, 'S9.1-the-scrollback-is-gone', scrollback.join(', ') || 'none');
    const modes = loose.map((file) => [file.slice(home.length + 1), WINDOWS ? (openToOthers(file) ? 'open' : 'owner-only') : (statSync(file).mode & 0o777).toString(8)]);
    check(loose.length > 0 && modes.every(([, mode]) => mode === (WINDOWS ? 'owner-only' : '600')), 'S9.2-the-modes-are-right', modes.map((m) => m.join(' ')).join(', ') || 'none of the three existed, so this proved nothing');
    for (const [host, id] of Object.entries(before11)) check(json(workstationFile)[host]?.workstationId === id, 'S11.1-the-workstation-keeps-its-id', `${host}: ${id}`);
    const bookFile = join(home, 'keychain-migration.json');
    const book = existsSync(bookFile) ? json(bookFile).secrets ?? {} : {};
    const notDone = [...expected.keys()].filter((key) => book[key] !== 'done');
    check(notDone.length === 0, 'S3.0-the-book-says-done', notDone.length ? `not done: ${notDone.join(', ')}` : `${Object.keys(book).length} rows`);
    cdp.close();
    await stopApp();

    say('S3: a second launch writes nothing, and a key renewed after the move stays');
    const renewed = agentKey(ids.first);
    await keep(`tynn/agent/${ids.first}`, renewed);
    const bookBefore = sha(bookFile);
    const again = await launchNew();
    const nameAgain = await until('the account', 60_000, async () => (await features(again)).user);
    await sleep(8_000);
    check(nameAgain === who, 'S3.1-still-signed-in', String(nameAgain));
    check(sha(bookFile) === bookBefore, 'S3.2-the-book-did-not-change');
    check((await held(`tynn/agent/${ids.first}`)) === renewed, 'S3.3-the-renewed-key-was-not-overwritten');

    if (process.env.UPGRADE_RELAY) {
        say('S11: the moved key signs its way onto the relay');
        const workstation = (c) => c.evaluate('(window.genieTest ?? window.genie).features.snapshot().then((d) => d?.remote?.tynnWorkstation ?? null)');
        await again.evaluate(`(window.genieTest ?? window.genie).features.act({ kind: 'settings.set', key: 'remote_access', value: true }).then(() => true)`);
        const reached = await until('the relay', 90_000, async () => { const t = await workstation(again); return t?.relay?.state === 'reachable' ? t : null; });
        const seen = await workstation(again);
        check(Boolean(reached), 'S11.2-the-moved-key-gets-onto-the-relay', reached ? String(reached.relay.relay) : JSON.stringify(seen?.relay ?? null));
        check(String(reached?.relay?.relay ?? '').startsWith(process.env.UPGRADE_RELAY), 'S11.3-and-it-is-the-test-relay', String(reached?.relay?.relay ?? 'none'));
        again.close();
        await stopApp();

        const [host] = Object.keys(before11);
        const name = `workstation/${host}`;
        const moved = await held(name);
        await keep(name, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
        const wrong = await launchNew();
        let through = false;
        for (let i = 0; i < 45 && !through; i += 1) { through = (await workstation(wrong))?.relay?.state === 'reachable'; await sleep(1000); }
        const after = await workstation(wrong);
        // Refused BECAUSE of the key. "Could not be reached" is the network, and batch FF's control passed on exactly that, proving nothing.
        const reason = String(after?.relay?.reason ?? '');
        const refused = after?.registered === false || (after?.relay?.state === 'unavailable' && reason !== '' && !/could not be reached/i.test(reason));
        check(!through && refused, 'S11.4-CONTROL-another-key-under-that-id-is-refused', JSON.stringify({ registered: after?.registered ?? null, id: after?.workstationId === seen?.workstationId ? 'the same' : 'another', relay: after?.relay ?? null }));
        wrong.close();
        await stopApp();
        await keep(name, moved);
    } else {
        say('S11: the relay half did not run: UPGRADE_RELAY is not set');
        again.close();
    }
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
