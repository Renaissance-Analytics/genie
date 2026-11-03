#!/usr/bin/env node
/**
 * THE KEYRING'S REAL INSTALL, THROUGH PKEXEC, FROM THE HOST PROCESS (the beta.56 acceptance). gnome-keyring is really removed, the card says not-installed, its button runs in the
 * detached host, pkexec runs pacman, and the keychain answers with no restart of Genie. On omarchy-test. Refuses anywhere else.
 *
 *   npm ci && node node_modules/electron/install.js && npm run build
 *   node scripts/smoke-seed.mjs && node scripts/keyring-install-cdp.mjs
 *
 * THE PACKAGE: `pacman -S --needed` takes it from /var/cache/pacman/pkg when the file there is the version the sync database names. If the cache does not hold it, this downloads it first
 * with `pacman -Sw`, while gnome-keyring is still installed. If the mirror cannot be reached either, it says so and stops with exit 3: that needs a VM snapshot with the package in its cache.
 *
 * NOBODY TYPES A PASSWORD: a polkit rule, written here and removed at the end, lets user genie run pkexec with no prompt. So this proves pkexec and pacman from the host process, and
 * not the password prompt, which only a person can see.
 *
 * Prints `### keyring-install <check>=PASS|FAIL  detail`, then `### keyring-install=PASS|FAIL`. Capped at 8 min. Every exit puts the package back and removes the rule.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: this removes a system package; test machines only'); process.exit(2); }
process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
const PORT = Number(process.env.CDP_PORT ?? 9222);
const CACHE = '/var/cache/pacman/pkg';
const DAEMON = '/usr/bin/gnome-keyring-daemon';
const RULE = '/etc/polkit-1/rules.d/10-genie-keyring-install-test.rules';
const require = createRequire(`${process.cwd()}/`);
const say = (line) => console.log(`--- ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, name, detail = '') => { console.log(`### keyring-install ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`); if (!ok) failures.push(name); };
const until = async (what, ms, read) => {
    const end = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > end) { say(`gave up waiting for ${what} after ${ms / 1000} s`); return null; }
        await sleep(500);
    }
};
const quiet = (command, ...args) => { try { execFileSync(command, args, { stdio: 'ignore', timeout: 120_000 }); return true; } catch { return false; } };
const sudo = (...args) => quiet('sudo', '-n', ...args);
const output = (command, ...args) => { try { return execFileSync(command, args, { encoding: 'utf8', timeout: 30_000 }).trim(); } catch { return ''; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hostPid = () => { try { return JSON.parse(readFileSync(join(homedir(), '.genie', 'runtime', 'host.json'), 'utf8')).pid; } catch { return null; } };
const keychainAnswers = async () => {
    const { AsyncEntry } = require('@napi-rs/keyring');
    let read;
    try { read = new AsyncEntry('Genie', 'genie/probe', { linux: { store: 'secret-service' } }).getPassword().then(() => true, () => false); } catch { return false; }
    return Promise.race([read, sleep(20_000).then(() => false)]);
};

let window = null;
let cached = null;
let removed = false;
let ruleWritten = false;
async function finish() {
    const host = hostPid();
    for (const pid of [window?.pid, host]) { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
    await sleep(1500);
    for (const pid of [window?.pid, host]) { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    if (removed && !existsSync(DAEMON) && cached) sudo('pacman', '-U', '--noconfirm', '--needed', cached);
    if (ruleWritten) sudo('rm', '-f', RULE);
    check(!removed || existsSync(DAEMON), 'Z-the-package-is-back');
    if (failures.length > 0) {
        try {
            console.log('--- the end of the host log');
            for (const line of readFileSync(join(homedir(), '.genie', 'logs', 'genie-host.log'), 'utf8').split('\n').slice(-25)) console.log(line.slice(0, 220));
        } catch (error) { console.log(`--- no host log: ${error instanceof Error ? error.message : String(error)}`); }
    }
    console.log(`### keyring-install=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
    process.exit(failures.length === 0 ? 0 : 1);
}
setTimeout(() => { check(false, 'the-8-min-cap'); void finish(); }, 480_000).unref();

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
    const version = output('pacman', '-Q', 'gnome-keyring').split(/\s+/)[1] ?? '';
    const syncVersion = output('pacman', '-Si', 'gnome-keyring').split('\n').find((l) => l.startsWith('Version'))?.split(':').slice(1).join(':').trim() ?? '';
    const inCache = () => { try { return readdirSync(CACHE).find((name) => name.startsWith(`gnome-keyring-${syncVersion}-`) && name.endsWith('.pkg.tar.zst')) ?? null; } catch { return null; } };
    if (!inCache()) { say('not in the cache: downloading it, with gnome-keyring still installed'); sudo('pacman', '-Sw', '--noconfirm', 'gnome-keyring'); }
    const file = inCache();
    say(`installed ${version}; the sync database names ${syncVersion}; cached: ${file ?? 'no'}`);
    if (!file) {
        console.log(`### keyring-install needs-a-snapshot=INFO  ${CACHE} has no gnome-keyring-${syncVersion}, and pacman -Sw could not get it: take a VM snapshot with \`sudo pacman -Sw --noconfirm gnome-keyring\` run first`);
        process.exit(3);
    }
    cached = join(CACHE, file);
    const offline = output('sudo', '-n', 'pacman', '-Sp', '--print-format', '%l', 'gnome-keyring');
    check(offline.startsWith('file://') || offline.includes(file), '0-CONTROL-pacman-would-use-the-cache-or-this-file', offline.slice(0, 120));

    const rule = join(tmpdir(), 'genie-install-test.rules');
    writeFileSync(rule, `polkit.addRule(function (action, subject) { if (action.id === 'org.freedesktop.policykit.exec' && subject.user === 'genie') return polkit.Result.YES; });\n`);
    ruleWritten = sudo('install', '-m', '0644', rule, RULE);
    check(ruleWritten, '1-the-test-only-polkit-rule');
    await sleep(2000);

    quiet('systemctl', '--user', 'stop', 'gnome-keyring-daemon.socket', 'gnome-keyring-daemon.service');
    quiet('pkill', '-f', '^(/usr/bin/)?gnome-keyring-daemon');
    removed = sudo('pacman', '-Rdd', '--noconfirm', 'gnome-keyring');
    quiet('busctl', '--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ReloadConfig');
    check(removed && !existsSync(DAEMON), '2-CONTROL-it-is-really-removed', output('pacman', '-Q', 'gnome-keyring') || 'not installed');
    check(!(await keychainAnswers()), '3-CONTROL-the-keychain-really-refuses');

    const env = { ...process.env, XDG_SESSION_TYPE: 'x11', DISPLAY: process.env.DISPLAY ?? ':0' };
    delete env.ELECTRON_RUN_AS_NODE;
    window = spawn(require('electron'), ['.', '--no-sandbox', '--ozone-platform=x11', `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
    const page = await until('a window on the debugger port', 60_000, async () => {
        try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { return null; }
    });
    if (!page) throw new Error('no window on the debugger port');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await until('window.genie', 30_000, () => cdp.evaluate('typeof window.genie === "object"'));
    const card = () => cdp.evaluate('window.genie.features.snapshot().then((d) => d?.integrations?.keyring ?? null)');
    const shown = await until('the card', 45_000, card);
    check(shown?.state === 'not-installed', '4-the-card-says-not-installed', JSON.stringify(shown));
    const host = hostPid();
    const windowPid = window.pid;

    say('pressing the button');
    await cdp.evaluate(`window.genie.features.act({ kind: 'keyring.fix' })`);
    const installed = await until('the package to arrive', 180_000, () => existsSync(DAEMON));
    check(Boolean(installed), '5-the-button-installed-it', output('pacman', '-Q', 'gnome-keyring') || 'not installed');
    const answered = await until('the keychain to answer', 60_000, keychainAnswers);
    check(Boolean(answered), '6-the-keychain-answers-now');
    const gone = await until('the card to go', 30_000, async () => (await card()) === null);
    check(Boolean(gone), '7-the-card-went', JSON.stringify(await card()));
    check(window?.pid === windowPid && alive(windowPid) && alive(host) && hostPid() === host, '8-NOBODY-RESTARTED-same-window-and-host', `window ${windowPid}, host ${host}`);
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
