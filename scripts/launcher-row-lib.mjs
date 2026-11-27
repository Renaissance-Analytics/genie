/**
 * WHAT THE LAUNCHER'S VM ROWS SHARE (Tynn #1058). The helpers scripts/quit-keeps-host-cdp.mjs (L5) grew, taken out so the
 * L6 update rows (scripts/launcher-updates-row.mjs) use the same ones: the step lines and PASS/FAIL checks, every wait
 * bounded, the process table read from the OS, the screen photographed as the person sees it, the Linux tray's menu opened
 * with a pointer, Genie's page and its debugger, the ticker agents' ledgers, and the launcher's control wire spoken from
 * Node. quit-keeps-host-cdp.mjs keeps its own copies for now; it can import these once it is next changed.
 *
 * Nothing here launches anything by itself: every function is called by a row that has already refused to run off a test
 * machine (`testMachineOrRefuse`).
 */
import { mainWindow } from './cdp-main-window.mjs';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

export const WIN = process.platform === 'win32';
export const OS = WIN ? 'windows' : 'linux';
/** Bounds for the process calls a row makes synchronously: none may block a run. */
export const SYNC_MS = 15_000;

// ---------------------------------------------------------------- the run: its clock, its steps, its checks
/** What the row is doing and what has failed: one per process. `name` heads the refusal and the verdict lines. */
export const run = { t0: Date.now(), current: 'start', failures: [], name: 'launcher-row', out: process.cwd() };
export const since = () => `${((Date.now() - run.t0) / 1000).toFixed(1)}s`;
/** Every step names itself BEFORE it acts: a hang always says where it stopped. */
export function step(id, what) {
    run.current = `${id} ${what}`;
    console.log(`[${since()}] step ${id}: ${what}`);
}
export function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) run.failures.push(label);
    return ok;
}
/** Cannot run here: said, and exit 2. */
export function refuse(why) {
    console.error(`${run.name}: CANNOT RUN — ${why}`);
    process.exit(2);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** `p`, or a rejection naming what missed its deadline. */
export function within(ms, what, p) {
    let t;
    return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`deadline: ${what} did not answer within ${Math.round(ms / 1000)} s`)), ms); })])
        .finally(() => clearTimeout(t));
}
/** Retry `what` (each attempt bounded too) until it answers truthy or `ms` runs out; the last value either way. */
export async function until(what, ms, interval = 500) {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
        try { last = await within(Math.max(1_000, Math.min(15_000, end - Date.now())), 'an attempt', Promise.resolve().then(what)); } catch { last = null; }
        if (last) return last;
        await sleep(interval);
    }
    return last;
}
export const readOr = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
export const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** It launches Electron and real hosts, so it runs only on a test machine; anywhere else it refuses (exit 2). */
export function testMachineOrRefuse(allowVar) {
    const user = process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? '';
    const ok = process.env.CI === 'true' || process.env.GENIE_TEST_MACHINE === '1' || process.env[allowVar] === '1' || (process.platform === 'linux' && user === 'genie');
    if (!ok) refuse(`it launches Electron and real hosts, so it runs only on a test machine (CI, GENIE_TEST_MACHINE=1, the test VM as user \`genie\`, or ${allowVar}=1); user is "${user}"`);
}

/**
 * A HOME OF ITS OWN: a new directory is HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME and XDG_DATA_HOME for
 * the row and everything it starts (the launcher's desktop entry and ~/.local/bin/genie land in it, never the VM user's),
 * and smoke-seed.mjs writes its workspace in a fresh folder there (the seed takes its cwd, and must never take the
 * checkout's). Node's own directory goes first on PATH, so the stub provider's `#!/usr/bin/env node` finds node without a
 * shim that reads the real home. A seed that fails is "cannot run here", said with its words.
 */
