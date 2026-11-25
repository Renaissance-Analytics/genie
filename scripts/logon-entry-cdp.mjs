#!/usr/bin/env node
/**
 * LOGON START, READ AT THE OS (the host split P6-3; Tynn #1036, task #1501). src/core/logon.ts decides whether Genie starts
 * at logon, src/main/tray-residence.ts writes it, and their unit tests use ports. This drives a PACKAGED Genie (a
 * development run is never registered: core/tray-resident.ts loginItemPlan) and reads back what it really wrote:
 *
 *   Windows  the value under HKCU\Software\Microsoft\Windows\CurrentVersion\Run whose data names the packaged exe, and its
 *            StartupApproved\Run flag (02 enabled, 03 switched off in Task Manager), with `reg query`;
 *   Linux    $XDG_CONFIG_HOME/autostart/genie.desktop: its Exec and Hidden lines, and what systemd's own reader
 *            (systemd-xdg-autostart-generator, which uwsm's session start runs) makes of it.
 *
 *   node scripts/logon-entry-cdp.mjs table             the gate row (`logon` in linux.sh and windows.ps1)
 *   node scripts/logon-entry-cdp.mjs arm on|off        set the setting (and start minimised), then Shut down everything
 *   node scripts/logon-entry-cdp.mjs after-logon start|none    after a real logon: Genie came back hidden, or stayed down
 *   node scripts/logon-entry-cdp.mjs apply-break <name>        a source break probe, before the build (see BREAKS)
 *
 * LOGON_APP names the packaged app: Genie.exe on Windows, the AppImage (or linux-unpacked/genie) on Linux.
 *
 * TABLE (a home of its own: HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME; HKCU is the machine's, and the row
 * takes its value away again whatever happens):
 *   1. at boot, with the setting off and the mark absent, there is no entry;
 *   2. live: the setting on → the entry appears (no --hidden); start minimised on → --hidden; off → gone again; the setting
 *      off → the entry goes. After every switch the window process and genie-host are the same pids: nothing restarted;
 *   3. the four cases of core/logon.ts, by the tray's own items (main.ts's probe, GENIE_TRAY_PROBE=1):
 *        left running + setting off   Just close the UI → the entry is there, --hidden; Open Genie → gone
 *        left running + setting on    Just close the UI → --hidden; Open Genie → there, no --hidden
 *        shut down + setting on       Shut down everything → Genie ends, the entry stays
 *        shut down + setting off      Shut down everything → Genie ends, no entry
 *   The window that was shown at launch is found by the same window gauge the real logon uses (a positive control).
 *
 * BREAKS (logon-break.txt or LOGON_BREAK): apply-break patches the source before the build and writes the file:
 *   no-follow     the setting's change is not applied: 2 must fail on "switching the setting on wrote the entry"
 *   mark-ignored  the left-running mark is not followed: 3 must fail on "left running + setting off"
 * The logon probes (no-entry, stale-entry) are the wrappers' (vm-logon-linux.sh, vm-logon-windows.ps1): they change the
 * entry just before the logon.
 *
 * SAFETY: it launches Genie, so only on a test machine (GENIE_TEST_MACHINE=1, or the test VMs' user `genie`).
 * Exit: 0 every check passed; 1 a check failed; 2 cannot run here.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { mainWindow } from './cdp-main-window.mjs';

const T0 = Date.now();
const since = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;
const WIN = process.platform === 'win32';
const HIDDEN = '--hidden';
const PORT = Number(process.env.LOGON_CDP_PORT ?? 9420);
const INSPECT = Number(process.env.LOGON_INSPECT ?? 9421);
const SYNC_MS = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function step(what) { console.log(`[${since()}] ${what}`); }
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
    return ok;
}
function refuse(why) { console.log(`### logon=CANNOT-RUN ${why}`); process.exit(2); }

const BREAKS = {
    'no-follow': {
        file: 'src/main/tray-residence.ts',
        anchor: "        safely('applying the change', () => applyLoginItem(port, planFor(env, settings.snapshot(), left())));",
        replace: '        void 0; // P6-3 BREAK PROBE no-follow: a change of the setting is not applied',
        red: 'switching the setting on wrote the entry',
    },
    'mark-ignored': {
        file: 'src/main/tray-residence.ts',
        anchor: "    leftRunning?.onChange(() => safely('applying the mark', () => applyLoginItem(port, planFor(env, settings.snapshot(), left()))));",
        replace: '    // P6-3 BREAK PROBE mark-ignored: the left-running mark is not followed',
        red: 'left running + setting off',
    },
};

const [mode = 'table', arg = ''] = process.argv.slice(2);
const breakName = process.env.LOGON_BREAK || (existsSync('logon-break.txt') ? readFileSync('logon-break.txt', 'utf8').trim() : '');

if (mode === 'apply-break') {
    const b = BREAKS[arg];
    if (!b) refuse(`no such source break probe: '${arg}' (${Object.keys(BREAKS).join(', ')})`);
    const text = readFileSync(b.file, 'utf8');
    const n = text.split(b.anchor).length - 1;
    if (n !== 1) refuse(`the probe's line is in ${b.file} ${n} times, not once: it would patch nothing`);
    writeFileSync(b.file, text.replace(b.anchor, b.replace));
    writeFileSync('logon-break.txt', `${arg}\n`);
    console.log(`BREAK PROBE ${arg} applied to ${b.file}; the row must go red on: ${b.red}`);
    process.exit(0);
}

const user = process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? '';
if (!(process.env.GENIE_TEST_MACHINE === '1' || user === 'genie')) refuse(`it launches Genie, so only on a test machine (GENIE_TEST_MACHINE=1 or user genie); user is "${user}"`);
const APP = process.env.LOGON_APP ? resolve(process.env.LOGON_APP) : '';
if (!APP || !existsSync(APP)) refuse(`LOGON_APP must name the packaged Genie (got '${process.env.LOGON_APP ?? ''}')`);
if (breakName) console.log(`BREAK PROBE asked: ${breakName}${BREAKS[breakName] ? ` (the run must go red on: ${BREAKS[breakName].red})` : ''}`);

// ---------------------------------------------------------------- a home of its own (table) or the person's (the real logon)
if (mode === 'table') {
    const root = mkdtempSync(join(tmpdir(), 'genie-logon-home-'));
    const env = { HOME: root, USERPROFILE: root, APPDATA: join(root, 'AppData', 'Roaming'), LOCALAPPDATA: join(root, 'AppData', 'Local'), XDG_CONFIG_HOME: join(root, '.config') };
    for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME]) mkdirSync(dir, { recursive: true });
    Object.assign(process.env, env);
    delete process.env.GENIE_HOME;
    step(`a home of its own: ${root}`);
}
process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
const HOME = homedir();
const GENIE_HOME = join(process.env.HOME && !WIN ? process.env.HOME : (process.env.USERPROFILE ?? HOME), '.genie');
const HOST_RECORD = join(GENIE_HOME, 'runtime', 'host.json');
const MARK = join(GENIE_HOME, 'runtime', 'left-running');
const configHome = () => (process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0 ? process.env.XDG_CONFIG_HOME : join(process.env.HOME ?? HOME, '.config'));
const OUT = resolve(process.env.LOGON_OUT ?? join('ci-out', 'logon'));
mkdirSync(OUT, { recursive: true });

function seed() {
    const workspace = mkdtempSync(join(tmpdir(), 'genie-logon-workspace-'));
    const r = spawnSync(process.execPath, [resolve('scripts', 'smoke-seed.mjs')], { cwd: workspace, encoding: 'utf8', timeout: 60_000, env: process.env, windowsHide: true });
    if (r.status !== 0) refuse(`the seed failed (exit ${r.status}): ${String(r.stderr ?? '').trim().slice(0, 300)}`);
}

// ---------------------------------------------------------------- the OS entry, as the OS keeps it
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
function regValues(key) {
    let out = '';
    try { out = execFileSync('reg', ['query', key], { encoding: 'utf8', timeout: SYNC_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return []; }
    return out.split(/\r?\n/).map((l) => /^ {4}(.+?) {4}(REG_\w+) {4}(.*)$/.exec(l)).filter(Boolean).map((m) => ({ name: m[1], type: m[2], data: m[3] }));
}
/** The entry Genie wrote, read back: present, its arguments, and the words to print. */
function entry() {
    if (WIN) {
        const exe = APP.toLowerCase();
        const v = regValues(RUN_KEY).find((x) => x.data.toLowerCase().includes(exe));
        if (!v) return { present: false, hidden: false, words: `no value under ${RUN_KEY} names ${APP}` };
        const approved = regValues(APPROVED_KEY).find((x) => x.name === v.name);
        const enabled = !approved || /^0?2/.test(approved.data);
        return { present: enabled, hidden: v.data.split(/\s+/).includes(HIDDEN), name: v.name, words: `${RUN_KEY}\\${v.name} = ${v.data}; StartupApproved: ${approved ? approved.data.slice(0, 8) : '(none: enabled)'}` };
    }
    const file = join(configHome(), 'autostart', 'genie.desktop');
    if (!existsSync(file)) return { present: false, hidden: false, words: `no ${file}` };
    const text = readFileSync(file, 'utf8');
    const exec = /^Exec=(.*)$/m.exec(text)?.[1] ?? '';
    const hiddenLine = /^Hidden=(.*)$/m.exec(text)?.[1] ?? '(none)';
    const target = process.env.LOGON_APPIMAGE || APP;
    const names = exec.includes(target);
    return { present: hiddenLine !== 'true' && names, hidden: exec.split(/\s+/).includes(HIDDEN), words: `${file}: Exec=${exec} | Hidden=${hiddenLine}${names ? '' : ` (Exec does not name ${target})`}`, exec };
}
/** Linux: what systemd's own xdg-autostart reader makes of the autostart folder: the unit it would start at the session's start. */
function systemdReads() {
    const gen = ['/usr/lib/systemd/user-generators/systemd-xdg-autostart-generator', '/lib/systemd/user-generators/systemd-xdg-autostart-generator'].find((p) => existsSync(p));
    if (!gen) return { unit: null, words: 'systemd-xdg-autostart-generator is not on this machine' };
    const out = mkdtempSync(join(tmpdir(), 'genie-xdg-gen-'));
    spawnSync(gen, [out, out, out], { encoding: 'utf8', timeout: SYNC_MS, env: process.env });
    const unitFile = join(out, 'app-genie@autostart.service');
    const unit = existsSync(unitFile) ? readFileSync(unitFile, 'utf8') : null;
    const execStart = unit ? (/^ExecStart=(.*)$/m.exec(unit)?.[1] ?? '') : '';
    rmSync(out, { recursive: true, force: true });
    return { unit, execStart, words: unit ? `systemd would start app-genie@autostart.service: ExecStart=${execStart}` : 'systemd makes no app-genie@autostart.service of it' };
}
function readEntry(label) {
    const e = entry();
    console.log(`  entry (${label}): ${e.words}`);
    if (!WIN) { const s = systemdReads(); console.log(`  ${s.words}`); e.systemd = s; }
    return e;
}
async function entryUntil(want, label, ms = 20_000) {
    const end = Date.now() + ms;
    let e = entry();
    while (Date.now() < end && !want(e)) { await sleep(500); e = entry(); }
    return readEntry(label);
}

