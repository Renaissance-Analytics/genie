#!/usr/bin/env node
/**
 * UPDATES FROM THE LAUNCHER, MEASURED ON THE REAL PROGRAMS (Tynn #1058 L6; the spec's "The update flow, per component" and
 * "What the CI rows become"). One script, four rows, both OSes:
 *
 *   node scripts/launcher-updates-row.mjs --row client-only-update | host-update | host-update-rollback | launcher-self-update
 *                                              | version-skew
 *
 * EVERY ROW starts the same way. A home of its own (HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME,
 * XDG_DATA_HOME), seeded with smoke-seed.mjs. The package-tracks row's signed packages (release/tracks/packages, the build
 * in release/tracks/build.txt: OLD) are installed into a code root of that home by the launcher that row built
 * (`genie install --from ... --profile both --channel stable --yes`). NEW packages are made by repacking that row's trees
 * (release/tracks/trees/<track>) with scripts/pack-track.mjs at the next build of the same day (2026.11.27-1 becomes
 * 2026.11.27-2), a host's and a browser's naming the NEW client, each signed with the run's THROWAWAY key
 * (scripts/ci/throwaway-manifest-key.mjs, in ci-out/setup), and served on a local feed (scripts/ci/local-track-feed.mjs, the
 * GitHub REST list with an ETag). The launcher then runs (`serve`) where it is installed: on Linux <code root>/launcher/
 * <OLD>/genie through ~/.local/bin/genie, as install wrote it; on Windows a copy at <LOCALAPPDATA>\Programs\Genie\Genie.exe,
 * the path the NSIS installer uses (the self-update renames the running Genie.exe, so it must never be the tree's). It reads
 * that feed (GENIE_LAUNCHER_FEED), checks only when asked (GENIE_LAUNCHER_AUTO_CHECK=0: its 90 s first check would apply the
 * client by itself), and answers the tray probe (GENIE_LAUNCHER_TRAY_PROBE=1). The host is started through it
 * (launcher.ensureHost; the rollback row by `genie ensure-host`, see ensureHostByCli), and this tree's Electron is the client, told the launcher's environment as the launcher tells the
 * client it starts. Three agents stream through it on the stub app server's TICKER mode (`tick <n> pid <pid>` four times a
 * second, so each ledger names the provider process streaming for it). The launcher is spoken to on its control wire, as
 * the client and the host speak to it (launcher-row-lib.mjs `wireCall`).
 *
 * client-only-update  The feed offers client, browser and host NEW. launcher.check makes all three READY and applies none;
 *   the tray offers "Updates (N)" and "Update host" (NEW in its tooltip) (tray-offer-<os>.png) and its Updates opens the launcher's
 *   Updates window (updates-<os>.png). The client, then the browser, are applied (launcher.apply); the open window is left
 *   on its build and the launcher's attached links are told launcher.updateReady; the SAME host pid, the SAME provider pid
 *   per agent, and every tick streamed meanwhile in each ledger, in order; state.json points client and browser at NEW and
 *   leaves the host at OLD. The host is offered but NEVER applied here. Then the next window (launcher.openWindow) runs from
 *   <code root>/client/<NEW> and comes up (the launcher takes it off trial); next-window-<os>.png.
 *
 * host-update  The feed offers host and client NEW. The tray's offer "Update host" (NEW in its tooltip) (launcher.trayAct
 *   installHostUpdate) asks the running host to install through its own drain; while the launcher's hostUpdate phase is
 *   draining, stopping, swapping or starting the Updates window shows "Updating the host" (host-update-progress-<os>.png).
 *   Then: the phase is done; the old host pid is gone; a new host runs at NEW from <code root>/host/<NEW>; state.json host
 *   NEW (previous OLD) and client NEW; the drain's record (running-at-quit.json) named every agent while the update ran,
 *   and is spent after it; every agent came back ONCE (the restore-once proof below); every old provider is gone.
 *
 * host-update-rollback  As host-update, but the NEW host is broken: its app/dist/main/host.js is replaced by a script that
 *   exits 3 before it does anything (repacked and signed like the rest), and the launcher's rollback bound is 20 s
 *   (GENIE_LAUNCHER_HOST_READY_MS=20000). Then: the phase is rolled-back and says "so Genie went back to <OLD>"; a host runs at
 *   OLD again (a new pid); state.json host OLD and client OLD; every agent came back ONCE, from the same record; the Updates
 *   window shows "Back on the version that worked" (host-update-rollback-<os>.png).
 *
 * launcher-self-update  A second launcher, built with GENIE_TRACK_BUILD=<NEW> and the same GENIE_MANIFEST_PUBLIC_KEYS (the
 *   CI row builds it into native/launcher/target-l6 and names it in LAUNCHER_ROW_NEW_LAUNCHER), packed as track launcher NEW
 *   and published. launcher.apply {track: launcher}: launcher.json then names a new live pid and the old one exits; a hello
 *   is welcomed by that pid with build NEW; the host pid and every provider pid are unchanged and the ledgers keep streaming;
 *   on Linux ~/.local/bin/genie points at <code root>/launcher/<NEW>/genie, on Windows Genie.exe holds the NEW bytes and
 *   Genie.exe.old is cleared. The tray after the handover is photographed (tray-after-handover-<os>.png).
 *
 * version-skew  (Tynn #1058 L8: "the previous published client against the new host and the reverse, as real processes").
 *   The feed offers client and host NEW. The client NEW is applied alone; the INSTALLED client program of NEW
 *   (<code root>/client/<NEW>/genie-client, by its own path, its debugger port and page probe on) is run against the host OLD
 *   the launcher started from <code root>/host/<OLD>: a turn both ways (an agent added, started and prompted from that
 *   client, its ticks streamed back into it, from one provider under that host) and the three tickers still streaming into
 *   it. Then the host goes to NEW through its own drain and the launcher's swap, and the INSTALLED client OLD (kept as the
 *   previous build) is run against it: the same turn, and every ticker restored under the new host streaming into it.
 *   WHAT N-1 IS HERE: until a track has a published release, OLD and NEW are two builds of this one tree (the package-tracks
 *   row's packages and their repack at the next build): two installs, two folders, two processes of each pairing, each
 *   speaking the wire to the other, so the row proves the pairings run and stream, not a difference of code between them.
 *   Once a track release is published, OLD is meant to be that release (version-skew-client-new-host-old-<os>.png,
 *   version-skew-client-old-host-new-<os>.png).
 *
 * RESTORE ONCE (vm-host-update-linux.sh and vm-windows-update.ps1's proof, P6-2, kept): the agents' provider processes are
 * sampled the whole time the update runs (pid and start time, so a reused pid is another process), never only after it.
 * Every provider from before is gone; exactly as many new providers as agents run under the new host, after ten more
 * seconds for a second start to show; no other new provider was seen at all while it ran (a second start that died is
 * still one too many); the record is spent; and each agent's session is running again in a new client. On Windows each
 * sample is a CIM query that takes seconds, so a second start shorter than that can be missed there; the live count and
 * the spent record still hold.
 *
 * HOW IT RUNS: from the root of a built tree (npm run build) after package-tracks, inside the display session, as the CI
 * rows in scripts/ci/linux.sh and windows.ps1 run it. CDP_PORT is the client's debugger port; LAUNCHER_ROW_OUT where its
 * screenshots and logs go (ci-out/<row>); LAUNCHER_ROW_DEADLINE_MS its watchdog; LAUNCHER_ROW_KEY_DIR the throwaway key's
 * folder (ci-out/setup); LAUNCHER_ROW_NEW_LAUNCHER the second launcher (launcher-self-update only); LAUNCHER_ROW_ARGS more
 * Electron flags. NEW packages made from the trees are kept under release/tracks/updates/<NEW> with the key that signed
 * them, so the next row of the same run reuses them instead of packing the host again.
 *
 * IT NEVER HANGS SILENTLY: every step prints a line BEFORE it acts, every wait and wire call has its own deadline, and a
 * watchdog ends the run at LAUNCHER_ROW_DEADLINE_MS naming the step it was in. Whatever ends the run, the cleanup runs,
 * bounded: the agents stopped, every launcher, host, client and provider this run started ended, and on Windows the whole
 * run ended through scripts/end-own-tree.mjs (Tynn #1031), which fails the run on anything it left.
 *
 * SAFETY: it installs and starts real programs, so it refuses to run anywhere but a test machine — CI, the test VM (Linux
 * user `genie`), GENIE_TEST_MACHINE=1 (the CI scripts' statement) or LAUNCHER_ROW_ALLOW=1. Never on the owner's desktop.
 *
 * Exit: 0 every check passed; 1 a check failed (or a deadline was missed); 2 cannot run here.
 */