export function ownHome(prefix) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const env = { HOME: root, USERPROFILE: root, APPDATA: join(root, 'AppData', 'Roaming'), LOCALAPPDATA: join(root, 'AppData', 'Local'), XDG_CONFIG_HOME: join(root, '.config'), XDG_DATA_HOME: join(root, '.local', 'share') };
    for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME]) mkdirSync(dir, { recursive: true });
    Object.assign(process.env, env);
    delete process.env.GENIE_HOME;
    process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const seeded = spawnSync(process.execPath, [resolve('scripts', 'smoke-seed.mjs')], { cwd: workspace, encoding: 'utf8', timeout: 60_000, env: process.env, windowsHide: true });
    if (seeded.status !== 0) refuse(`the seed could not be written in ${root} (exit ${seeded.status}${seeded.error ? `, ${seeded.error.message}` : ''}): ${String(`${seeded.stderr ?? ''}\n${seeded.stdout ?? ''}`).trim().split(/\r?\n/).filter((l) => /\S/.test(l) && !/^\s+at /.test(l)).slice(0, 6).join(' | ')}`);
    console.log(`  ${String(seeded.stdout ?? '').trim()}`);
    return root;
}

// ---------------------------------------------------------------- the process table (the OS's word, not Genie's)
export function alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
let table = null;
/** ONE read of every process's command line on Windows, kept for a minute (a single read has taken over 30 s on a loaded VM). */
function readTable() {
    const started = Date.now();
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }';
    try {
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
        const lines = new Map();
        for (const line of out.split(/\r?\n/)) { const i = line.indexOf('|'); if (i > 0 && line.slice(i + 1).trim()) lines.set(Number(line.slice(0, i)), line.slice(i + 1).trim()); }
        console.log(`  (the process table: ${lines.size} command lines in ${Math.round((Date.now() - started) / 1000)} s)`);
        return { at: Date.now(), lines, error: null };
    } catch (error) {
        return { at: Date.now(), lines: new Map(), error: error.code === 'ETIMEDOUT' ? 'PowerShell took over 120 s' : String(error.message).slice(0, 120) };
    }
}
/** A process's command line, or why it could not be read: never an empty string that reads as "not that program". */
export function commandLine(pid) {
    if (!WIN) {
        try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch (error) { return `(unread: ${error.code ?? error.message})`; }
    }
    if (!table || Date.now() - table.at > 60_000 || !table.lines.has(Number(pid))) table = readTable();
    return table.lines.get(Number(pid)) ?? `(unread: ${table.error ?? 'not in the process table'})`;
}
/** The program a process runs, by its path (Linux: /proc/<pid>/exe; Windows: its ExecutablePath), or why it is unread. */
export function executableOf(pid) {
    if (!WIN) { try { return execFileSync('readlink', ['-f', `/proc/${pid}/exe`], { encoding: 'utf8', timeout: SYNC_MS }).trim(); } catch (e) { return `(unread: ${e.message.slice(0, 80)})`; } }
    try {
        return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ExecutablePath`], { encoding: 'utf8', timeout: 60_000, windowsHide: true }).trim() || '(unread: no such process)';
    } catch (e) { return `(unread: ${String(e.message).slice(0, 80)})`; }
}
const execAsync = (file, args, options) => new Promise((resolveIt) => { execFile(file, args, options, (error, stdout) => resolveIt({ error, stdout: String(stdout ?? '') })); });
/**
 * Every live process whose command line holds `needle`, as `{pid, ppid, key}`, where `key` is `pid@<its start>`: a pid the
 * OS reused for another process is another key. Linux reads /proc; Windows one filtered CIM query (asynchronous, so the
 * row's other waits keep running), which leaves out PowerShell itself (its own command line holds the needle).
 */
export async function processesNamed(needle) {
    if (!WIN) {
        const out = [];
        for (const name of readdirSync('/proc')) {
            if (!/^\d+$/.test(name)) continue;
            let cmd = '';
            try { cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8'); } catch { continue; }
            if (!cmd.includes(needle)) continue;
            const stat = readOr(`/proc/${name}/stat`);
            const rest = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
            if (rest.length < 20) continue;
            out.push({ pid: Number(name), ppid: Number(rest[1]), key: `${name}@${rest[19]}` });
        }
        return out;
    }
    const script = `Get-CimInstance Win32_Process -Filter "Name <> 'powershell.exe' AND CommandLine LIKE '%${needle}%'" | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.ToFileTimeUtc())" }`;
    const r = await execAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    if (r.error) return null;
    return r.stdout.split(/\r?\n/).map((l) => l.trim().split('|')).filter((p) => p.length === 3 && /^\d+$/.test(p[0])).map(([pid, ppid, start]) => ({ pid: Number(pid), ppid: Number(ppid), key: `${pid}@${start}` }));
}
/** Every process's parent, now: pid -> ppid (Linux /proc; Windows one CIM read without command lines). */
export function parents() {
    const map = new Map();
    if (!WIN) {
        for (const name of readdirSync('/proc')) {
            if (!/^\d+$/.test(name)) continue;
            const stat = readOr(`/proc/${name}/stat`);
            const rest = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
            if (rest.length > 1) map.set(Number(name), Number(rest[1]));
        }
        return map;
    }
    try {
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)" }'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        for (const line of out.split(/\r?\n/)) { const [p, pp] = line.trim().split('|'); if (/^\d+$/.test(p ?? '') && /^\d+$/.test(pp ?? '')) map.set(Number(p), Number(pp)); }
    } catch { /* an empty map: nothing descends, and the check says so */ }
    return map;
}
/** Whether `pid` is `ancestor` or started under it, by the parent pids (bounded: a chain is never this long). */
export function descends(pid, ancestor, map) {
    let at = pid;
    for (let i = 0; i < 16 && Number.isInteger(at) && at > 1; i++) {
        if (at === ancestor) return true;
        at = map.get(at);
    }
    return false;
}

