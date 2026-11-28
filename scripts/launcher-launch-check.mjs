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
 *   3. the Genie Browser, opened as the person opens it: the tray panel (#1514), opened as a click on the icon opens it
 *      (`launcher.trayPanel`), its words read in its own webview (`launcher.uiProbe`), photographed
 *      -> launch-3-tray-panel-<os>.png, and its "Open Genie Browser" clicked in the page (the item's own handler, which
 *      runs tray::act; the launcher answers these only with GENIE_LAUNCHER_TRAY_PROBE=1, which the row gives it). A NEW process runs `--genie-browser`, its executable the client's program at <build> (the browser
 *      component runs on the client's program, components.rs: its package carries no second copy of the app), its parent
 *      the launcher (never the host: a host that spawned Electron itself is what L4 removed), its window on screen
 *      -> launch-3-browser-<os>.png;
 *   4. side by side: the host and the client are the same pids as before the Browser opened, and all three are alive
 *      -> launch-4-side-by-side-<os>.png;
 *   5. the UI closed ("Just close the UI", the tray's "Close Genie window"): the client gone, the host and the launcher the
 *      same pids, the Browser closed as its window is -> launch-5-ui-closed-<os>.png; then the tray's "Open Genie Browser"
 *      opens a Browser window with no client running, started by the launcher, and starts no client window
 *      -> launch-5-browser-no-client-<os>.png;
 *   6. a host no client window has spoken to: stopped (launcher.stopHost) and started from the tray ("Start this
 *      computer's host") with the UI closed; the tray's "Open Genie Browser" still opens a Browser window, started by the
 *      launcher, and no client window -> launch-6-browser-fresh-host-<os>.png;
 *   7. the launch pad (#1515, `launcher.openPad`): its words (the greeting by the hour, the host's agents and uptime, Genie,
 *      the Genie Browser, Genie Apps, Updates, Settings) -> launch-pad-<os>.png; its Genie "Open" opens a client window and
 *      its Browser "Open" a Browser started by the launcher; the tray panel with two paired hosts listed
 *      -> launch-tray-panel-<os>.png; its "Start when I sign in" turns the logon setting over and back; its "Stop this
 *      computer's host" asks first (-> launch-7-stop-asks-<os>.png) and Cancel leaves the host running; with the UI
 *      closed its "Open Genie" opens a client window -> launch-7-panel-open-genie-<os>.png.
 *      The two screenshots named for the mockup are compared with sandbox/launcher-design/shots/direction-c-{pad,tray}.png.
 *
 *   node scripts/launcher-launch-check.mjs --code <code root> --data <data root> --build <build> --launcher <exe> --out <dir>
 * Prints `### launcher-launch=PASS|FAIL <why>`; exits 1 on a failure.
 */
import { existsSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { WIN, OS, SYNC_MS, run, step, check, sleep, until, alive, executableOf, commandLine, processesNamed, parents, descends, shot, pressKey, wireCall, testMachineOrRefuse, leftClickLinuxTrayIcon, moveCursor } from './launcher-row-lib.mjs';

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

/**
 * THE DESKTOP'S NOTIFICATIONS DISMISSED BEFORE A PHOTOGRAPH. Omarchy's toasts are drawn by quickshell, a layer above every
 * window; run 1128-101943-c231fa photographed the tray panel under four of them. Dismissed through the notification
 * server's own interface: org.freedesktop.Notifications.CloseNotification for each id issued since the session began (the
 * spec's, so any server answers it), then quickshell's own IPC (its running instance named from its command line, in a
 * UTF-8 locale: under "C" it refused, exit 255), then the other daemons' commands. Whether anything is still drawn over
 * the panel is measured, not assumed (`nothingOver`). GENIE_ROW_KEEP_NOTIFICATIONS=1 leaves them up: the red run.
 */
const KEEP_NOTIFICATIONS = process.env.GENIE_ROW_KEEP_NOTIFICATIONS === '1';
const sessionEnv = () => ({ ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}` });
let notifierSaid = false;
function clearNotifications() {
    if (WIN) return;
    if (KEEP_NOTIFICATIONS) {
        {
            for (const n of [1, 2, 3]) {
                const r = spawnSync('busctl', ['--user', 'call', 'org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'Notify', 'susssasa{sv}i', 'genie-row', '0', '', `A toast left up (${n})`, 'The red run: drawn over the tray panel', '0', '0', '0'], { encoding: 'utf8', timeout: 5_000, env: sessionEnv() });
                console.log(`  (a toast posted and left up: exit ${r.status} ${String(r.stdout || r.stderr || '').trim().slice(0, 80)})`);
            }
        }
        notifierSaid = true;
        spawnSync('sleep', ['1']);
        return;
    }
    const said = [];
    let closed = 0;
    let last = '';
    for (let id = 1; id <= 200; id++) {
        const r = spawnSync('busctl', ['--user', 'call', 'org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'CloseNotification', 'u', String(id)], { encoding: 'utf8', timeout: 3_000, env: sessionEnv() });
        if (r.status === 0) closed++; else last = String(r.stderr || r.error?.code || `exit ${r.status}`).trim().slice(0, 120);
    }
    said.push(`CloseNotification answered for ${closed} of ids 1-200${last ? ` (else: ${last})` : ''}`);
    for (const call of quickshellDismissers()) {
        const r = spawnSync(call[0], call.slice(1), { encoding: 'utf8', timeout: 5_000, env: sessionEnv() });
        said.push(`${call.join(' ')}: exit ${r.status ?? r.error?.code}`);
    }
    for (const [cmd, ...args] of [['makoctl', 'dismiss', '--all'], ['swaync-client', '--close-all'], ['dunstctl', 'close-all']]) {
        const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5_000, env: sessionEnv() });
        if (r.status === 0) said.push(`${cmd} ${args.join(' ')}: done`);
    }
    if (!notifierSaid) console.log(`  (notifications: ${said.join('; ')})`);
    notifierSaid = true;
    spawnSync('sleep', ['0.6']);
}
/** quickshell's own IPC calls that dismiss notifications: its running instance named by the config on its command line,
 * `qs ipc show` read for a target named for notifications and a function that dismisses, clears or closes them. */
let qsCalls = null;
function quickshellDismissers() {
    if (qsCalls) return qsCalls;
    qsCalls = [];
    const where = [];
    for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
        let argv = [];
        try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
        if (!/(^|\/)(qs|quickshell)$/.test(argv[0] ?? '')) continue;
        console.log(`  (quickshell runs: ${argv.join(' ')})`);
        for (let i = 1; i < argv.length; i++) if (['-c', '--config', '-p', '--path'].includes(argv[i]) && argv[i + 1]) where.push([argv[i], argv[i + 1]]);
        where.push(['--pid', pid]);
        break;
    }
    for (const w of [...where, []]) {
        const r = spawnSync('qs', ['ipc', ...w, 'show'], { encoding: 'utf8', timeout: 5_000, env: sessionEnv() });
        console.log(`  (qs ipc ${w.join(' ')} show: exit ${r.status ?? r.error?.code} ${String(r.stdout || r.stderr || '').replace(/\s+/g, ' ').slice(0, 500)})`);
        if (r.status !== 0 || !String(r.stdout).trim()) continue;
        let target = null;
        for (const line of String(r.stdout).split('\n')) {
            const t = /^\s*target\s+(\S+)/.exec(line);
            if (t) { target = t[1]; continue; }
            const f = /^\s*function\s+(\w+)\(\s*\)/.exec(line);
            if (f && target && /notif/i.test(target) && /dismiss|clear|close/i.test(f[1])) qsCalls.push(['qs', 'ipc', ...w, 'call', target, f[1]]);
        }
        break;
    }
    return qsCalls;
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
    for (const f of ['genie-browser.log', 'genie-launcher.log', 'genie-launcher-ui.log']) {
        const p = join(data, 'logs', f);
        if (!existsSync(p)) { console.log(`--- ${p}: none`); continue; }
        const lines = readFileSync(p, 'utf8').split(/\r?\n/);
        console.log(`--- ${p} (last 40 lines)\n${lines.slice(-40).join('\n')}`);
    }
}
/**
 * Every live process running `program` (the client's: its window, the Browser, their Chromium children), by the OS's own
 * record of each process's executable: /proc/<pid>/exe on Linux, Win32_Process.ExecutablePath on Windows (the path given
 * in the environment, never quoted into the query). Not by command line: a needle in a command line read the running
 * client as absent (item 1128-044254-abfe17), so every "none" here rides on a positive control in the same run.
 */
function programsRunning(program) {
    if (!WIN) {
        const out = [];
        for (const name of readdirSync('/proc')) {
            if (!/^\d+$/.test(name)) continue;
            let target = '';
            try { target = readlinkSync(`/proc/${name}/exe`); } catch { continue; }
            if (target === program) out.push(Number(name));
        }
        return out;
    }
    try {
        const listed = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$p = $env:GENIE_ROW_PROGRAM; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $p } | ForEach-Object { $_.ProcessId }'], { encoding: 'utf8', timeout: 120_000, windowsHide: true, env: { ...process.env, GENIE_ROW_PROGRAM: program } });
        return listed.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
    } catch (e) {
        console.log(`  (the process table could not be read: ${String(e.message).slice(0, 120)})`);
        return null;
    }
}
const clientPrograms = async () => (programsRunning(exe('client', 'genie-client')) ?? []).filter((p) => alive(p)).map((pid) => ({ pid }));
/** The Browser closed as its window is (SIGTERM; taskkill without /F), ended only when that does not close it. */
async function closeBrowser(pid) {
    if (!alive(pid)) return true;
    if (WIN) spawnSync('taskkill', ['/PID', String(pid)], { timeout: SYNC_MS, windowsHide: true });
    else { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    if (await until(() => !alive(pid), 20_000, 500)) return true;
    console.log(`  (the Browser ${pid} had to be ended)`);
    if (WIN) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: SYNC_MS, windowsHide: true });
    else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    return Boolean(await until(() => !alive(pid), 10_000, 500));
}

/**
 * THE TRAY PANEL AND THE LAUNCH PAD (#1514, #1515): what their pages say, read in their own webviews (`launcher.uiProbe`:
 * the page's innerText and its items, as it reported them after its last draw), never the launcher's model alone.
 */
const PANEL_WORDS = ['Genie', 'This computer’s host · running', 'Open Genie', 'Open Genie Browser', 'Hosts', 'This computer', 'Stop this computer’s host', 'Updates', 'Start when I sign in', 'Close Genie', 'Shut down everything'];
const panelText = (p) => String(p?.shown?.text ?? '');
/** innerText applies the page's CSS (the HOSTS label is upper case on screen): compared without case. */
const panelSays = (p, words) => panelText(p).toLowerCase().includes(words.toLowerCase());
const panelItem = (p, id) => (p?.shown?.items ?? []).find((i) => i.id === id) ?? null;
async function openSurface(method, surface) {
    const asked = await wireCall(runtime, method);
    if (!asked.ok) { console.log(`  ${method}: ${asked.reason}`); return null; }
    if (method === 'launcher.trayPanel') console.log(`  the panel's items (the launcher's model): ${JSON.stringify(asked.value?.items)}`);
    return until(async () => { const p = await wireCall(runtime, 'launcher.uiProbe', [{ surface }]); return p.ok && p.value?.open && p.value?.shown ? p.value : null; }, 20_000, 500);
}
const openPanel = () => openSurface('launcher.trayPanel', 'panel');
/**
 * THE PANEL IS ON SCREEN AND IN FRONT, BY THE WINDOW SYSTEM'S OWN WORD (not the page's, not the launcher's): Hyprland's
 * client list and active window on Linux; user32 on Windows (FindWindow "Genie tray": visible, topmost, the launcher's,
 * inside the work area against the taskbar). Its size is the page's own. With `click` (a real click on the tray icon), it
 * opened by that click, under the bar. A panel whose page loaded but whose window never showed fails here (the red run).
 */
function hypr(args) {
    const r = spawnSync('hyprctl', ['-i', '0', '-j', ...args], { encoding: 'utf8', timeout: SYNC_MS });
    try { return JSON.parse(r.stdout); } catch { return null; }
}
function winPanel() {
    const ps = join(run.out, 'panel-window.ps1');
    writeFileSync(ps, [
        'Add-Type @"',
        'using System; using System.Runtime.InteropServices;',
        'public static class GW {',
        '  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }',
        '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);',
        '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
        '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);',
        '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);',
        '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
        '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
        '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
        '  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);',
        '  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);',
        '  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int DwmGetWindowRect(IntPtr h, int a, out R v, int size);',
        '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);',
        '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);',
        '}',
        '"@',
        '[GW]::SetProcessDPIAware() | Out-Null',
        'Add-Type -AssemblyName System.Windows.Forms',
        // [NullString]::Value, not $null: PowerShell hands $null to a string parameter as "", and FindWindow("", …) matches no
        // class (run 1128-101927-62aca8 read a panel that was on screen as absent).
        "$h = [GW]::FindWindow([NullString]::Value, 'Genie tray')",
        "if ($h -eq [IntPtr]::Zero) { 'none'; exit 0 }",
        '$r = New-Object GW+R; [GW]::GetWindowRect($h, [ref]$r) | Out-Null',
        '$frame = "$($r.L),$($r.T)-$($r.Ri),$($r.B)"',
        '$v = New-Object GW+R; if ([GW]::DwmGetWindowRect($h, 9, [ref]$v, 16) -eq 0 -and $v.Ri -gt $v.L) { $r = $v }',
        '$p = [uint32]0; [GW]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null',
        '$wa = [System.Windows.Forms.Screen]::FromHandle($h).WorkingArea',
        '$over = @(); $o = [GW]::GetWindow($h, 3)',
        'while ($o -ne [IntPtr]::Zero) {',
        '  if ([GW]::IsWindowVisible($o)) {',
        '    $c = 0; [GW]::DwmGetWindowAttribute($o, 14, [ref]$c, 4) | Out-Null',
        '    $q = New-Object GW+R; [GW]::GetWindowRect($o, [ref]$q) | Out-Null',
        '    if ($c -eq 0 -and $q.Ri -gt $q.L -and $q.B -gt $q.T -and $q.L -lt $r.Ri -and $r.L -lt $q.Ri -and $q.T -lt $r.B -and $r.T -lt $q.B) {',
        '      $cn = New-Object System.Text.StringBuilder 256; [GW]::GetClassName($o, $cn, 256) | Out-Null',
        '      $tn = New-Object System.Text.StringBuilder 256; [GW]::GetWindowText($o, $tn, 256) | Out-Null',
        '      $over += "$($cn.ToString()) [$($tn.ToString())] $($q.L),$($q.T)-$($q.Ri),$($q.B)"',
        '    }',
        '  }',
        '  $o = [GW]::GetWindow($o, 3)',
        '}',
        '@{ visible = [GW]::IsWindowVisible($h); left = $r.L; top = $r.T; right = $r.Ri; bottom = $r.B; topmost = (([GW]::GetWindowLong($h, -20) -band 8) -ne 0); pid = $p; foreground = ([GW]::GetForegroundWindow() -eq $h); over = $over; frame = $frame; work = @{ left = $wa.Left; top = $wa.Top; right = $wa.Right; bottom = $wa.Bottom } } | ConvertTo-Json -Compress',
    ].join('\r\n'));
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const out = String(r.stdout ?? '').trim();
    if (out === 'none') return { none: true };
    try { return JSON.parse(out.split(/\r?\n/).pop()); } catch { return { error: `${out.slice(0, 200)} ${String(r.stderr ?? '').slice(0, 200)}` }; }
}
async function panelOnScreen(label, page, click = null) {
    const want = { w: Number(page?.shown?.w ?? 0), h: Number(page?.shown?.h ?? 0) };
    if (!WIN) {
        let seen = null;
        await until(() => { const list = hypr(['clients']) ?? []; seen = list.find((c) => c.pid === launcherPidNow && c.title === 'Genie tray' && c.mapped !== false && c.hidden !== true) ?? null; return seen; }, 10_000, 500);
        console.log(`  ${label}: Hyprland lists the panel: ${JSON.stringify(seen && { at: seen.at, size: seen.size, floating: seen.floating, address: seen.address })}`);
        check(Boolean(seen), `${label}: the tray panel's window is on screen (Hyprland lists it mapped)`);
        if (!seen) return null;
        const active = hypr(['activewindow']);
        check(active?.address === seen.address, `${label}: the tray panel is in front (Hyprland's active window)`, `active ${active?.title} ${active?.address}`);
        check(seen.floating === true, `${label}: the tray panel floats over the tiled windows`);
        // The layers above the windows, for the record: Omarchy's are full-screen and mostly clear (its bar 1280x720,
        // its notifications a full-height strip: run 1128-103822-569d52), so their rectangles say nothing of what they draw.
        const meet = (x, y, w, h) => w > 0 && h > 0 && x < seen.at[0] + seen.size[0] && seen.at[0] < x + w && y < seen.at[1] + seen.size[1] && seen.at[1] < y + h;
        const layersMeeting = [];
        for (const m of Object.values(hypr(['layers']) ?? {})) for (const level of ['2', '3']) for (const l of m?.levels?.[level] ?? []) if (meet(l.x, l.y, l.w, l.h)) layersMeeting.push(`${l.namespace} ${l.x},${l.y} ${l.w}x${l.h}`);
        console.log(`  ${label}: layers above the windows whose rectangles meet the panel's: ${layersMeeting.join('; ') || 'none'}`);
        clearNotifications(); // dismissed (or, in the red run, fresh toasts posted) right before the panel is measured
        const px = panelPixels(seen.at[0], seen.at[1], seen.size[0], seen.size[1]);
        check(px.ok && px.off <= px.n * 0.03, `${label}: nothing is drawn over the panel (its own edge pixels are its own colour)`, px.ok ? `${px.off} of ${px.n} edge pixels are not the panel's #100c28${px.first ? `, e.g. ${px.first}` : ''}` : px.why);
        check(Math.abs(seen.size[0] - want.w) <= 4 && Math.abs(seen.size[1] - want.h) <= 4, `${label}: the panel's window is its page's size`, `window ${seen.size}, page ${want.w}x${want.h}`);
        const mon = (hypr(['monitors']) ?? []).find((m) => m.focused) ?? {};
        const top = Number(mon.y ?? 0) + Number(mon.reserved?.[1] ?? 0);
        const right = Number(mon.x ?? 0) + Number(mon.width ?? 0) / Number(mon.scale || 1);
        const bottom = Number(mon.y ?? 0) + Number(mon.height ?? 0) / Number(mon.scale || 1);
        const left = Number(mon.x ?? 0);
        check(seen.at[0] >= left && seen.at[1] >= top && seen.at[0] + seen.size[0] <= right && seen.at[1] + seen.size[1] <= bottom, `${label}: the panel lies wholly on the screen, under the bar`, `panel ${seen.at} ${seen.size}, work ${left},${top}-${right},${bottom}`);
        if (click) {
            check(seen.at[1] >= top && seen.at[1] <= top + 24, `${label}: it opened just under the bar it was clicked in`, `top ${seen.at[1]}, the bar ends at ${top}`);
            const spans = click.x >= seen.at[0] - 8 && click.x <= seen.at[0] + seen.size[0] + 8;
            check(spans || seen.at[0] + seen.size[0] >= right - 24, `${label}: it opened by the click (over it, or against the screen's edge)`, `click ${click.x}, panel ${seen.at[0]}..${seen.at[0] + seen.size[0]}, screen right ${right}`);
        }
        return seen;
    }
    let w = null;
    await until(() => { w = winPanel(); return w?.visible ? w : null; }, 10_000, 1_000);
    console.log(`  ${label}: user32 says of "Genie tray": ${JSON.stringify(w)}`);
    check(w?.visible === true, `${label}: the tray panel's window is on screen (user32: visible)`);
    if (!w?.visible) return null;
    check(Number(w.pid) === launcherPidNow, `${label}: it is the launcher's window`, `pid ${w.pid}`);
    check(w.topmost === true, `${label}: the tray panel is in front (topmost)`);
    const k = (w.right - w.left) / Math.max(1, want.w);
    check(want.w > 0 && Math.abs((w.bottom - w.top) - want.h * k) <= 4, `${label}: the panel's window is its page's size`, `window ${w.right - w.left}x${w.bottom - w.top}, page ${want.w}x${want.h}`);
    const inside = w.left >= w.work.left && w.right <= w.work.right && w.top >= w.work.top && w.bottom <= w.work.bottom;
    check(inside && w.work.bottom - w.bottom <= 40, `${label}: it sits on the taskbar, inside the work area`, `panel ${w.left},${w.top}-${w.right},${w.bottom}, work ${JSON.stringify(w.work)}`);
    const overW = [].concat(w.over ?? []).filter(Boolean);
    check(overW.length === 0, `${label}: nothing is drawn over the panel (no visible window above it meets it)`, overW.join('; '));
    return w;
}
let launcherPidNow = 0;
/**
 * THE PANEL'S OWN PIXELS, AS PHOTOGRAPHED (Linux): its rectangle captured from the screen (grim -g), and every pixel of its
 * padding bands (left, right, top and bottom, inside its border and clear of its rounded corners), where the page paints
 * nothing but its background, #100c28, compared with that colour. A toast, a tooltip or any window drawn over the panel
 * changes them. Tolerance 12 a channel (the compositor's own rounding).
 */
function panelPixels(x, y, w, h) {
    const r = spawnSync('grim', ['-g', `${x},${y} ${w}x${h}`, '-t', 'ppm', '-'], { maxBuffer: 32 * 1024 * 1024, timeout: SYNC_MS, encoding: 'buffer' });
    if (r.status !== 0 || !r.stdout || r.stdout.length < 16) return { ok: false, why: `grim -g: exit ${r.status} ${String(r.stderr ?? '').slice(0, 120)}` };
    const buf = r.stdout;
    const fields = [];
    let i = 0;
    const space = (b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
    while (fields.length < 4 && i < buf.length) { while (space(buf[i])) i++; let j = i; while (j < buf.length && !space(buf[j])) j++; fields.push(buf.subarray(i, j).toString('latin1')); i = j; }
    const [magic, W, H] = [fields[0], Number(fields[1]), Number(fields[2])];
    if (magic !== 'P6') return { ok: false, why: `not a PPM (${magic})` };
    const px = buf.subarray(i + 1);
    const at = (u, v) => { const k = (v * W + u) * 3; return [px[k], px[k + 1], px[k + 2]]; };
    const want = [0x10, 0x0c, 0x28];
    let n = 0;
    let off = 0;
    let first = null;
    const look = (u, v) => {
        if (u < 0 || v < 0 || u >= W || v >= H) return;
        n++;
        const got = at(u, v);
        if (got.some((c, k) => Math.abs(c - want[k]) > 12)) { off++; if (!first) first = `(${u},${v}) rgb(${got.join(',')})`; }
    };
    for (let v = 18; v < H - 18; v++) for (const u of [2, 3, 4, W - 5, W - 4, W - 3]) look(u, v);
    for (let u = 18; u < W - 18; u++) for (const v of [2, 3, H - 4, H - 3]) look(u, v);
    return { ok: n > 0, why: 'no pixels read', n, off, first };
}
/** Mockup sample words that must never be in the panel unless the machine really has them (direction-c-tray.png). */
const MOCKUP_SAMPLES = ['Studio desktop', 'Build box', 'studio-desktop', 'build-box', 'asleep'];
/**
 * THE PANEL'S HOSTS ARE THIS MACHINE'S OWN: "This computer" (it has a host) and each address it paired with
 * (<runtime>/device-hosts.json, read here, not asked of the launcher), named by its address's host; nothing else. No
 * mockup sample word anywhere in it, and no label cut short.
 */
function panelHostsAreReal(label, page) {
    let paired = [];
    try { paired = JSON.parse(readFileSync(join(runtime, 'device-hosts.json'), 'utf8')).hosts ?? []; } catch { paired = []; }
    const nameOf = (u) => { try { return new URL(u.includes('://') ? u : `http://${u}`).hostname; } catch { return u; } };
    const want = ['This computer', ...paired.filter((u) => typeof u === 'string' && u).map(nameOf)];
    const got = (page?.shown?.items ?? []).filter((i) => String(i.id ?? '').startsWith('host:')).map((i) => i.name ?? i.label);
    console.log(`  ${label}: the machine's hosts ${JSON.stringify(want)}; the panel lists ${JSON.stringify(got)}`);
    check(JSON.stringify(got) === JSON.stringify(want), `${label}: the panel lists exactly this machine's hosts`, `machine ${JSON.stringify(want)}, panel ${JSON.stringify(got)}`);
    const text = panelText(page);
    const samples = MOCKUP_SAMPLES.filter((w) => text.includes(w));
    check(samples.length === 0, `${label}: the panel says none of the mockup's sample hosts`, samples.join(', '));
    check(Array.isArray(page?.shown?.clipped) && page.shown.clipped.length === 0, `${label}: no label of the panel is cut short`, JSON.stringify(page?.shown?.clipped));
}
/** Where the window system put the launcher's windows (Hyprland's own list; on Windows the screenshot says). */
function launcherWindows(pid) {
    if (WIN) return;
    const r = spawnSync('hyprctl', ['-j', 'clients'], { encoding: 'utf8', timeout: SYNC_MS });
    try { for (const c of JSON.parse(r.stdout).filter((c) => c.pid === pid)) console.log(`  window "${c.title}": at ${JSON.stringify(c.at)}, size ${JSON.stringify(c.size)}, floating ${c.floating}`); } catch { console.log('  (hyprctl clients said nothing)'); }
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
launcherPidNow = launcherPid;
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
// The tray panel (#1514), opened as a click on the icon opens it, its words read in its own webview, photographed, and its
// "Open Genie Browser" clicked in the page as a person clicks it.
const panel3 = await openPanel();
check(Boolean(panel3), 'the tray panel opened and its page said what it shows', panel3 ? '' : 'nothing within 20 s');
for (const words of PANEL_WORDS) check(panelSays(panel3, words), `the tray panel says "${words}"`, panelText(panel3));
check(panelItem(panel3, 'openBrowser')?.enabled === true, 'the tray panel offers "Open Genie Browser"', JSON.stringify(panel3?.items ?? null));
panelHostsAreReal('step 3', panel3);
await sleep(1_200);
await panelOnScreen('step 3', panel3);
photograph(`launch-3-tray-panel-${OS}.png`);
const acted = await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'panel', click: 'openBrowser' }]);
check(acted.ok && acted.value?.clicked === true, 'the tray panel\'s "Open Genie Browser" was clicked', acted.ok ? JSON.stringify(acted.value?.clicked) : acted.reason);
check(Boolean(await until(async () => { const p = await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'panel' }]); return p.ok && p.value?.open === false ? true : null; }, 10_000, 500)), 'the tray panel closed once its item was chosen, as a menu does');
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

