#!/usr/bin/env node
/**
 * QUIT KEEPS THE HOST (the host split P1b, genie#1451; THE LAUNCHER'S since Tynn #1058 L5) — measured on the REAL app with a
 * REAL process table.
 *
 * L5: the launcher owns the tray and the quit's answers. The row installs the package-tracks row's signed packages into a
 * code root of its own, runs that launcher (`serve`, with GENIE_LAUNCHER_TRAY_PROBE=1) and starts the host through it; the
 * client is this tree's Electron, told the launcher's environment (GENIE_LAUNCHER_EXE, GENIE_LAUNCHER_HOST_BUILD) as the
 * launcher tells the client it starts, so it adopts that host and attaches to that launcher. Then: "Just close the UI" ends
 * the CLIENT process while the launcher, the host and the providers keep their pids; the tray's menu (photographed) says
 * the host runs the agents; a new client finds every tick; the tray's Close Genie ends it; the tray's Shut down everything
 * ASKS in the launcher's own window (photographed) and Escape cancels; the client's "Shut down everything" makes the
 * launcher stop the host on its own progress (Tynn #1079: no kill, its clean-exit marker, no crash record), then exit; and
 * the host started again reads no crash. What follows is the P1b text this grew from.
 *
 *   node scripts/quit-keeps-host-cdp.mjs
 *
 * Three agents stream; the person answers the quit "Just close the UI" (the owner, 2026-11-02: "Keep the tray up"), and:
 *   every window closes, the window process STAYS as the tray, and the tray says the host runs the agents;
 *   Open Genie from the tray builds the window again in that same process: the SAME genie-host pid, the SAME provider pid per
 *   agent, and every ledger has grown — with every tick the providers streamed while no window was open, in order;
 *   closed again from the tray, a SECOND LAUNCH builds the window again in the same process (the single-instance lock);
 *   "Shut down everything" from the tray ends the window process, the host and the providers.
 *
 * HOW IT RUNS. It launches Genie itself, from the
 * root of a built and SEEDED tree (smoke-seed.mjs), with nothing of Genie's on the debugger port: vm-smoke stops its own
 * Electron first. AS A CI ROW (`quit-keeps-host` in scripts/ci/linux.sh and windows.ps1, Tynn #1036) it is given
 * QUIT_CDP_OWN_HOME=1: a NEW home (HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME), seeded here with
 * smoke-seed.mjs before any Genie path is read, so its Genie has a single-instance lock, a genie-host and a ~/.genie of its
 * own beside the run's shared app; its ports (CDP_PORT, QUIT_CDP_INSPECT) and QUIT_CDP_OUT for its logs come from the row.
 * Electron is started by its own path, never through npx (a moved home has no npm cache, and mise's shims refuse it), and
 * the page it attaches to is Genie's MAIN window (cdp-main-window.mjs), never the "Starting Genie's host…" window that
 * opens first. Launch flags follow the caller's session: `--no-sandbox` on Linux, `--ozone-platform=$XDG_SESSION_TYPE`
 * when that is x11 or wayland, anything else in QUIT_CDP_ARGS. Providers are the stub app server (scripts/stub-codex.mjs)
 * in its TICKER mode — `tick <n> pid <pid>` four times a second, so each agent's ledger names the process streaming for it —
 * switched on by a marker file holding THIS script's pid (a marker whose pid is dead is ignored by the stub, so a run that
 * was killed cannot turn a later smoke's provider into a ticker).
 *
 * HOW IT ANSWERS THE QUIT. The question is a native dialog CDP cannot click. The WINDOW process is launched with
 * `--inspect` (a launch flag, like `--remote-debugging-port`; the host is spawned without it). Over that inspector the
 * script replaces the person's CLICK — `dialog.showMessageBoxSync` answers a button index and writes down what it was asked
 * — and calls `app.quit()`. Everything after the click is the product's own: before-quit, quitPlan, quitAnswer, closeUi.
 * What the dialog was asked is checked, so a two-answer question (no host) cannot pass. The TRAY is read and clicked the
 * same way: main.ts's read-only probe (`Symbol.for('genie.tray')`) says what it shows, and an item's click is the very
 * handler the tray's menu runs — Electron's Tray can be neither asked nor clicked from outside.
 *
 * IT NEVER HANGS SILENTLY (batch L2: a first version printed nothing for 600 s before `timeout` killed it). Every step prints
 * a line BEFORE it acts, with the time since start. Every fetch, CDP call and wait has its own deadline, and a missed one
 * fails naming its step. Every synchronous process call has a timeout. A watchdog ends the run at QUIT_CDP_DEADLINE_MS
 * (default 360 s, under the batch's 420) naming the step it was in. Whatever ends the run, the cleanup runs, bounded: the
 * agents are stopped, its Electron ended, and a host it could not shut down through the quit is ended by signal.
 *
 * SAFETY: it launches Electron, so it refuses to run anywhere but a test machine — CI, the test VM (Linux user `genie`),
 * GENIE_TEST_MACHINE=1 (the CI scripts' statement) or QUIT_CDP_ALLOW=1 (the Windows VM's runner). Never on the owner's desktop.
 *
 * ON WINDOWS ITS RUN ENDS THROUGH scripts/end-own-tree.mjs (Tynn #1031), as every row that starts its own Genie: the app's
 * tree, its genie-host and what this run started, ended, waited for and named; anything left fails the run.
 *
 * Exit: 0 every check passed; 1 a check failed (or a deadline was missed); 2 cannot run here.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const T0 = Date.now();
const since = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;
let current = 'start';
/** Every step names itself BEFORE it acts: a hang always says where it stopped. */
function step(id, what) {
    current = `${id} ${what}`;
    console.log(`[${since()}] step ${id}: ${what}`);
}

step('0.1', 'reading the settings');
const WIN = process.platform === 'win32';
step('0.2', 'is this a test machine? (CI, GENIE_TEST_MACHINE=1, user genie, or QUIT_CDP_ALLOW=1)');
const user = process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? '';
const testMachine = process.env.CI === 'true' || process.env.GENIE_TEST_MACHINE === '1' || process.env.QUIT_CDP_ALLOW === '1' || (process.platform === 'linux' && user === 'genie');
if (!testMachine) refuse(`it launches Electron, so it runs only on a test machine (CI, GENIE_TEST_MACHINE=1, the test VM as user \`genie\`, or QUIT_CDP_ALLOW=1); user is "${user}"`);
step('0.3', `is this the root of a Genie tree? (${process.cwd()})`);
if (!existsSync('package.json') || !existsSync('scripts/stub-codex.mjs')) refuse(`run it from the root of a built Genie tree (${process.cwd()})`);
// The stub provider is started by its path through its `#!/usr/bin/env node` line, and git holds it without the execute bit
// (a CI tree is a fresh copy): made executable here, by the script that names it as the provider (linux.sh's need_app does too).
if (!WIN) chmodSync('scripts/stub-codex.mjs', 0o755);
/**
 * A HOME OF ITS OWN (QUIT_CDP_OWN_HOME=1, the CI row): a new directory is HOME, USERPROFILE, APPDATA, LOCALAPPDATA and
 * XDG_CONFIG_HOME for this script and everything it starts, and smoke-seed.mjs writes its workspace there. The workspace is
 * a fresh directory in that home, never the checkout (the seed takes its cwd): a Genie writes its workspace's project.json,
 * and the seed then refuses the checkout's on the next run in the same tree (the first Azure probe's restored run). Node's own
 * directory goes first on PATH, so the stub provider's `#!/usr/bin/env node` finds node without a shim that reads the real
 * home (linux.sh's need_app, for the same reason). Bounded; a seed that fails is "cannot run here", said with its words.
 */