// ---------------------------------------------------------------- the screen, as the person sees it
/** The whole screen: grim on Linux, the desktop's own copy on Windows (scripts/ci/screenshot.ps1). Says where it went. */
export function shot(name) {
    mkdirSync(run.out, { recursive: true });
    const file = join(run.out, name);
    if (WIN) spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts', 'ci', 'screenshot.ps1'), '-Out', file], { timeout: SYNC_MS, windowsHide: true });
    else spawnSync('grim', [file], { timeout: SYNC_MS });
    console.log(existsSync(file) ? `SCREENSHOT ${file}` : `  no screenshot could be taken: ${file}`);
    return existsSync(file);
}
/** A key, as the person's keyboard sends it to the window in front (wtype on Wayland; SendKeys on Windows). */
export function pressKey(key) {
    if (WIN) spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key === 'Escape' ? '{ESC}' : key}')`], { timeout: SYNC_MS, windowsHide: true });
    else spawnSync('wtype', ['-k', key], { timeout: SYNC_MS });
}
/**
 * THE LINUX TRAY'S MENU, OPENED AS A PERSON OPENS IT (best effort, for a screenshot; quit-keeps-host-cdp.mjs's way):
 * Waybar draws a StatusNotifierItem's menu and only a pointer opens it. Omarchy keeps the tray's icons in a drawer behind
 * its "<": the cursor goes there (Hyprland's dispatch or ydotool, checked with `hyprctl cursorpos`), the bar is read again,
 * and the icon that appeared is right-clicked. Each step says whether it worked; a row never fails on it.
 */