import {
    OS, SYNC_MS, WIN, alive, check, commandLine, contiguous, descends, executableOf, freePort, openClient, openLinuxTrayMenu, ownHome, parents,
    pressKey, processesNamed, readJson, readOr, refuse, run, since, shot, sleep, step, testMachineOrRefuse, ticksOf, until, wireAttach, wireCall,
    wireHello,
} from './launcher-row-lib.mjs';
import { ARCH, PLATFORM, startFeed } from './ci/local-track-feed.mjs';
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { packTrack } from './pack-track.mjs';
import { publicKeyOf, signManifestBytes } from './sign-manifest.mjs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROWS = ['client-only-update', 'host-update', 'host-update-rollback', 'launcher-self-update', 'version-skew'];
const ROW = (() => { const i = process.argv.indexOf('--row'); return i > 0 ? process.argv[i + 1] : null; })();
run.name = `launcher-updates ${ROW ?? '(no row)'}`;
step('0.1', `reading the settings (row ${ROW})`);
if (!ROWS.includes(ROW)) refuse(`--row must be one of ${ROWS.join(', ')} (it was ${JSON.stringify(ROW)})`);
step('0.2', 'is this a test machine? (CI, GENIE_TEST_MACHINE=1, user genie, or LAUNCHER_ROW_ALLOW=1)');
testMachineOrRefuse('LAUNCHER_ROW_ALLOW');
step('0.3', `is this the root of a built Genie tree after package-tracks? (${process.cwd()})`);
if (!existsSync('package.json') || !existsSync('scripts/stub-codex.mjs')) refuse(`run it from the root of a built Genie tree (${process.cwd()})`);
const TRACKS = resolve('release', 'tracks');
const TREES = join(TRACKS, 'trees');
const PACKAGES = join(TRACKS, 'packages');
if (!existsSync(join(TRACKS, 'build.txt')) || !existsSync(PACKAGES) || !existsSync(TREES)) refuse(`no packages from the package-tracks row (${join(TRACKS, 'build.txt')}, ${PACKAGES}, ${TREES})`);
// The stub provider is started by its path through its `#!/usr/bin/env node` line; git holds it without the execute bit.
if (!WIN) chmodSync('scripts/stub-codex.mjs', 0o755);

/** The next build of the same day: what a second release that day is called (2026.11.27-1 -> 2026.11.27-2). */
function nextBuild(build) {
    const m = /^(\d{4}\.\d{2}\.\d{2})-(\d{1,6})$/.exec(build);
    if (!m) refuse(`release/tracks/build.txt holds ${JSON.stringify(build)}, not a track build <date>-<n>`);
    return `${m[1]}-${Number(m[2]) + 1}`;
}
const OLD = readFileSync(join(TRACKS, 'build.txt'), 'utf8').trim();
const NEW = nextBuild(OLD);
run.out = resolve(process.env.LAUNCHER_ROW_OUT ?? join('ci-out', ROW));
const OUT = run.out;
mkdirSync(OUT, { recursive: true });
const KEY_DIR = resolve(process.env.LAUNCHER_ROW_KEY_DIR ?? join('ci-out', 'setup'));
const PEM = readOr(join(KEY_DIR, 'THROWAWAY-manifest-signing-key.pem'));
const PUB = readOr(join(KEY_DIR, 'THROWAWAY-manifest-public-key.txt')).trim();
step('0.4', `the run's throwaway signing key (${KEY_DIR}) is the one the launcher was built to trust`);
if (!PEM || !PUB) refuse(`no throwaway key in ${KEY_DIR} (the package-tracks row writes it)`);
try { if (publicKeyOf(PEM) !== PUB) refuse(`the signing key in ${KEY_DIR} is not the public key beside it`); } catch (e) { refuse(`the throwaway key cannot sign: ${e.message}`); }
const NEW_LAUNCHER = process.env.LAUNCHER_ROW_NEW_LAUNCHER ? resolve(process.env.LAUNCHER_ROW_NEW_LAUNCHER) : null;
if (ROW === 'launcher-self-update') {
    step('0.5', `the second launcher (${NEW_LAUNCHER}) says it is build ${NEW}`);
    if (!NEW_LAUNCHER || !existsSync(NEW_LAUNCHER)) refuse(`launcher-self-update needs LAUNCHER_ROW_NEW_LAUNCHER, a launcher built with GENIE_TRACK_BUILD=${NEW} (${NEW_LAUNCHER})`);
    const said = spawnSync(NEW_LAUNCHER, ['version'], { encoding: 'utf8', timeout: SYNC_MS, windowsHide: true });
    if (String(said.stdout ?? '').trim() !== NEW) refuse(`${NEW_LAUNCHER} says it is build ${JSON.stringify(String(said.stdout ?? '').trim())}, not ${NEW}: it was not built for this row`);
}

const HOME = ownHome('genie-l6-home-');
step('0.6', `a home of its own: ${HOME}`);
const GENIE_HOME = join(homedir(), '.genie');
const RUNTIME = join(GENIE_HOME, 'runtime');
const HOST_RECORD = join(RUNTIME, 'host.json');
const RUNNING_AT_QUIT = join(RUNTIME, 'running-at-quit.json');
const HOST_LOG = join(GENIE_HOME, 'logs', 'genie-host.log');
const LAUNCHER_OWN_LOG = join(GENIE_HOME, 'logs', 'genie-launcher.log');
const CODE_ROOT = join(dirname(GENIE_HOME), 'genie-code');
const STATE = join(CODE_ROOT, 'state.json');
const LAUNCHER_LOG = join(OUT, 'launcher.log');
const LAUNCHER_TREE = join(TREES, 'launcher', WIN ? 'Genie.exe' : 'genie');
const STUB = join(process.cwd(), 'scripts', 'stub-codex.mjs');
const TICKER = join(tmpdir(), 'genie-stub-codex-ticker');
const AGENTS = 3;
let PORT = Number(process.env.CDP_PORT ?? 9401);
const DEADLINE_MS = Number(process.env.LAUNCHER_ROW_DEADLINE_MS ?? 1_200_000);
/** The phases in which the Updates window says "Updating the host" (updates.html `busy`). */
const BUSY = ['draining', 'stopping', 'swapping', 'starting', 'rolling-back'];
// Everything this run starts (the launcher, the host it starts, the clients) reads the same roots and the same stub provider.
Object.assign(process.env, { GENIE_HOME, GENIE_CODE_ROOT: CODE_ROOT, GENIE2_CODEX_BINARY: process.env.GENIE2_CODEX_BINARY || STUB, GENIE_TEST_MACHINE: '1' });

const state = () => readJson(STATE)?.tracks ?? {};
const hostRecord = () => readJson(HOST_RECORD);
const idsIn = (file) => { const v = readJson(file); return Array.isArray(v) ? v.map(String) : []; };
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const samePath = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
const under = (path, folder) => (WIN ? path.toLowerCase() : path).startsWith((WIN ? folder.toLowerCase() : folder) + (WIN ? '\\' : '/'));
/** What the launcher says about its updates now (no network), or null. */
const updatesNow = async () => { const r = await wireCall(RUNTIME, 'launcher.updates', [], 15_000); return r.ok ? r.value : null; };
const trackRow = (view, track) => (view?.tracks ?? []).find((t) => t.track === track) ?? null;

// ---------------------------------------------------------------- the NEW packages, made and signed here
const UPDATES = join(TRACKS, 'updates', NEW);
/**
 * One NEW package, packed from `from` and signed with the run's throwaway key, in `dir`. A package this run already made
 * there (the same build, signed by the same key: its `.made` file says so) is used as it is.
 */
async function newPackage(track, { from = join(TREES, track), dir = UPDATES, notes = null } = {}) {
    const stem = `${track}-${NEW}-${PLATFORM}-${ARCH}`;
    const made = join(dir, `${stem}.made`);
    const manifest = join(dir, `${stem}.manifest.json`);
    if (readOr(made).trim() === PUB && existsSync(manifest) && existsSync(`${manifest}.sig`)) {
        console.log(`  ${track} ${NEW}: already made and signed by this run's key (${dir})`);
        return dir;
    }
    const t = Date.now();
    const r = await packTrack({
        from, out: dir, track, build: NEW, channel: 'stable', platform: PLATFORM, arch: ARCH, minLauncher: null,
        notes: notes ?? `What is new in ${track} ${NEW}.`, ...(track === 'host' || track === 'browser' ? { withClient: NEW } : {}),
    });
    writeFileSync(`${r.manifest}.sig`, signManifestBytes(readFileSync(r.manifest), PEM));
    writeFileSync(made, PUB);
    console.log(`  ${track} ${NEW}: ${r.value.files.length} files packed and signed in ${Math.round((Date.now() - t) / 1000)} s (${r.archive})`);
    return dir;
}
/**
 * THE BROKEN HOST (host-update-rollback): the host's tree, copied into this run's home, with its entry
 * (app/dist/main/host.js, the file the launcher starts the host on) replaced by a script that exits 3 before it writes
 * host.json or reads anything, as a host build that cannot start does. Packed and signed like any other: the signature is
 * Genie's, so only its start can fail. Never kept beyond this run's home.
 */