function ownHome() {
    const root = mkdtempSync(join(tmpdir(), 'genie-quit-home-'));
    const env = { HOME: root, USERPROFILE: root, APPDATA: join(root, 'AppData', 'Roaming'), LOCALAPPDATA: join(root, 'AppData', 'Local'), XDG_CONFIG_HOME: join(root, '.config') };
    for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME]) mkdirSync(dir, { recursive: true });
    Object.assign(process.env, env);
    delete process.env.GENIE_HOME;
    process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
    step('0.3h', `a home of its own, seeded (smoke-seed.mjs, ≤ 60 s): ${root}`);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const seeded = spawnSync(process.execPath, [resolve('scripts', 'smoke-seed.mjs')], { cwd: workspace, encoding: 'utf8', timeout: 60_000, env: process.env, windowsHide: true });
    if (seeded.status !== 0) refuse(`the seed could not be written in ${root} (exit ${seeded.status}${seeded.error ? `, ${seeded.error.message}` : ''}): ${String(`${seeded.stderr ?? ''}\n${seeded.stdout ?? ''}`).trim().split(/\r?\n/).filter((l) => /\S/.test(l) && !/^\s+at /.test(l)).slice(0, 6).join(' | ')}`);
    console.log(`  ${String(seeded.stdout ?? '').trim()}`);
    return root;
}
if (process.env.QUIT_CDP_OWN_HOME === '1') ownHome();
let PORT = Number(process.env.CDP_PORT ?? 9222);
let INSPECT = Number(process.env.QUIT_CDP_INSPECT ?? 9229);
const CLOSED_MS = Number(process.env.QUIT_CDP_CLOSED_MS ?? 12_000);
const DEADLINE_MS = Number(process.env.QUIT_CDP_DEADLINE_MS ?? 360_000);
const AGENTS = 3;
const TICKER = join(tmpdir(), 'genie-stub-codex-ticker');
const PROOF = join(tmpdir(), `genie-quit-answer-${process.pid}.json`);
// Every dialog call the window makes while a substitution is in place, answered or not (batch SS on Windows: 26e read none).
const CALLS = join(tmpdir(), `genie-quit-dialog-calls-${process.pid}.log`);
const GENIE_HOME = process.env.GENIE_HOME && process.env.GENIE_HOME.length > 0 ? process.env.GENIE_HOME : join(homedir(), '.genie');
const HOST_RECORD = join(GENIE_HOME, 'runtime', 'host.json');
const LIFECYCLE = join(GENIE_HOME, 'runtime', 'lifecycle.log');
const HOST_LOG = join(GENIE_HOME, 'logs', 'genie-host.log');
const OUT = process.env.QUIT_CDP_OUT ? resolve(process.env.QUIT_CDP_OUT) : join(process.cwd(), 'smoke-out');
// THE LAUNCHER (L5): the package-tracks row's, installing into a code root of this run's home.
const LAUNCHER_SRC = resolve('release', 'tracks', 'trees', 'launcher', WIN ? 'Genie.exe' : 'genie');
const PACKAGES = resolve('release', 'tracks', 'packages');
const CODE_ROOT = join(dirname(GENIE_HOME), 'genie-code');
const LAUNCHER_LOG = join(OUT, 'launcher.log');
const STUB = join(process.cwd(), 'scripts', 'stub-codex.mjs');
// Everything this run starts (the launcher, the host it starts, the client) reads the same roots and the same stub provider.
Object.assign(process.env, { GENIE_HOME, GENIE_CODE_ROOT: CODE_ROOT, GENIE2_CODEX_BINARY: process.env.GENIE2_CODEX_BINARY || STUB, GENIE_TEST_MACHINE: '1' });
let launcherPid = null;
let launcherHostBuild = null;
const launcherRecord = () => { try { return JSON.parse(readFileSync(join(GENIE_HOME, 'runtime', 'launcher.json'), 'utf8')); } catch { return null; } };
/** One launcher command, bounded: its exit code and what it said. */
function launcherCli(args, ms = 30_000) {
    const r = spawnSync(LAUNCHER_SRC, args, { encoding: 'utf8', timeout: ms, env: process.env, windowsHide: true });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
/** The whole screen, as the person sees it: grim on Linux, the desktop's own copy on Windows (scripts/ci/screenshot.ps1). */
function shot(name) {
    mkdirSync(OUT, { recursive: true });
    const file = join(OUT, name);
    if (WIN) spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts', 'ci', 'screenshot.ps1'), '-Out', file], { timeout: SYNC_MS, windowsHide: true });
    else spawnSync('grim', [file], { timeout: SYNC_MS });
    console.log(existsSync(file) ? `SCREENSHOT ${file}` : `  no screenshot could be taken: ${file}`);
}
/** A key, as the person's keyboard sends it to the window in front (wtype on Wayland; SendKeys on Windows). */
function pressKey(key) {
    if (WIN) spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key === 'Escape' ? '{ESC}' : key}')`], { timeout: SYNC_MS, windowsHide: true });
    else spawnSync('wtype', ['-k', key], { timeout: SYNC_MS });
}
/**
 * THE LINUX TRAY'S MENU, OPENED AS A PERSON OPENS IT (best effort, for the screenshot): Waybar draws a StatusNotifierItem's
 * menu, and only a pointer opens it. The icon is found as the bar's pixels that changed when the launcher put it up
 * (grim -t ppm, before and after); Hyprland puts the cursor on it (its own dispatch, checked with `hyprctl cursorpos`), and
 * ydotool presses the right button. Each step says whether it worked; the row does not fail on it.
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
function trayIconOf(before, after) {
    if (!before || !after || before.w !== after.w) return null;
    const rows = Math.min(30, after.h);
    const changed = [];
    for (let x = Math.floor(after.w * 0.6); x < after.w; x++) {
        let d = 0;
        for (let y = 0; y < rows; y++) { const k = (y * after.w + x) * 3; d += Math.abs(after.px[k] - before.px[k]) + Math.abs(after.px[k + 1] - before.px[k + 1]) + Math.abs(after.px[k + 2] - before.px[k + 2]); }
        if (d > 120) changed.push(x);
    }
    if (changed.length === 0) return null;
    // The rightmost run of changed columns ends where the new icon ends (what shifted left of it changed too).
    const right = changed[changed.length - 1];
    return { x: right - 9, y: Math.round(rows * 0.45) };
}
function cursorAt() {
    const r = spawnSync('hyprctl', ['-i', '0', 'cursorpos'], { encoding: 'utf8', timeout: SYNC_MS });
    const m = /(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(r.stdout ?? '');
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}
/** Runs of columns in the bar's right part where `hit(x)` is true: [{from, to}], left to right. */
function runs(w, from, hit) {
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
/** ydotool and its daemon (uinput, as root): a pointer the way a person's mouse is one. */
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
/** Move the cursor to (x, y): Hyprland's own dispatch where it takes one, else ydotool's moves, corrected against where
 * `hyprctl cursorpos` says the cursor is (pointer acceleration makes one move land short or long). The way, or null. */
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
/**
 * Omarchy keeps the tray's icons in a drawer behind its "<" (Waybar's group drawer, opened on hover): the cursor goes to
 * the "<" (the leftmost light glyph of the bar's right group), the bar is read again, and the icons that appeared are the
 * tray's; ours is right-clicked.
 */
function openLinuxTrayMenu() {
    const bar = screenPixels();
    if (!bar) { console.log('  linux tray: the screen could not be read (grim -t ppm)'); return false; }
    const rows = Math.min(28, bar.h);
    const bright = (img) => (x) => { for (let y = 4; y < rows - 4; y++) if (lum(img, x, y) > 120) return true; return false; };
    const glyphs = runs(bar.w, Math.floor(bar.w * 0.75), bright(bar));
    console.log(`  linux tray: the bar's right group: ${JSON.stringify(glyphs)}`);
    if (glyphs.length === 0) return false;
    const expander = { x: Math.round((glyphs[0].from + glyphs[0].to) / 2), y: Math.round(rows / 2) };
    const how = moveCursor(expander.x, expander.y);
    if (!how) { console.log('  linux tray: Hyprland did not move the cursor'); return false; }
    console.log(`  linux tray: the cursor is on the drawer at ${expander.x},${expander.y} (${how})`);
    spawnSync('sleep', ['1.2']);
    const open = screenPixels();
    if (!open) return false;
    const changed = runs(open.w, Math.floor(open.w * 0.5), (x) => { for (let y = 0; y < rows; y++) if (Math.abs(lum(open, x, y) - lum(bar, x, y)) > 40) return true; return false; });
    console.log(`  linux tray: what the drawer showed: ${JSON.stringify(changed)}`);
    // The revealed icons are the ones that were not there; the drawer's own glyph changing is not one (it is at the expander).
    const icons = changed.filter((r) => r.to - r.from >= 8 && Math.abs((r.from + r.to) / 2 - expander.x) > 10);
    if (icons.length === 0) return false;
    const ours = icons[icons.length - 1];
    const at = { x: Math.round((ours.from + ours.to) / 2), y: expander.y };
    const moved = moveCursor(at.x, at.y);
    if (!moved) return false;
    const click = ydotool(['click', '0xC1']);
    console.log(`  linux tray: right-click on ${at.x},${at.y} (ydotool exit ${click.status}${click.stderr ? `: ${String(click.stderr).trim().slice(0, 120)}` : ''})`);
    return click.status === 0;
}
let barBefore = null;

/** How many crash records the host's runtime holds. */
const crashRecords = () => { try { return readdirSync(join(GENIE_HOME, 'runtime', 'crash')).length; } catch { return 0; } };
/**
 * THE AGENTS' SHUTDOWN DRAIN (src/core/agent-shutdown-drain.ts AGENT_DRAIN_WAIT_MS; test/quit-keeps-host-row-1036.test.ts
 * holds the two equal): "Shut down everything" lets a mid-turn agent reach a safe point for this long before it stops it.
 * The ticker agents are mid-turn for ever, so the window process exits after it: step 26 waits the drain plus 60 s.
 */
const AGENT_DRAIN_WAIT_MS = 120_000;
/** Bounds for the process calls this script makes synchronously: none may block a run. */
const SYNC_MS = 15_000;

const failures = [];
/** Where the lifecycle log stood when this run began: its gauge lines from here on are this run's (printed pass or fail). */
let gaugeFrom = null;
const GAUGE = /(^| )(host )?(stall main|stall renderer|ipc waiting|ipc slow|net slow|features slow|stall profiler off)/;
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
    return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** `p`, or a rejection naming what missed its deadline. */
function within(ms, what, p) {
    let t;
    return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`deadline: ${what} did not answer within ${Math.round(ms / 1000)} s`)), ms); })])
        .finally(() => clearTimeout(t));
}
/** Retry `what` (each attempt bounded too) until it answers truthy or `ms` runs out; the last value either way. */
async function until(what, ms, interval = 500) {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
        try { last = await within(Math.max(1_000, Math.min(15_000, end - Date.now())), 'an attempt', Promise.resolve().then(what)); } catch { last = null; }
        if (last) return last;
        await sleep(interval);
    }
    return last;
}