// ---------------------------------------------------------------- 5. the UI closed: the tray still opens the Browser
// "Just close the UI" (the tray's "Close Genie window", control::close_ui): every client goes, the host and the launcher
// stay. The Browser is closed too, as a person closes its window (a graceful end: SIGTERM, taskkill without /F). Then the
// tray's "Open Genie Browser" opens a Browser window with no client running: started by the launcher, its window on
// screen, and no client window started for it.
step(5, 'the UI closed (the host and the launcher left running), the tray opens the Genie Browser');
// The gauge first: it finds the client window that runs now, so "none" after is a measurement (RULES: a gauge that reads one).
const control5 = await clientPrograms();
check(control5.some((p) => p.pid === clientPid), 'the gauge finds the running client window (a positive control)', control5.map((p) => p.pid).join(', '));
const closed = await wireCall(runtime, 'launcher.trayAct', [{ action: 'closeUi' }]);
check(closed.ok, 'the tray\'s "Close Genie window" was chosen', closed.ok ? JSON.stringify(closed.value) : closed.reason);
const clientGone = await until(() => !alive(clientPid), 30_000, 500);
check(Boolean(clientGone), 'the client window closed', `pid ${clientPid}`);
check(await closeBrowser(browserPid), 'the Browser closed', `pid ${browserPid}`);
const quiet = await wireCall(runtime, 'launcher.status');
const clientsLeft = (await clientPrograms()).map((p) => p.pid);
check(quiet.ok && Number(quiet.value.host?.pid) === hostPid && alive(hostPid), 'the host is left running, the same pid', `before ${hostPid}, now ${quiet.ok ? quiet.value.host?.pid : quiet.reason}`);
check(quiet.ok && Number(quiet.value.launcher?.pid) === launcherPid && alive(launcherPid), 'the launcher is left running, the same pid');
check(quiet.ok && (quiet.value.clients ?? []).length === 0, 'no client is attached to the launcher', JSON.stringify(quiet.ok ? quiet.value.clients : null));
check(clientsLeft.length === 0, 'no client program runs (no window, no Browser)', clientsLeft.join(', '));
photograph(`launch-5-ui-closed-${OS}.png`);
const before5 = new Set((await browserMains()).map((p) => p.key));
const acted5 = await wireCall(runtime, 'launcher.trayAct', [{ action: 'openBrowser' }]);
check(acted5.ok, 'the tray\'s "Open Genie Browser" was chosen with no client running', acted5.ok ? JSON.stringify(acted5.value) : acted5.reason);
const started5 = await until(async () => (await browserMains()).find((p) => !before5.has(p.key)) ?? null, 30_000, 1_000);
check(Boolean(started5), 'a new Genie Browser process started within 30 s with no client running', started5 ? `pid ${started5.pid}` : 'none');
if (started5) {
    check(samePath(executableOf(started5.pid), exe('client', 'genie-client')), 'the Browser runs the client\'s program', executableOf(started5.pid));
    check(started5.ppid === launcherPid, 'the Browser\'s parent is the launcher', `ppid ${started5.ppid}, launcher ${launcherPid}, host ${hostPid}`);
    const win5 = await windowOnScreen(started5.pid, 45_000);
    check(win5.windows.length > 0, 'the Browser\'s window is on screen with no client running', win5.error ?? JSON.stringify(win5.windows));
}
const tree5 = parents();
const windowsNow = (await clientPrograms()).filter((p) => !(started5 && (p.pid === started5.pid || descends(p.pid, started5.pid, tree5))));
check(windowsNow.length === 0, 'no client window was started for it', windowsNow.map((p) => p.pid).join(', '));
check(alive(hostPid), 'the host is still the same pid', `pid ${hostPid}`);
photograph(`launch-5-browser-no-client-${OS}.png`);

