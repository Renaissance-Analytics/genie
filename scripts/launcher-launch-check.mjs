#!/usr/bin/env node
/**
 * THE LAUNCHER LAUNCHES ALL THREE, END TO END (Tynn #1058; beta.67's release condition: "the launcher with client, host
 * and browser working from it"). In a test VM only: the launcher-install rows (scripts/vm-launcher-install-linux.sh,
 * scripts/vm-launcher-install.ps1) run it on the fresh install they just made (the profile `both`), once Genie is open.
 * It asks the OS, never Genie, what runs, and photographs the screen as the person sees it:
 *
 *   1. the host: the launcher's record names a live genie-host whose executable is <code>/host/<build>/genie-host;
 *   2. a client window: a pid attached to the launcher (launcher.status `clients`), its executable
 *      <code>/client/<build>/genie-client, not the browser, with its window on screen -> launch-2-client-<os>.png;
 *   3. the Genie Browser, opened as the person opens it: the tray's "Open Genie Browser" item (`launcher.trayAct
 *      openBrowser`, the item's own handler, tray::act; the launcher answers it only with GENIE_LAUNCHER_TRAY_PROBE=1, which
 *      the row gives it). A NEW process runs `--genie-browser`, its executable the client's program at <build> (the browser
 *      component runs on the client's program, components.rs: its package carries no second copy of the app), its parent
 *      the launcher (never the host: a host that spawned Electron itself is what L4 removed), its window on screen
 *      -> launch-3-browser-<os>.png;
 *   4. side by side: the host and the client are the same pids as before the Browser opened, and all three are alive
 *      -> launch-4-side-by-side-<os>.png.
 *
 *   node scripts/launcher-launch-check.mjs --code <code root> --data <data root> --build <build> --launcher <exe> --out <dir>
 * Prints `### launcher-launch=PASS|FAIL <why>`; exits 1 on a failure.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { WIN, OS, SYNC_MS, run, step, check, sleep, until, alive, executableOf, commandLine, processesNamed, parents, descends, shot, pressKey, wireCall, testMachineOrRefuse } from './launcher-row-lib.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const code = arg('code');
const data = arg('data');
const build = arg('build');
/** The installed launcher: <code>/launcher/<build>/genie on Linux, %LOCALAPPDATA%/Programs/Genie/Genie.exe on Windows. */
const launcherExe = arg('launcher');
run.name = 'launcher-launch';
run.out = arg('out') ?? join(process.cwd(), 'ci-out', 'launcher-install');
if (!code || !data || !build || !launcherExe) { console.error('usage: launcher-launch-check.mjs --code <code root> --data <data root> --build <build> --launcher <installed launcher> [--out <dir>]'); process.exit(2); }
testMachineOrRefuse('GENIE_LAUNCHER_ROWS');
const runtime = join(data, 'runtime');
const exe = (track, name) => join(code, track, build, WIN ? `${name}.exe` : name);
const samePath = (a, b) => (WIN ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/** The desktop's own notifications dismissed before a photograph (mako on the Linux VM), as the migrate row does. */
function clearNotifications() {
    if (!WIN) spawnSync('makoctl', ['dismiss', '--all'], { timeout: 5_000 });
}
function photograph(name) {
    clearNotifications();
    return shot(name);
}

/**
 * The windows a process shows on screen, as the window system says it: Hyprland's client list (mapped, not hidden) on
 * Linux; on Windows the process's visible top-level window (MainWindowHandle, non-zero only for a visible one) and its title.
 */
function windowsOf(pid) {
    if (!WIN) {
        const r = spawnSync('hyprctl', ['-j', 'clients'], { encoding: 'utf8', timeout: SYNC_MS });
        if (r.status !== 0) return { error: `hyprctl clients failed: ${String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 120)}`, windows: [] };
        let list = [];
        try { list = JSON.parse(r.stdout); } catch { return { error: 'hyprctl clients said no JSON', windows: [] }; }
        return { error: null, windows: list.filter((c) => c.pid === pid && c.mapped !== false && c.hidden !== true).map((c) => ({ title: c.title, at: c.at, size: c.size })) };
    }
    try {
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; "$([int64]$p.MainWindowHandle)|$($p.MainWindowTitle)"`], { encoding: 'utf8', timeout: 60_000, windowsHide: true }).trim();
        const [handle, ...title] = out.split('|');
        return { error: null, windows: Number(handle) !== 0 ? [{ title: title.join('|'), handle: Number(handle) }] : [] };
    } catch (e) {
        return { error: `Get-Process ${pid}: ${String(e.message).slice(0, 120)}`, windows: [] };
    }
}
async function windowOnScreen(pid, ms) {
    let last = { error: null, windows: [] };
    const seen = await until(() => { last = windowsOf(pid); return last.windows.length > 0 ? last : null; }, ms, 1_000);
    return seen ?? last;
}
/**
 * The browser's own main process: its command line names --genie-browser, and its parent is no such process (a Chromium
 * child that carries the flag is under it). By parentage alone, so no command line is read in the wait.
 */
async function browserMains() {
    const found = (await processesNamed('--genie-browser')) ?? [];
    return found.filter((p) => !found.some((q) => q.pid === p.ppid));
}

/** What the launcher and the Browser said, on a failure: the launcher's spawn log for the Browser, and its own. */
function dumpLogs() {
    for (const f of ['genie-browser.log', 'genie-launcher.log']) {
        const p = join(data, 'logs', f);
        if (!existsSync(p)) { console.log(`--- ${p}: none`); continue; }
        const lines = readFileSync(p, 'utf8').split(/\r?\n/);
        console.log(`--- ${p} (last 40 lines)\n${lines.slice(-40).join('\n')}`);
    }
}
const fail = (why) => {
    dumpLogs();
    console.log(`### launcher-launch=FAIL ${why}`);
    process.exit(1);
};

// ---------------------------------------------------------------- 1. the host, from its own folder
step(1, 'the launcher started the host from its own folder');
const status = await wireCall(runtime, 'launcher.status');
if (!status.ok) fail(`launcher.status was not answered: ${status.reason}`);
const s = status.value;
console.log(`  launcher.status: launcher ${JSON.stringify(s.launcher)}, host ${JSON.stringify(s.host)}, clients ${JSON.stringify(s.clients)}, profile ${s.profile}`);
const launcherPid = Number(s.launcher?.pid);
check(s.launcher?.running === true && alive(launcherPid), 'the launcher runs', `pid ${launcherPid}`);
check(samePath(executableOf(launcherPid), launcherExe), `the launcher is the installed one (${launcherExe})`, executableOf(launcherPid));
const hostPid = Number(s.host?.pid);
check(s.host?.running === true && alive(hostPid), 'the host runs, by the launcher\'s record', `pid ${hostPid}`);
const hostExe = executableOf(hostPid);
check(samePath(hostExe, exe('host', 'genie-host')), `genie-host runs from ${join(code, 'host', build)}`, hostExe);
console.log(`  genie-host's parent: ${parents().get(hostPid) ?? '(gone)'}`);

// ---------------------------------------------------------------- 2. a client window, attached to the launcher
step(2, 'a client window is open from the client\'s folder, attached to the launcher');
const attached = (Array.isArray(s.clients) ? s.clients : []).map(Number).filter((p) => alive(p));
check(attached.length > 0, 'a client is attached to the launcher (launcher.attach)', JSON.stringify(s.clients));
const clientPid = attached.find((p) => samePath(executableOf(p), exe('client', 'genie-client')) && !commandLine(p).includes('--genie-browser')) ?? null;
check(clientPid !== null, `an attached client runs ${exe('client', 'genie-client')}`, attached.map((p) => `${p}: ${executableOf(p)}`).join('; '));
if (clientPid === null) { photograph(`launch-2-client-${OS}.png`); fail(`no client window attached to the launcher runs from ${join(code, 'client', build)}`); }
const clientWin = await windowOnScreen(clientPid, 30_000);
check(clientWin.windows.length > 0, 'the client\'s window is on screen', clientWin.error ?? JSON.stringify(clientWin.windows));
photograph(`launch-2-client-${OS}.png`);

// ---------------------------------------------------------------- 3. the Genie Browser, from the tray's item
step(3, 'the Genie Browser opened from the tray\'s "Open Genie Browser"');
const before = new Set((await browserMains()).map((p) => p.key));
console.log(`  browser processes before: ${before.size ? [...before].join(', ') : 'none'}`);
const browserTrack = s.tracks?.browser;
check(browserTrack?.verified === true && browserTrack?.current === build, `the browser track ${build} is installed and verifies`, JSON.stringify(browserTrack));
const menu = await wireCall(runtime, 'launcher.trayMenu');
console.log(`  the tray's menu: ${menu.ok ? JSON.stringify(menu.value?.items) : menu.reason}`);
check(menu.ok && JSON.stringify(menu.value?.items ?? []).includes('Open Genie Browser'), 'the tray offers "Open Genie Browser"');
// Windows shows the real menu at the icon for it (tray::show_menu); Linux's is drawn by the desktop's tray, which only a
// pointer opens. Shown: photographed, then closed with Escape, so it covers nothing later.
if (menu.ok && menu.value?.shown === true) {
    await sleep(1_500);
    photograph(`launch-3-tray-menu-${OS}.png`);
    pressKey('Escape');
    await sleep(1_000);
}
const acted = await wireCall(runtime, 'launcher.trayAct', [{ action: 'openBrowser' }]);
check(acted.ok, 'the tray\'s "Open Genie Browser" was chosen', acted.ok ? JSON.stringify(acted.value) : acted.reason);
const started = await until(async () => (await browserMains()).find((p) => !before.has(p.key)) ?? null, 30_000, 1_000);
check(Boolean(started), 'a new Genie Browser process started within 30 s', started ? `pid ${started.pid}: ${commandLine(started.pid)}` : 'none');
if (!started) {
    photograph(`launch-3-browser-${OS}.png`);
    fail('the tray\'s "Open Genie Browser" started no Genie Browser');
}
const browserPid = started.pid;
const browserExe = executableOf(browserPid);
check(samePath(browserExe, exe('client', 'genie-client')), `the Browser runs the client's program at ${build} (the browser component runs on it)`, browserExe);
check(existsSync(join(code, 'browser', build, '.complete')), `the browser track's own folder ${join(code, 'browser', build)} is complete`, (() => { try { return readdirSync(join(code, 'browser', build)).join(', '); } catch (e) { return e.code; } })());
check(started.ppid === launcherPid, 'the Browser\'s parent is the launcher', `ppid ${started.ppid}, launcher ${launcherPid}, host ${hostPid}`);
check(!descends(browserPid, hostPid, parents()), 'the Browser was not started by the host');
const browserWin = await windowOnScreen(browserPid, 45_000);
check(browserWin.windows.length > 0, 'the Browser\'s window is on screen', browserWin.error ?? JSON.stringify(browserWin.windows));
photograph(`launch-3-browser-${OS}.png`);

// ---------------------------------------------------------------- 4. the three, side by side
step(4, 'the host, the client and the Browser run side by side');
await sleep(5_000);
const after = await wireCall(runtime, 'launcher.status');
if (!after.ok) fail(`launcher.status was not answered after the Browser opened: ${after.reason}`);
check(Number(after.value.host?.pid) === hostPid && alive(hostPid), 'the host is the same pid, alive', `before ${hostPid}, after ${after.value.host?.pid}`);
check(alive(clientPid) && (after.value.clients ?? []).map(Number).includes(clientPid), 'the client is the same pid, alive and attached', `pid ${clientPid}, attached ${JSON.stringify(after.value.clients)}`);
check(alive(browserPid), 'the Browser is still running', `pid ${browserPid}`);
const winsNow = windowsOf(browserPid);
check(winsNow.windows.length > 0 && windowsOf(clientPid).windows.length > 0, 'the client\'s and the Browser\'s windows are both on screen');
photograph(`launch-4-side-by-side-${OS}.png`);

if (run.failures.length) fail(run.failures.join('; '));
console.log(`### launcher-launch=PASS the launcher's host (pid ${hostPid}) from ${join(code, 'host', build)}, a client window (pid ${clientPid}) attached to it from ${join(code, 'client', build)}, and the Genie Browser (pid ${browserPid}, parent the launcher ${launcherPid}) opened from the tray's item with its window on screen; the host and the client unchanged`);