// ---------------------------------------------------------------- the process table (the OS's word, not Genie's)
function alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/**
 * A process's command line, or why it couldn't be read: never an empty string that reads as "not that program". Batch SS on Windows
 * had a live host and live providers read as '' (rows 5 and 8): a cold PowerShell under load can take longer than one try allows.
 */
function commandLine(pid) {
    if (!WIN) {
        try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch (error) { return `(unread: ${error.code ?? error.message})`; }
    }
    // ONE read of every process, kept for a minute: batch SS's repeat measured a single PowerShell read at over 30 s on the Windows
    // VM, so one per pid ran the proof into its ceiling before row 9. Read again only for a pid the table hasn't got.
    if (!table || Date.now() - table.at > 60_000 || !table.lines.has(Number(pid))) table = readTable();
    return table.lines.get(Number(pid)) ?? `(unread: ${table.error ?? 'not in the process table'})`;
}
let table = null;
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
function hostRecord() {
    try { return JSON.parse(readFileSync(HOST_RECORD, 'utf8')); } catch { return null; }
}
const readOr = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
/** Is anything answering HTTP on the port? Bounded: a port that accepts and never answers counts as busy, after 3 s. */
async function answers(port) {
    try {
        await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3_000) });
        return true;
    } catch (e) {
        return e?.name === 'TimeoutError' ? 'accepts but does not answer' : false;
    }
}

/**
 * Who holds a listening port, in the OS's words: `ss -ltnp` and each owner's command line (Linux; bounded). Printed when
 * the run refuses a busy port, so the next failure names the process instead of guessing (batch L3).
 */