const BROKEN_HOST = [
    '// THE BROKEN HOST of the host-update-rollback row (scripts/launcher-updates-row.mjs): it exits at boot, before it writes',
    '// host.json or reads anything, as a host build that cannot start does. Only that row packs it; it is never shipped.',
    'process.exit(3);',
    '',
].join('\n');
async function brokenHostPackage() {
    const tree = join(HOME, 'broken-host-tree');
    const entry = join(tree, 'app', 'dist', 'main', 'host.js');
    cpSync(join(TREES, 'host'), tree, { recursive: true });
    if (!existsSync(entry)) refuse(`the host's tree has no app/dist/main/host.js to break (${entry})`);
    writeFileSync(entry, BROKEN_HOST);
    const dir = await newPackage('host', { from: tree, dir: join(HOME, 'broken-host-package'), notes: `What is new in host ${NEW} (it cannot start).` });
    rmSync(tree, { recursive: true, force: true });
    return dir;
}
/** The second launcher, alone in a folder under its own program name, packed as track launcher NEW. */
async function newLauncherPackage() {
    const tree = join(HOME, 'launcher-next-tree');
    mkdirSync(tree, { recursive: true });
    const program = join(tree, WIN ? 'Genie.exe' : 'genie');
    copyFileSync(NEW_LAUNCHER, program);
    if (!WIN) chmodSync(program, 0o755);
    return newPackage('launcher', { from: tree, dir: join(HOME, 'launcher-next-package') });
}

// ---------------------------------------------------------------- what this run starts, for its cleanup
const launcherPids = new Set();
const hostPids = new Set();
const installedClientPids = new Set();
/** The providers the new host restored (host-update rows): ended with the rest. */
const restoredPids = new Set();
const agents = [];
const sessions = [];
let feed = null;
let observer = null;
let LAUNCHER = null;
const launcherPid = () => { const r = readJson(join(RUNTIME, 'launcher.json')); return Number.isInteger(r?.pid) ? r.pid : null; };

