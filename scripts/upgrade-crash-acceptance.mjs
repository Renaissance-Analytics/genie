#!/usr/bin/env node
/**
 * A CRASH AT EACH STEP OF THE MOVE LEAVES A WORKING COPY (plan §13, S4). A real window is killed with SIGKILL at each hold of the test build (src/main/migration-holds.ts), and the next launch, with
 * no hold, finishes. What is read after each is the real keychain and the real files. On omarchy-test, with tynn.ai aliased to tynn.gen. Refuses anywhere else.
 *
 *   bash vm-tynn-alias-linux.sh <dir>            # the alias: nothing here may reach production
 *   npm ci && node node_modules/electron/install.js && GENIE_TEST_HOLDS=1 npm run build
 *   node scripts/upgrade-crash-acceptance.mjs
 *
 * THE PROFILE. Two secrets, GitHub's access and refresh tokens, test words only, sealed by a small app run on this tree's Electron under this tree's name, so with the key the window will use. A seal
 * it could not open would read `old-copy-unreadable` and never reach a hold, so reaching one is the control. Beta.56's own seals are upgrade-acceptance-cdp.mjs's job; what is measured here is the order
 * of the steps. The hold is on the SECOND secret, so each case also shows a secret that already finished is not disturbed.
 *
 * Only the window is killed: the host stays up, as it does when a window crashes.
 *
 * ON WINDOWS (scripts/vm-acceptance-windows.sh in the envelope; plan §13): the same, in the logged-on session, because over SSH Credential Manager answers ERROR_NO_SUCH_LOGON_SESSION. @napi-rs/keyring is the reader
 * there too. safeStorage's key is in userData's Local State on Windows, so the sealer runs in the real userData rather than its own.
 *
 * WHETHER THE SEAL CAN BE OPENED IS CHECKED, NOT ASSUMED. On Windows a window that cannot open it says `old-copy-unreadable` and never reaches a hold, and that reads the same for a sealer whose key never reached the disk and for a
 * real launch that cannot read a seal. So: both ways of ending the sealer are measured in a folder of their own (`measure-seal-ended-by-*`); a new process must open the real seal before anything else runs (`2a`); and when a window
 * misses a hold, the same seal is opened outside it (`0a`). 0a PASS beside a missed hold means the window could not read what another process can, which is the product. 0a FAIL means the seal or its key.
 *
 * Prints `### crash <check>=PASS|FAIL  detail`, then `### crash=PASS|FAIL`. Capped at 18 min. No value is printed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: this replaces a profile; test machines only'); process.exit(2); }
process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;

const home = join(homedir(), '.genie');
const runtime = join(home, 'runtime');
const require = createRequire(`${process.cwd()}/`);
const work = mkdtempSync(join(tmpdir(), 'crash-'));
const say = (line) => console.log(`--- ${line}`);
const WINDOWS = process.platform === 'win32';
const WINDOW_ARGS = WINDOWS ? [] : ['--no-sandbox', '--ozone-platform=x11'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, name, detail = '') => { console.log(`### crash ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`); if (!ok) failures.push(name); };
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

const { AsyncEntry } = require('@napi-rs/keyring');
const PIN = { linux: { store: 'secret-service' } };
const entry = (name) => new AsyncEntry('Genie', name, PIN);
const held = async (name) => { try { return (await entry(name).getPassword()) ?? null; } catch { return null; } };
const forget = async (name) => { try { await entry(name).deletePassword(); } catch { /* it was not there */ } };