function screenPixels() {
    const r = spawnSync('grim', ['-t', 'ppm', '-'], { maxBuffer: 64 * 1024 * 1024, timeout: SYNC_MS, encoding: 'buffer' });
    if (r.status !== 0 || !r.stdout || r.stdout.length < 16) return null;
    const buf = r.stdout;
    const fields = [];
    let i = 0;
    const space = (b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
    while (fields.length < 4 && i < buf.length) {
        while (space(buf[i])) i++;
        let j = i;
        while (j < buf.length && !space(buf[j])) j++;
        fields.push(buf.subarray(i, j).toString('latin1'));
        i = j;
    }
    if (fields[0] !== 'P6' || fields[3] !== '255') return null;
    return { w: Number(fields[1]), h: Number(fields[2]), px: buf.subarray(i + 1) };
}
function cursorAt() {
    const r = spawnSync('hyprctl', ['-i', '0', 'cursorpos'], { encoding: 'utf8', timeout: SYNC_MS });
    const m = /(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(r.stdout ?? '');
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}
function runsOf(w, from, hit) {
    const out = [];
    for (let x = from; x < w; x++) {
        if (!hit(x)) continue;
        const last = out[out.length - 1];
        if (last && x - last.to <= 3) last.to = x; else out.push({ from: x, to: x });
    }
    return out;
}
const lum = (img, x, y) => { const k = (y * img.w + x) * 3; return (img.px[k] + img.px[k + 1] + img.px[k + 2]) / 3; };
const YDOTOOL_SOCK = '/tmp/genie-ydotool.sock';
let ydotoolUp = false;
function ydotool(args) {
    if (!ydotoolUp) {
        if (spawnSync('sh', ['-c', 'command -v ydotool'], { timeout: SYNC_MS }).status !== 0) {
            spawnSync('sudo', ['-n', 'pacman', '-S', '--needed', '--noconfirm', 'ydotool'], { timeout: 180_000, stdio: 'ignore' });
        }
        const ids = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
        spawn('sudo', ['-n', 'ydotoold', `--socket-path=${YDOTOOL_SOCK}`, `--socket-own=${ids}`], { detached: true, stdio: 'ignore' }).unref();
        spawnSync('sleep', ['1.5']);
        ydotoolUp = true;
    }
    return spawnSync('ydotool', args, { encoding: 'utf8', timeout: SYNC_MS, env: { ...process.env, YDOTOOL_SOCKET: YDOTOOL_SOCK } });
}
function moveCursor(x, y) {
    for (let i = 0; i < 12; i++) {
        const c = cursorAt();
        if (!c) break;
        const dx = Math.round(x - c.x);
        const dy = Math.round(y - c.y);
        if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return `ydotool, ${i} move(s)`;
        const r = ydotool(['mousemove', '-x', String(Math.max(-400, Math.min(400, dx))), '-y', String(Math.max(-400, Math.min(400, dy)))]);
        if (r.status !== 0) { console.log(`  linux tray: ydotool mousemove: ${String(r.stderr ?? '').trim().slice(0, 120)}`); break; }
        spawnSync('sleep', ['0.15']);
    }
    const tries = [
        ['hyprctl', ['-i', '0', 'dispatch', 'movecursor', String(x), String(y)]],
        ['hyprctl', ['-i', '0', 'eval', `hl.dispatch("movecursor", "${x} ${y}")`]],
        ['hyprctl', ['-i', '0', 'eval', `hl.dispatch("movecursor ${x} ${y}")`]],
    ];
    for (const [cmd, args] of tries) {
        const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: SYNC_MS });
        const c = cursorAt();
        if (c && Math.abs(c.x - x) <= 3 && Math.abs(c.y - y) <= 3) return args.slice(2).join(' ');
        console.log(`  linux tray: ${args.slice(2).join(' ')} -> ${String(r.stdout ?? '').trim().slice(0, 80)} (cursor ${JSON.stringify(c)})`);
    }
    return null;
}
export function openLinuxTrayMenu() {
    const bar = screenPixels();
    if (!bar) { console.log('  linux tray: the screen could not be read (grim -t ppm)'); return false; }
    const rows = Math.min(28, bar.h);
    const bright = (img) => (x) => { for (let y = 4; y < rows - 4; y++) if (lum(img, x, y) > 120) return true; return false; };
    const glyphs = runsOf(bar.w, Math.floor(bar.w * 0.75), bright(bar));
    console.log(`  linux tray: the bar's right group: ${JSON.stringify(glyphs)}`);
    if (glyphs.length === 0) return false;
    const expander = { x: Math.round((glyphs[0].from + glyphs[0].to) / 2), y: Math.round(rows / 2) };
    const how = moveCursor(expander.x, expander.y);
    if (!how) { console.log('  linux tray: Hyprland did not move the cursor'); return false; }
    console.log(`  linux tray: the cursor is on the drawer at ${expander.x},${expander.y} (${how})`);
    spawnSync('sleep', ['1.2']);
    const open = screenPixels();
    if (!open) return false;
    const changed = runsOf(open.w, Math.floor(open.w * 0.5), (x) => { for (let y = 0; y < rows; y++) if (Math.abs(lum(open, x, y) - lum(bar, x, y)) > 40) return true; return false; });
    console.log(`  linux tray: what the drawer showed: ${JSON.stringify(changed)}`);
    const icons = changed.filter((r) => r.to - r.from >= 8 && Math.abs((r.from + r.to) / 2 - expander.x) > 10);
    if (icons.length === 0) return false;
    const ours = icons[icons.length - 1];
    const at = { x: Math.round((ours.from + ours.to) / 2), y: expander.y };
    if (!moveCursor(at.x, at.y)) return false;
    const click = ydotool(['click', '0xC1']);
    console.log(`  linux tray: right-click on ${at.x},${at.y} (ydotool exit ${click.status}${click.stderr ? `: ${String(click.stderr).trim().slice(0, 120)}` : ''})`);
    return click.status === 0;
}

