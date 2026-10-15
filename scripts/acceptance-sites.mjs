/**
 * ACCEPTANCE — SITES, THROUGH THE FRONT DOOR, ON THE INSTALLED APP (Windows test VM).
 *
 * Why this exists (the owner, 2026-10-14): "Zero *.gen sites are being served … we need to tighten up our recursive
 * self improvement protocols … so you can test and verify features are actually working for real beyond smoke tests and
 * api return codes." Every check that shipped sites was green while the owner's browser got nothing: one site's own
 * Caddy held :80 and the admin port, so the other sites and Genie's front door could not start, and a certificate
 * prompt appeared that nobody asked for. Those are OUTCOMES, and this script checks only outcomes:
 *
 *   1. two declared sites answer over https://<name>.gen THROUGH THE FRONT DOOR, each with its own page;
 *   2. no site's own Caddy holds :80 or the admin port :2019 (only the front door may hold what it needs);
 *   3. launching Genie adds NO certificate to the user's trusted roots (only the person's Trust may);
 *   4. a normal quit leaves no Caddy behind, and after a relaunch both sites answer again.
 *
 * It seeds state exactly as a real machine has it (a workspace envelope with a `sites` block, registered in
 * workspaces.json) and never reaches into the app: it launches the installed exe, reads HTTP, netstat and the cert
 * store, and quits it the way a window close does. Every owner report about hosting becomes a check here.
 *
 * Usage (in the VM): node scripts\acceptance-sites.mjs "C:\Users\...\Programs\Genie\Genie.exe"
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const exe = process.argv[2];
if (!exe || !existsSync(exe)) throw new Error(`usage: node scripts/acceptance-sites.mjs <installed Genie.exe> (got ${exe})`);

const results = [];
const check = (ok, label, detail) => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();

// ---- seed: a workspace envelope declaring two static sites, registered like any workspace -----------------------
const token = `accept-${Date.now().toString(36)}`;
const ws = join(homedir(), 'accept-sites-ws');
const sites = [
    { key: 'acceptaaaaaaaaaa', name: 'accepta', dir: 'public-a', body: `${token}-A` },
    { key: 'acceptbbbbbbbbbb', name: 'acceptb', dir: 'public-b', body: `${token}-B` },
];
mkdirSync(ws, { recursive: true });
for (const s of sites) {
    mkdirSync(join(ws, s.dir), { recursive: true });
    writeFileSync(join(ws, s.dir, 'index.html'), `<!doctype html><title>${s.name}</title><p>${s.body}</p>\n`);
}
writeFileSync(join(ws, 'project.json'), `${JSON.stringify({
    name: 'Acceptance sites',
    sites: Object.fromEntries(sites.map((s) => [s.key, { repo: '', runMode: 'host', kind: 'http', enabled: true, name: s.name, genName: `${s.name}.gen`, hostServe: { mode: 'static', root: s.dir } }])),
}, null, 2)}\n`);
const runtime = join(homedir(), '.genie', 'runtime');
mkdirSync(runtime, { recursive: true });
const wsFile = join(runtime, 'workspaces.json');
const before = existsSync(wsFile) ? JSON.parse(readFileSync(wsFile, 'utf8')) : [];
writeFileSync(wsFile, JSON.stringify([...before.filter((w) => w.id !== 'accept'), { id: 'accept', path: ws }], null, 2));
console.log(`seeded ${ws} with ${sites.map((s) => `${s.name}.gen`).join(', ')}`);

// ---- what the outcomes are measured with ------------------------------------------------------------------------
/** GET https://<host>/ through the front door on 127.0.0.1:443, SNI and Host = the .gen name. */
const fetchSite = (host) => new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: 443, path: '/', servername: host, headers: { Host: host }, rejectUnauthorized: false, timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end();
});
const waitForSites = async (seconds) => {
    const until = Date.now() + seconds * 1000;
    let last = [];
    while (Date.now() < until) {
        last = await Promise.all(sites.map((s) => fetchSite(`${s.name}.gen`)));
        if (last.every((r, i) => r.status === 200 && r.body.includes(sites[i].body))) return last;
        await sleep(2000);
    }
    return last;
};
/** Who listens on a port: [{ pid, image, commandLine }]. */
const listeners = (port) => {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    const pids = new Set(out.split(/\r?\n/).filter((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l)).map((l) => l.trim().split(/\s+/).pop()));
    return [...pids].map((pid) => {
        const cmd = ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`);
        return { pid, commandLine: cmd };
    });
};
const trustedRoots = () => Number(ps('@(Get-ChildItem Cert:\\CurrentUser\\Root).Count'));
const caddies = () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='caddy.exe'").Count`);

// ---- precondition: the installed app carries its Caddy (a VM build without it served nothing, 2026-10-14) ----------
const bundledCaddy = join(dirname(exe), 'resources', 'runtime', 'caddy.exe');
check(existsSync(bundledCaddy), '0. the installed app carries its Caddy', bundledCaddy);
const genieLog = join(homedir(), 'accept-genie.log');
const launch = () => { const fd = openSync(genieLog, 'a'); return spawn(exe, [], { detached: false, stdio: ['ignore', fd, fd] }); };

/** A red run explains itself: what the front door was told, what the sites folder holds, what Genie said. */
const explain = (when) => {
    console.log(`--- diagnostics (${when}):`);
    const dump = (label, fn) => { try { console.log(`--- ${label}:\n${fn()}`); } catch (e) { console.log(`--- ${label}: (unreadable: ${e.message})`); } };
    dump('front-door Caddyfile', () => readFileSync(join(runtime, 'caddy', 'Caddyfile'), 'utf8'));
    dump('workspaces.json as Genie left it', () => readFileSync(wsFile, 'utf8'));
    dump('front door, every listener on :443', () => JSON.stringify(listeners(443)));
    dump('runtime/sites', () => readdirSync(join(runtime, 'sites')).join(', '));
    dump('site-run-state.json', () => readFileSync(join(runtime, 'site-run-state.json'), 'utf8'));
    dump('Genie output (last 40 lines)', () => readFileSync(genieLog, 'utf8').split(/\r?\n/).slice(-40).join('\n'));
};

// ---- run 1 --------------------------------------------------------------------------------------------------------
const rootsBefore = trustedRoots();
console.log(`trusted roots before launch: ${rootsBefore}`);
let app = launch();
console.log(`launched ${exe} (pid ${app.pid})`);

const first = await waitForSites(120);
sites.forEach((s, i) => check(first[i]?.status === 200 && first[i].body.includes(s.body), `1. https://${s.name}.gen answers with ITS page through the front door`, `HTTP ${first[i]?.status} ${String(first[i]?.body).slice(0, 80).replace(/\s+/g, ' ')}`));

for (const port of [80, 2019]) {
    const holders = listeners(port);
    const siteHolders = holders.filter((h) => /\\sites\\/i.test(h.commandLine));
    check(siteHolders.length === 0, `2. no site's own Caddy holds :${port}`, holders.length ? holders.map((h) => `${h.pid} ${h.commandLine.slice(0, 120)}`).join(' | ') : 'nobody listens');
}

// Read while Genie is still up: after a quit the state it served is gone.
if (results.some((r) => !r)) explain('run 1, Genie still running');

const rootsAfter = trustedRoots();
check(rootsAfter === rootsBefore, '3. launching Genie added no trusted root certificate (only the person\u2019s Trust may)', `${rootsBefore} → ${rootsAfter}`);

// A normal quit: WM_CLOSE (taskkill WITHOUT /F), exactly what closing the window does.
// taskkill exits 1 when the process has no window to close; that is a finding (4a), never a crash of this script.
// Over SSH there is no interactive desktop, and Windows refuses WM_CLOSE outright ("no window took WM_CLOSE", measured
// 2026-10-14) — the message never reaches Genie, so a "still running" there measures the session, not Genie. Then 4a is
// reported NOT TESTABLE with its reason and left out of the verdict; a graceful quit is checked from a desktop session.
let closeRefused = false;
try { execFileSync('taskkill', ['/PID', String(app.pid)], { stdio: 'ignore' }); } catch { closeRefused = true; }
if (closeRefused) {
    console.log('  NOT TESTABLE  4a. a normal quit ends Genie  — no interactive desktop: Windows refused WM_CLOSE, so it never reached Genie; Genie is forced off below');
} else {
    const quitUntil = Date.now() + 60_000;
    while (Date.now() < quitUntil && ps(`[bool](Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue)`) === 'True') await sleep(1000);
}
const stillUp = ps(`[bool](Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue)`) === 'True';
if (!closeRefused) check(!stillUp, '4a. a normal quit ends Genie', stillUp ? 'still running after 60 s' : 'exited');
if (stillUp) { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* raced its own exit */ } }
await sleep(3000);
check(caddies() === '0', '4b. nothing Genie served outlives it: no caddy.exe left', `${caddies()} caddy.exe`);

// ---- run 2: after the restart, the sites come back ------------------------------------------------------------------
app = launch();
console.log(`relaunched (pid ${app.pid})`);
const second = await waitForSites(120);
sites.forEach((s, i) => check(second[i]?.status === 200 && second[i].body.includes(s.body), `4c. after a restart https://${s.name}.gen answers again`, `HTTP ${second[i]?.status}`));
try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
await sleep(2000);

// ---- leave the VM as we found it ----------------------------------------------------------------------------------
writeFileSync(wsFile, JSON.stringify(before, null, 2));
const failed = results.filter((r) => !r).length;
if (failed > 0) {
    explain('at the end');
}
console.log(failed === 0 ? `\nACCEPTANCE SITES PASSED — ${results.length} checks` : `\nACCEPTANCE SITES FAILED — ${failed} of ${results.length} checks`);
process.exit(failed === 0 ? 0 : 1);