// ---------------------------------------------------------------- 6. a host that never saw a client window
// The host stopped and started again with the UI closed (a person who stops and starts it from the tray; a logon that
// starts the host alone): no client window has told this host anything. The tray's "Open Genie Browser" still opens a
// Browser window. The stop is asked on the launcher's wire (launcher.stopHost): the tray's "Stop host" asks a question
// first, which a row cannot answer; the start is the tray's own "Start this computer's host".
step(6, 'the host restarted with no client, the tray opens the Genie Browser');
if (started5) check(await closeBrowser(started5.pid), 'the Browser from step 5 closed', `pid ${started5.pid}`);
const stopped = await wireCall(runtime, 'launcher.stopHost', [], 120_000);
check(stopped.ok, 'the host was stopped (launcher.stopHost)', stopped.ok ? JSON.stringify(stopped.value) : stopped.reason);
check(Boolean(await until(() => !alive(hostPid), 60_000, 500)), 'the old host is gone', `pid ${hostPid}`);
const startedHost = await wireCall(runtime, 'launcher.trayAct', [{ action: 'startHost' }]);
check(startedHost.ok, 'the tray\'s "Start this computer\'s host" was chosen', startedHost.ok ? JSON.stringify(startedHost.value) : startedHost.reason);
const fresh = await until(async () => { const st = await wireCall(runtime, 'launcher.status'); const pid = Number(st.ok ? st.value.host?.pid : 0); return st.ok && st.value.host?.running && pid !== hostPid && alive(pid) ? pid : null; }, 120_000, 1_000);
check(Boolean(fresh), 'a new host runs, started by the tray', fresh ? `pid ${fresh}` : 'none within 120 s');
if (fresh) check(samePath(executableOf(fresh), exe('host', 'genie-host')), `the new host runs from ${join(code, 'host', build)}`, executableOf(fresh));
const none6 = await clientPrograms();
check(none6.length === 0, 'no client program runs: no window has spoken to this host', none6.map((p) => p.pid).join(', '));
const before6 = new Set((await browserMains()).map((p) => p.key));
const acted6 = await wireCall(runtime, 'launcher.trayAct', [{ action: 'openBrowser' }]);
check(acted6.ok, 'the tray\'s "Open Genie Browser" was chosen', acted6.ok ? JSON.stringify(acted6.value) : acted6.reason);
const started6 = await until(async () => (await browserMains()).find((p) => !before6.has(p.key)) ?? null, 45_000, 1_000);
check(Boolean(started6), 'a new Genie Browser process started within 45 s for a host no window has spoken to', started6 ? `pid ${started6.pid}` : 'none');
if (started6) {
    check(started6.ppid === launcherPid, 'the Browser\'s parent is the launcher', `ppid ${started6.ppid}, launcher ${launcherPid}, host ${fresh}`);
    const win6 = await windowOnScreen(started6.pid, 45_000);
    check(win6.windows.length > 0, 'the Browser\'s window is on screen', win6.error ?? JSON.stringify(win6.windows));
}
const tree6 = parents();
const windows6 = (await clientPrograms()).filter((p) => !(started6 && (p.pid === started6.pid || descends(p.pid, started6.pid, tree6))));
check(windows6.length === 0, 'no client window was started for it', windows6.map((p) => p.pid).join(', '));
photograph(`launch-6-browser-fresh-host-${OS}.png`);