// ---------------------------------------------------------------- ports, CDP (Genie's page)
/** Is anything answering HTTP on the port? Bounded: a port that accepts and never answers counts as busy, after 3 s. */
export async function answers(port) {
    try {
        await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3_000) });
        return true;
    } catch (e) {
        return e?.name === 'TimeoutError' ? 'accepts but does not answer' : false;
    }
}
/** Who holds a listening port, in the OS's words (`ss -ltnp` and each owner's command line; Linux only). */
function portOwners(port) {
    if (process.platform !== 'linux') return '(not read off Linux)';
    let ss = '';
    try { ss = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', timeout: SYNC_MS }).trim(); } catch (e) { return `ss failed: ${e.message}`; }
    const pids = [...new Set([...ss.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
    return [`  ss -ltnp 'sport = :${port}':`, `    ${ss || '(no listener)'}`, ...pids.map((pid) => `    pid ${pid}: ${commandLine(pid).slice(0, 300)}`)].join('\n');
}
/**
 * A port the previous Genie should have let go of: named, given 30 s to come free, and if it is STILL held a failed check
 * (someone holds a dead Genie's port, a finding of its own) and the run carries on on the first free port above.
 */
export async function freePort(port, label, id) {
    step(id, `is the ${label} port ${port} free? (≤ 3 s)`);
    const busy = await answers(port);
    if (!busy) return port;
    console.log(`  the ${label} port ${port} is held (${busy === true ? 'it answers' : busy}):`);
    console.log(portOwners(port));
    const freed = await until(async () => !(await answers(port)), 30_000, 1_000);
    if (freed) { console.log(`  the ${label} port ${port} came free`); return port; }
    check(false, `${id}. the ${label} port ${port} is still held after the previous Genie ended (its holder is named above)`);
    for (let p = port + 100; p < port + 200; p++) if (!(await answers(p))) { console.log(`  this run uses the ${label} port ${p} instead`); return p; }
    refuse(`no free ${label} port in ${port + 100}..${port + 199}`);
}
export async function targetOn(port, kind, ms) {
    let last = 'no attempt';
    const found = await until(async () => {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json();
            // Genie's MAIN window by its URL (cdp-main-window.mjs): the host-wait window opens first and has no window.genie.
            const t = kind === 'page' ? mainWindow(targets) : targets.find((x) => x.webSocketDebuggerUrl);
            if (!t) last = `no ${kind} yet (${targets.length} targets)`;
            return t ?? null;
        } catch (e) { last = String(e?.message ?? e); return null; }
    }, ms);
    if (!found) throw new Error(`no ${kind} on port ${port} within ${Math.round(ms / 1000)} s: ${last}`);
    return found;
}
export class Cdp {
    #ws; #id = 1; #pending = new Map(); #label;
    static async connect(url, label) {
        const c = new Cdp();
        c.#label = label;
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (typeof r === 'function') { c.#pending.delete(f.id); r(f); } });
        c.#ws.addEventListener('close', () => { for (const r of c.#pending.values()) r({ error: { message: 'socket closed' } }); c.#pending.clear(); });
        await within(15_000, `the ${label} socket`, new Promise((res, rej) => {
            c.#ws.addEventListener('open', res, { once: true });
            c.#ws.addEventListener('error', () => rej(new Error(`${label}: socket error`)), { once: true });
        }));
        return c;
    }
    send(method, params = {}, ms = 30_000) {
        const id = this.#id++;
        return within(ms, `${this.#label} ${method}`, new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method, params })); }))
            .finally(() => this.#pending.delete(id));
    }
    async evaluate(expression, ms = 30_000) {
        const f = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ms);
        if (f.error) throw new Error(`${this.#label}: ${JSON.stringify(f.error)}`);
        if (f.result.exceptionDetails) throw new Error(`${this.#label} threw: ${f.result.exceptionDetails.exception?.description ?? f.result.exceptionDetails.text ?? '?'}`);
        return f.result.result.value;
    }
    close() { try { this.#ws.close(); } catch { /* gone */ } }
}

// ---------------------------------------------------------------- this tree's Electron, as the client the row drives
function launchArgs() {
    const args = [];
    if (process.platform === 'linux') {
        args.push('--no-sandbox');
        if (process.env.XDG_SESSION_TYPE === 'x11' || process.env.XDG_SESSION_TYPE === 'wayland') args.push(`--ozone-platform=${process.env.XDG_SESSION_TYPE}`);
    }
    for (const a of (process.env.LAUNCHER_ROW_ARGS ?? '').split(/\s+/)) if (a && !args.includes(a)) args.push(a);
    return args;
}
/** Electron's binary, by its own path (node_modules/electron's answer): never npx, which reads npm's cache under the home. */
const electronBinary = () => createRequire(import.meta.url)('electron');
/**
 * This tree's Electron as a Genie client, told the launcher's environment as the launcher tells the client it starts
 * (GENIE_LAUNCHER_EXE, GENIE_LAUNCHER_HOST_BUILD), so it adopts that host and attaches to that launcher; its page on the
 * debugger port, its window.genie loaded. Every wait is bounded and named by the caller's step.
 */
export async function openClient({ label, id, port, launcherExe, hostBuild }) {
    step(`${id}a`, `launching Genie (this tree's Electron, ${label}), linked to the host ${hostBuild}`);
    mkdirSync(run.out, { recursive: true });
    const log = join(run.out, `client-${label}.log`);
    const out = openSync(log, 'a');
    const argv = ['.', `--remote-debugging-port=${port}`, ...launchArgs()];
    const child = spawn(electronBinary(), argv, { detached: !WIN, stdio: ['ignore', out, out], windowsHide: false, env: { ...process.env, GENIE_LAUNCHER_EXE: launcherExe, GENIE_LAUNCHER_HOST_BUILD: hostBuild, GENIE_PAGE_PROBE: '1' } });
    let gone = false;
    child.once('exit', () => { gone = true; });
    child.once('error', () => { gone = true; });
    console.log(`  launched (${label}) pid ${child.pid}: electron ${argv.join(' ')}  → ${log}`);
    const app = {
        log, pid: child.pid ?? null,
        get gone() { return gone; },
        kill() {
            if (gone || !child.pid) return;
            try {
                if (WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', timeout: SYNC_MS });
                else process.kill(-child.pid, 'SIGKILL');
            } catch { /* gone */ }
        },
    };
    const session = { app, cdp: null };
    step(`${id}b`, `waiting for the window on the debugger port ${port} (≤ 90 s)`);
    const page = await targetOn(port, 'page', 90_000);
    session.cdp = await Cdp.connect(page.webSocketDebuggerUrl, `${label} page`);
    step(`${id}c`, 'waiting for the page to load window.genie (≤ 60 s)');
    const ready = await until(() => session.cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"', 5_000), 60_000);
    if (ready !== true) throw new Error(`${label}: window.genie never appeared within 60 s`);
    return session;
}

// ---------------------------------------------------------------- the ledger's word: which pid streams, up to which tick
export async function ticksOf(cdp, agentId) {
    const json = await cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(agentId)}).then((d) => JSON.stringify({ running: d?.session?.running ?? null, rows: d?.rows ?? [] }))`, 10_000);
    const detail = JSON.parse(json);
    const text = JSON.stringify(detail.rows);
    const ticks = new Map();
    for (const m of text.matchAll(/tick (\d+) pid (\d+)/g)) ticks.set(Number(m[1]), Number(m[2]));
    const pids = [...new Set(ticks.values())];
    const max = ticks.size === 0 ? 0 : Math.max(...ticks.keys());
    return { running: detail.running, ticks, pids, max, size: text.length };
}
/** The first tick missing from `from` to `to`, or null when every one is there. */
export const contiguous = (ticks, from, to) => { for (let n = from; n <= to; n++) if (!ticks.has(n)) return n; return null; };

// ---------------------------------------------------------------- the launcher's control wire, spoken from Node
/**
 * THE CONTROL WIRE (native/launcher/src/control.rs): JSON lines on the endpoint `<runtime>/launcher.json` names (a per-user
 * named pipe on Windows, `launcher.sock` elsewhere), the token in `<runtime>/launcher.token`, a `hello` with an offer at
 * the launcher's own schema (read from launcher.json, so the pair always agrees), then calls and their results. Every
 * answer is `{ok, value | reason, welcome}`, never a throw: a launcher that is not there, refuses or does not answer is said.
 */
export const launcherRecordIn = (runtime) => readJson(join(runtime, 'launcher.json'));
function wireOpen(runtime, ms) {
    return new Promise((resolveIt) => {
        const record = launcherRecordIn(runtime);
        const token = readOr(join(runtime, 'launcher.token')).trim();
        if (!record?.endpoint || !token) { resolveIt({ error: `no launcher record or token in ${runtime}` }); return; }
        const socket = connect({ path: record.endpoint });
        let buffer = '';
        const frames = [];
        const waiters = [];
        const timer = setTimeout(() => { socket.destroy(); resolveIt({ error: `the launcher's endpoint ${record.endpoint} did not welcome within ${Math.round(ms / 1000)} s` }); }, ms);
        const deliver = (frame) => { const w = waiters.findIndex((x) => x.match(frame)); if (w >= 0) waiters.splice(w, 1)[0].resolve(frame); else frames.push(frame); };
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            buffer += chunk;
            let i;
            while ((i = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, i).trim();
                buffer = buffer.slice(i + 1);
                if (!line) continue;
                try { deliver(JSON.parse(line)); } catch { /* not a frame */ }
            }
        });
        const closed = [];
        socket.on('close', () => { for (const w of waiters.splice(0)) w.resolve(null); for (const c of closed) c(); });
        socket.on('error', (e) => { clearTimeout(timer); resolveIt({ error: `the launcher's endpoint ${record.endpoint}: ${e.message}` }); });
        const next = (match, wait) => {
            const at = frames.findIndex(match);
            if (at >= 0) return Promise.resolve(frames.splice(at, 1)[0]);
            return new Promise((r) => { const w = { match, resolve: r }; waiters.push(w); setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); r(null); } }, wait); });
        };
        socket.on('connect', async () => {
            socket.write(`${JSON.stringify({ kind: 'hello', auth: { kind: 'token', token }, label: 'genie launcher row', track: 'client', schema: record.schema, minSchema: record.schema, capabilities: ['launcher@1'] })}\n`);
            const welcome = await next((f) => f.kind === 'welcome' || f.kind === 'refused', ms);
            clearTimeout(timer);
            if (!welcome) { socket.destroy(); resolveIt({ error: 'the launcher closed the link before it welcomed' }); return; }
            if (welcome.kind === 'refused') { socket.destroy(); resolveIt({ error: `the launcher refused: ${welcome.reason}` }); return; }
            resolveIt({ socket, welcome, record, next, frames, onClose: (f) => closed.push(f) });
        });
    });
}
let callId = 0;
/** One call on a link of its own: hello, the call, its result; the link closed after, whatever happened. */
export async function wireCall(runtime, method, args = [], ms = 30_000) {
    const link = await wireOpen(runtime, Math.min(ms, 15_000));
    if (link.error) return { ok: false, reason: link.error, welcome: null };
    const id = ++callId;
    link.socket.write(`${JSON.stringify({ kind: 'call', id, method, args })}\n`);
    const result = await link.next((f) => f.kind === 'result' && f.id === id, ms);
    link.socket.destroy();
    if (!result) return { ok: false, reason: `${method} was not answered within ${Math.round(ms / 1000)} s (or the link closed)`, welcome: link.welcome };
    return result.ok === true ? { ok: true, value: result.value ?? null, welcome: link.welcome } : { ok: false, reason: result.reason ?? `${method} failed`, code: result.code, welcome: link.welcome };
}
/** A hello alone: the launcher's welcome (its pid and build), or why there is none. */
export async function wireHello(runtime, ms = 10_000) {
    const link = await wireOpen(runtime, ms);
    if (link.error) return { ok: false, reason: link.error };
    link.socket.destroy();
    return { ok: true, welcome: link.welcome, record: link.record };
}
/**
 * A link held open with `launcher.attach {pid}`, as a client holds its own: every event the launcher says on it is kept.
 * The row attaches in ITS OWN pid, so the launcher's events are observed without standing in for a window; nothing the
 * update rows do closes the clients (no closeUi, no shutDown), which would make the launcher wait for this pid.
 */
export async function wireAttach(runtime, pid) {
    const link = await wireOpen(runtime, 15_000);
    if (link.error) return { ok: false, reason: link.error, events: () => [], close() {} };
    const id = ++callId;
    link.socket.write(`${JSON.stringify({ kind: 'call', id, method: 'launcher.attach', args: [{ pid }] })}\n`);
    const result = await link.next((f) => f.kind === 'result' && f.id === id, 15_000);
    return {
        ok: result?.ok === true, reason: result?.reason ?? null,
        /** The events said on this link so far (frames of kind `event`). */
        events: () => link.frames.filter((f) => f.kind === 'event'),
        close: () => link.socket.destroy(),
    };
}