// ---------------------------------------------------------------- processes and windows, the OS's word
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const hostPid = () => { try { return JSON.parse(readFileSync(HOST_RECORD, 'utf8')).pid ?? null; } catch { return null; } };
function winTable() {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)|$($_.CommandLine)" }';
    try {
        return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
            .split(/\r?\n/).map((l) => l.split('|')).filter((p) => p.length >= 3 && Number(p[0]) > 0).map((p) => ({ pid: Number(p[0]), exe: p[1], cmd: p.slice(2).join('|') }));
    } catch { return []; }
}
/** Every process of the packaged Genie: from its install (or AppImage mount), and genie-host from its copy under ~/.genie/host. */
function genieProcesses() {
    if (WIN) {
        const dir = dirname(APP).toLowerCase();
        const hostDir = join(GENIE_HOME, 'host').toLowerCase();
        return winTable().filter((p) => p.exe && (p.exe.toLowerCase().startsWith(dir) || p.exe.toLowerCase().startsWith(hostDir)));
    }
    const out = [];
    for (const d of readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        let exe = '';
        let cmd = '';
        try { exe = readlinkSync(`/proc/${d}/exe`); } catch { continue; }
        try { cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch { /* gone */ }
        const appImage = process.env.LOGON_APPIMAGE || APP;
        if (exe.startsWith('/tmp/.mount_') || exe.startsWith('/tmp/appimage_extracted_') || exe.startsWith(join(GENIE_HOME, 'host')) || exe.startsWith(dirname(APP)) || cmd.startsWith(appImage)) out.push({ pid: Number(d), exe, cmd });
    }
    return out;
}
/** The window process: the packaged exe itself, not one of its helpers (--type=). */
const windowProcess = (procs) => procs.find((p) => !/--type=/.test(p.cmd) && (WIN ? p.exe.toLowerCase() === APP.toLowerCase() : !p.exe.startsWith(join(GENIE_HOME, 'host')) && /\/(genie|Genie)$/.test(p.exe)));
/**
 * The visible top-level windows of these pids, as the desktop shows them (Windows: EnumWindows; Linux: Hyprland's clients).
 * Windows: what the callback writes is collected, never written: a script block run as a delegate has no pipeline, so its
 * Write-Output went nowhere and the control read the shown window as none (item 1125-025900-274bb7, 1c).
 */
function shownWindows(pids) {
    if (pids.length === 0) return [];
    if (WIN) {
        const ps = `Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class GenieWins {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$want = @(${pids.join(',')})
$found = New-Object System.Collections.Generic.List[string]
[void][GenieWins]::EnumWindows({ param($h, $l) $p = 0; [void][GenieWins]::GetWindowThreadProcessId($h, [ref]$p); if ($want -contains [int]$p -and [GenieWins]::IsWindowVisible($h)) { $s = New-Object System.Text.StringBuilder 256; [void][GenieWins]::GetWindowText($h, $s, 256); if ($s.Length -gt 0) { $found.Add("$p|$s") } }; $true }, [IntPtr]::Zero)
$found`;
        try {
            const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
            return out.split(/\r?\n/).filter((l) => l.includes('|')).map((l) => ({ pid: Number(l.slice(0, l.indexOf('|'))), title: l.slice(l.indexOf('|') + 1) }));
        } catch (e) { return [{ pid: 0, title: `(could not be read: ${String(e.message).slice(0, 120)})` }]; }
    }
    try {
        const clients = JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8', timeout: SYNC_MS }));
        return clients.filter((c) => pids.includes(c.pid) && c.mapped !== false && c.hidden !== true).map((c) => ({ pid: c.pid, title: c.title }));
    } catch (e) { return [{ pid: 0, title: `(could not be read: ${String(e.message).slice(0, 120)})` }]; }
}
function noWindowShown(procs) {
    const shown = shownWindows(procs.map((p) => p.pid));
    return { none: shown.length === 0, words: shown.length === 0 ? 'no window of Genie is shown' : `shown: ${shown.map((w) => `${w.pid} "${w.title}"`).join(', ')}` };
}

// ---------------------------------------------------------------- CDP (the page) and the inspector (the window's main)
async function until(what, ms, interval = 500) {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
        try { last = await what(); } catch { last = null; }
        if (last) return last;
        await sleep(interval);
    }
    return last;
}
async function target(port, kind, ms) {
    const t = await until(async () => {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json();
        return kind === 'page' ? mainWindow(list) : list.find((x) => x.webSocketDebuggerUrl);
    }, ms);
    if (!t) throw new Error(`no ${kind} on port ${port} within ${ms / 1000} s`);
    return t;
}
class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect(url) {
        const c = new Cdp();
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (typeof r === 'function') { c.#pending.delete(f.id); r(f); } });
        c.#ws.addEventListener('close', () => { for (const r of c.#pending.values()) r({ error: { message: 'socket closed' } }); c.#pending.clear(); });
        await new Promise((res, rej) => { c.#ws.addEventListener('open', res, { once: true }); c.#ws.addEventListener('error', () => rej(new Error('socket error')), { once: true }); setTimeout(() => rej(new Error('socket did not open in 15 s')), 15_000); });
        return c;
    }
    async evaluate(expression, ms = 30_000) {
        const id = this.#id++;
        const f = await Promise.race([new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); }), sleep(ms).then(() => ({ error: { message: `no answer in ${ms / 1000} s` } }))]);
        this.#pending.delete(id);
        if (f.error) throw new Error(f.error.message);
        if (f.result.exceptionDetails) throw new Error(f.result.exceptionDetails.exception?.description ?? f.result.exceptionDetails.text);
        return f.result.result.value;
    }
    async close() {
        if (this.#ws.readyState === WebSocket.CLOSED) return;
        const done = new Promise((r) => this.#ws.addEventListener('close', r, { once: true }));
        this.#ws.close();
        await Promise.race([done, sleep(5_000)]);
    }
}

let app = null;
function launch(label) {
    const log = join(OUT, `logon-${label}.log`);
    const out = openSync(log, 'a');
    const argv = [`--inspect=${INSPECT}`, `--remote-debugging-port=${PORT}`];
    // GENIE_TRAY_PROBE: main.ts's read-only tray probe; GENIE_PAGE_PROBE: the page's window.genieTest (features.act), as the rows' launches.
    const child = spawn(APP, argv, { detached: !WIN, stdio: ['ignore', out, out], windowsHide: false, env: { ...process.env, GENIE_TRAY_PROBE: '1', GENIE_PAGE_PROBE: '1' } });
    let gone = false;
    const exited = new Promise((r) => child.once('exit', (code, signal) => { gone = true; r({ code, signal }); }));
    child.once('error', () => { gone = true; });
    step(`launched ${APP} (${label}) pid ${child.pid} → ${log}`);
    app = { pid: child.pid, log, exited, get gone() { return gone; } };
    return app;
}
async function open(label) {
    launch(label);
    const launched = Date.now();
    const page = await target(PORT, 'page', 120_000);
    // The main window is built after the window's settings are said or the boot deadline (10 s) has passed (main.ts): how long it took says which.
    step(`the main window's page after ${((Date.now() - launched) / 1000).toFixed(1)} s`);
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    if (await until(() => cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"', 5_000), 60_000) !== true) throw new Error('window.genie never appeared');
    const inspector = await Cdp.connect((await target(INSPECT, 'node', 30_000)).webSocketDebuggerUrl);
    const windowPid = await inspector.evaluate('process.pid', 10_000);
    const host = await until(() => { const p = hostPid(); return alive(p) ? p : null; }, 90_000);
    step(`window process ${windowPid}, genie-host ${host}`);
    return { cdp, inspector, windowPid, host };
}
const setSetting = (s, key, value) => s.cdp.evaluate(`(window.genieTest ?? window.genie).features.act({ kind: 'settings.set', key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} }).then(() => true)`, 15_000);
async function samePids(s, label) {
    const w = await s.inspector.evaluate('process.pid', 10_000).catch(() => null);
    const h = hostPid();
    return check(w === s.windowPid && h === s.host && alive(h), `${label}: nothing restarted`, `window ${w} (was ${s.windowPid}), genie-host ${h} (was ${s.host})`);
}
const windowsIn = (s) => s.inspector.evaluate(`(() => { const r = process.getBuiltinModule('node:module').createRequire(process.execPath); return r('electron').BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length; })()`, 10_000);
const trayClick = (s, label, delayMs) => s.inspector.evaluate(`(() => {
    const t = globalThis[Symbol.for('genie.tray')];
    if (!t) return 'no tray probe in this build';
    if (!t.labels().includes(${JSON.stringify(label)})) return 'the tray offers no ' + ${JSON.stringify(label)} + ': ' + JSON.stringify(t.labels());
    setTimeout(() => t.click(${JSON.stringify(label)}), ${delayMs});
    return 'ok';
})()`, 10_000).catch((e) => String(e?.message ?? e));
/** The person's answer to the next native question (the tray's confirm), and nothing else. */
const answerNextDialog = (s, index) => s.inspector.evaluate(`(() => {
    const { dialog } = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron');
    const real = dialog.showMessageBoxSync;
    dialog.showMessageBoxSync = (...args) => { dialog.showMessageBoxSync = real; return ${index}; };
    return 'ok';
})()`, 10_000).catch((e) => String(e?.message ?? e));
async function reopenedPage(s) {
    const page = await target(PORT, 'page', 60_000);
    s.cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    if (await until(() => s.cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"', 5_000), 60_000) !== true) throw new Error('window.genie never appeared after Open Genie');
}
/** Shut down everything from the tray, confirmed; the sessions let go first. True when the window process and genie-host ended. */
async function shutDown(s, label) {
    check(await answerNextDialog(s, 1) === 'ok', `${label}: the tray's confirm will be answered Shut down everything`);
    check(await trayClick(s, 'Shut down everything', 1_000) === 'ok', `${label}: the tray's Shut down everything was clicked`);
    await s.cdp?.close();
    await s.inspector.close();
    const ended = await Promise.race([app.exited.then(() => true), sleep(150_000).then(() => false)]);
    const hostGone = await until(() => !alive(s.host), 60_000);
    return check(ended && hostGone === true, `${label}: the window process and genie-host ended`, `window ${ended ? 'exited' : 'STILL RUNNING'}, genie-host ${s.host} ${hostGone ? 'gone' : 'STILL RUNNING'}`);
}

async function cleanup() {
    const procs = genieProcesses();
    if (WIN) {
        try {
            const { endOwnRun } = await import('./end-own-tree.mjs');
            if (procs.length > 0) await endOwnRun({ app: app && !app.gone ? app : null, hostPid: hostPid(), others: procs.map((p) => p.pid), since: T0, log: () => {} });
        } catch (e) { console.log(`  cleanup: ${e.message}`); }
    } else {
        for (const p of procs) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    }
}

// ---------------------------------------------------------------- the modes
async function table() {
    seed();
    const before = readEntry('before Genie ran');
    check(!before.present, '0. there is no entry before Genie runs', before.words);

    let s = await open('a');
    const boot = await entryUntil(() => true, 'at boot, setting off, not left running', 5_000);
    check(!boot.present, '1. at boot with the setting off and the mark absent there is no entry', boot.words);
    const shown = noWindowShown(genieProcesses());
    check(!shown.none, '1c. CONTROL: the window gauge finds the window a launch shows', shown.words);

    step('2. switching the setting live');
    await setSetting(s, 'launch_at_login', true);
    let e = await entryUntil((x) => x.present, 'setting on');
    check(e.present && !e.hidden, `2a. switching the setting on wrote the entry, without ${HIDDEN}`, e.words);
    if (!WIN) check(Boolean(e.systemd?.execStart?.includes(process.env.LOGON_APPIMAGE || APP)), '2a-systemd. systemd would start it at the session start', e.systemd?.words);
    await samePids(s, '2a');
    await setSetting(s, 'start_minimized', true);
    e = await entryUntil((x) => x.hidden, 'start minimised on');
    check(e.present && e.hidden, `2b. start minimised on: the entry starts it with ${HIDDEN}`, e.words);
    await samePids(s, '2b');
    await setSetting(s, 'start_minimized', false);
    e = await entryUntil((x) => !x.hidden, 'start minimised off');
    check(e.present && !e.hidden, `2c. start minimised off: ${HIDDEN} is gone`, e.words);
    await setSetting(s, 'launch_at_login', false);
    e = await entryUntil((x) => !x.present, 'setting off');
    check(!e.present, '2d. switching the setting off removed the entry', e.words);
    if (!WIN) check(e.systemd?.unit === null, '2d-systemd. systemd would start nothing', e.systemd?.words);
    await samePids(s, '2d');

    step('3. the four logon cases');
    for (const [setting, label] of [[false, 'left running + setting off'], [true, 'left running + setting on']]) {
        await setSetting(s, 'launch_at_login', setting);
        await entryUntil((x) => x.present === setting && !x.hidden, `${label}: before`);
        check(await trayClick(s, 'Just close the UI', 500) === 'ok', `${label}: the tray's Just close the UI was clicked`);
        await s.cdp.close();
        const closed = await until(async () => (await windowsIn(s)) === 0, 20_000);
        check(closed === true && existsSync(MARK), `${label}: every window closed, the window process stays, the mark is written`, `mark ${existsSync(MARK) ? 'present' : 'ABSENT'} at ${MARK}`);
        e = await entryUntil((x) => x.present && x.hidden, `${label}: UI closed`);
        check(e.present && e.hidden, `3. ${label}: the entry starts it at logon, ${HIDDEN} (start)`, e.words);
        await samePids(s, label);
        check(await trayClick(s, 'Open Genie', 0) === 'ok', `${label}: the tray's Open Genie was clicked`);
        await reopenedPage(s);
        e = await entryUntil((x) => x.present === setting && !x.hidden, `${label}: Genie opened again`);
        check(!existsSync(MARK) && e.present === setting && !e.hidden, `${label}: opened again, the mark is gone and the entry is the setting's again`, e.words);
        await samePids(s, `${label}, opened again`);
    }
    await setSetting(s, 'launch_at_login', true);
    await entryUntil((x) => x.present, 'shut down + setting on: before');
    if (await shutDown(s, 'shut down + setting on')) {
        e = readEntry('shut down + setting on: after');
        check(e.present && !existsSync(MARK), '3. shut down + setting on: the entry stays, so it starts at logon (start)', e.words);
    }
    s = await open('b');
    e = await entryUntil((x) => x.present, 'relaunched, setting on');
    check(e.present, '3b. a relaunch with the setting on keeps the entry', e.words);
    await setSetting(s, 'launch_at_login', false);
    await entryUntil((x) => !x.present, 'shut down + setting off: before');
    if (await shutDown(s, 'shut down + setting off')) {
        e = readEntry('shut down + setting off: after');
        check(!e.present && !existsSync(MARK), '3. shut down + setting off: no entry, so it stays down (stays down)', e.words);
    }
}

async function arm(on) {
    seed();
    const s = await open(`arm-${on ? 'on' : 'off'}`);
    await setSetting(s, 'start_minimized', true);
    await setSetting(s, 'launch_at_login', on);
    const e = await entryUntil((x) => x.present === on && (!on || x.hidden), `armed ${on ? 'on' : 'off'}`);
    check(e.present === on && (!on || e.hidden), `arm: the setting ${on ? 'on' : 'off'} (start minimised on): the entry is ${on ? `there, ${HIDDEN}` : 'absent'}`, e.words);
    if (await shutDown(s, 'arm')) {
        const after = readEntry('after Shut down everything');
        check(after.present === on && !existsSync(MARK), `arm: after Shut down everything the entry is ${on ? 'there' : 'absent'} and nothing is left running`, after.words);
        const left = genieProcesses();
        check(left.length === 0, 'arm: no Genie process is left', left.map((p) => `${p.pid} ${p.exe}`).join('; '));
    }
}

async function afterLogon(expect) {
    readEntry('at logon');
    if (expect === 'start') {
        const found = await until(() => { const p = genieProcesses(); const w = windowProcess(p); return w && alive(hostPid()) ? p : null; }, 240_000, 2_000);
        const procs = found ?? genieProcesses();
        const w = windowProcess(procs);
        check(Boolean(found), 'after-logon: Genie started at logon, and genie-host is up', `window process ${w ? `${w.pid}: ${w.cmd}` : 'NONE'}; genie-host ${hostPid() ?? 'none'} ${alive(hostPid()) ? 'alive' : 'NOT alive'}`);
        if (found) {
            check(w.cmd.split(/\s+/).includes(HIDDEN), `after-logon: it was started with ${HIDDEN}, as the entry says`, w.cmd);
            await sleep(15_000);
            const shown = noWindowShown(genieProcesses());
            check(shown.none, 'after-logon: it came back minimised: no window shown', shown.words);
        }
    } else if (expect === 'none') {
        // The same gauge the start case finds Genie with; given the time a logon start takes there (up to 240 s), and more.
        await sleep(150_000);
        const procs = genieProcesses();
        check(procs.length === 0, 'after-logon: Genie stayed down: no Genie process', procs.map((p) => `${p.pid} ${p.cmd.slice(0, 160)}`).join('; ') || 'none');
    } else refuse(`after-logon start|none, not '${expect}'`);
}

let code = 0;
try {
    if (mode === 'table') await table();
    else if (mode === 'arm') await arm(arg === 'on');
    else if (mode === 'after-logon') await afterLogon(arg);
    else refuse(`no such mode: ${mode}`);
} catch (error) {
    check(false, `the run did not finish: ${String(error?.message ?? error).slice(0, 300)}`);
} finally {
    if (mode === 'table') {
        await cleanup();
        // HKCU is the machine's: whatever the run left there goes.
        if (WIN) for (const v of regValues(RUN_KEY).filter((x) => x.data.toLowerCase().includes(APP.toLowerCase()))) spawnSync('reg', ['delete', RUN_KEY, '/v', v.name, '/f'], { timeout: SYNC_MS, windowsHide: true });
    }
    code = failures.length === 0 ? 0 : 1;
    console.log(`### logon-${mode}${arg ? ` ${arg}` : ''}=${code === 0 ? 'PASS' : `FAIL ${failures.join(' | ')}`}`);
}
process.exit(code);