function endPid(pid, tree = false) {
    if (!alive(pid)) return;
    try {
        if (WIN) execFileSync('taskkill', [...(tree ? ['/T'] : []), '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: SYNC_MS });
        else process.kill(pid, 'SIGKILL');
    } catch { /* gone */ }
}
let cleaned = false;
async function cleanup(why) {
    if (cleaned) return;
    cleaned = true;
    console.log(`[${since()}] cleanup (${why})`);
    rmSync(TICKER, { force: true });
    observer?.close();
    // The agents first, through the product, while a client is there to ask (bounded per agent).
    const live = sessions.filter((s) => s.cdp && !s.app.gone).pop();
    if (live) {
        for (const ag of agents) {
            try { await live.cdp.evaluate(`(window.genieTest ?? window.genie).stopAgent(${JSON.stringify(ag.id)}); true`, 5_000); console.log(`  stopped ${ag.name}`); } catch (e) { console.log(`  could not stop ${ag.name}: ${e.message}`); }
        }
    }
    for (const s of sessions) { s.cdp?.close(); if (!WIN) s.app.kill(); }
    // Every launcher this run started (the old and, after a self-update, the new): they hold no state; the hosts follow.
    for (const pid of [...launcherPids, launcherPid()]) if (Number.isInteger(pid)) { launcherPids.add(pid); endPid(pid); }
    const rec = hostRecord();
    if (Number.isInteger(rec?.pid)) hostPids.add(rec.pid);
    if (WIN) {
        // THE WINDOWS CLEANUP (Tynn #1031): every client's tree, every host this run saw, the providers and the launchers, by
        // the helper every row that starts its own Genie uses; what it leaves running is this row's failure.
        let endOwnRun = null;
        try { ({ endOwnRun } = await import('./end-own-tree.mjs')); } catch (error) { check(false, 'the Windows cleanup: scripts/end-own-tree.mjs (Tynn #1031) is not in this tree', String(error?.message ?? error).slice(0, 160)); }
        if (endOwnRun) {
            const app = sessions[sessions.length - 1]?.app ?? null;
            const others = [...agents.map((ag) => ag.pid), ...restoredPids, ...launcherPids, ...installedClientPids, ...hostPids, ...sessions.slice(0, -1).map((s) => s.app.pid)].filter((pid) => Number.isInteger(pid) && pid > 0);
            const ended = await endOwnRun({ app, hostPid: Number.isInteger(rec?.pid) ? rec.pid : null, others, since: run.t0, log: (line) => { console.log(`  ${line}`); } });
            check(ended.ok, 'nothing of this run is left running by its own cleanup', ended.ok ? '' : `LEFT RUNNING by this run's own cleanup: ${ended.words}`);
        } else {
            for (const s of sessions) s.app.kill();
        }
    } else {
        for (const pid of installedClientPids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
        // This run's providers: the agents' own, the restored ones, and any stub-codex under one of this run's hosts, read
        // before the hosts go (a provider whose host has gone is re-parented and no longer reads as ours).
        const map = parents();
        const ours = new Set([...agents.map((ag) => ag.pid), ...restoredPids]);
        for (const p of (await processesNamed('stub-codex')) ?? []) if ([...hostPids].some((h) => descends(p.pid, h, map))) ours.add(p.pid);
        // A host is ended by signal: SIGTERM (its graceful shutdown, which stops its sessions), then SIGKILL after 15 s; then
        // any provider of ours still standing, and any client window the launcher started.
        for (const pid of hostPids) {
            if (!alive(pid)) continue;
            console.log(`  ending the host pid ${pid} (SIGTERM, then SIGKILL after 15 s)`);
            try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
            for (let i = 0; i < 30 && alive(pid); i++) await sleep(500);
            endPid(pid);
        }
        for (const pid of ours) endPid(pid);
        for (const pid of installedClientPids) endPid(pid);
    }
    await feed?.close();
    // The code root this row installed (hundreds of MB) goes once nothing of the run runs from it; the logs stay for the report.
    try { rmSync(CODE_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); console.log(`  removed ${CODE_ROOT}`); } catch (e) { console.log(`  could not remove ${CODE_ROOT}: ${e.message}`); }
}
function finish() {
    if (run.failures.length) {
        console.log(`\n${ROW.toUpperCase()} (LAUNCHER L6) FAILED — ${run.failures.length} check(s):\n${run.failures.map((f) => `  - ${f}`).join('\n')}`);
        for (const log of [LAUNCHER_LOG, LAUNCHER_OWN_LOG, HOST_LOG, ...sessions.map((s) => s.app.log)]) {
            if (existsSync(log)) { console.log(`\n--- ${log} (last 50 lines) ---`); console.log(readOr(log).split('\n').slice(-50).join('\n')); }
        }
        process.exit(1);
    }
    const words = {
        'client-only-update': `the client and the browser went to ${NEW} from the launcher's feed while the host and every provider kept their pids and every tick streamed; the next window ran ${NEW}`,
        'host-update': `the host went ${OLD} -> ${NEW} through its own drain and the launcher's swap; every agent came back once`,
        'host-update-rollback': `a host ${NEW} that could not start was ended and Genie went back to ${OLD}; every agent came back once`,
        'launcher-self-update': `the launcher ${OLD} handed its endpoint to ${NEW}; the host and every provider kept their pids`,
        'version-skew': `the installed client ${NEW} ran against the installed host ${OLD}, and the client ${OLD} against the host ${NEW}, a turn streamed both ways in each`,
    }[ROW];
    console.log(`\n[${since()}] ${ROW.toUpperCase()} (LAUNCHER L6) — measured: ${words}.`);
    process.exit(0);
}

// ================================================================================================================ run
// THE WATCHDOG: a promise nothing settles would otherwise hold the run until the batch's `timeout` kills it, silently.
const watchdog = setTimeout(() => {
    check(false, `WATCHDOG: the run passed ${Math.round(DEADLINE_MS / 1000)} s`, `stuck in step ${run.current}`);
    setTimeout(() => { console.log('  cleanup did not finish within 90 s; exiting'); process.exit(1); }, 90_000).unref();
    void cleanup('watchdog').finally(finish);
}, DEADLINE_MS);

console.log(`\nLAUNCHER L6 — ${ROW}: ${OLD} installed, ${NEW} on a local feed (deadline ${Math.round(DEADLINE_MS / 1000)} s)\n`);
PORT = await freePort(PORT, 'debugger', '0.7');

// -------------------------------------------------------------------------------- OLD installed by the launcher
step('0.8', `the launcher (${LAUNCHER_TREE}) installs ${OLD} from ${PACKAGES} into ${CODE_ROOT}`);
if (!existsSync(LAUNCHER_TREE)) refuse(`no launcher from the package-tracks row (${LAUNCHER_TREE})`);
// THE CODE ROOT IS THE USER'S ONLY (the launcher refuses one other accounts can write to). On Windows the run's home is under
// the VM's temp folder, whose root gives BUILTIN\Users create rights: this user and SYSTEM only, inherited, as
// %LOCALAPPDATA% gives a real code root (quit-keeps-host-cdp.mjs, the same fix).
if (WIN) {
    mkdirSync(CODE_ROOT, { recursive: true });
    const me = (spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: SYNC_MS }).stdout ?? '').trim().split(',').pop()?.replace(/"/g, '') ?? '';
    if (!/^S-1-5-/.test(me)) refuse(`this user's SID could not be read (${me})`);
    const acl = spawnSync('icacls', [CODE_ROOT, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], { encoding: 'utf8', timeout: SYNC_MS });
    if (acl.status !== 0) refuse(`the code root could not be made private: ${String(acl.stdout ?? '')}${String(acl.stderr ?? '')}`.slice(0, 300));
}
{
    const r = spawnSync(LAUNCHER_TREE, ['install', '--from', PACKAGES, '--profile', 'both', '--channel', 'stable', '--yes'], { encoding: 'utf8', timeout: 300_000, env: process.env, windowsHide: true });
    const said = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (r.status !== 0) refuse(`the launcher did not install the packages (exit ${r.status}): ${said.slice(0, 400)}`);
    console.log(`  ${said.split(/\r?\n/).join(' | ')}`);
}
const installed = state();
if (installed.client?.current !== OLD || installed.host?.current !== OLD || installed.browser?.current !== OLD) refuse(`the install did not point client, host and browser at ${OLD}: ${JSON.stringify(installed)}`);
// WHERE THE LAUNCHER RUNS FROM: Linux, the launcher install put in its own track's folder and linked from ~/.local/bin/genie;
// Windows, Genie.exe where the NSIS installer puts it, copied from the tree (a self-update renames the running program).
if (WIN) {
    LAUNCHER = join(process.env.LOCALAPPDATA, 'Programs', 'Genie', 'Genie.exe');
    mkdirSync(dirname(LAUNCHER), { recursive: true });
    copyFileSync(LAUNCHER_TREE, LAUNCHER);
} else {
    LAUNCHER = join(HOME, '.local', 'bin', 'genie');
    let to = '';
    try { to = readlinkSync(LAUNCHER); } catch (e) { refuse(`install made no ${LAUNCHER} (${e.code}): the launcher package was not installed`); }
    if (!samePath(to, join(CODE_ROOT, 'launcher', OLD, 'genie'))) refuse(`${LAUNCHER} points at ${to}, not the installed launcher ${OLD}`);
    if (installed.launcher?.current !== OLD) refuse(`state.json's launcher is ${JSON.stringify(installed.launcher)}, not ${OLD}`);
}
console.log(`  the launcher runs from ${LAUNCHER}`);

// -------------------------------------------------------------------------------- NEW packages, on a local feed
step('0.9', `the NEW packages (${NEW}), repacked from the package-tracks row's trees and signed with the run's throwaway key`);
const published = [];
try {
    feed = await startFeed();
    const offer = async (track, dir) => { feed.publish({ track, build: NEW, dir }); published.push(track); };
    if (ROW === 'client-only-update') {
        await offer('client', await newPackage('client'));
        await offer('browser', await newPackage('browser'));
        // The host is offered too, for the tray's "Update host" (NEW in its tooltip) in its screenshot; this row never applies it.
        await offer('host', await newPackage('host'));
    } else if (ROW === 'host-update' || ROW === 'version-skew') {
        await offer('client', await newPackage('client'));
        await offer('host', await newPackage('host'));
    } else if (ROW === 'host-update-rollback') {
        await offer('client', await newPackage('client'));
        await offer('host', await brokenHostPackage());
    } else {
        await offer('launcher', await newLauncherPackage());
    }
} catch (error) {
    refuse(`the NEW packages could not be made: ${String(error?.message ?? error).slice(0, 400)}`);
}
console.log(`  the feed ${feed.url} offers ${published.map((t) => `${t} ${NEW}`).join(', ')}`);

// -------------------------------------------------------------------------------- the launcher, the host
step('0.10', 'the launcher started (serve; its feed, no timer, its tray probe) (≤ 30 s)');
{
    const log = openSync(LAUNCHER_LOG, 'a');
    const env = { ...process.env, GENIE_LAUNCHER_FEED: feed.url, GENIE_LAUNCHER_AUTO_CHECK: '0', GENIE_LAUNCHER_TRAY_PROBE: '1', ...(ROW === 'host-update-rollback' ? { GENIE_LAUNCHER_HOST_READY_MS: '20000' } : {}) };
    const child = spawn(LAUNCHER, ['serve'], { detached: !WIN, stdio: ['ignore', log, log], windowsHide: false, env });
    if (Number.isInteger(child.pid)) launcherPids.add(child.pid);
    child.unref();
}
/** Cannot run, once something of this run is running: what it started is ended first, then the refusal (exit 2). */
async function refuseCleanly(why) {
    clearTimeout(watchdog);
    await cleanup('cannot run');
    refuse(why);
}
const firstLauncher = await until(() => { const p = launcherPid(); return alive(p) ? p : null; }, 30_000);
if (!firstLauncher) await refuseCleanly(`the launcher did not start: ${readOr(LAUNCHER_LOG).slice(-400)}`);
launcherPids.add(firstLauncher);
console.log(`  launcher pid ${firstLauncher}`);
/**
 * THE ROLLBACK ROW'S FIRST HOST is started by `genie ensure-host` (the same host::ensure_host, in a launcher process of its
 * own) and adopted by the serving launcher: that launcher's 20 s bound is the rollback's, and it would also bound this first
 * boot, which a loaded VM can take longer than 20 s for. The other rows ask the serving launcher (launcher.ensureHost).
 */
function ensureHostByCli() {
    const r = spawnSync(LAUNCHER, ['ensure-host'], { encoding: 'utf8', timeout: 120_000, env: process.env, windowsHide: true });
    const said = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    let value = null;
    try { value = JSON.parse(said.split(/\r?\n/).filter((l) => l.startsWith('{')).pop() ?? 'null'); } catch { /* said below */ }
    return r.status === 0 && value ? { ok: true, value } : { ok: false, reason: `genie ensure-host exited ${r.status}: ${said.slice(0, 300)}` };
}
step('0.11', `the host, started through the launcher (${ROW === 'host-update-rollback' ? 'genie ensure-host' : 'launcher.ensureHost'}, ≤ 120 s)`);
const ensured = ROW === 'host-update-rollback' ? ensureHostByCli() : await wireCall(RUNTIME, 'launcher.ensureHost', [], 120_000);
if (Number.isInteger(ensured.value?.pid)) hostPids.add(ensured.value.pid);
if (!ensured.ok || ensured.value?.build !== OLD) await refuseCleanly(`the launcher did not start the host ${OLD}: ${ensured.reason ?? JSON.stringify(ensured.value)}`);
console.log(`  ${JSON.stringify(ensured.value)}`);
hostPids.add(ensured.value.pid);
step('0.12', `the ticker marker, holding this script's pid ${process.pid}`);
writeFileSync(TICKER, String(process.pid));

// -------------------------------------------------------------------------------- the client and three ticker agents
let hostPid = null;
let a = null;
/** Three codex agents, started and prompted through `session`, each streaming from ONE provider pid. */
async function startAgents(session) {
    step('1e', 'reading the seed: its first workspace');
    const snap = await session.cdp.evaluate('window.genieTest.snapshot()', 15_000);
    const workspaceId = snap.workspaces?.[0]?.id ?? null;
    if (typeof workspaceId !== 'string') throw new Error('no workspace in the seed (smoke-seed.mjs)');
    for (let i = 1; i <= AGENTS; i++) {
        const name = `ticker-${i}-${process.pid}`;
        step(`1.${i}`, `adding the codex agent ${name}`);
        const added = await session.cdp.evaluate(`(window.genieTest ?? window.genie).addAgent(${JSON.stringify(workspaceId)}, { name: ${JSON.stringify(name)}, purpose: 'Streams ticks for the launcher update rows.', provider: 'codex' })`, 30_000);
        if (check(added?.ok === true, `1.${i} agent ${name} added`, added?.ok ? added.id : added?.reason)) agents.push({ id: added.id, name });
    }
    for (const ag of agents) {
        step('2', `starting ${ag.name} (≤ 30 s to running)`);
        await waitForPageProbe(session.cdp);
        await session.cdp.evaluate(`window.genieTest.agents.restart(${JSON.stringify(ag.id)}, "graceful"); true`, 15_000);
        const running = await until(() => session.cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(ag.id)}).then((d) => d?.session?.running === true)`, 5_000), 30_000);
        check(running === true, `2. ${ag.name}'s session is running`);
        step('3', `prompting ${ag.name}`);
        const sent = await session.cdp.evaluate(`(window.genieTest ?? window.genie).prompt(${JSON.stringify(ag.id)}, 'Stream ticks until stopped.')`, 15_000);
        check(sent?.ok === true, `3. ${ag.name} took the prompt`, sent?.reason ?? '');
    }
    for (const ag of agents) {
        step('4', `waiting for ${ag.name}'s ledger to stream 8 ticks (≤ 30 s)`);
        const t = await until(async () => { const x = await ticksOf(session.cdp, ag.id); return x.max >= 8 ? x : null; }, 30_000);
        ag.before = t ?? await ticksOf(session.cdp, ag.id);
        ag.pid = ag.before.pids.length === 1 ? ag.before.pids[0] : null;
        check(ag.pid !== null, `4. ${ag.name}'s ledger is streaming, from ONE provider pid`, `ticks to ${ag.before.max}, pids ${JSON.stringify(ag.before.pids)}`);
    }
}
/** POSITIVE CONTROL: the pids read are real, live, and what they say they are — before anything is updated. */
function controls(session) {
    step('5', `positive control: host.json (${HOST_RECORD}) and the process table`);
    hostPid = hostRecord()?.pid ?? null;
    check(alive(hostPid) && /host\.js/.test(commandLine(hostPid)), '5. CONTROL: host.json names a LIVE genie-host process', `pid ${hostPid}: ${commandLine(hostPid).slice(0, 160)}`);
    check(hostPid === ensured.value.pid, '6. CONTROL: it is the host the launcher started', `${ensured.value.pid} / ${hostPid}`);
    const pids = agents.map((ag) => ag.pid);
    check(new Set(pids).size === AGENTS, '7. CONTROL: three DIFFERENT provider pids', JSON.stringify(pids));
    for (const ag of agents) check(alive(ag.pid) && /stub-codex/.test(commandLine(ag.pid)), `8. CONTROL: ${ag.name}'s provider pid ${ag.pid} is a LIVE stub-codex process`, commandLine(ag.pid).slice(0, 120));
    check(alive(session.app.pid), '9. CONTROL: the client process is alive', `pid ${session.app.pid}`);
}
/** Each agent's ledger grew past where it was, from the SAME provider pid, with every tick in between, in order. */
async function ledgersStreamedThrough(session, id, why) {
    for (const ag of agents) {
        step(id, `${ag.name}: its ledger past tick ${ag.before.max} (≤ 30 s)`);
        const after = await until(async () => { const x = await ticksOf(session.cdp, ag.id); return x.max > ag.before.max + 8 ? x : null; }, 30_000) ?? await ticksOf(session.cdp, ag.id);
        check(after.running === true, `${id}. ${ag.name} is still running`, String(after.running));
        check(after.pids.length === 1 && after.pids[0] === ag.pid && alive(ag.pid), `${id}. ${ag.name}: the SAME provider pid, alive`, `${ag.pid} → ${JSON.stringify(after.pids)}`);
        const gap = contiguous(after.ticks, ag.before.max + 1, after.max);
        check(after.max > ag.before.max && gap === null, `${id}. ${ag.name}: every tick streamed ${why} is in the ledger, in order`, gap === null ? `${ag.before.max + 1}..${after.max}` : `tick ${gap} missing`);
        ag.before = after;
    }
}
function sameHostAndProviders(id, why) {
    check(alive(hostPid) && hostRecord()?.pid === hostPid, `${id}. the SAME host pid ${why}`, `${hostPid} → ${hostRecord()?.pid}`);
    for (const ag of agents) check(alive(ag.pid), `${id}. ${ag.name}'s provider pid ${ag.pid} is alive ${why}`);
}
/** Ends a client this run launched, and waits for it (≤ 15 s). */
async function endClient(session) {
    session.cdp?.close();
    session.cdp = null;
    session.app.kill();
    await until(() => !alive(session.app.pid), 15_000);
}
/** The tray's menu as words (and, on Windows, shown at its icon) and, on Linux, opened with a pointer; then photographed. */
async function trayShot(name) {
    const menu = await wireCall(RUNTIME, 'launcher.trayMenu', [], 15_000);
    const linuxOpened = WIN ? true : openLinuxTrayMenu();
    await sleep(1_500);
    shot(name);
    console.log(`  the tray menu ${linuxOpened ? 'was opened for this screenshot' : 'could not be opened on this desktop: the screenshot shows the bar and its icon only'}`);
    pressKey('Escape');
    return menu;
}

// ================================================================================================================ the rows
async function clientOnlyUpdate() {
    step('10', 'launcher.check: the feed read, every newer build made READY, nothing applied (≤ 600 s)');
    const checked = await wireCall(RUNTIME, 'launcher.check', [], 600_000);
    console.log(`  ${JSON.stringify(checked.value?.tracks ?? checked.reason)}`);
    const client = trackRow(checked.value, 'client');
    const browser = trackRow(checked.value, 'browser');
    const host = trackRow(checked.value, 'host');
    check(checked.ok, '10. launcher.check answered', checked.reason ?? '');
    check(client?.state === 'ready' && client?.offer?.build === NEW && client?.current === OLD, `10a. the client ${NEW} is READY (downloaded and verified), the current still ${OLD}`, JSON.stringify(client));
    check(browser?.state === 'ready' && browser?.offer?.build === NEW, `10b. the browser ${NEW} is READY`, JSON.stringify(browser));
    check(host?.state === 'ready' && host?.offer?.build === NEW && host?.withClient === NEW && host?.restartsHost === true, `10c. the host ${NEW} is offered too, with its client ${NEW}, and says it restarts the host`, JSON.stringify(host));
    check(state().client?.current === OLD && state().host?.current === OLD, '10d. a check applies nothing: state.json still points client and host at OLD', JSON.stringify(state()));
    check(feed.hits().assets.length > 0, '10e. the launcher downloaded the packages from the feed', JSON.stringify(feed.hits()));
    // L7 (Tynn #716): a person's check asks the host to check its tools too; the real genie-host answers engine.toolchain on
    // the launcher's link, and its rows sit beside the tracks (photographed in step 12's Updates window).
    const tools = checked.value?.tools;
    console.log(`  tools: ${JSON.stringify(tools)}`);
    check(tools?.host === true && !tools?.why && Array.isArray(tools?.rows), "10f. the host's tools are beside the tracks: the real host answered engine.toolchain on the launcher's link", JSON.stringify(tools));

    step('11', 'the tray offers the updates: "Updates (N)" and "Update host", the build NEW in its tooltip (photographed)');
    const menu = await trayShot(`tray-offer-${OS}.png`);
    const items = menu.value?.items ?? [];
    const count = Number(/^Updates \((\d+)\)$/.exec(items.find((i) => /^Updates \(\d+\)$/.test(i)) ?? '')?.[1] ?? 0);
    check(menu.ok && count >= 3 && items.includes('Update host'), `11. the TRAY says "Updates (${count})" (client, browser, host) and offers "Update host"`, items.join(' | '));
    check(/\d+ updates? ready/.test(menu.value?.tooltip ?? '') && (menu.value?.tooltip ?? '').includes(`(host ${NEW})`), `11t. its tooltip says the updates are ready and names the host build ${NEW}`, menu.value?.tooltip ?? '');

    step('12', "the tray's Updates: the launcher's Updates window (photographed)");
    const logAt = readOr(LAUNCHER_LOG).length;
    const act = await wireCall(RUNTIME, 'launcher.trayAct', [{ action: 'updates' }], 15_000);
    const shown = await until(() => (/the Updates window is shown/.test(readOr(LAUNCHER_LOG).slice(logAt)) ? true : null), 30_000);
    check(act.ok && shown === true, "12. the tray's Updates opened the launcher's own Updates window", act.reason ?? readOr(LAUNCHER_LOG).slice(logAt).slice(-300));
    await sleep(2_000);
    shot(`updates-${OS}.png`);

    step('13', "a link of this run's own, attached to the launcher, to hear what it tells its clients");
    observer = await wireAttach(RUNTIME, process.pid);
    check(observer.ok, '13. the launcher took the attach', observer.reason ?? '');

    step('14', `launcher.apply client, then browser: pointed at ${NEW}, the open window left on its build`);
    const appliedClient = await wireCall(RUNTIME, 'launcher.apply', [{ track: 'client' }], 60_000);
    check(appliedClient.ok && appliedClient.value?.build === NEW, `14a. the client ${NEW} is applied`, appliedClient.reason ?? JSON.stringify(appliedClient.value));
    check(Array.isArray(appliedClient.value?.windowsKept) && appliedClient.value.windowsKept.includes(a.app.pid), "14b. the open client window is one the launcher KEPT (it is attached and was not closed)", JSON.stringify(appliedClient.value?.windowsKept));
    const appliedBrowser = await wireCall(RUNTIME, 'launcher.apply', [{ track: 'browser' }], 60_000);
    check(appliedBrowser.ok && appliedBrowser.value?.build === NEW, `14c. the browser ${NEW} is applied (it runs on the client ${NEW})`, appliedBrowser.reason ?? JSON.stringify(appliedBrowser.value));
    const told = await until(() => { const e = observer.events().filter((x) => x.name === 'launcher.updateReady'); return e.length >= 2 ? e : null; }, 15_000) ?? observer.events();
    check(told.some((e) => e.track === 'client' && e.build === NEW) && told.some((e) => e.track === 'browser' && e.build === NEW), "14d. the launcher's attached links were told launcher.updateReady for the client and the browser", JSON.stringify(told));
    const st = state();
    check(st.client?.current === NEW && st.client?.previous === OLD && st.browser?.current === NEW, `14e. state.json: client ${NEW} (previous ${OLD}), browser ${NEW}`, JSON.stringify(st));
    check(st.host?.current === OLD, `14f. and the host is untouched: still ${OLD}`, JSON.stringify(st.host));

    step('15', 'through the update: the same host, the same providers, every tick (12 s)');
    await sleep(12_000);
    sameHostAndProviders('15a', 'after the client update');
    check(hostRecord()?.build === OLD, `15b. the host still runs ${OLD}`, JSON.stringify(hostRecord()));
    check(!a.app.gone && alive(a.app.pid), '15c. the open client window still runs: it was left on its build', `pid ${a.app.pid}`);
    await ledgersStreamedThrough(a, '15d', 'through the client update');

    step('16', `the next window: it runs from ${join(CODE_ROOT, 'client', NEW)}`);
    await endClient(a);
    const opened = await wireCall(RUNTIME, 'launcher.openWindow', [], 90_000);
    const pid = opened.value?.pid;
    if (Number.isInteger(pid)) installedClientPids.add(pid);
    check(opened.ok && opened.value?.build === NEW && opened.value?.program === NEW, `16a. launcher.openWindow started the client ${NEW}`, opened.reason ?? JSON.stringify(opened.value));
    const exe = Number.isInteger(pid) ? executableOf(pid) : '(no pid)';
    check(under(exe, join(CODE_ROOT, 'client', NEW)), `16b. the new window's process runs from the client ${NEW}'s own folder`, exe);
    await sleep(10_000);
    shot(`next-window-${OS}.png`);
    const cameUp = await until(() => (alive(pid) && state().client?.trial !== true ? true : null), 30_000);
    check(cameUp === true, `16c. it came up: alive, and the launcher took the client ${NEW} off trial`, `alive ${alive(pid)}, ${JSON.stringify(state().client)}`);
    sameHostAndProviders('16d', 'after the new window');
}

/**
 * THE AGENTS' PROVIDERS, SAMPLED WHILE THE UPDATE RUNS: every stub-codex process seen (pid and start), the drain's record
 * whenever it names agents, and the launcher's hostUpdate as it moves. Stopped by `stop()`, which returns what it saw.
 */
function watchUpdate() {
    const seen = new Map();
    const phases = [];
    let record = [];
    let last = null;
    let stopped = false;
    const providers = (async () => {
        while (!stopped) {
            for (const p of (await processesNamed('stub-codex')) ?? []) if (!seen.has(p.key)) seen.set(p.key, { ...p, at: since() });
            const ids = idsIn(RUNNING_AT_QUIT);
            // Every agent it named while the update ran: the restore takes each off as it starts, 3 s apart.
            for (const id of ids) if (!record.includes(id)) record.push(id);
            await sleep(WIN ? 250 : 500);
        }
    })();
    const launcher = (async () => {
        while (!stopped) {
            const u = await updatesNow();
            if (u?.hostUpdate && typeof u.hostUpdate === 'object') {
                last = u.hostUpdate;
                if (phases[phases.length - 1] !== last.phase) { phases.push(last.phase); console.log(`  [${since()}] hostUpdate: ${last.phase}${last.said ? ` — ${last.said}` : ''}`); }
            }
            await sleep(1_000);
        }
    })();
    return {
        last: () => last,
        phases: () => [...phases],
        async stop() { stopped = true; await Promise.all([providers, launcher]); return { seen, phases: [...phases], record, last }; },
    };
}

async function hostUpdate(broken) {
    const expectBuild = broken ? OLD : NEW;
    step('10', 'launcher.check: the host and its client made READY, nothing applied (≤ 600 s)');
    const checked = await wireCall(RUNTIME, 'launcher.check', [{ tools: false }], 600_000);
    console.log(`  ${JSON.stringify(checked.value?.tracks ?? checked.reason)}`);
    const host = trackRow(checked.value, 'host');
    check(checked.ok && host?.state === 'ready' && host?.offer?.build === NEW && host?.withClient === NEW, `10a. the host ${NEW} is READY with its client ${NEW}${broken ? ' (the broken one: its signature is good, only its start fails)' : ''}`, checked.reason ?? JSON.stringify(host));
    check(state().host?.current === OLD && state().client?.current === OLD, '10b. a check applies nothing: state.json still points host and client at OLD', JSON.stringify(state()));
    const menu = await wireCall(RUNTIME, 'launcher.trayMenu', [], 15_000);
    pressKey('Escape');
    check((menu.value?.items ?? []).includes('Update host') && (menu.value?.tooltip ?? '').includes(`(host ${NEW})`), `10c. the tray offers "Update host", ${NEW} in its tooltip`, `${(menu.value?.items ?? []).join(' | ')} / ${menu.value?.tooltip ?? ''}`);

    step('11', 'before the update: the providers under the old host, read from the OS');
    const map = parents();
    const everyBefore = (await processesNamed('stub-codex')) ?? [];
    const before = everyBefore.filter((p) => descends(p.pid, hostPid, map));
    // EVERY provider alive before the update, ours or not: "no other was started while it ran" counts only what started
    // after. A gate VM can hold another row's stub (Linux, 1127-174858-edb743: one from 23 s into the row, under no host of it).
    const beforeKeys = new Set(everyBefore.map((p) => p.key));
    check(before.length === AGENTS && agents.every((ag) => before.some((p) => p.pid === ag.pid)), `11. CONTROL: the OS shows ${AGENTS} stub-codex providers under the host ${hostPid}, the agents' own`, JSON.stringify(before));

    step('12', `the tray's "Update host" (${NEW}): the host drains itself, the launcher swaps it`);
    const watch = watchUpdate();
    const logAt = readOr(LAUNCHER_LOG).length;
    const act = await wireCall(RUNTIME, 'launcher.trayAct', [{ action: 'installHostUpdate' }], 15_000);
    check(act.ok, "12a. the tray's offer was chosen", act.reason ?? '');
    const busy = await until(() => (BUSY.includes(watch.last()?.phase) ? watch.last() : null), 90_000, 300);
    check(busy !== null && busy.from === OLD && busy.to === NEW, `12b. the host update is under way (${busy?.phase}), ${OLD} → ${NEW}`, JSON.stringify(watch.last()));
    check(Number(busy?.agents?.count ?? 0) >= AGENTS, '12c. the launcher knows which agents the drain pauses', JSON.stringify(busy?.agents));
    const shown = await until(() => (/the Updates window is shown/.test(readOr(LAUNCHER_LOG).slice(logAt)) ? true : null), 60_000);
    check(shown === true, '12d. the tray opened the Updates window to show the update', readOr(LAUNCHER_LOG).slice(logAt).slice(-300));
    await sleep(1_500);
    const during = watch.last()?.phase;
    check(BUSY.includes(during), `12e. the Updates window is photographed while the host is updating (${during})`);
    shot(broken ? `host-update-rollback-progress-${OS}.png` : `host-update-progress-${OS}.png`);

    const finalPhase = broken ? 'rolled-back' : 'done';
    step('13', `waiting for the host update to end (${finalPhase}; ≤ 540 s: the drain's 120 s, the old host's exit, the start${broken ? ', the rollback' : ''})`);
    const ended = await until(() => (['done', 'rolled-back', 'failed'].includes(watch.last()?.phase) ? watch.last() : null), 540_000, 1_000);
    check(ended?.phase === finalPhase, `13a. the host update ended ${finalPhase}`, JSON.stringify(ended));
    if (broken) {
        check(String(ended?.said ?? '').includes(`so Genie went back to ${OLD}`), `13b. it says why, in words: "…so Genie went back to ${OLD}…"`, String(ended?.said));
        // The launcher's own record of the steps: "starting" can last under a second (the new host exits at once), which a
        // sampler misses (Windows, 1127-174858-edb743).
        const steps = (ended?.steps ?? []).join(' → ');
        check(/starting → rolling-back → rolled-back$/.test(steps), '13c. the new host was started, then the launcher went back', steps);
        check(new RegExp(`the new host ${NEW.replace(/\./g, '\\.')} did not come up`).test(readOr(LAUNCHER_LOG)), `13d. the launcher logged that the host ${NEW} did not come up`);
        await sleep(2_500);
        // The launcher opens Genie again after the swap (15f), over the Updates window: the tray's Updates brings it forward.
        const front = await wireCall(RUNTIME, 'launcher.trayAct', [{ action: 'updates' }], 15_000);
        console.log(`  the Updates window brought forward for the shot: ${front.ok ? 'yes' : front.reason}`);
        await sleep(2_000);
        shot(`host-update-rollback-${OS}.png`);
    }

    step('14', `the host after it: a new pid at ${expectBuild}, the old one gone`);
    const rec = await until(() => { const r = hostRecord(); return r && r.pid !== hostPid && alive(r.pid) ? r : null; }, 60_000) ?? hostRecord();
    if (Number.isInteger(rec?.pid)) hostPids.add(rec.pid);
    check(!alive(hostPid), `14a. the old host pid ${hostPid} is gone`);
    check(rec?.pid !== hostPid && alive(rec?.pid) && rec?.build === expectBuild, `14b. a NEW host runs ${expectBuild}`, JSON.stringify(rec));
    const exe = Number.isInteger(rec?.pid) ? commandLine(rec.pid) : '';
    check(exe.includes(join(CODE_ROOT, 'host', expectBuild)) || (WIN && exe.toLowerCase().includes(join(CODE_ROOT, 'host', expectBuild).toLowerCase())), `14c. it runs from the host ${expectBuild}'s own folder`, exe.slice(0, 240));
    const st = state();
    if (broken) check(st.host?.current === OLD && st.client?.current === OLD, `14d. state.json went back: host ${OLD}, client ${OLD}`, JSON.stringify(st));
    else check(st.host?.current === NEW && st.host?.previous === OLD && st.client?.current === NEW, `14d. state.json: host ${NEW} (previous ${OLD}), client ${NEW}`, JSON.stringify(st));

    step('15', 'every agent back ONCE: the providers under the new host (≤ 120 s), then 10 s for a second start to show');
    const newHost = rec?.pid ?? -1;
    const underNew = async () => { const m = parents(); return ((await processesNamed('stub-codex')) ?? []).filter((p) => !beforeKeys.has(p.key) && descends(p.pid, newHost, m)); };
    await until(async () => ((await underNew()).length >= AGENTS ? true : null), 120_000, 2_000);
    await sleep(10_000);
    const live = (await processesNamed('stub-codex')) ?? [];
    const now = await underNew();
    const saw = await watch.stop();
    const fresh = [...saw.seen.keys()].filter((k) => !beforeKeys.has(k));
    for (const p of now) restoredPids.add(p.pid);
    check(before.every((p) => !live.some((q) => q.key === p.key)), '15a. every provider from before the update is gone', JSON.stringify(live));
    check(now.length === AGENTS, `15b. exactly ${AGENTS} new providers run under the new host ${newHost}: one per agent`, JSON.stringify(now));
    check(fresh.length === AGENTS, `15c. and no other was started while it ran: ${fresh.length} new provider process(es) seen in all (want ${AGENTS})`, JSON.stringify(fresh.map((k) => saw.seen.get(k))));
    check(agents.every((ag) => saw.record.includes(ag.id)), "15d. the drain's record (running-at-quit.json) named every agent while the update ran", JSON.stringify(saw.record));
    const spent = await until(() => (idsIn(RUNNING_AT_QUIT).length === 0 ? true : null), 60_000);
    check(spent === true, '15e. the record is spent: the agents were restored from it', JSON.stringify(idsIn(RUNNING_AT_QUIT)));

    step('15f', `the window left when the host installed, and the launcher opened Genie again, on the client ${expectBuild} (≤ 60 s)`);
    const reopened = await until(() => {
        const m = /Genie opened again after the host's update \((\{.*\})\)/.exec(readOr(LAUNCHER_LOG).slice(logAt));
        try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
    }, 60_000);
    if (Number.isInteger(reopened?.pid)) installedClientPids.add(reopened.pid);
    check(reopened?.program === expectBuild, `15f. the launcher opened Genie again after the swap, on the client ${expectBuild} ("drain and swap the host, then refresh the UI")`, JSON.stringify(reopened));
    // Its window has no debugger port: it is ended, and step 16 reads the agents in a client of this row's own.
    if (Number.isInteger(reopened?.pid)) { endPid(reopened.pid); await until(() => (!alive(reopened.pid) ? true : null), 15_000); }

    step('16', `each agent's session runs again, read in a new client linked to the host ${expectBuild}`);
    await endClient(a);
    const b = await openClient({ label: 'after', id: 16, port: PORT, launcherExe: LAUNCHER, hostBuild: rec?.build ?? expectBuild });
    sessions.push(b);
    for (const ag of agents) {
        const running = await until(() => b.cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(ag.id)}).then((d) => d?.session?.running === true)`, 5_000), 60_000);
        check(running === true, `16a. ${ag.name} is running again under the new host`);
        // Restored means streaming again: a tick in its ledger from one of the providers the new host started (step 15).
        const fresh = new Set(now.map((p) => p.pid));
        const t = await until(async () => { const x = await ticksOf(b.cdp, ag.id).catch(() => null); return x && x.pids.some((pid) => fresh.has(pid)) ? x : null; }, 30_000)
            ?? await ticksOf(b.cdp, ag.id).catch(() => null);
        check(Boolean(t?.pids.some((pid) => fresh.has(pid))), `16b. ${ag.name} streams again, from a provider the new host started`,
            `ledger to tick ${t?.max}, pids ${JSON.stringify(t?.pids)}; new providers ${JSON.stringify([...fresh])} (before the update: pid ${ag.pid})`);
    }
}

/** An installed client build's own program: <code root>/client/<build>/genie-client(.exe). */
const clientProgram = (build) => join(CODE_ROOT, 'client', build, WIN ? 'genie-client.exe' : 'genie-client');
const skewAgents = [];
/**
 * A TURN BOTH WAYS through `session` (version-skew): an agent of its own added, started and prompted FROM this client (the
 * request goes client -> host), and its provider's reply streamed back INTO this client's ledger (host -> client), from
 * one provider process under the host now running.
 */
async function skewTurn(session, id, label, tag) {
    const snap = await session.cdp.evaluate('window.genieTest.snapshot()', 15_000);
    const workspaceId = snap.workspaces?.[0]?.id ?? null;
    if (!check(typeof workspaceId === 'string', `${id}.1 ${label}: this client reads the host's workspaces`, JSON.stringify(snap.workspaces ?? null).slice(0, 200))) return;
    // An agent's name: a letter, then lower-case letters, digits and dashes, at most 40 (the host refuses any other; the
    // gate's first run, 1127-205532-3c9e94, used the label with its builds in it, which is 47).
    const name = `skew-${tag}-${process.pid}`;
    step(`${id}.2`, `${label}: adding the agent ${name} from this client`);
    const added = await session.cdp.evaluate(`(window.genieTest ?? window.genie).addAgent(${JSON.stringify(workspaceId)}, { name: ${JSON.stringify(name)}, purpose: 'Streams ticks for the version-skew row.', provider: 'codex' })`, 30_000);
    if (!check(added?.ok === true, `${id}.2 ${label}: the host took the new agent from this client`, added?.ok ? added.id : added?.reason)) return;
    const ag = { id: added.id, name };
    skewAgents.push(ag);
    step(`${id}.3`, `${label}: starting and prompting ${name} (≤ 60 s to running)`);
    await waitForPageProbe(session.cdp);
    await session.cdp.evaluate(`window.genieTest.agents.restart(${JSON.stringify(ag.id)}, "graceful"); true`, 15_000);
    const running = await until(() => session.cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(ag.id)}).then((d) => d?.session?.running === true)`, 5_000), 60_000);
    check(running === true, `${id}.3 ${label}: ${name}'s session is running`);
    const sent = await session.cdp.evaluate(`(window.genieTest ?? window.genie).prompt(${JSON.stringify(ag.id)}, 'Stream ticks until stopped.')`, 15_000);
    check(sent?.ok === true, `${id}.4 ${label}: the prompt went from this client to the host`, sent?.reason ?? '');
    step(`${id}.5`, `${label}: the reply streams back into this client: 8 ticks (≤ 45 s)`);
    const t = await until(async () => { const x = await ticksOf(session.cdp, ag.id); return x.max >= 8 ? x : null; }, 45_000) ?? await ticksOf(session.cdp, ag.id);
    const host = hostRecord()?.pid ?? -1;
    const pid = t.pids.length === 1 ? t.pids[0] : null;
    if (Number.isInteger(pid)) restoredPids.add(pid);
    check(pid !== null && descends(pid, host, parents()) && /stub-codex/.test(commandLine(pid)), `${id}.5 ${label}: the turn streamed back, from ONE provider under the host ${host}`, `ticks to ${t.max}, pids ${JSON.stringify(t.pids)}`);
    const gap = contiguous(t.ticks, 1, t.max);
    check(gap === null, `${id}.6 ${label}: every tick of the turn is in this client's ledger, in order`, gap === null ? `1..${t.max}` : `tick ${gap} missing`);
}

