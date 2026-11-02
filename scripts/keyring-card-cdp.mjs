#!/usr/bin/env node
/**
 * THE KEYRING CARD READS THE HOST (P3.4 cut c), on the real app and the real gnome-keyring, on omarchy-test. Refuses anywhere else.
 *
 *   npm ci && node node_modules/electron/install.js && npm run build
 *   node scripts/smoke-seed.mjs && node scripts/keyring-card-cdp.mjs
 *
 * WHAT "NOT RUNNING" REALLY IS. gnome-keyring's Secret Service is D-Bus activated: stopping the daemon does not keep it stopped, because the next libsecret read starts it again,
 * this script's own read included (batch V: the control failed for exactly that). So a person never sees a card just because the daemon is not running. Three phases, each
 * read from the bus with `busctl`, which activates nothing:
 *   A. THE ORDINARY CASE: daemon stopped, activation file in place. Genie starts, the service comes up with nobody pressing anything, and there is no card.
 *   B. "not-running": installed, and the bus cannot activate it (its activation file hidden; sudo, test VM only). The card must come from the host, and its button must start
 *      the daemon directly (`gnome-keyring-daemon --start`), with no restart of Genie. CONTROL: the keychain really refuses before the click, read over the same bus.
 *   C. "not-installed": the daemon's binary hidden too. The card says so and names the command. The button is not pressed: a real install needs a package mirror and a polkit
 *      agent, and is covered by unit tests only.
 *
 * Prints `### keyring-card <check>=PASS|FAIL  detail`, then `### keyring-card=PASS|FAIL`. Capped at 6 min. Every exit puts back what it hid and leaves the Secret Service as it found it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: this stops the keyring; test machines only'); process.exit(2); }
process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
const PORT = Number(process.env.CDP_PORT ?? 9222);
const require = createRequire(`${process.cwd()}/`);
const say = (line) => console.log(`--- ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, name, detail = '') => { console.log(`### keyring-card ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`); if (!ok) failures.push(name); };
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
const sudo = (...args) => { try { execFileSync('sudo', ['-n', ...args], { stdio: 'ignore', timeout: 20_000 }); return true; } catch { return false; } };
/** What the bus says, with no read that could activate anything. `pkill -x` cannot match this name: a process name is cut at 15 characters. */
const bus = () => {
    try {
        const line = execFileSync('busctl', ['--user', 'list', '--no-legend', '--no-pager'], { encoding: 'utf8', timeout: 10_000 }).split('\n').find((l) => l.startsWith('org.freedesktop.secrets ')) ?? '';
        const pid = line.trim().split(/\s+/)[1] ?? '';
        return { owned: /^\d+$/.test(pid), activatable: pid === '-', line: line.replace(/\s+/g, ' ').slice(0, 90) };
    } catch (error) { return { owned: false, activatable: false, line: `busctl: ${error instanceof Error ? error.message : String(error)}` }; }
};
function stopKeyring() {
    quiet('systemctl', '--user', 'stop', 'gnome-keyring-daemon.socket', 'gnome-keyring-daemon.service');
    quiet('pkill', '-f', '^(/usr/bin/)?gnome-keyring-daemon');
}
const reloadBus = () => quiet('busctl', '--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ReloadConfig');
const HIDDEN = '.hidden-by-keyring-card';
const SERVICES = '/usr/share/dbus-1/services';
const DAEMON = '/usr/bin/gnome-keyring-daemon';
const hiddenFiles = new Set();
function hide(file) { if (sudo('mv', file, `${file}${HIDDEN}`)) { hiddenFiles.add(file); return true; } return false; }
function putBack() {
    for (const file of [...hiddenFiles]) { if (sudo('mv', `${file}${HIDDEN}`, file)) hiddenFiles.delete(file); else say(`could not put back ${file}`); }
    reloadBus();
}
const activationFiles = () => { try { return readdirSync(SERVICES).map((name) => `${SERVICES}/${name}`).filter((file) => /^Name=org\.freedesktop\.secrets\s*$/m.test(readFileSync(file, 'utf8'))); } catch { return []; } };
const keychainAnswers = async () => {
    const { AsyncEntry } = require('@napi-rs/keyring');
    const read = new AsyncEntry('Genie', 'genie/probe', { linux: { store: 'secret-service' } }).getPassword().then(() => true, () => false);
    return Promise.race([read, sleep(20_000).then(() => false)]);
};
const hostPid = () => { try { return JSON.parse(readFileSync(join(homedir(), '.genie', 'runtime', 'host.json'), 'utf8')).pid; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let window = null;
async function stopApp() {
    const host = hostPid();
    for (const pid of [window?.pid, host]) { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
    await sleep(1500);
    for (const pid of [window?.pid, host]) { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    window = null;
}
async function finish() {
    await stopApp();
    putBack();
    quiet('systemctl', '--user', 'start', 'gnome-keyring-daemon.socket');
    if (failures.length > 0) {
        try {
            console.log('--- the end of the host log');
            for (const line of readFileSync(join(homedir(), '.genie', 'logs', 'genie-host.log'), 'utf8').split('\n').slice(-25)) console.log(line.slice(0, 220));
        } catch (error) { console.log(`--- no host log: ${error instanceof Error ? error.message : String(error)}`); }
    }
    console.log(`### keyring-card=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
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
        if (f.result?.exceptionDetails) throw new Error(`page threw: ${f.result.exceptionDetails.exception?.description ?? '?'}`);
        return f.result?.result?.value;
    }
}

async function launch() {
    const env = { ...process.env, XDG_SESSION_TYPE: 'x11', DISPLAY: process.env.DISPLAY ?? ':0' };
    window = spawn(require('electron'), ['.', '--no-sandbox', '--ozone-platform=x11', `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
    const page = await until('a window on the debugger port', 60_000, async () => {
        try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { return null; }
    });
    if (!page) throw new Error('no window on the debugger port');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await until('window.genie', 30_000, () => cdp.evaluate('typeof window.genie === "object"'));
    const card = () => cdp.evaluate('window.genie.features.snapshot().then((d) => d?.integrations?.keyring ?? null)');
    return { cdp, card };
}

try {
    say('A. THE ORDINARY CASE: the daemon stopped, the bus can still start it');
    const before = bus();
    check(before.owned || before.activatable, 'A0-CONTROL-the-gauge-sees-the-service', before.line);
    stopKeyring();
    const stopped = await until('the daemon to go', 15_000, () => !bus().owned);
    check(Boolean(stopped) && bus().activatable, 'A1-CONTROL-not-running-and-activatable', bus().line);
    {
        const { card } = await launch();
        const woke = await until('the service to come up', 45_000, () => bus().owned);
        check(Boolean(woke), 'A2-it-came-up-with-nobody-pressing-anything', bus().line);
        await until('the host', 30_000, () => hostPid());
        await sleep(5_000);
        const shown = await card();
        check(shown === null, 'A3-there-is-no-card', JSON.stringify(shown));
        await stopApp();
    }

    say('B. NOT RUNNING: installed, and the bus cannot start it');
    const files = activationFiles();
    check(files.length > 0, 'B0-CONTROL-found-its-activation-file', files.join(', '));
    stopKeyring();
    await until('the daemon to go', 15_000, () => !bus().owned);
    for (const file of files) hide(file);
    reloadBus();
    const hiddenNow = await until('the bus to forget it', 15_000, () => { const b = bus(); return !b.owned && !b.activatable; });
    check(Boolean(hiddenNow), 'B1-CONTROL-the-bus-cannot-start-it', bus().line || 'not listed');
    check(!(await keychainAnswers()), 'B2-CONTROL-the-keychain-really-refuses');
    check(!bus().owned, 'B3-CONTROL-and-that-read-started-nothing', bus().line || 'not listed');
    {
        say('launching');
        const { cdp, card } = await launch();
        const shown = await until('the card', 45_000, card);
        check(shown?.state === 'not-running', 'B4-the-card-shows-what-the-host-found', JSON.stringify(shown));
        const host = hostPid();
        check(Boolean(host) && alive(host), 'B5-the-host-is-up', String(host));
        const windowPid = window.pid;
        say('pressing the button');
        await cdp.evaluate(`window.genie.features.act({ kind: 'keyring.fix' })`);
        const answered = await until('the keychain to answer', 60_000, keychainAnswers);
        check(Boolean(answered), 'B6-the-keychain-answers-now', bus().line);
        const gone = await until('the card to go', 30_000, async () => (await card()) === null);
        check(Boolean(gone), 'B7-the-card-went', JSON.stringify(await card()));
        check(window?.pid === windowPid && alive(windowPid) && alive(host) && hostPid() === host, 'B8-NOBODY-RESTARTED-same-window-and-host', `window ${windowPid}, host ${host}`);
        await stopApp();
    }

    say('C. NOT INSTALLED: no daemon on this machine');
    stopKeyring();
    await until('the daemon to go', 15_000, () => !bus().owned);
    hide(DAEMON);
    check(!existsSync(DAEMON) && !bus().owned && !bus().activatable, 'C0-CONTROL-no-daemon-and-nothing-to-activate', bus().line || 'not listed');
    {
        const { card } = await launch();
        const shown = await until('the card', 45_000, card);
        check(shown?.state === 'not-installed', 'C1-the-card-says-not-installed', JSON.stringify(shown));
        check(typeof shown?.manual === 'string' && shown.manual.includes('gnome-keyring'), 'C2-and-names-the-command', String(shown?.manual));
        await stopApp();
    }
    putBack();
    check(existsSync(DAEMON) && hiddenFiles.size === 0, 'D-everything-hidden-was-put-back');
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