// ---------------------------------------------------------------- 7. the launch pad and the tray panel drive Genie
// The launch pad (#1515), the launcher's own window (`launcher.openPad`, as the panel's header opens it): its words read in
// its webview and photographed beside the mockup's; its Genie "Open" opens a client window and its Browser "Open" a
// Browser. Then the tray panel (#1514), with two paired hosts on its list (addresses in device-hosts.json, as pairing
// writes them; .invalid, so nothing is reached): its words, its photograph, its "Start when I sign in" turned over and
// back (the logon setting), its "Stop this computer's host" asking first (Cancel leaves the host as it was), and its
// "Open Genie" opening a client window with the UI closed.
step(7, 'the launch pad and the tray panel open Genie and the Genie Browser');
const hostNow = fresh ?? hostPid;
const pad = await openSurface('launcher.openPad', 'pad');
check(Boolean(pad), 'the launch pad opened and its page said what it shows', pad ? '' : 'nothing within 20 s');
const padText = String(pad?.shown?.text ?? '');
console.log(`  the launch pad says: ${padText.replace(/\s*\n\s*/g, ' | ')}`);
const hour = Number(pad?.shown?.hour);
const greeting = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
check(padText.includes(greeting), `the launch pad greets by this computer's time of day ("${greeting}", hour ${hour})`, padText.split('\n')[1] ?? '');
for (const words of ['Everything is running.', 'This computer’s host', 'Running', 'Genie', 'Your workspaces and agents', 'Genie Browser', 'Browse alongside your agents', 'Genie Apps', 'Coming soon', 'Apps you add to Genie will show up here, ready to open.', 'Settings']) {
    check(padText.includes(words), `the launch pad says "${words}"`);
}
check(/(No agents working|\d+ agents? working) · up (less than a minute|\d+ min|\d+ hours?|\d+ days?)/.test(padText), 'the host card says its agents and its uptime, from the launcher', padText.match(/[^\n]*working[^\n]*/)?.[0] ?? '');
check(/Updates?( ready)?/.test(padText), 'the launch pad offers its updates');
check(Array.isArray(pad?.shown?.clipped) && pad.shown.clipped.length === 0, 'no label of the launch pad is cut short', JSON.stringify(pad?.shown?.clipped));
for (const id of ['openGenie', 'openBrowser', 'stopHost', 'updates', 'openSettings']) check(Boolean((pad?.shown?.items ?? []).find((i) => i.id === id && i.enabled !== false)), `the launch pad offers ${id}`);
launcherWindows(launcherPid);
await sleep(1_500);
photograph(`launch-pad-${OS}.png`);
// The pad's Genie "Open": a client window, attached, on screen.
const padGenie = await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'pad', click: 'openGenie' }]);
check(padGenie.ok && padGenie.value?.clicked === true, 'the launch pad\'s Genie "Open" was clicked');
const client7 = await until(async () => { const st = await wireCall(runtime, 'launcher.status'); const pids = (st.ok ? st.value.clients ?? [] : []).map(Number).filter((p) => alive(p) && samePath(executableOf(p), exe('client', 'genie-client'))); return pids[0] ?? null; }, 60_000, 1_000);
check(Boolean(client7), 'a client window opened from the launch pad, attached to the launcher', client7 ? `pid ${client7}` : 'none within 60 s');
if (client7) check((await windowOnScreen(client7, 30_000)).windows.length > 0, 'its window is on screen');
// The pad's Browser "Open": a new Browser, started by the launcher.
if (started6) check(await closeBrowser(started6.pid), 'the Browser from step 6 closed', `pid ${started6.pid}`);
const before7 = new Set((await browserMains()).map((p) => p.key));
await wireCall(runtime, 'launcher.openPad');
await sleep(1_000);
const padBrowser = await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'pad', click: 'openBrowser' }]);
check(padBrowser.ok && padBrowser.value?.clicked === true, 'the launch pad\'s Genie Browser "Open" was clicked');
const started7 = await until(async () => (await browserMains()).find((p) => !before7.has(p.key)) ?? null, 45_000, 1_000);
check(Boolean(started7), 'a new Genie Browser started from the launch pad', started7 ? `pid ${started7.pid}` : 'none within 45 s');
if (started7) {
    check(started7.ppid === launcherPid, 'the Browser\'s parent is the launcher', `ppid ${started7.ppid}, launcher ${launcherPid}`);
    check((await windowOnScreen(started7.pid, 45_000)).windows.length > 0, 'the Browser\'s window is on screen');
}
await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'pad', close: true }]);
// The panel, with the client window and the Browser open and two paired hosts listed.
// On Linux as a person opens it: a left click on Genie's icon in Omarchy's Waybar tray (its drawer opened first). The
// desktop's notifications (which draw over every window) are dismissed first, so the photograph shows the panel whole.
clearNotifications();
let panel7 = null;
let click7 = null;
if (!WIN) {
    click7 = await leftClickLinuxTrayIcon(async () => {
        panel7 = await until(async () => { const q = await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'panel' }]); return q.ok && q.value?.open && q.value?.shown ? q.value : null; }, 5_000, 500);
        return Boolean(panel7);
    });
    check(Boolean(click7), "the tray panel opened from a left click on Genie's icon in the Waybar tray", click7 ? JSON.stringify(click7) : 'no icon in the drawer opened it');
}
if (!panel7) panel7 = await openPanel();
check(Boolean(panel7), 'the tray panel opened again');
console.log(`  the tray panel says: ${panelText(panel7).replace(/\s*\n\s*/g, ' | ')}`);
for (const words of [...PANEL_WORDS, 'agents keep running']) check(panelSays(panel7, words), `the tray panel says "${words}"`);
panelHostsAreReal('step 7', panel7);
if (!WIN && click7) {
    const at = (hypr(['clients']) ?? []).find((c) => c.pid === launcherPid && c.title === 'Genie tray');
    if (at) console.log(`  the pointer rests on the panel's edge: ${moveCursor(at.at[0] + at.size[0] - 3, at.at[1] + 3) ?? 'it could not be moved'}`);
}
await sleep(1_200);
await panelOnScreen('step 7', panel7, click7);
launcherWindows(launcherPid);
photograph(`launch-tray-panel-${OS}.png`);
// "Start when I sign in": the logon setting, turned over in place and back.
const logonFile = join(runtime, 'logon.json');
const logonOf = () => { try { return JSON.parse(readFileSync(logonFile, 'utf8')).setting === true; } catch { return false; } };
const logonWas = logonOf();
const toggleOn = () => wireCall(runtime, 'launcher.uiProbe', [{ surface: 'panel' }]).then((p) => (p.ok ? (p.value?.shown?.items ?? []).find((i) => i.id === 'logon')?.on : null));
const shownWas = await toggleOn();
check(shownWas === String(logonWas), 'the panel\'s "Start when I sign in" shows the logon setting', `shown ${shownWas}, setting ${logonWas}`);
await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'panel', click: 'logon' }]);
check(Boolean(await until(() => (logonOf() !== logonWas ? true : null), 10_000, 300)), '"Start when I sign in" turned the logon setting over', `was ${logonWas}, now ${logonOf()}`);
check(Boolean(await until(async () => ((await toggleOn()) === String(!logonWas) ? true : null), 10_000, 500)), 'the panel stayed open and shows the new setting');
await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'panel', click: 'logon' }]);
check(Boolean(await until(() => (logonOf() === logonWas ? true : null), 10_000, 300)), '"Start when I sign in" turned it back', `now ${logonOf()}`);
// "Stop this computer's host" asks first, as the menu's did; Cancel leaves the host running.
await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'panel', click: 'stopHost' }]);
const asked7 = await until(async () => { const p = await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'panel' }]); return p.ok && (p.value?.asking ?? []).length ? p.value.asking : null; }, 15_000, 500);
check(Array.isArray(asked7) && asked7.some((t) => t.startsWith('Stop this computer')), 'the panel\'s "Stop this computer\'s host" asks first', JSON.stringify(asked7));
await sleep(1_000);
photograph(`launch-7-stop-asks-${OS}.png`);
await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'panel', cancelAsks: true }]);
await sleep(2_000);
check(alive(hostNow), 'Cancel left the host running, the same pid', `pid ${hostNow}`);
// The panel's "Open Genie" with the UI closed: a client window.
const closed7 = await wireCall(runtime, 'launcher.trayAct', [{ action: 'closeUi' }]);
check(closed7.ok, 'the UI closed');
if (client7) check(Boolean(await until(() => !alive(client7), 30_000, 500)), 'the client window closed', `pid ${client7}`);
if (started7) await closeBrowser(started7.pid);
const panel7b = await openPanel();
check(Boolean(panel7b), 'the tray panel opened with the UI closed');
check(panelSays(panel7b, 'Close Genie') && panelItem(panel7b, 'closeUi')?.enabled === false, 'with no window open, "Close Genie" has nothing to close', JSON.stringify(panelItem(panel7b, 'closeUi')));
const panelGenie = await wireCall(runtime, 'launcher.uiProbe', [{ surface: 'panel', click: 'openGenie' }]);
check(panelGenie.ok && panelGenie.value?.clicked === true, 'the tray panel\'s "Open Genie" was clicked');
const client7b = await until(async () => { const st = await wireCall(runtime, 'launcher.status'); const pids = (st.ok ? st.value.clients ?? [] : []).map(Number).filter((p) => alive(p) && samePath(executableOf(p), exe('client', 'genie-client'))); return pids[0] ?? null; }, 60_000, 1_000);
check(Boolean(client7b), 'a client window opened from the tray panel, attached to the launcher', client7b ? `pid ${client7b}` : 'none within 60 s');
if (client7b) check((await windowOnScreen(client7b, 30_000)).windows.length > 0, 'its window is on screen');
photograph(`launch-7-panel-open-genie-${OS}.png`);

if (run.failures.length) fail(run.failures.join('; '));
console.log(`### launcher-launch=PASS the launcher's host (pid ${hostPid}) from ${join(code, 'host', build)}, a client window (pid ${clientPid}) attached to it from ${join(code, 'client', build)}, and the Genie Browser (pid ${browserPid}, parent the launcher ${launcherPid}) opened from the tray's item with its window on screen; the host and the client unchanged; with the UI closed the tray opened the Browser again (pid ${started5?.pid}) with no client, and for a host restarted with no client (pid ${started6?.pid})`);
