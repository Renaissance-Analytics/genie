#!/usr/bin/env node
/**
 * THE KEYRING CARD READS THE HOST (P3.4 cut c), on the real app and the real gnome-keyring, on omarchy-test. Refuses anywhere else.
 *
 *   npm ci && node node_modules/electron/install.js && npm run build
 *   node scripts/smoke-seed.mjs && node scripts/keyring-card-cdp.mjs
 *
 * It starts the app itself, with the Secret Service stopped. The card must come from the host, and its button must start the keyring with no restart of Genie.
 *   CONTROL: the keychain really refuses before the click, read from this script over the same bus.
 *   THE CLAIM: the card shows not-running; the button runs in the host; the keychain then answers; the card goes; the same window process is still there.
 *
 * Prints `### keyring-card <check>=PASS|FAIL  detail`, then `### keyring-card=PASS|FAIL`. Capped at 4 min, and leaves the Secret Service running as it found it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
function stopKeyring() {
    quiet('systemctl', '--user', 'stop', 'gnome-keyring-daemon.socket', 'gnome-keyring-daemon.service');
    quiet('pkill', '-x', 'gnome-keyring-daemon');
}
const keychainAnswers = async () => {
    const { AsyncEntry } = require('@napi-rs/keyring');
    return new AsyncEntry('Genie', 'genie/probe', { linux: { store: 'secret-service' } }).getPassword().then(() => true, () => false);
};
const hostPid = () => { try { return JSON.parse(readFileSync(join(homedir(), '.genie', 'runtime', 'host.json'), 'utf8')).pid; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let window = null;
async function finish() {
    const host = hostPid();
    for (const pid of [window?.pid, host]) { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
    await sleep(1500);
    for (const pid of [window?.pid, host]) { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    quiet('systemctl', '--user', 'start', 'gnome-keyring-daemon.socket');
    console.log(`### keyring-card=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
    process.exit(failures.length === 0 ? 0 : 1);
}
setTimeout(() => { check(false, 'the-4-min-cap'); void finish(); }, 240_000).unref();

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

try {
    say('stopping the Secret Service');
    stopKeyring();
    await sleep(1500);
    check(!(await keychainAnswers()), '1-CONTROL-the-keychain-really-refuses');

    say('launching');
    const env = { ...process.env, XDG_SESSION_TYPE: 'x11', DISPLAY: process.env.DISPLAY ?? ':0' };
    window = spawn(require('electron'), ['.', '--no-sandbox', '--ozone-platform=x11', `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
    const page = await until('a window on the debugger port', 60_000, async () => {
        try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { return null; }
    });
    if (!page) throw new Error('no window on the debugger port');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await until('window.genie', 30_000, () => cdp.evaluate('typeof window.genie === "object"'));
    const card = () => cdp.evaluate('window.genie.features.snapshot().then((d) => d?.integrations?.keyring ?? null)');
    const shown = await until('the card', 45_000, card);
    check(shown?.state === 'not-running' || shown?.state === 'not-installed', '2-the-card-shows-what-the-host-found', JSON.stringify(shown));
    const hostLog = hostPid();
    check(Boolean(hostLog) && alive(hostLog), '3-the-host-is-up', String(hostLog));

    say('pressing the button');
    await cdp.evaluate(`window.genie.features.act({ kind: 'keyring.fix' })`);
    const answered = await until('the keychain to answer', 60_000, keychainAnswers);
    check(Boolean(answered), '4-the-keychain-answers-now');
    const gone = await until('the card to go', 30_000, async () => (await card()) === null);
    check(Boolean(gone), '5-the-card-went', JSON.stringify(await card()));
    check(alive(window.pid) && alive(hostLog) && hostPid() === hostLog, '6-NOBODY-RESTARTED-same-window-and-host', `window ${window.pid}, host ${hostLog}`);
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