/**
 * VERSION SKEW (Tynn #1058 L8; the spec's "Mixed pairs are tested, not assumed"): the client N-1 against the host N, and
 * the reverse, as the real installed programs of each build, each from its own folder, with a turn streamed both ways.
 * OLD is N-1 and NEW is N (see the header for what they are made of).
 */
async function versionSkew() {
    step('10', 'launcher.check: the client and the host NEW made READY, nothing applied (≤ 600 s)');
    const checked = await wireCall(RUNTIME, 'launcher.check', [{ tools: false }], 600_000);
    const host = trackRow(checked.value, 'host');
    const client = trackRow(checked.value, 'client');
    check(checked.ok && client?.state === 'ready' && host?.state === 'ready' && host?.withClient === NEW, `10a. the client ${NEW} and the host ${NEW} (with its client ${NEW}) are READY`, checked.reason ?? JSON.stringify(checked.value?.tracks));

    // ---------------------------------------------------------------- the client NEW against the host OLD
    step('11', `the client ${NEW} applied by itself: the host stays ${OLD}`);
    const applied = await wireCall(RUNTIME, 'launcher.apply', [{ track: 'client' }], 60_000);
    check(applied.ok && applied.value?.build === NEW, `11a. the client ${NEW} is applied`, applied.reason ?? JSON.stringify(applied.value));
    check(state().host?.current === OLD && hostRecord()?.build === OLD && hostRecord()?.pid === hostPid, `11b. the host is still ${OLD}, the same pid ${hostPid}`, JSON.stringify(hostRecord()));
    await endClient(a);
    const newOld = await openClient({ label: 'client-new-host-old', id: 12, port: PORT, launcherExe: LAUNCHER, hostBuild: OLD, program: clientProgram(NEW) });
    sessions.push(newOld);
    if (Number.isInteger(newOld.app.pid)) installedClientPids.add(newOld.app.pid);
    check(under(executableOf(newOld.app.pid), join(CODE_ROOT, 'client', NEW)), `12d. the client is the INSTALLED ${NEW}, run from its own folder`, executableOf(newOld.app.pid));
    const oldHostCmd = commandLine(hostPid);
    check(hostRecord()?.build === OLD && (oldHostCmd.includes(join(CODE_ROOT, 'host', OLD)) || (WIN && oldHostCmd.toLowerCase().includes(join(CODE_ROOT, 'host', OLD).toLowerCase()))), `12e. against the INSTALLED host ${OLD}, run from its own folder`, oldHostCmd.slice(0, 240));
    await skewTurn(newOld, '12', `client-${NEW}-host-${OLD}`, 'newclient');
    await ledgersStreamedThrough(newOld, '12t', `into the client ${NEW} from the host ${OLD}`);
    shot(`version-skew-client-new-host-old-${OS}.png`);

    // ---------------------------------------------------------------- the host NEW, then the client OLD against it
    step('13', `the host to ${NEW} through its own drain and the launcher's swap (≤ 540 s)`);
    const logAt = readOr(LAUNCHER_LOG).length;
    const act = await wireCall(RUNTIME, 'launcher.trayAct', [{ action: 'installHostUpdate' }], 15_000);
    check(act.ok, "13a. the tray's \"Update host\" was chosen", act.reason ?? '');
    const ended = await until(async () => { const u = await updatesNow(); const p = u?.hostUpdate?.phase; return ['done', 'rolled-back', 'failed'].includes(p) ? u.hostUpdate : null; }, 540_000, 2_000);
    check(ended?.phase === 'done', `13b. the host update ended done`, JSON.stringify(ended));
    const rec = await until(() => { const r = hostRecord(); return r && r.pid !== hostPid && alive(r.pid) ? r : null; }, 60_000) ?? hostRecord();
    if (Number.isInteger(rec?.pid)) hostPids.add(rec.pid);
    check(rec?.build === NEW && alive(rec?.pid), `13c. a new host runs ${NEW}`, JSON.stringify(rec));
    const reopened = await until(() => {
        const m = /Genie opened again after the host's update \((\{.*\})\)/.exec(readOr(LAUNCHER_LOG).slice(logAt));
        try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
    }, 60_000);
    // The launcher opens its current client (NEW) after the swap; this row opens the OLD one instead.
    if (Number.isInteger(reopened?.pid)) { installedClientPids.add(reopened.pid); endPid(reopened.pid); await until(() => (!alive(reopened.pid) ? true : null), 15_000); }
    if (newOld.app && !newOld.app.gone) await endClient(newOld);
    const st = state();
    check(st.client?.current === NEW && st.client?.previous === OLD && existsSync(clientProgram(OLD)), `13d. the client ${OLD} is still installed, as the previous build`, JSON.stringify(st.client));

    step('14', `the client ${OLD} against the host ${NEW}`);
    const oldNew = await openClient({ label: 'client-old-host-new', id: 14, port: PORT, launcherExe: LAUNCHER, hostBuild: NEW, program: clientProgram(OLD) });
    sessions.push(oldNew);
    if (Number.isInteger(oldNew.app.pid)) installedClientPids.add(oldNew.app.pid);
    check(under(executableOf(oldNew.app.pid), join(CODE_ROOT, 'client', OLD)), `14d. the client is the INSTALLED ${OLD}, run from its own folder`, executableOf(oldNew.app.pid));
    const hostCmd = Number.isInteger(rec?.pid) ? commandLine(rec.pid) : '';
    check(hostCmd.includes(join(CODE_ROOT, 'host', NEW)) || (WIN && hostCmd.toLowerCase().includes(join(CODE_ROOT, 'host', NEW).toLowerCase())), `14e. against the INSTALLED host ${NEW}, run from its own folder`, hostCmd.slice(0, 240));
    await skewTurn(oldNew, '14', `client-${OLD}-host-${NEW}`, 'oldclient');
    for (const ag of agents) {
        const t = await until(async () => { const x = await ticksOf(oldNew.cdp, ag.id).catch(() => null); return x && x.running && x.pids.some((p) => p !== ag.pid) ? x : null; }, 90_000);
        check(t !== null, `14t. ${ag.name}, restored under the host ${NEW}, streams into the client ${OLD}`, t ? `pids ${JSON.stringify(t.pids)}` : 'no new provider in its ledger');
        for (const p of t?.pids ?? []) restoredPids.add(p);
    }
    shot(`version-skew-client-old-host-new-${OS}.png`);
}

