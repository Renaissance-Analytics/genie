#!/usr/bin/env node
/**
 * THE HOST SPLIT, MEASURED (genie#1386 phase 1). Run IN A TEST VM, from a built tree (`npm ci && npm run build`):
 *
 *   node scripts/perf-lag/host-split-proof.mjs [seconds=180] [scale=0.25]
 *
 * The same heavy agent load twice — eleven Codex agents resumed mid-turn (seed.mjs, the owner's restart), every one
 * streaming nonstop (stub-codex-busy.mjs) — measured by measure.mjs in the real window (main's event-loop gaps over
 * 50 ms, keystroke-to-paint, CPU profiles):
 *
 *   1. BEFORE: the emergency fallback (host.js withheld, so the host cannot start) — the agents run in Electron main,
 *      as every build before phase 1;
 *   2. AFTER:  the default — the agents run in genie-host.
 *
 * Then, still AFTER: the window CRASHES (Electron main killed outright). The host and every provider must still be
 * running, and their threads still growing; a relaunched window must ADOPT the same host (same pid, same providers)
 * and is measured again.
 *
 * Results: perf-out/host-split-proof.json and a summary on stdout. Every Genie process this started is ended on exit.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const SECONDS = Number(process.argv[2] ?? 180);
const SCALE = String(process.argv[3] ?? '0.25');
const require = createRequire(import.meta.url);
const electron = require('electron'); // the binary's path, under Node
const root = resolve('.');
const home = homedir();
const runtime = join(home, '.genie', 'runtime');
const out = join(root, 'perf-out');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(`[proof ${new Date().toISOString()}] ${line}`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
// LOADED WINDOW (2026-11-01): the first Windows run measured agents mostly STARTING (the host's first spawn came 73 s
// after launch, the eleventh ~160 s, in a 150 s window), and its provider gauge read 0 while 8 were running (children.json
// read mid-rename). So: the agents' spawns are read from the host's own lifecycle.log lines, the measured window starts
// once all of them have spawned, and the LOAD is proved inside that window by thread growth.
const AGENTS = 11;
const lifecycleText = () => { try { return readFileSync(join(runtime, 'lifecycle.log'), 'utf8'); } catch { return ''; } };
/** Every agent spawn in this seed's lifecycle.log: when, whose, and its first pid (the supervisor that holds the provider). */
const spawns = () => lifecycleText().split('\n').flatMap((line) => {
    const m = /^(\S+) spawn kind=agent owner=(\S+) run=\d+ pids=(\d+)/.exec(line);
    return m ? [{ t: Date.parse(m[1]), owner: m[2], pid: Number(m[3]) }] : [];
});
const providerPids = () => spawns().map((x) => x.pid);
const threadBytes = () => { let n = 0; for (const f of existsSync(join(runtime, 'sessions')) ? readdirSync(join(runtime, 'sessions')) : []) n += statSync(join(runtime, 'sessions', f)).size; return n; };
const killTree = (pid) => {
    if (!pid || !alive(pid)) return;
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
};

const env = { ...process.env, GENIE2_CODEX_BINARY: join(root, 'scripts', 'perf-lag', 'stub-codex-busy.mjs') };
let window = null;
const launched = [];

function launch(label, mode) {
    const e = { ...env, LAUNCHED_AT_MS: String(Date.now()) };
    // THE BASELINE has no switch (the owner, 2026-11-01: there is no in-process mode). It is the emergency fallback, reached
    // the way a real failure reaches it: the host bundle is withheld, the host cannot start, and the agents run in main —
    // as every build before phase 1. Put back for the AFTER runs.
    const hostJs = join(root, 'dist', 'main', 'host.js');
    if (mode === 'in-process' && existsSync(hostJs)) renameSync(hostJs, `${hostJs}.withheld`);
    if (mode !== 'in-process' && existsSync(`${hostJs}.withheld`)) renameSync(`${hostJs}.withheld`, hostJs);
    const args = ['--inspect=9229', '.', '--remote-debugging-port=9222', ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : [])];
    const child = spawn(electron, args, { cwd: root, env: e, stdio: ['ignore', 'ignore', 'ignore'], detached: process.platform !== 'win32' });
    launched.push(child.pid);
    log(`launched ${label} (${mode}) electron pid=${child.pid}`);
    return { child, at: Number(e.LAUNCHED_AT_MS) };
}

