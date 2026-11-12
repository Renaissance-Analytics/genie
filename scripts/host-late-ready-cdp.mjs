#!/usr/bin/env node
/**
 * A HOST THAT IS READY LATE (Tynn #700). Run from a built tree on a test machine only (GENIE_TEST_MACHINE=1, which both
 * gates set; it refuses otherwise), never the owner's desktop:
 *   node scripts/host-late-ready-cdp.mjs
 * Own temporary home and profile. genie-host is started 25 s late on purpose (GENIE_TEST_HOST_READY_DELAY_MS, read only by
 * the host just before it writes its record), past the 20 s the window used to give up at. PASS only when the window
 * reaches its page and its preload answers, and the window's log never said the host was unavailable.
 * --break delays the host as long as it allows (120 s), past this script's 90 s deadline for the page: it must FAIL,
 * proving the script fails when no page comes.
 * Exit 0 pass; 1 fail.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WIN = process.platform === 'win32';
const started = Date.now();
const PORT = Number(process.env.CDP_PORT ?? 9336);
const DELAY_MS = process.argv.includes('--break') ? '130000' : '25000';
const OUT = resolve('smoke-out');
const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const alive = (pid) => { try { if (!Number.isInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
let app; let root; let failed = null;

async function targets() { return (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3_000) })).json(); }
async function until(label, fn, ms) {
    const end = Date.now() + ms; let last;
    while (Date.now() < end) {
        try { const value = await fn(); if (value) return value; } catch (error) { last = error.message; }
        await sleep(500);
    }
    throw new Error(`${label}: no positive result in ${ms}ms${last ? ` (${last})` : ''}`);
}
async function evaluate(url, expression) {
    const socket = new WebSocket(url);
    await new Promise((ok, no) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', () => no(new Error('CDP socket error')), { once: true }); });
    const answer = await new Promise((ok) => { socket.addEventListener('message', (event) => ok(JSON.parse(event.data)), { once: true }); socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
    socket.close();
    return answer.result?.result?.value;
}

async function cleanup() {
    if (app?.pid) { try { if (WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { timeout: 15_000, stdio: 'ignore' }); else process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ } }
    if (root) {
        // A fresh private home had no record before launch; never enumerate or kill other Genies.
        const hostPid = readJson(join(root, '.genie', 'runtime', 'host.json'))?.pid;
        if (alive(hostPid)) { try { process.kill(hostPid, 'SIGTERM'); } catch { /* gone */ } }
        for (let i = 0; i < 20 && alive(hostPid); i++) await sleep(250);
        if (alive(hostPid)) { try { process.kill(hostPid, 'SIGKILL'); } catch { /* gone */ } }
    }
}

try {
    // A TEST MACHINE ONLY: both gates set GENIE_TEST_MACHINE=1 on one (scripts/ci/linux.sh, windows.ps1). Anywhere else
    // this starts nothing: it would launch Genie on someone's desktop.
    if (process.env.GENIE_TEST_MACHINE !== '1') throw new Error('refused: not a test machine (GENIE_TEST_MACHINE=1 says one is); nothing was launched');
    let busy = false;
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1_000) }); busy = true; } catch (e) { if (e.name === 'TimeoutError') busy = true; }
    if (busy) throw new Error(`debugger port ${PORT} is occupied; no existing app was touched`);
    root = mkdtempSync(join(tmpdir(), 'genie-host-late-'));
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const env = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: join(root, '.genie'), GENIE_PAGE_PROBE: '1', GENIE_TEST_HOST_READY_DELAY_MS: '25000' };
    if (DELAY_MS !== '25000') env.GENIE_TEST_HOST_READY_DELAY_MS = DELAY_MS;
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, timeout: 15_000, stdio: 'pipe' });
    mkdirSync(OUT, { recursive: true });
    const fd = openSync(join(OUT, 'host-late-ready-electron.log'), 'w');
    const electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron');
    const args = ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(root, 'profile')}`];
    if (!WIN) args.push('--no-sandbox');
    const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    app = spawn(needsXvfb ? 'xvfb-run' : electron, needsXvfb ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', electron, ...args] : args, { env, detached: !WIN, windowsHide: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    log(`launched; the host is started ${Number(env.GENIE_TEST_HOST_READY_DELAY_MS) / 1000} s late`);
    // The wait itself shows while the host is late: its window is a page too, so the main window is found by its file.
    const page = await until('page target', async () => mainWindow(await targets()), 90_000);
    log(`page target after ${((Date.now() - started) / 1000).toFixed(1)} s: ${page.url.split('#')[0]}`);
    await until('preload answers', () => evaluate(page.webSocketDebuggerUrl, 'typeof window.genie === "object"'), 30_000);
    const lifecycle = readText(join(root, '.genie', 'runtime', 'lifecycle.log'));
    if (/agent host unavailable/.test(lifecycle)) throw new Error('the window said the host was unavailable, though the page came');
    const steps = lifecycle.split(/\r?\n/).filter((l) => / boot step=/.test(l));
    for (const line of steps) log(line.trim());
    log('PASS: the window reached its page with a host that was ready late');
} catch (error) {
    failed = error;
    log(`FAIL: ${error.message}`);
    if (root) for (const line of readText(join(root, '.genie', 'runtime', 'lifecycle.log')).split(/\r?\n/).slice(-30)) if (line.trim()) log(`  lifecycle: ${line}`);
} finally {
    await cleanup();
}
process.exit(failed ? 1 : 0);