async function launcherSelfUpdate() {
    step('10', 'launcher.check: the launcher NEW made READY (≤ 300 s)');
    const checked = await wireCall(RUNTIME, 'launcher.check', [{ tools: false }], 300_000);
    console.log(`  ${JSON.stringify(checked.value?.tracks ?? checked.reason)}`);
    const row = trackRow(checked.value, 'launcher');
    check(checked.ok && row?.state === 'ready' && row?.offer?.build === NEW && row?.current === OLD, `10. the launcher ${NEW} is READY, this one ${OLD}`, checked.reason ?? JSON.stringify(row));
    const oldLauncher = launcherPid();
    const exeBefore = WIN ? sha256(LAUNCHER) : null;

    step('11', `launcher.apply launcher: the endpoint handed to ${NEW}`);
    const applied = await wireCall(RUNTIME, 'launcher.apply', [{ track: 'launcher' }], 30_000);
    check(applied.ok && applied.value?.handingOver === true && applied.value?.build === NEW, `11. the launcher hands over to ${NEW}`, applied.reason ?? JSON.stringify(applied.value));

    step('12', 'launcher.json names a new live launcher, and the old one exits (≤ 90 s)');
    const next = await until(() => { const p = launcherPid(); return p && p !== oldLauncher && alive(p) ? p : null; }, 90_000);
    if (next) launcherPids.add(next);
    check(next !== null, '12a. launcher.json names a NEW launcher pid, alive', `${oldLauncher} → ${launcherPid()}`);
    const oldGone = await until(() => (!alive(oldLauncher) ? true : null), 60_000);
    check(oldGone === true, `12b. the old launcher pid ${oldLauncher} exited`);
    const hello = await wireHello(RUNTIME, 15_000);
    check(hello.ok && hello.welcome?.pid === next && hello.welcome?.build === NEW, `12c. a hello to the endpoint is welcomed by the new launcher, build ${NEW}`, hello.reason ?? JSON.stringify(hello.welcome));
    check(new RegExp(`took over from the launcher ${oldLauncher}\\b`).test(readOr(LAUNCHER_OWN_LOG)), '12d. the new launcher said it took over from the old one (its log)', readOr(LAUNCHER_OWN_LOG).split('\n').slice(-5).join(' | '));
    const view = await updatesNow();
    const after = trackRow(view, 'launcher');
    check(after?.current === NEW && !after?.why, `12e. the launcher's Updates list says ${NEW}, with no failure`, JSON.stringify(after));

    step('13', 'where the launcher is installed now');
    if (WIN) {
        check(sha256(LAUNCHER) === sha256(NEW_LAUNCHER) && sha256(LAUNCHER) !== exeBefore, `13a. ${LAUNCHER} holds the NEW launcher's bytes`);
        const cleared = await until(() => (!existsSync(join(dirname(LAUNCHER), 'Genie.exe.old')) ? true : null), 90_000);
        check(cleared === true, '13b. Genie.exe.old (the old program, set aside) is cleared once the old launcher has gone');
    } else {
        let to = '';
        try { to = readlinkSync(LAUNCHER); } catch (e) { to = `(unread: ${e.code})`; }
        check(samePath(to, join(CODE_ROOT, 'launcher', NEW, 'genie')), `13a. ~/.local/bin/genie points at the launcher ${NEW}`, to);
        check(state().launcher?.current === NEW && state().launcher?.previous === OLD, `13b. state.json: launcher ${NEW} (previous ${OLD})`, JSON.stringify(state().launcher));
    }

    step('14', 'the client and the host were not touched: the same pids, every tick');
    sameHostAndProviders('14a', 'through the launcher\'s own update');
    await ledgersStreamedThrough(a, '14b', 'through the handover');

    step('15', 'the tray after the handover (photographed)');
    const menu = await trayShot(`tray-after-handover-${OS}.png`);
    check(menu.ok, '15. the new launcher answers its tray probe', menu.reason ?? (menu.value?.items ?? []).join(' | '));
}