async function measure(label, at, seconds, needSpawns = AGENTS) {
    let exited = false;
    const done = new Promise((r) => {
        const m = spawn(process.execPath, [join(root, 'scripts', 'perf-lag', 'measure.mjs'), label, String(seconds)], { cwd: out, env: { ...process.env, LAUNCHED_AT_MS: String(at) }, stdio: 'inherit' });
        m.once('exit', (code) => { exited = true; r(code); });
    });
    // The LOADED window: from 15 s after the needed spawns have all happened (since this launch) to the end of the run.
    let loadedAt = null;
    let bytesAtLoaded = null;
    while (!exited && loadedAt === null) {
        const since = spawns().filter((x) => x.t >= at);
        if (since.length >= needSpawns) {
            loadedAt = Math.max(...since.map((x) => x.t)) + 15_000;
            while (!exited && Date.now() < loadedAt) await sleep(500);
            bytesAtLoaded = threadBytes();
            log(`${label}: all ${needSpawns} agents spawned; loaded window from +${loadedAt - at} ms, threads ${bytesAtLoaded} bytes`);
        } else await sleep(1000);
    }
    const code = await done;
    const bytesAtEnd = threadBytes();
    const result = readJson(join(out, `${label}-result.json`));
    if (code !== 0 || !result) log(`measure ${label} exited ${code}`);
    if (loadedAt === null) log(`${label}: only ${spawns().filter((x) => x.t >= at).length} of ${needSpawns} agents spawned during the run: NO loaded window`);
    return result ? { ...result, loadedFromMs: loadedAt === null ? null : loadedAt - at, threadGrowthInLoadedWindow: bytesAtLoaded === null ? null : bytesAtEnd - bytesAtLoaded } : null;
}

function clean() {
    for (const pid of launched) killTree(pid);
    const host = readJson(join(runtime, 'host.json'));
    if (host?.pid) killTree(host.pid);
    for (const pid of providerPids()) killTree(pid);
}

process.on('exit', clean);
process.on('SIGINT', () => process.exit(130));

const summary = { seconds: SECONDS, scale: SCALE, platform: process.platform };

async function seed() {
    clean();
    await sleep(2000);
    rmSync(join(home, '.genie'), { recursive: true, force: true });
    rmSync(join(home, 'lagws'), { recursive: true, force: true });
    execFileSync(process.execPath, [join(root, 'scripts', 'perf-lag', 'seed.mjs'), SCALE], { stdio: 'inherit' });
}

// 1. BEFORE
await seed();
window = launch('before', 'in-process');
summary.before = await measure('before', window.at, SECONDS);
killTree(window.child.pid);
await sleep(3000);

// 2. AFTER
await seed();
window = launch('after', 'host');
summary.after = await measure('after', window.at, SECONDS);

// 3. THE WINDOW CRASHES
const host = readJson(join(runtime, 'host.json'));
const providers = providerPids();
// POSITIVE CONTROL: the gauge must see the agents alive before it is trusted to see them alive after.
summary.crash = { hostPid: host?.pid ?? null, providers: providers.length, providersAliveBefore: providers.filter(alive).length, controlOk: providers.length >= AGENTS && providers.filter(alive).length >= AGENTS };
const bytesBefore = threadBytes();
log(`killing the window outright (electron pid=${window.child.pid}); host pid=${host?.pid}, ${providers.length} providers`);
// Electron main ONLY — never its tree: on Windows the host's parent pid IS this process, and a tree kill would take the
// host with it, which is not what a crashed window does. Chromium's own children exit with their browser process.
try { process.kill(window.child.pid, 'SIGKILL'); } catch { /* gone */ }
await sleep(15_000);
summary.crash.hostAliveAfterCrash = host?.pid ? alive(host.pid) : false;
summary.crash.providersAliveAfterCrash = providers.filter(alive).length;
summary.crash.threadBytesGrewWithNoWindow = threadBytes() > bytesBefore;
summary.crash.threadBytes = { atCrash: bytesBefore, fifteenSecondsLater: threadBytes() };