function portOwners(port) {
    if (process.platform !== 'linux') return '(not read off Linux)';
    let ss = '';
    try { ss = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', timeout: SYNC_MS }).trim(); } catch (e) { return `ss failed: ${e.message}`; }
    const pids = [...new Set([...ss.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
    const owners = pids.map((pid) => `    pid ${pid} (ppid ${readOr(`/proc/${pid}/stat`).split(') ')[1]?.split(' ')[1] ?? '?'}): ${commandLine(pid).slice(0, 300) || '(gone)'}`);
    return [`  ss -ltnp 'sport = :${port}':`, `    ${ss || '(no listener)'}`, ...(owners.length ? ['  owners:', ...owners] : ['  owners: none visible to this user'])].join('\n');
}

// ---------------------------------------------------------------- CDP (the page) and the inspector (the window's main)
async function targetOn(port, kind, ms) {
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
class Cdp {
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
    /** Closed, and the close done (bounded): a session still attached keeps a quitting Node process waiting for it. */
    async closed(ms = 5_000) {
        if (this.#ws.readyState === WebSocket.CLOSED) return true;
        const done = new Promise((r) => this.#ws.addEventListener('close', () => r(true), { once: true }));
        this.close();
        return Promise.race([done, sleep(ms).then(() => false)]);
    }
}

// ---------------------------------------------------------------- one Genie, launched and ended by this script
function launchArgs() {
    const args = [];
    if (process.platform === 'linux') {
        args.push('--no-sandbox');
        if (process.env.XDG_SESSION_TYPE === 'x11' || process.env.XDG_SESSION_TYPE === 'wayland') args.push(`--ozone-platform=${process.env.XDG_SESSION_TYPE}`);
    }
    for (const a of (process.env.QUIT_CDP_ARGS ?? '').split(/\s+/)) if (a && !args.includes(a)) args.push(a);
    return args;
}
/** Electron's binary, by its own path (node_modules/electron's answer): never npx, which reads npm's cache under the home. */
const electronBinary = () => createRequire(import.meta.url)('electron');
function launch(label) {
    mkdirSync(OUT, { recursive: true });
    const log = join(OUT, `quit-keeps-host-${label}.log`);
    const out = openSync(log, 'a');
    const argv = [`--inspect=${INSPECT}`, '.', `--remote-debugging-port=${PORT}`, ...launchArgs()];
    // GENIE_TRAY_PROBE=1: main.ts's read-only tray probe exists only in a launch that asks for it (this proof's).
    const child = spawn(electronBinary(), argv, { detached: !WIN, stdio: ['ignore', out, out], windowsHide: false, env: { ...process.env, GENIE_LAUNCHER_EXE: LAUNCHER_SRC, ...(launcherHostBuild ? { GENIE_LAUNCHER_HOST_BUILD: launcherHostBuild } : {}), GENIE_PAGE_PROBE: '1' } });
    let gone = false;
    const exited = new Promise((r) => {
        child.once('exit', (code, signal) => { gone = true; r({ code, signal }); });
        child.once('error', (error) => { gone = true; r({ code: null, signal: null, error: String(error) }); });
    });
    console.log(`  launched (${label}) pid ${child.pid}: electron ${argv.join(' ')}  → ${log}`);
    return {
        log, exited, pid: child.pid ?? null,
        get gone() { return gone; },
        kill() {
            if (gone || !child.pid) return;
            try {
                if (WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', timeout: SYNC_MS });
                else process.kill(-child.pid, 'SIGKILL');
            } catch { /* gone */ }
        },
    };
}
/** A launch, its page and its main-process inspector. Each wait is bounded and named by the caller's step. */
async function open(label, id) {
    step(`${id}a`, `launching Genie (${label})`);
    const app = launch(label);
    const session = { app, cdp: null, inspector: null, windowPid: null };
    step(`${id}b`, `waiting for the window on the debugger port ${PORT} (≤ 90 s)`);
    const page = await targetOn(PORT, 'page', 90_000);
    session.cdp = await Cdp.connect(page.webSocketDebuggerUrl, `${label} page`);
    step(`${id}c`, 'waiting for the page to load window.genie (≤ 60 s)');
    const ready = await until(() => session.cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"', 5_000), 60_000);
    if (ready !== true) throw new Error(`${label}: window.genie never appeared within 60 s`);
    step(`${id}d`, `connecting to the window process's inspector on ${INSPECT} (≤ 30 s)`);
    session.inspector = await Cdp.connect((await targetOn(INSPECT, 'node', 30_000)).webSocketDebuggerUrl, `${label} inspector`);
    session.windowPid = await session.inspector.evaluate('process.pid', 10_000);
    console.log(`  window process pid ${session.windowPid}`);
    return session;
}

/**
 * The person's click, and nothing else: the dialog answers `index` and writes down what it asked; then the quit is the
 * product's own (`app.quit()` → before-quit → quitPlan → quitAnswer → runQuit). Answers whether the substitution took.
 *
 * THE INSPECTOR LETS GO BEFORE THE QUIT (batch M: both windows ended their quit and then sat on "Waiting for the debugger
 * to disconnect..." — Node keeps a process alive while a debugger session is attached, so the script's own session held
 * the window open, and the exit checks failed for the harness, not the product). The quit is deferred by a second; this
 * session is closed, and its close done, well inside it.
 */
async function answerTheQuit(inspector, index) {
    rmSync(PROOF, { force: true });
    const said = await inspector.evaluate(`(() => {
        const module = process.getBuiltinModule && process.getBuiltinModule('node:module');
        if (!module) return 'no process.getBuiltinModule in this Electron';
        const require = module.createRequire(process.execPath);
        const { app, dialog } = require('electron');
        const fs = require('node:fs');
        const note = (kind, args) => { try { const o = args.find((a) => a && typeof a === 'object' && Array.isArray(a.buttons)) ?? {}; fs.appendFileSync(${JSON.stringify(CALLS)}, new Date().toISOString() + ' ' + kind + ' ' + JSON.stringify({ title: o.title ?? null, buttons: o.buttons ?? null }) + ' at ' + (new Error().stack ?? '').split('\\n').slice(2, 6).map((l) => l.trim()).join(' < ') + '\\n'); } catch {} };
        if (!dialog.__genieNoted) {
            dialog.__genieNoted = true;
            const realAsync = dialog.showMessageBox;
            dialog.showMessageBox = (...args) => { note('showMessageBox (async, not answered)', args); return realAsync.apply(dialog, args); };
        }
        const click = (...args) => {
            note('showMessageBoxSync (answered ${index})', args);
            const options = args.find((a) => a && typeof a === 'object' && Array.isArray(a.buttons)) ?? {};
            fs.writeFileSync(${JSON.stringify(PROOF)}, JSON.stringify({ buttons: options.buttons ?? null, message: options.message ?? null, answered: ${index} }));
            return ${index};
        };
        dialog.showMessageBoxSync = click;
        if (require('electron').dialog.showMessageBoxSync !== click) return 'the dialog could not be answered (the substitution did not take)';
        setTimeout(() => app.quit(), 1000);
        return 'ok';
    })()`, 10_000);
    const detached = await inspector.closed(5_000);
    console.log(`  the inspector session ${detached ? 'is closed' : 'did NOT close within 5 s'} before the quit`);
    return said;
}
const asked = () => { try { return JSON.parse(readFileSync(PROOF, 'utf8')); } catch { return null; } };
const exitWithin = (app, ms) => Promise.race([app.exited, sleep(ms).then(() => null)]);
/**
 * Why a window did not exit: Node's own words when a debugger session holds it (then it is this harness, not Genie), or
 * the product's — named either way, from the window's log.
 */
function whyStillRunning(app, ms) {
    const tail = readOr(app.log).split('\n').slice(-20).join('\n');
    const after = `still running after ${Math.round(ms / 1000)} s`;
    return /Waiting for the debugger to disconnect/.test(tail)
        ? `${after}, HELD BY A DEBUGGER SESSION ("Waiting for the debugger to disconnect...") — the harness, not the product`
        : `${after} (no debugger hold in its log: the product did not exit)`;
}

// ---------------------------------------------------------------- the client, read over the main process's inspector
/** How many windows the window process has now. */
const windowsIn = (inspector) => inspector.evaluate(`(() => {
    const require = process.getBuiltinModule('node:module').createRequire(process.execPath);
    return require('electron').BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
})()`, 10_000);
/**
 * The person's answer to the NEXT native question (the tray's "always ask"), and nothing else: the dialog answers `index`
 * and writes down what it asked, then puts itself back. No quit is started here — the tray item's own handler does that.
 */
async function answerNextDialog(inspector, index) {
    rmSync(PROOF, { force: true });
    return inspector.evaluate(`(() => {
        const require = process.getBuiltinModule('node:module').createRequire(process.execPath);
        const { dialog } = require('electron');
        const fs = require('node:fs');
        const real = dialog.showMessageBoxSync;
        const click = (...args) => {
            const options = args.find((a) => a && typeof a === 'object' && Array.isArray(a.buttons)) ?? {};
            fs.writeFileSync(${JSON.stringify(PROOF)}, JSON.stringify({ title: options.title ?? null, buttons: options.buttons ?? null, message: options.message ?? null, answered: ${index} }));
            dialog.showMessageBoxSync = real;
            return ${index};
        };
        dialog.showMessageBoxSync = click;
        return require('electron').dialog.showMessageBoxSync === click ? 'ok' : 'the dialog could not be answered (the substitution did not take)';
    })()`, 10_000).catch((e) => String(e?.message ?? e));
}

/** Is there a page on the debugger port now? (Bounded.) */
async function pageOn(port) {
    try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json();
        return targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { return false; }
}
/** The window built again in the SAME process: its new page, its inspector (the same one), its pid. */
async function reopened(first, label, id) {
    step(`${id}w`, `waiting for the window to come back on the debugger port ${PORT} (≤ 60 s)`);
    const page = await targetOn(PORT, 'page', 60_000);
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl, `${label} page`);
    const ready = await until(() => cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"', 5_000), 60_000);
    if (ready !== true) throw new Error(`${label}: window.genie never appeared within 60 s`);
    const inspector = first.inspector ?? await Cdp.connect((await targetOn(INSPECT, 'node', 15_000)).webSocketDebuggerUrl, `${label} inspector`);
    const windowPid = await inspector.evaluate('process.pid', 10_000);
    return { app: first.app, cdp, inspector, windowPid };
}
/** A second launch, as a person makes one: it hands over through the single-instance lock and exits. */
function launchSecond() {
    mkdirSync(OUT, { recursive: true });
    const out = openSync(join(OUT, 'quit-keeps-host-second-launch.log'), 'a');
    const child = spawn(electronBinary(), ['.', ...launchArgs()], { stdio: ['ignore', out, out], windowsHide: false });
    if (Number.isInteger(child.pid)) secondPid = child.pid;
    return new Promise((r) => { child.once('exit', (code, signal) => r({ code, signal })); child.once('error', (e) => r({ error: String(e) })); });
}

// ---------------------------------------------------------------- the ledger's word: which pid streams, up to which tick
async function ticksOf(cdp, agentId) {
    const json = await cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(agentId)}).then((d) => JSON.stringify({ running: d?.session?.running ?? null, rows: d?.rows ?? [] }))`, 10_000);
    const detail = JSON.parse(json);
    const text = JSON.stringify(detail.rows);
    const ticks = new Map();
    for (const m of text.matchAll(/tick (\d+) pid (\d+)/g)) ticks.set(Number(m[1]), Number(m[2]));
    const pids = [...new Set(ticks.values())];
    const max = ticks.size === 0 ? 0 : Math.max(...ticks.keys());
    return { running: detail.running, ticks, pids, max, size: text.length };
}
const contiguous = (ticks, from, to) => { for (let n = from; n <= to; n++) if (!ticks.has(n)) return n; return null; };

// ---------------------------------------------------------------- cleanup: bounded, whatever ended the run
let a = null;
let b = null;
let c = null;
const agents = [];
let hostPid = null;
/** The terminal this run opened, and its second launch: what the Windows cleanup is given beside the app and the host. */
let terminalPid = null;
let secondPid = null;
let shutDownProven = false;
let cleaned = false;
async function cleanup(why) {
    if (cleaned) return;
    cleaned = true;
    console.log(`[${since()}] cleanup (${why})`);
    rmSync(TICKER, { force: true });
    if (!shutDownProven) {
        // The agents first, through the product, while a window is there to ask (bounded per agent).
        for (const s of [b, a]) {
            if (!s?.cdp || s.app.gone) continue;
            for (const ag of agents) {
                try { await s.cdp.evaluate(`(window.genieTest ?? window.genie).stopAgent(${JSON.stringify(ag.id)}); true`, 5_000); console.log(`  stopped ${ag.name}`); } catch (e) { console.log(`  could not stop ${ag.name}: ${e.message}`); }
            }
            break;
        }
    }
    for (const s of [a, b, c]) {
        if (!s) continue;
        s.cdp?.close(); s.inspector?.close();
        if (!WIN) s.app.kill();
    }
    // The launcher this run started, whatever happened (it holds no state; the host is handled below).
    if (alive(launcherPid)) { try { if (WIN) execFileSync('taskkill', ['/F', '/PID', String(launcherPid)], { stdio: 'ignore', timeout: SYNC_MS }); else process.kill(launcherPid, 'SIGKILL'); } catch { /* gone */ } }
    if (WIN) {
        // THE WINDOWS CLEANUP (Tynn #1031): the app's tree, the host in this run's own record, the providers, the terminal and
        // the second launch, by the helper every row that starts its own Genie uses: the process table read before anything
        // is ended, every taskkill's answer kept, waited for until nothing of this run is in the table, and what is left NAMED.
        // A proven shutdown still goes through it: what "Shut down everything" left behind is this row's failure.
        let endOwnRun = null;
        try { ({ endOwnRun } = await import('./end-own-tree.mjs')); } catch (error) { check(false, 'the Windows cleanup: scripts/end-own-tree.mjs (Tynn #1031) is not in this tree', String(error?.message ?? error).slice(0, 160)); }
        if (endOwnRun) {
            const others = [...agents.map((ag) => ag.pid), terminalPid, secondPid, launcherPid].filter((pid) => Number.isInteger(pid) && pid > 0);
            const ended = await endOwnRun({ app: a?.app ?? null, hostPid: Number.isInteger(hostPid) ? hostPid : (hostRecord()?.pid ?? null), others, since: T0, log: (line) => { console.log(`  ${line}`); } });
            check(ended.ok, 'nothing of this run is left running by its own cleanup', ended.ok ? '' : `LEFT RUNNING by this run's own cleanup: ${ended.words}`);
        } else {
            for (const s of [a, b]) s?.app.kill();
        }
    }
    if (!shutDownProven && !WIN) {
        // A host this run could not end through "Shut down everything" is ended by signal: SIGTERM (its graceful shutdown,
        // which stops its sessions), then SIGKILL; then any provider of ours still standing.
        if (alive(hostPid)) {
            console.log(`  ending the host pid ${hostPid} (SIGTERM, then SIGKILL after 15 s)`);
            try { process.kill(hostPid, 'SIGTERM'); } catch { /* gone */ }
            for (let i = 0; i < 30 && alive(hostPid); i++) await sleep(500);
            if (alive(hostPid)) { try { process.kill(hostPid, 'SIGKILL'); } catch { /* gone */ } }
            console.log(`  host pid ${hostPid}: ${alive(hostPid) ? 'STILL ALIVE' : 'gone'}`);
        }
        for (const ag of agents) if (alive(ag.pid)) { try { process.kill(ag.pid, 'SIGKILL'); console.log(`  ended provider pid ${ag.pid}`); } catch { /* gone */ } }
    }
    rmSync(PROOF, { force: true });
}
/** Every gauge line this run wrote (window and genie-host share the lifecycle log), with its count: a pass shows them too. */
function printGauge() {
    const text = gaugeFrom === null ? '' : readOr(LIFECYCLE).slice(gaugeFrom);
    const lines = text.split('\n').filter((l) => GAUGE.test(l));
    console.log(`\n--- GAUGE: ${lines.length} stall/slow line(s) this run in ${LIFECYCLE} ---`);
    for (const l of lines) console.log(l);
}
function finish() {
    printGauge();
    if (failures.length) {
        console.log(`\nQUIT-KEEPS-HOST FAILED — ${failures.length} check(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
        for (const label of ['first', 'second']) {
            const log = join(OUT, `quit-keeps-host-${label}.log`);
            if (existsSync(log)) { console.log(`\n--- ${log} (last 40 lines) ---`); console.log(readOr(log).split('\n').slice(-40).join('\n')); }
        }
        // Where the window's boot stopped: batch SS on Windows had a window process with DevTools up and no page for 90 s.
        for (const log of [LIFECYCLE, HOST_LOG]) {
            if (existsSync(log)) { console.log(`\n--- ${log} (last 60 lines) ---`); console.log(readOr(log).split('\n').slice(-60).join('\n')); }
        }
        process.exit(1);
    }
    console.log(`\n[${since()}] QUIT KEEPS THE HOST — measured: "Just close the UI" ended the client and kept the launcher, the host and the providers; a new client found every tick; the launcher's tray asked before it stopped anything; "Shut down everything" stopped the host on its own progress and the launcher exited; the next boot read no crash.`);
    process.exit(0);
}
function refuse(why) {
    console.error(`quit-keeps-host: CANNOT RUN — ${why}`);
    process.exit(2);
}

// ================================================================================================================ run
// THE WATCHDOG: a promise nothing settles would otherwise hold the run until the batch's `timeout` kills it, silently.
const watchdog = setTimeout(() => {
    check(false, `WATCHDOG: the run passed ${Math.round(DEADLINE_MS / 1000)} s`, `stuck in step ${current}`);
    setTimeout(() => { console.log('  cleanup did not finish within 60 s; exiting'); process.exit(1); }, 60_000).unref();
    void cleanup('watchdog').finally(finish);
}, DEADLINE_MS);

/**
 * A port the previous Genie should have let go of (batch L3: 9222 "accepts but does not answer" right after vm-smoke ended
 * its window). Named — `ss` and each owner's command line — given 30 s to come free (a window still dying), named again,
 * and if it is STILL held: a failed check (someone holds a dead Genie's port, which is a finding of its own), and this run
 * carries on, on the first free port above, so the same batch still measures what this script is for.
 */
async function freePort(port, label, id) {
    step(id, `is the ${label} port ${port} free? (≤ 3 s)`);
    const busy = await answers(port);
    if (!busy) return port;
    console.log(`  the ${label} port ${port} is held (${busy === true ? 'it answers' : busy}):`);
    console.log(portOwners(port));
    step(`${id}w`, `waiting for the ${label} port ${port} to come free (≤ 30 s)`);
    const freed = await until(async () => !(await answers(port)), 30_000, 1_000);
    if (freed) { console.log(`  the ${label} port ${port} came free`); return port; }
    console.log(`  STILL held after 30 s:`);
    console.log(portOwners(port));
    check(false, `${id}. the ${label} port ${port} is still held after the previous Genie ended (its holder is named above)`);
    for (let p = port + 100; p < port + 200; p++) if (!(await answers(p))) { console.log(`  this run uses the ${label} port ${p} instead`); return p; }
    refuse(`no free ${label} port in ${port + 100}..${port + 199}`);
}
PORT = await freePort(PORT, 'debugger', '0.4');
INSPECT = await freePort(INSPECT, 'inspector', '0.5');

console.log(`\nQUIT KEEPS THE HOST — "Just close the UI" with agents streaming, then open Genie again (deadline ${Math.round(DEADLINE_MS / 1000)} s)\n`);
gaugeFrom = readOr(LIFECYCLE).length;
step('0.5a', `the launcher (${LAUNCHER_SRC}) installs the signed packages into ${CODE_ROOT}`);
if (!existsSync(LAUNCHER_SRC) || !existsSync(PACKAGES)) refuse(`no launcher or packages from the package-tracks row (${LAUNCHER_SRC}, ${PACKAGES})`);
// THE CODE ROOT IS THE USER'S ONLY (the launcher refuses one other accounts can write to). On Windows the run's home is under
// the VM's temp folder, whose D: root gives BUILTIN\Users create rights (native/launcher/tests/common: the same fix): this
// user and SYSTEM only, inherited, as %LOCALAPPDATA% gives a real code root.
if (WIN) {
    mkdirSync(CODE_ROOT, { recursive: true });
    const me = (spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: SYNC_MS }).stdout ?? '').trim().split(',').pop()?.replace(/"/g, '') ?? '';
    if (!/^S-1-5-/.test(me)) refuse(`this user's SID could not be read (${me})`);
    const acl = spawnSync('icacls', [CODE_ROOT, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], { encoding: 'utf8', timeout: SYNC_MS });
    if (acl.status !== 0) refuse(`the code root could not be made private: ${String(acl.stdout ?? '')}${String(acl.stderr ?? '')}`.slice(0, 300));
}
const installed = launcherCli(['install', '--profile', 'both', '--from', PACKAGES, '--yes'], 300_000);
if (installed.code !== 0) refuse(`the launcher did not install the packages: ${installed.out.slice(0, 400)}`);
console.log(`  ${installed.out.split(/\r?\n/).join(' | ')}`);
// The bar before the launcher's icon is in it (Linux): what changes is where the icon went.
if (!WIN) barBefore = screenPixels();
step('0.5b', 'the launcher started (serve, with its tray probe) (≤ 30 s)');
mkdirSync(OUT, { recursive: true });
{
    const log = openSync(LAUNCHER_LOG, 'a');
    const child = spawn(LAUNCHER_SRC, ['serve'], { detached: !WIN, stdio: ['ignore', log, log], windowsHide: false, env: { ...process.env, GENIE_LAUNCHER_TRAY_PROBE: '1' } });
    child.unref();
}
const record = await until(() => { const r = launcherRecord(); return r && alive(r.pid) ? r : null; }, 30_000);
if (!record) refuse(`the launcher did not start: ${readOr(LAUNCHER_LOG).slice(-400)}`);
launcherPid = record.pid;
console.log(`  launcher pid ${launcherPid} on ${record.endpoint}`);
step('0.5c', 'the host, started through the launcher (≤ 90 s)');
const ensured = launcherCli(['ensure-host'], 90_000);
try { launcherHostBuild = JSON.parse(ensured.out.split(/\r?\n/).filter((l) => l.startsWith('{')).pop() ?? 'null')?.build ?? null; } catch { /* said below */ }
if (ensured.code !== 0 || !launcherHostBuild) refuse(`the launcher did not start the host: ${ensured.out.slice(0, 400)}`);
console.log(`  ${ensured.out}`);
step('0.6', `the ticker marker, holding this script's pid ${process.pid}`);
writeFileSync(TICKER, String(process.pid));
let cannot = null;
/** Failures from before the run (a held port, 0.4/0.5) are reported, never mistaken for the run's own controls failing. */
const failuresBeforeRun = failures.length;
/**
 * QUIT_CDP_CARRY_ON=1: a failed agent step or control is a FAIL row, and the run carries on to the quit and the tray with what
 * is running, so one run on a slow VM still answers the tray's question (batch SS on Windows: two runs ended before row 26).
 * The rows that need the agents fail on their own; nothing passes for want of them.
 */
const CARRY_ON = process.env.QUIT_CDP_CARRY_ON === '1';
const carry = async (label, fn) => {
    if (!CARRY_ON) return fn();
    try { return await fn(); } catch (error) { check(false, `${label} (carried on past it)`, String(error?.message ?? error).slice(0, 160)); return undefined; }
};
try {
    // -------------------------------------------------------------------------------- A: three agents streaming
    a = await open('first', 1);
    step('1e', 'reading the seed: its first workspace');
    const snap = await a.cdp.evaluate('window.genieTest.snapshot()', 15_000);
    const workspaceId = snap.workspaces?.[0]?.id ?? null;
    if (typeof workspaceId !== 'string') { cannot = 'no workspace in the seed (run smoke-seed.mjs first)'; throw new Error(cannot); }
    for (let i = 1; i <= AGENTS; i++) {
        const name = `ticker-${i}-${process.pid}`;
        step(`1.${i}`, `adding the codex agent ${name}`);
        const added = await a.cdp.evaluate(`(window.genieTest ?? window.genie).addAgent(${JSON.stringify(workspaceId)}, { name: ${JSON.stringify(name)}, purpose: 'Streams ticks for the quit check.', provider: 'codex' })`, 30_000);
        if (check(added?.ok === true, `1.${i} agent ${name} added`, added?.ok ? added.id : added?.reason)) agents.push({ id: added.id, name });
    }
    for (const ag of agents) await carry(`2-3. ${ag.name}`, async () => {
        step('2', `starting ${ag.name} (≤ 30 s to running)`);
        await waitForPageProbe(a.cdp);
        await a.cdp.evaluate(`window.genieTest.agents.restart(${JSON.stringify(ag.id)}, "graceful"); true`, 15_000);
        const running = await until(() => a.cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(ag.id)}).then((d) => d?.session?.running === true)`, 5_000), 30_000);
        check(running === true, `2. ${ag.name}'s session is running`);
        step('3', `prompting ${ag.name}`);
        const sent = await a.cdp.evaluate(`(window.genieTest ?? window.genie).prompt(${JSON.stringify(ag.id)}, 'Stream ticks until stopped.')`, 15_000);
        check(sent?.ok === true, `3. ${ag.name} took the prompt`, sent?.reason ?? '');
    });
    for (const ag of agents) await carry(`4. ${ag.name}`, async () => {
        step('4', `waiting for ${ag.name}'s ledger to stream 8 ticks (≤ 30 s)`);
        const t = await until(async () => { const x = await ticksOf(a.cdp, ag.id); return x.max >= 8 ? x : null; }, 30_000);
        ag.before = t ?? await ticksOf(a.cdp, ag.id);
        ag.pid = ag.before.pids.length === 1 ? ag.before.pids[0] : null;
        check(ag.pid !== null, `4. ${ag.name}'s ledger is streaming, from ONE provider pid`, `ticks to ${ag.before.max}, pids ${JSON.stringify(ag.before.pids)}`);
    });
    for (const ag of agents) { ag.before ??= { max: 0, size: 0, pids: [] }; ag.pid ??= null; }

    // POSITIVE CONTROL: the pids read above are real, live, and what they say they are — before anything is closed.
    step('5', `positive control: host.json (${HOST_RECORD}) and the process table`);
    hostPid = hostRecord()?.pid ?? null;
    check(alive(hostPid) && /host\.js/.test(commandLine(hostPid)), '5. CONTROL: host.json names a LIVE genie-host process', `pid ${hostPid}: ${commandLine(hostPid).slice(0, 160)}`);
    check(hostPid !== a.windowPid && alive(a.windowPid), '6. CONTROL: the host is not the window process (both live)', `host ${hostPid}, window ${a.windowPid}`);
    const pids = agents.map((ag) => ag.pid);
    check(new Set(pids).size === AGENTS, '7. CONTROL: three DIFFERENT provider pids', JSON.stringify(pids));
    for (const ag of agents) check(alive(ag.pid) && /stub-codex/.test(commandLine(ag.pid)), `8. CONTROL: ${ag.name}'s provider pid ${ag.pid} is a LIVE stub-codex process`, commandLine(ag.pid).slice(0, 120));
    for (const ag of agents) await carry(`9. ${ag.name}`, async () => {
        step('9', `positive control: ${ag.name} is streaming NOW (≤ 10 s)`);
        const later = await until(async () => { const x = await ticksOf(a.cdp, ag.id); return x.max > ag.before.max ? x : null; }, 10_000);
        check(later !== null && later.pids.length === 1 && later.pids[0] === ag.pid, `9. CONTROL: ${ag.name} is streaming NOW (its ledger grew within seconds, same pid)`, `${ag.before.max} → ${later?.max}`);
        ag.before = later ?? ag.before;
    });
    // Only THIS run's setup and controls gate what follows. A port finding at 0.4/0.5 is its own failed check and the run
    // carries on past it on a free port (batch L4 aborted here on it, with every control passing).
    const controlFailures = failures.slice(failuresBeforeRun);
    if (controlFailures.length && !CARRY_ON) throw new Error(`the controls failed (${controlFailures.join('; ')}): nothing after them could mean anything`);
    if (controlFailures.length) console.log(`  CARRYING ON past ${controlFailures.length} failed setup or control row(s), to answer the quit and tray rows with what is running`);

    // A TERMINAL: "Shut down everything" must end it (genie#1508).
    step('9t', 'a terminal open');
    const terminal = await a.cdp.evaluate(`window.genieTest.terminals.open(${JSON.stringify(workspaceId)}, {}).then((t) => ({ id: t.id, pid: t.pid }))`, 30_000);
    terminalPid = Number.isInteger(terminal?.pid) ? terminal.pid : null;
    check(alive(terminal?.pid), '9t. CONTROL: a terminal is open, its pid alive', JSON.stringify(terminal));

    // -------------------------------------------------------------------------------- "Just close the UI": the CLIENT ends
    // (Tynn #1058 L5) The launcher owns the tray: the answer is launcher.closeUi, every client window closes and the client
    // PROCESS ends; the launcher, the host and the providers keep their pids.
    let lifecycleAt = readOr(LIFECYCLE).length;
    const launcherLogAt = readOr(LAUNCHER_LOG).length;
    step('10', 'answering the quit "Just close the UI" (button 1)');
    const took = await answerTheQuit(a.inspector, 1);
    check(took === 'ok', '10. the quit is answered by button 1 (the person\'s click, substituted)', String(took));
    a.inspector = null;
    step('11', 'waiting for the client process to end (≤ 30 s)');
    const clientExit = await exitWithin(a.app, 30_000);
    check(clientExit !== null && !alive(a.windowPid), '11. "Just close the UI" ENDED the client process', clientExit ? `code ${clientExit.code}` : whyStillRunning(a.app, 30_000));
    const q = asked();
    check(JSON.stringify(q?.buttons) === JSON.stringify(['Cancel', 'Just close the UI', 'Shut down everything']), '12. the quit ASKED the two answers, and button 1 was "Just close the UI"', JSON.stringify(q));
    check(alive(launcherPid) && launcherRecord()?.pid === launcherPid, '12l. the LAUNCHER keeps running, the same pid', `pid ${launcherPid}`);
    // The launcher closes every attached client, the one that asked too: whichever word reaches it first is its reason.
    check(/the client ends \((the quit’s answer: Just close the UI|the launcher closed the UI)\)/.test(readOr(LIFECYCLE).slice(lifecycleAt)), '12c. the client said why it ended: the quit’s answer, through the launcher (lifecycle log)');
    check(existsSync(join(GENIE_HOME, 'runtime', 'left-running')), '12m. the host is marked left running (it comes back at logon, P6)');
    a.cdp.close();

    // -------------------------------------------------------------------------------- no client: the tray is the launcher's
    step('14', `no client: waiting ${Math.round(CLOSED_MS / 1000)} s`);
    await sleep(CLOSED_MS);
    check(alive(hostPid) && hostRecord()?.pid === hostPid, `14. with NO client for ${Math.round(CLOSED_MS / 1000)} s, the SAME host is alive`, `pid ${hostPid}`);
    for (const ag of agents) check(alive(ag.pid), `15. with no client, ${ag.name}'s provider is alive`, `pid ${ag.pid}`);
    check(alive(launcherPid), '16. the launcher (the tray) is alive', `pid ${launcherPid}`);
    check(!(await pageOn(PORT)), '17. no page on the debugger port (the client really went)');
    step('17m', 'the launcher\'s tray: its menu, as words, and shown (Windows) for the screenshot');
    const menu = launcherCli(['tray-menu']);
    let items = [];
    try { items = JSON.parse(menu.out).items ?? []; } catch { /* said below */ }
    const header = items.find((i) => i.startsWith('[Host: running')) ?? '';
    const said = Number(/· (\d+) agents?\]/.exec(header)?.[1] ?? 0);
    check(menu.code === 0 && said >= AGENTS && items.includes('Open Genie') && items.includes('Stop host') && items.includes('Shut down everything') && items.includes('Close Genie window (unavailable)'),
        '17m. the TRAY (the launcher\'s) says the host runs the agents, offers Open Genie, Stop this computer\'s host and Shut down everything; Close Genie is unavailable with no window', menu.out.slice(0, 400));
    // Windows: the probe showed the menu at the icon. Linux: a pointer opens Waybar's menu (best effort, said either way).
    const linuxMenu = WIN ? true : openLinuxTrayMenu();
    await sleep(1_500);
    shot(`tray-menu-${WIN ? 'windows' : 'linux'}.png`);
    console.log(`  the tray menu ${linuxMenu ? 'was opened for this screenshot' : 'could not be opened on this desktop: the screenshot shows the bar and its icon only'}`);
    pressKey('Escape');

    // -------------------------------------------------------------------------------- Genie opened again
    lifecycleAt = readOr(LIFECYCLE).length;
    step('18', 'Genie opened again: a NEW client process links to the SAME host (≤ 90 s)');
    b = await open('second', 18);
    check(b.windowPid !== a.windowPid, '18. a NEW client process (the first one ended)', `${a.windowPid} → ${b.windowPid}`);
    check(hostRecord()?.pid === hostPid, '19. the SAME host pid (host.json)', `${hostPid} → ${hostRecord()?.pid}`);
    for (const ag of agents) {
        step('20', `${ag.name} after the reopen: its ledger past tick ${ag.before.max} (≤ 30 s)`);
        const after = await until(async () => { const x = await ticksOf(b.cdp, ag.id); return x.max > ag.before.max ? x : null; }, 30_000) ?? await ticksOf(b.cdp, ag.id);
        check(after.running === true, `20. ${ag.name} is still running`, String(after.running));
        check(after.pids.length === 1 && after.pids[0] === ag.pid && alive(ag.pid), `21. ${ag.name}: the SAME provider pid, alive`, `${ag.pid} → ${JSON.stringify(after.pids)}`);
        const closedTicks = Math.floor(CLOSED_MS / 250 / 2);
        check(after.max - ag.before.max >= closedTicks && after.size > ag.before.size, `22. ${ag.name}'s ledger GREW while no client ran`, `ticks ${ag.before.max} → ${after.max} (≥ ${closedTicks} wanted), ${ag.before.size} → ${after.size} bytes`);
        const gap = contiguous(after.ticks, ag.before.max + 1, after.max);
        check(gap === null, `23. ${ag.name}: every tick streamed while no client ran is in the ledger, in order`, gap === null ? `${ag.before.max + 1}..${after.max}` : `tick ${gap} missing`);
    }
    step('23t', 'the terminal after the reopen');
    const terminalsAfter = await b.cdp.evaluate(`window.genieTest.terminals.list(${JSON.stringify(workspaceId)}).then((l) => l.map((t) => ({ id: t.id, pid: t.pid })))`, 15_000);
    check(alive(terminal.pid) && terminalsAfter.some((t) => t.id === terminal.id && t.pid === terminal.pid), '23t. "Just close the UI" keeps the terminal: the same id and pid after the reopen', JSON.stringify(terminalsAfter));

    // -------------------------------------------------------------------------------- the tray's Close Genie
    step('24', 'the tray\'s Close Genie (launcher.closeUi): the client ends, nothing else (≤ 30 s)');
    await sleep(2_000); // the client attaches to the launcher as it comes up
    const attachedNow = launcherCli(['status', '--json']);
    const closeTray = launcherCli(['tray-act', 'closeUi']);
    check(closeTray.code === 0, '24a. the tray\'s Close Genie was chosen', closeTray.out.slice(0, 200));
    b.inspector?.close?.();
    b.inspector = null;
    const bExit = await exitWithin(b.app, 30_000);
    check(bExit !== null && !alive(b.windowPid), '24. the tray\'s Close Genie ENDED the client process', bExit ? `code ${bExit.code}` : whyStillRunning(b.app, 30_000));
    check(alive(hostPid) && alive(launcherPid) && agents.every((ag) => alive(ag.pid)), '25. and only it: the launcher, the host and every provider alive', attachedNow.out.slice(0, 200));
    b.cdp.close();
    b.cdp = null;

    // -------------------------------------------------------------------------------- the tray's Shut down everything ASKS
    // ALWAYS ASK (the owner, 2026-11-02), in the launcher's own window (direction C). Cancel: nothing stops.
    step('25q', 'the tray\'s Shut down everything ASKS in the launcher\'s window; Escape cancels it');
    const askAt = readOr(LAUNCHER_LOG).length;
    const askTray = launcherCli(['tray-act', 'shutDown']);
    check(askTray.code === 0, '25q. the tray\'s Shut down everything was chosen', askTray.out.slice(0, 200));
    const asking = await until(() => /genie: asking: Shut down everything\?/.test(readOr(LAUNCHER_LOG).slice(askAt)) ? true : null, 20_000);
    check(asking === true, '25r. the launcher ASKED "Shut down everything?" in its own window', readOr(LAUNCHER_LOG).slice(askAt).slice(-300));
    await sleep(2_000);
    shot(`quit-prompt-${WIN ? 'windows' : 'linux'}.png`);
    pressKey('Escape');
    const cancelled = await until(() => /genie: Shut down everything\?: cancelled/.test(readOr(LAUNCHER_LOG).slice(askAt)) ? true : null, 15_000);
    check(cancelled === true, '25s. Escape CANCELLED it (the launcher said so)', readOr(LAUNCHER_LOG).slice(askAt).slice(-300));
    await sleep(2_000);
    check(alive(launcherPid) && alive(hostPid) && agents.every((ag) => alive(ag.pid)), '25t. Cancel stopped NOTHING: the launcher, the host and the providers all alive');

    // -------------------------------------------------------------------------------- Shut down everything, from the quit
    c = await open('third', 26);
    lifecycleAt = readOr(LIFECYCLE).length;
    const hostLogAt = readOr(HOST_LOG).length;
    const crashBefore = crashRecords();
    step('26', `Shut down everything from the client's quit (button 2): the client ends, the launcher stops the host on its own progress, then exits (≤ ${Math.round((AGENT_DRAIN_WAIT_MS + 120_000) / 1000)} s)`);
    const tookShut = await answerTheQuit(c.inspector, 2);
    check(tookShut === 'ok', '26a. the quit is answered by button 2, "Shut down everything"', String(tookShut));
    c.inspector = null;
    const cExit = await exitWithin(c.app, AGENT_DRAIN_WAIT_MS + 60_000);
    check(cExit !== null, '26b. the client process EXITED', cExit ? `code ${cExit.code}` : whyStillRunning(c.app, AGENT_DRAIN_WAIT_MS + 60_000));
    step('27', `waiting for the host pid ${hostPid}, then the launcher pid ${launcherPid}, to end (≤ 180 s)`);
    const hostGone = await until(() => !alive(hostPid), 180_000);
    check(hostGone === true, '27. "Shut down everything" ENDED the host', `pid ${hostPid}`);
    const launcherGone = await until(() => !alive(launcherPid), 60_000);
    check(launcherGone === true, '27l. then the LAUNCHER exited', `pid ${launcherPid}`);
    const launcherSaid = readOr(LAUNCHER_LOG).slice(launcherLogAt);
    check(/shut down everything: the host stopped/.test(launcherSaid) && !/made no progress|was still stopping/.test(launcherSaid), '27g. GRACEFULLY: the launcher waited for the host\'s own stop and never ended it (Tynn #1079)', (launcherSaid.match(/shut down everything: .*/) ?? ['(nothing said)'])[0].slice(0, 200));
    check(existsSync(join(GENIE_HOME, 'runtime', 'clean-exit.json')), '27c. the host wrote its clean-exit marker: its next boot reads no crash', join(GENIE_HOME, 'runtime', 'clean-exit.json'));
    check(/shutting down: /.test(readOr(HOST_LOG).slice(hostLogAt)), '27h. the host ran its own shutdown (its log)');
    check(crashRecords() === crashBefore, '27r. no crash record was written', `${crashBefore} → ${crashRecords()}`);
    for (const ag of agents) {
        step('28', `waiting for ${ag.name}'s provider pid ${ag.pid} to end (≤ 30 s)`);
        const gone = await until(() => !alive(ag.pid), 30_000);
        check(gone === true, `28. and ${ag.name}'s provider (the same gauge reading it dead now)`, `pid ${ag.pid}`);
    }
    step('28t', `waiting for the terminal's pid ${terminal.pid} to end (≤ 30 s)`);
    const terminalGone = await until(() => !alive(terminal.pid), 30_000);
    check(terminalGone === true, '28t. "Shut down everything" ends the terminal (genie#1508)', `pid ${terminal.pid}`);
    check(!existsSync(join(GENIE_HOME, 'runtime', 'left-running')), '28m. everything shut down: the host is not left running');
    shutDownProven = hostGone === true;

    // -------------------------------------------------------------------------------- the next boot reads no crash
    step('29', 'the host started again: its boot reads a clean end (no safe mode)');
    const bootAt = readOr(LIFECYCLE).length + readOr(HOST_LOG).length;
    const again = launcherCli(['ensure-host'], 90_000);
    let againPid = null;
    try { againPid = JSON.parse(again.out.split(/\r?\n/).filter((l) => l.startsWith('{')).pop() ?? 'null')?.pid ?? null; } catch { /* said below */ }
    check(again.code === 0 && alive(againPid), '29a. the host starts again', again.out.slice(0, 200));
    await sleep(5_000);
    const bootSaid = `${readOr(LIFECYCLE)}${readOr(HOST_LOG)}`.slice(bootAt);
    check(!/safe mode: the last run did not end cleanly/.test(`${readOr(LIFECYCLE)}\n${readOr(HOST_LOG)}`.slice(-20_000)), '29. its boot did NOT read a crash (no safe mode): the slow, clean stop was a clean stop', bootSaid.split(/\r?\n/).filter((l) => /safe mode|clean/.test(l)).slice(0, 3).join(' | ') || 'no safe-mode line');
    if (alive(againPid)) {
        const stopped = launcherCli(['stop-host'], 200_000);
        check(stopped.code === 0, '29b. and it stops gracefully again (genie stop-host)', stopped.out.slice(0, 200));
    }
} catch (error) {
    if (cannot === null) check(false, `the run stopped in step ${current}`, String(error?.message ?? error));
}
clearTimeout(watchdog);
await cleanup(failures.length || cannot ? 'after a failure' : 'done');
if (cannot !== null && failures.length === 0) refuse(cannot);
finish();