const ACCESS = 'github/access';
const REFRESH = 'github/refresh';
const githubFile = join(home, 'github.json');
const bookFile = join(home, 'keychain-migration.json');
const bookOf = () => { try { return json(bookFile).secrets ?? {}; } catch { return {}; } };
const fileOf = () => { try { return json(githubFile); } catch { return {}; } };

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
    console.log(`### crash=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
    process.exit(failures.length === 0 ? 0 : 1);
}
// 18 minutes: five steps of two launches, at about 40 s to a migration on the Windows VM (batch II), plus the measures.
setTimeout(() => { check(false, 'the-18-min-cap'); void finish(); }, 1_080_000).unref();

const electronEnv = (extra = {}) => { const env = { ...process.env, XDG_SESSION_TYPE: 'x11', DISPLAY: process.env.DISPLAY ?? ':0', ...extra }; delete env.ELECTRON_RUN_AS_NODE; return env; };
const launch = (extra) => { window = spawn(require('electron'), ['.', ...WINDOW_ARGS], { env: electronEnv(extra), stdio: 'ignore' }); };

const own = JSON.parse(readFileSync('package.json', 'utf8'));
/** Where the window keeps Local State on Windows: Electron's userData, by the app's name. */
const realUserData = () => join(process.env.APPDATA ?? '', own.productName ?? own.name);
/** A short hash of the key in a folder's Local State, or null: it says whether the key is on disk, and whether it changed. No key is printed. */
function keyOnDisk(dir) {
    try {
        const key = json(join(dir, 'Local State')).os_crypt?.encrypted_key;
        return key ? createHash('sha256').update(key).digest('hex').slice(0, 12) : null;
    } catch { return null; }
}

/**
 * This tree's Electron under this tree's name: seals texts to base64, or opens base64 back to text. `end` is how it ends (`exit`: app.exit(0); `quit`: app.quit()), and `data` a userData of its own for a measure.
 */
function seal(texts, { mode = 'seal', end = 'quit', data = null } = {}) {
    const app = join(work, 'sealer');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: own.name, ...(own.productName ? { productName: own.productName } : {}), version: own.version, main: 'main.cjs' }));
    writeFileSync(join(app, 'main.cjs'), `
const { app, safeStorage } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
if (process.env.SEALER_DATA) app.setPath('userData', process.env.SEALER_DATA);
app.whenReady().then(() => {
    let out;
    try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('no encryption here: backend ' + safeStorage.getSelectedStorageBackend());
        const open = process.env.SEALER_MODE === 'open';
        out = { ok: true, results: JSON.parse(readFileSync(process.env.SEALER_IN, 'utf8')).map((text) => (open ? safeStorage.decryptString(Buffer.from(text, 'base64')) : safeStorage.encryptString(text).toString('base64'))) };
    } catch (error) { out = { ok: false, reason: String(error && error.message || error) }; }
    writeFileSync(process.env.SEALER_OUT, JSON.stringify(out), { mode: 0o600 });
    if (process.env.SEALER_END === 'quit') app.quit(); else app.exit(0);
});
`);
    const input = join(work, 'sealer-in.json');
    const output = join(work, 'sealer-out.json');
    writeFileSync(input, JSON.stringify(texts), { mode: 0o600 });
    execFileSync(require('electron'), [app, ...WINDOW_ARGS, ...(WINDOWS ? [] : ['--password-store=gnome-libsecret', `--user-data-dir=${join(work, 'sealer-data')}`])], { env: electronEnv({ SEALER_IN: input, SEALER_OUT: output, SEALER_MODE: mode, SEALER_END: end, ...(data ? { SEALER_DATA: data } : {}) }), stdio: 'ignore', timeout: 60_000 });
    const result = json(output);
    rmSync(input, { force: true });
    rmSync(output, { force: true });
    if (!result.ok) throw new Error(`the sealer: ${result.reason}`);
    return result.results;
}

/** A new process opens it, or says why not. */
const opens = (sealed, expected, data = null) => {
    try {
        const out = seal(sealed, { mode: 'open', data });
        return out.every((text, i) => text === expected[i]) ? { ok: true, why: '' } : { ok: false, why: 'it opened to something else' };
    } catch (error) { return { ok: false, why: error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : String(error) }; }
};

/** What each hold must find. The keychain's copy and the sealed one: at every step at least one is there, which is the whole of S4. */
const CASES = [
    { step: 'before-write', keychain: false, sealed: true, book: undefined },
    { step: 'after-write', keychain: true, sealed: true, book: undefined },
    { step: 'after-read-back', keychain: true, sealed: true, book: undefined },
    { step: 'after-book', keychain: true, sealed: true, book: 'verified' },
    { step: 'after-delete', keychain: true, sealed: false, book: 'verified' },
];

try {
    say('the alias: tynn.ai must be tynn.gen on this machine');
    const { address: resolved } = await lookup('tynn.ai');
    if (resolved !== '127.0.0.1' && resolved !== '::1') throw new Error(`tynn.ai resolves to ${resolved}: the alias is not up, and this would reach production`);
    check(true, '0-tynn-ai-is-the-alias', resolved);

    const bundled = readdirSync('dist/main').filter((name) => name.endsWith('.js')).some((name) => statSync(join('dist/main', name)).isFile() && readFileSync(join('dist/main', name), 'utf8').includes('GENIE_TEST_MIGRATION_HOLD'));
    check(bundled, '1-CONTROL-this-is-the-test-build', bundled ? '' : 'build with GENIE_TEST_HOLDS=1');
    if (!bundled) throw new Error('not the test build');

    const access = `ghu_${randomBytes(18).toString('hex')}`;
    const refresh = `ghr_${randomBytes(18).toString('hex')}`;
    mkdirSync(home, { recursive: true });
    if (WINDOWS) {
        for (const end of ['exit', 'quit']) {
            const data = join(work, `measure-${end}`);
            mkdirSync(data, { recursive: true });
            const word = randomBytes(9).toString('hex');
            const [sealed] = seal([word], { end, data });
            const key = keyOnDisk(data);
            const got = opens([sealed], [word], data);
            console.log(`### crash measure-seal-ended-by-${end} key-on-disk=${key ? 'yes' : 'no'} a-new-process-opens-it=${got.ok ? 'yes' : `no  ${got.why}`}`);
        }
    }
    say('sealing two test words');
    const [tokenEnc, refreshEnc] = seal([access, refresh]);
    check(Boolean(tokenEnc && refreshEnc), '2-sealed-two-test-words');
    const opened = opens([tokenEnc, refreshEnc], [access, refresh]);
    if (WINDOWS) say(`the key in ${realUserData()}: ${keyOnDisk(realUserData()) ?? 'none'}`);
    check(opened.ok, '2a-a-new-process-opens-the-seal', opened.why);
    if (!opened.ok) throw new Error('the seal cannot be opened, so no window could reach a hold');

    for (const { step, keychain, sealed, book } of CASES) {
        say(`S4 ${step}: a fresh profile, the test build, the window killed where it stops`);
        await stopApp();
        say('clearing the keychain');
        await forget(ACCESS);
        await forget(REFRESH);
        rmSync(bookFile, { force: true });
        writeFileSync(githubFile, JSON.stringify({ version: 1, state: 'signed-in', login: 'vm-person', name: null, source: 'sign-in', tokenEnc, refreshEnc }, null, 2), { mode: 0o600 });
        const marker = join(work, `held-${step}`);
        launch({ GENIE_TEST_MIGRATION_HOLD: `${step}:${REFRESH}`, GENIE_TEST_MIGRATION_HOLD_FILE: marker });
        const reached = await until(`the hold at ${step}`, 120_000, () => existsSync(marker));
        check(Boolean(reached), `S4.${step}.0-reached-the-hold`, reached ? '' : 'the window never got there');
        if (!reached) {
            await stopApp();
            const still = opens([tokenEnc, refreshEnc], [access, refresh]);
            check(still.ok, `S4.${step}.0a-the-seal-opens-outside-the-window`, still.ok ? 'so the window could not read what another process can' : still.why);
            if (WINDOWS) say(`the key now: ${keyOnDisk(realUserData()) ?? 'none'}`);
            continue;
        }
        const killed = window.pid;
        process.kill(killed, 'SIGKILL');
        window = null;
        await until('the window to die', 10_000, () => !alive(killed));

        const inKeychain = await held(REFRESH);
        const row = fileOf();
        check(inKeychain === (keychain ? refresh : null), `S4.${step}.1-the-keychain-as-it-should-be`, keychain ? 'holds it, byte for byte' : 'does not hold it yet');
        check((row.refreshEnc === refreshEnc) === sealed, `S4.${step}.2-the-seal-as-it-should-be`, sealed ? 'still there' : 'gone');
        check(bookOf()[REFRESH] === book, `S4.${step}.3-the-book-as-it-should-be`, String(book ?? 'no row'));
        check(inKeychain === refresh || row.refreshEnc === refreshEnc, `S4.${step}.4-a-working-copy-is-left`);
        check(bookOf()[ACCESS] === 'done' && (await held(ACCESS)) === access && row.tokenEnc === undefined, `S4.${step}.5-the-secret-before-it-is-undisturbed`);

        say(`S4 ${step}: the next launch, no hold`);
        launch({});
        const finished = await until('the move to finish', 120_000, () => bookOf()[REFRESH] === 'done');
        check(Boolean(finished), `S4.${step}.6-the-next-launch-finishes`, JSON.stringify(bookOf()));
        check((await held(REFRESH)) === refresh && (await held(ACCESS)) === access, `S4.${step}.7-both-are-in-the-keychain-byte-for-byte`);
        const after = fileOf();
        check(after.refreshEnc === undefined && after.tokenEnc === undefined, `S4.${step}.8-no-seal-is-left`, Object.keys(after).join(','));
    }
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