try {
    a = await openClient({ label: 'first', id: 1, port: PORT, launcherExe: LAUNCHER, hostBuild: OLD });
    sessions.push(a);
    const before = run.failures.length;
    await startAgents(a);
    controls(a);
    for (const ag of agents) {
        step('9a', `positive control: ${ag.name} is streaming NOW (≤ 10 s)`);
        const later = await until(async () => { const x = await ticksOf(a.cdp, ag.id); return x.max > ag.before.max ? x : null; }, 10_000);
        check(later !== null && later.pids.length === 1 && later.pids[0] === ag.pid, `9a. CONTROL: ${ag.name} is streaming NOW (its ledger grew within seconds, same pid)`, `${ag.before.max} → ${later?.max}`);
        ag.before = later ?? ag.before;
    }
    const controlFailures = run.failures.slice(before);
    if (controlFailures.length) throw new Error(`the controls failed (${controlFailures.join('; ')}): nothing after them could mean anything`);
    if (ROW === 'client-only-update') await clientOnlyUpdate();
    else if (ROW === 'host-update') await hostUpdate(false);
    else if (ROW === 'host-update-rollback') await hostUpdate(true);
    else if (ROW === 'version-skew') await versionSkew();
    else await launcherSelfUpdate();
} catch (error) {
    check(false, `the run stopped in step ${run.current}`, String(error?.stack ?? error?.message ?? error).split('\n').slice(0, 3).join(' | '));
}
clearTimeout(watchdog);
await cleanup(run.failures.length ? 'after a failure' : 'done');
finish();