// 4. A NEW WINDOW ADOPTS THE HOST
window = launch('adopted', 'host');
summary.adopted = await measure('adopted', window.at, Math.min(150, SECONDS), 0);
const hostAfter = readJson(join(runtime, 'host.json'));
summary.crash.samehostPidAfterRelaunch = hostAfter?.pid === host?.pid;
summary.crash.providersAliveAfterRelaunch = providers.filter(alive).length;
const lifecycle = existsSync(join(runtime, 'lifecycle.log')) ? readFileSync(join(runtime, 'lifecycle.log'), 'utf8') : '';
summary.crash.adoptedLine = lifecycle.split('\n').filter((l) => /agent host (adopted|started|replaced)/.test(l)).slice(-3);

// What each run says about MAIN (the browser UI thread that routes keystrokes): its event-loop gaps (measure.mjs records
// every gap over ~50 ms), how many were over 250 ms, the longest, its CPU busy time, and keystroke-to-paint.
const brief = (k) => {
    const r = summary[k];
    if (!r) return null;
    const lag = r.lag ?? [];
    const from = r.loadedFromMs;
    const loadedLag = from === null || from === undefined ? null : lag.filter(([t]) => t >= from);
    const loadedKeys = from === null || from === undefined ? null : (r.keys ?? []).filter(([t]) => t >= from).map(([, d]) => d).sort((a, b) => a - b);
    const q = (v, p) => (v && v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null);
    return {
        loaded: loadedLag === null ? null : {
            fromMs: from,
            threadGrowthBytes: r.threadGrowthInLoadedWindow,
            main: { gaps: loadedLag.length, over250: loadedLag.filter(([, d]) => d > 250).length, maxMs: Math.max(0, ...loadedLag.map(([, d]) => d)), totalMs: loadedLag.reduce((a, [, d]) => a + d, 0) },
            keys: { n: loadedKeys.length, p50: q(loadedKeys, 0.5), p95: q(loadedKeys, 0.95), max: loadedKeys.at(-1) ?? null },
        },
        rendererCallsTimedOut: r.rendererCallsTimedOut ?? null,
        main: { gaps: lag.length, over250: lag.filter(([, d]) => d > 250).length, maxMs: Math.max(0, ...lag.map(([, d]) => d)), totalMs: lag.reduce((a, [, d]) => a + d, 0), cpuMs: r.mainTop?.totalMs ?? null },
        boot: r.boot?.mainLag ?? null,
        steady: r.steady?.mainLag ?? null,
        keys: r.all?.keys ?? null,
        mainTop: (r.mainTop?.top ?? []).slice(0, 6),
    };
};
const report = { before: brief('before'), after: brief('after'), adopted: brief('adopted'), crash: summary.crash, seconds: SECONDS, scale: SCALE, platform: process.platform };
writeFileSync(join(out, 'host-split-proof.json'), JSON.stringify(report, null, 2));
log(`BEFORE  (agents in Electron main): ${JSON.stringify(report.before)}`);
log(`AFTER   (agents in genie-host):    ${JSON.stringify(report.after)}`);
log(`ADOPTED (after a window crash):    ${JSON.stringify(report.adopted)}`);
log(`CRASH: ${JSON.stringify(summary.crash)}`);
process.exit(0);
