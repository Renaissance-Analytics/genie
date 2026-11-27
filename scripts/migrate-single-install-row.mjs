#!/usr/bin/env node
/**
 * MIGRATE-SINGLE-INSTALL (Tynn #1058 L9; the envelope's .ai/plans/genie-2-host-split-2026-10-31.md, "Install, first run and
 * the migration"). The last published single-app Genie, v2.0.0-beta.66.1 as GitHub serves it, is installed and running
 * with an agent streaming and "start on logon" + "start minimised" on; its OWN updater (electron-updater, its own helper)
 * then installs the bridge this tree builds (scripts/build-track-packages.mjs bridge), and the row reads what is left:
 *
 *   --case unchanged   the bridge's feed names the host that is running (beta.66.1's own genieHostHash, from its published
 *                      feed file), so beta.66.1 installs it client-only and its host stays up. The launcher's first run
 *                      ADOPTS that host: the same host pid and start, every provider pid kept and none started again, the
 *                      ticks streamed through the install, state.json's host.current `adopted`.
 *   --case changed     the bridge's feed names the host it brings (this tree's dist/main/host.js; with GENIE_TEST_HOST_MARK
 *                      in the build, that host says the mark). beta.66.1 drains (who comes back is written to
 *                      running-at-quit.json), stops its host and installs; the launcher starts the bridge's host from its
 *                      own folder, and that host restores every agent ONCE, under it.
 *
 * Both cases: one logon entry, the launcher's (`"<launcher>" --logon`; the single app's is gone), the two settings carried
 * over (<data root>/runtime/logon.json), the launcher and the client each running from their own folders, and the data
 * root kept. Linux: the AppImage at the single app's path is now the bridge, and running it only reaches the launcher.
 *
 * WHAT THE PERSON SEES, photographed (MIGRATE_ROW_OUT): before (beta.66.1 with its agent), every 4 s from the install's
 * start until the launcher's window is up (during-NN), after (the window the launcher opened), and the agent in a client
 * window of the installed build. Named migrate-<case>-<what>-<os>.png.
 *
 * The feed: on Windows the installed beta.66.1's resources\app-update.yml is rewritten to the local feed, with no
 * publisherName (the bridge built here is not Authenticode-signed), as scripts/vm-client-only-update.ps1 does. On Linux
 * the published AppImage's app-update.yml is inside its read-only image, so beta.66.1 runs from its own extraction
 * (`--appimage-extract`, the payload unchanged but that file) with APPIMAGE naming the published file at
 * ~/Applications/Genie.AppImage, which electron-updater replaces with the bridge and runs, as it does for a person.
 *
 *   node scripts/migrate-single-install-row.mjs --case unchanged|changed
 *
 * Needs: the package-tracks row's packages and launcher (release/tracks, native/launcher/target-l3), dist/ built, a test
 * machine with its desktop session, and the network to GitHub's release downloads. CDP_PORT (beta.66.1's window, 9422),
 * MIGRATE_CLIENT_PORT (the client after, 9423), MIGRATE_ROW_DEADLINE_MS. Prints `### migrate-single-install=PASS|FAIL`.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    Cdp, OS, SYNC_MS, WIN, alive, check, targetOn, commandLine, descends, executableOf, openClient, parents, processesNamed, readJson, readOr, refuse, run, shot, since, sleep,
    step, testMachineOrRefuse, until, wireCall,
} from './launcher-row-lib.mjs';

const BASE = '2.0.0-beta.66.1';
const BRIDGE = '2.0.0';
const BASE_URL = `https://github.com/Renaissance-Analytics/genie/releases/download/v${BASE}`;
const FEED_PORT = 8099;
const FEED = `http://127.0.0.1:${FEED_PORT}/`;
const OLD_PORT = Number(process.env.CDP_PORT ?? 9422);
const CLIENT_PORT = Number(process.env.MIGRATE_CLIENT_PORT ?? 9423);
const ROOT = process.cwd();
const HOME = homedir();
const GHOME = join(HOME, '.genie');
const RUNTIME = join(GHOME, 'runtime');
const CODE = WIN ? join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'Genie') : join(process.env.XDG_DATA_HOME || join(HOME, '.local', 'share'), 'genie');
const INSTALL_DIR = join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'Programs', 'Genie');
const APPIMAGE_FILE = join(HOME, 'Applications', 'Genie.AppImage');
const AUTOSTART = join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'autostart', 'genie.desktop');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WORK = resolve('.migrate-row');
const CACHE = join(WORK, 'cache');

const caseArg = process.argv.indexOf('--case');
const CASE = caseArg > 0 ? process.argv[caseArg + 1] : '';
if (CASE !== 'unchanged' && CASE !== 'changed') { console.error('usage: migrate-single-install-row.mjs --case unchanged|changed'); process.exit(2); }
run.name = `migrate-single-install (${CASE})`;
run.out = resolve(process.env.MIGRATE_ROW_OUT ?? join('ci-out', `migrate-single-install-${CASE}`));
mkdirSync(run.out, { recursive: true });
const name = (what) => `migrate-${CASE}-${what}-${OS}.png`;
const MARK = process.env.GENIE_TEST_HOST_MARK ?? '';

testMachineOrRefuse('MIGRATE_ROW_ALLOW');
const DEADLINE = Number(process.env.MIGRATE_ROW_DEADLINE_MS ?? 1_500_000);
setTimeout(() => { console.log(`### migrate-single-install=FAIL the row's deadline (${DEADLINE / 1000} s) passed at step ${run.current}`); teardown(); process.exit(1); }, DEADLINE).unref();

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sh = (file, args, opts = {}) => spawnSync(file, args, { encoding: 'utf8', timeout: SYNC_MS * 8, windowsHide: true, ...opts });
const feedFile = WIN ? 'latest.yml' : 'latest-linux.yml';
const hostRecord = () => readJson(join(RUNTIME, 'host.json'));
const launcherRecord = () => readJson(join(RUNTIME, 'launcher.json'));
const state = () => readJson(join(CODE, 'state.json'));
const BUILD = readOr(join(ROOT, 'release', 'tracks', 'build.txt')).trim();
const LAUNCHER_BIN = join(ROOT, 'native', 'launcher', 'target-l3', 'release', WIN ? 'genie.exe' : 'genie');

/** A process's key (pid@start), from the OS's own table, or null when it is not running. */
async function keyOf(pid) {
    if (!alive(pid)) return null;
    if (!WIN) {
        const stat = readOr(`/proc/${pid}/stat`);
        const rest = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
        return rest.length > 20 ? `${pid}@${rest[19]}` : null;
    }
    const r = sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { "${Number(pid)}@$($p.CreationDate.ToFileTimeUtc())" }`]);
    return r.stdout.trim() || null;
}
const stubKeys = async () => (await processesNamed('stub-codex.mjs') ?? []).map((p) => p.key);

// ---------------------------------------------------------------- the logon entries, as the OS has them
/** Every logon entry that runs Genie: Windows Run values naming Programs\Genie\Genie.exe, or the autostart file. */
function genieEntries() {
    if (WIN) {
        const r = sh('reg', ['query', RUN_KEY]);
        return r.stdout.split(/\r?\n/).map((l) => /^\s{4}(.+?)\s{4}REG_(?:EXPAND_)?SZ\s{4}(.*)$/.exec(l)).filter(Boolean).map((m) => ({ name: m[1], data: m[2].trim() }))
            .filter((e) => e.data.toLowerCase().includes('\\programs\\genie\\genie.exe'));
    }
    const dir = join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'autostart');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((f) => ({ name: join(dir, f), data: readOr(join(dir, f)) })).filter((e) => /genie/i.test(e.data) && /^Exec=/m.test(e.data));
}

// ---------------------------------------------------------------- every Genie process here, ended (a clean start, and teardown)
async function endAll() {
    // WQL's LIKE takes a backslash as its escape: on Windows the needles are program names (a test VM runs no other Genie).
    const needles = WIN ? ['Genie.exe', 'genie-host', 'genie-client', 'stub-codex.mjs'] : ['/.genie/host/', `${CODE}/`, '/tmp/.mount_', join(WORK, 'base'), 'stub-codex.mjs', APPIMAGE_FILE];
    for (let round = 0; round < 2; round++) {
        for (const n of needles) {
            for (const p of await processesNamed(n) ?? []) {
                if (p.pid === process.pid) continue;
                try { if (WIN) sh('taskkill', ['/F', '/T', '/PID', String(p.pid)]); else process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
            }
        }
        await sleep(2_000);
    }
}
let feedServer = null;
let shooter = null;
function teardown() {
    try { feedServer?.kill(); } catch { /* gone */ }
    try { if (shooter) clearInterval(shooter); } catch { /* gone */ }
    if (WIN) spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::SetEnvironmentVariable('GENIE2_CODEX_BINARY', $null, 'User')"], { timeout: SYNC_MS, windowsHide: true });
}
process.on('exit', teardown);

async function cleanSlate() {
    step('0', 'a clean slate: every Genie process ended, any install removed, the data root, the programs folder and the entries gone');
    await endAll();
    if (WIN) {
        const uninstaller = join(INSTALL_DIR, 'Uninstall Genie.exe');
        if (existsSync(uninstaller)) sh(uninstaller, ['/S'], { timeout: 180_000 });
        await sleep(3_000);
        for (const e of genieEntries()) sh('reg', ['delete', RUN_KEY, '/v', e.name, '/f']);
        sh('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ai.tynn.genie', '/f']);
    } else {
        rmSync(AUTOSTART, { force: true });
        rmSync(join(HOME, '.local', 'bin', 'genie'), { force: true });
        rmSync(join(process.env.XDG_DATA_HOME || join(HOME, '.local', 'share'), 'applications', 'genie.desktop'), { force: true });
        rmSync(APPIMAGE_FILE, { force: true });
        rmSync(join(WORK, 'base'), { recursive: true, force: true });
    }
    for (const dir of [GHOME, CODE, ...(WIN ? [INSTALL_DIR] : [])]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1_000 });
    check(!existsSync(GHOME) && !existsSync(CODE), '0. nothing of Genie is left from before', `${GHOME}, ${CODE}`);
}

// ---------------------------------------------------------------- the published beta.66.1, and the bridge built here
async function download(asset) {
    mkdirSync(CACHE, { recursive: true });
    const file = join(CACHE, asset);
    if (existsSync(file) && statSync(file).size > 0) return file;
    const r = await fetch(`${BASE_URL}/${asset}`, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
    if (!r.ok) refuse(`${BASE_URL}/${asset} answered ${r.status}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    console.log(`  downloaded ${asset} (${statSync(file).size} bytes), sha256 ${sha256(file).slice(0, 16)}`);
    return file;
}

function bridgeFeed() {
    step('1', `the bridge ${BRIDGE}, built the old way from this tree's packages (track build ${BUILD}) and launcher`);
    if (!BUILD || !existsSync(LAUNCHER_BIN)) refuse(`the package-tracks row's packages and launcher are not here (release/tracks/build.txt, ${LAUNCHER_BIN})`);
    const out = join(ROOT, 'release', 'tracks', 'bridge');
    const marker = join(out, '.built-for-row');
    if (!existsSync(marker)) {
        const r = spawnSync(process.execPath, ['scripts/build-track-packages.mjs', 'bridge', '--version', BRIDGE, '--launcher', LAUNCHER_BIN, '--from', join(ROOT, 'release', 'tracks', 'packages'), '--feed', FEED], { stdio: 'inherit', timeout: 1_200_000, windowsHide: true });
        if (r.status !== 0) refuse(`build-track-packages.mjs bridge exited ${r.status}`);
        writeFileSync(marker, BUILD);
    }
    const feed = join(WORK, `feed-${CASE}`);
    rmSync(feed, { recursive: true, force: true });
    cpSync(out, feed, { recursive: true });
    rmSync(join(feed, '.built-for-row'), { force: true });
    return feed;
}

/** The genieHostHash a feed file names. */
const hostHashIn = (yml) => /^genieHostHash: '([0-9a-f]+)'$/m.exec(yml)?.[1] ?? null;

async function installBase() {
    step('2', `the last published single-app Genie, ${BASE}, from GitHub's release, installed as a person has it`);
    const publishedFeed = readOr(await download(feedFile));
    const baseHash = hostHashIn(publishedFeed);
    check(baseHash !== null, `2a. ${BASE}'s published ${feedFile} names its host`, baseHash ?? publishedFeed.slice(0, 200));
    if (WIN) {
        const setup = await download(`Genie-${BASE}-setup.exe`);
        const r = sh(setup, ['/S'], { timeout: 300_000 });
        check(r.status === 0 && existsSync(join(INSTALL_DIR, 'Genie.exe')), `2b. ${BASE}'s installer ran silently into ${INSTALL_DIR}`, `exit ${r.status}`);
        writeFileSync(join(INSTALL_DIR, 'resources', 'app-update.yml'), `provider: generic\nurl: ${FEED}\nupdaterCacheDirName: genie2-updater\n`);
        return { baseHash, program: join(INSTALL_DIR, 'Genie.exe'), args: [], env: {} };
    }
    // The bridge AppImage mounts itself with FUSE when electron-updater runs it: electron-builder's runtime loads libfuse.so.2
    // (scripts/vm-client-only-update-linux.sh measured it), so fuse2 is installed when missing, as a person installs it for
    // any AppImage on Arch. Where it cannot be, the AppImage's own extract-and-run, said.
    if (!/libfuse\.so\.2/.test(sh('ldconfig', ['-p']).stdout ?? '')) {
        const f = sh('sudo', ['-n', 'pacman', '-Sy', '--needed', '--noconfirm', 'fuse2'], { timeout: 300_000 });
        if (f.status !== 0) { process.env.APPIMAGE_EXTRACT_AND_RUN = '1'; console.log('  FUSE 2 could not be installed: AppImages run with APPIMAGE_EXTRACT_AND_RUN=1 here (not a FUSE mount)'); }
    }
    const image = await download(`Genie-${BASE}.AppImage`);
    mkdirSync(join(HOME, 'Applications'), { recursive: true });
    copyFileSync(image, APPIMAGE_FILE);
    chmodSync(APPIMAGE_FILE, 0o755);
    const base = join(WORK, 'base');
    mkdirSync(base, { recursive: true });
    const x = sh(APPIMAGE_FILE, ['--appimage-extract'], { cwd: base, timeout: 300_000 });
    const appRun = join(base, 'squashfs-root', 'AppRun');
    check(x.status === 0 && existsSync(appRun), `2b. ${BASE}'s AppImage at ${APPIMAGE_FILE}, its payload extracted for its feed file`, `exit ${x.status}`);
    writeFileSync(join(base, 'squashfs-root', 'resources', 'app-update.yml'), `provider: generic\nurl: ${FEED}\nupdaterCacheDirName: genie2-updater\n`);
    const ozone = process.env.XDG_SESSION_TYPE === 'wayland' ? ['--ozone-platform=wayland'] : [];
    return { baseHash, program: appRun, args: ['--no-sandbox', ...ozone], env: { APPIMAGE: APPIMAGE_FILE, APPDIR: join(base, 'squashfs-root') } };
}

// ---------------------------------------------------------------- the row
async function main() {
    console.log(`\nMIGRATE-SINGLE-INSTALL (${CASE}, ${OS}): ${BASE} as published -> the bridge ${BRIDGE} (track build ${BUILD})\n`);
    await cleanSlate();
    const feedDir = bridgeFeed();
    const base = await installBase();
    // The feed the bridge is served with: for `unchanged` it names the host that runs (beta.66.1's), for `changed` the one
    // the bridge brings. Nothing else in the file differs between the two.
    const yml = join(feedDir, feedFile);
    const builtHash = hostHashIn(readOr(yml));
    if (CASE === 'unchanged') writeFileSync(yml, readOr(yml).replace(/^genieHostHash: '[0-9a-f]+'$/m, `genieHostHash: '${base.baseHash}'`));
    const served = hostHashIn(readOr(yml));
    check(CASE === 'unchanged' ? served === base.baseHash : served === builtHash && builtHash !== base.baseHash,
        `2c. the bridge's ${feedFile} names ${CASE === 'unchanged' ? `the running host (${BASE}'s)` : "the host it brings, not the running one"}`, `served ${served}, ${BASE}'s ${base.baseHash}, the bridge's own ${builtHash}`);
    const bridgeArtifact = readdirSync(feedDir).find((f) => (WIN ? /-setup\.exe$/ : /\.AppImage$/).test(f));
    check(Boolean(bridgeArtifact) && readOr(yml).includes(`version: ${BRIDGE}`), `2d. the feed offers ${BRIDGE}: ${bridgeArtifact}`);
    feedServer = spawn(process.execPath, ['scripts/serve-feed.mjs', feedDir, String(FEED_PORT)], { stdio: 'ignore', windowsHide: true });
    const answered = await until(async () => (await fetch(`${FEED}${feedFile}`, { signal: AbortSignal.timeout(3_000) })).ok, 30_000);
    check(answered === true, `2e. the feed answers on ${FEED}`);

    step('3', `${BASE} running, an agent streaming (the stub provider's ticker), start on logon and start minimised on`);
    const ticker = join(tmpdir(), 'genie-stub-codex-ticker');
    writeFileSync(ticker, String(process.pid));
    const ticksFile = join(run.out, 'update-ticks.json');
    rmSync(ticksFile, { force: true });
    const stub = join(ROOT, 'scripts', 'stub-codex.mjs');
    // In-Session and the installer's relaunch read the USER's environment (Explorer's): the provider the host starts must be
    // the stub there too, for the agents a new host restores.
    if (WIN) sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', `[Environment]::SetEnvironmentVariable('GENIE2_CODEX_BINARY', '${stub}', 'User')`]);
    const workspace = join(WORK, `workspace-${CASE}`);
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const seeded = spawnSync(process.execPath, [join(ROOT, 'scripts', 'smoke-seed.mjs')], { cwd: workspace, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (seeded.status !== 0) refuse(`the seed failed: ${seeded.stderr}`);
    const oldLog = join(run.out, 'beta-window.log');
    const old = spawn(base.program, [...base.args, `--remote-debugging-port=${OLD_PORT}`], {
        detached: !WIN, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false,
        env: { ...process.env, ...base.env, GENIE2_CODEX_BINARY: stub, GENIE_PAGE_PROBE: '1' },
    });
    console.log(`  ${BASE} started: pid ${old.pid} (${base.program}); its log is ~/.genie/runtime/lifecycle.log (${oldLog} unused)`);
    const rec = await until(() => { const r = hostRecord(); return r && alive(r.pid) ? r : null; }, 120_000, 1_000);
    if (!check(Boolean(rec), `3a. ${BASE}'s host is up (host.json, a live pid)`)) throw new Error('no host');
    const hostBefore = rec.pid;
    const hostBeforeKey = await keyOf(hostBefore);
    const hostExe = executableOf(hostBefore);
    check(hostExe.includes(`${WIN ? '\\' : '/'}.genie${WIN ? '\\' : '/'}host${WIN ? '\\' : '/'}`), `3b. it runs from its own copy under ${GHOME}/host (P6-1), which no installer touches`, hostExe);
    // The two settings, set in the app as a person does: beta.66.1 writes its own logon entry for them.
    const cdpOld = await connectPage(OLD_PORT);
    for (const [key, value] of [['launch_at_login', true], ['start_minimized', true]]) {
        await cdpOld.evaluate(`(window.genieTest ?? window.genie).features.act({ kind: 'settings.set', key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} }).then(() => true)`, 15_000);
    }
    const entriesBefore = await until(() => { const e = genieEntries(); return e.length > 0 && e.every((x) => /--hidden/.test(x.data)) ? e : null; }, 30_000, 1_000);
    check(Boolean(entriesBefore), `3c. ${BASE} wrote its own logon entry, with --hidden`, JSON.stringify(entriesBefore ?? genieEntries()));
    // The photograph shows the dashboard as the person has it, not its loading frame (run 1127-211951-3a8597), and no
    // desktop notification over it.
    await until(() => cdpOld.evaluate('!!document.querySelector("main, [data-route]") && document.body.innerText.includes("Dashboard")', 5_000), 30_000, 1_000);
    await sleep(4_000);
    cdpOld.close();
    clearNotifications();
    shot(name('before'));

    // `changed`: no turn mid-flight when install is asked (the host-update row's way), so the drain does not wait on one.
    step('4', `${BASE}'s own updater installs the bridge (update-cdp.mjs: check, download, install), photographed every 4 s`);
    let n = 0;
    shooter = setInterval(() => { n += 1; if (n <= 30) shot(name(`during-${String(n).padStart(2, '0')}`)); }, 4_000);
    const samples = new Set();
    const sampler = setInterval(() => { void stubKeys().then((ks) => { for (const k of ks) samples.add(k); }); }, 1_000);
    // Asynchronous, so the sampler above runs while it drives (a spawnSync blocked it: run 1127-211951-3a8597 sampled none).
    const drive = await spawnAsync(process.execPath, ['scripts/update-cdp.mjs'], { stdio: 'inherit', windowsHide: true, env: { ...process.env, EXPECT_VERSION: BRIDGE, CDP_PORT: String(OLD_PORT), CDP_OWN_PID: String(old.pid), ...(CASE === 'unchanged' ? { UPDATE_TICKS_FILE: ticksFile } : {}) } });
    clearInterval(sampler);
    const stubsBefore = [...samples].sort();
    console.log(`  agent providers while install was asked: ${stubsBefore.join(' ') || 'none'}`);
    check(drive.status === 0, '4a. the single app took the bridge as its update and began installing it', `update-cdp.mjs exited ${drive.status}`);
    check(stubsBefore.length > 0, '4b. an agent was streaming when install was asked');

    step('5', 'the bridge lands: the launcher, installed, running, a client window from its own folder');
    const launcher = await until(() => { const l = launcherRecord(); return l && alive(l.pid) ? l : null; }, 300_000, 2_000);
    if (!check(Boolean(launcher), '5a. the launcher is running (launcher.json, a live pid)', JSON.stringify(launcherRecord()))) throw new Error('no launcher');
    const st = await until(() => { const s = state(); return s?.tracks?.client?.current ? s : null; }, 60_000, 1_000);
    check(st?.tracks?.client?.current === BUILD && st?.profile === 'both', `5b. state.json: the client ${BUILD}, profile both`, JSON.stringify(st));
    const clientExe = join(CODE, 'client', BUILD, WIN ? 'genie-client.exe' : 'genie-client');
    const client = await until(async () => (await processesNamed('genie-client') ?? []).find((p) => commandLine(p.pid).includes(join('client', BUILD))) ?? null, 120_000, 2_000);
    check(Boolean(client), `5c. a client window runs from its own folder (${clientExe})`, client ? commandLine(client.pid).slice(0, 200) : 'none');
    if (WIN) {
        const v = sh(join(INSTALL_DIR, 'Genie.exe'), ['version']);
        check(v.stdout.trim() === BUILD, '5d. Programs\\Genie\\Genie.exe, the path every shortcut and Run value names, is the launcher', `it says ${JSON.stringify(v.stdout.trim())}`);
    } else {
        const bridgeSha = sha256(join(feedDir, bridgeArtifact));
        check(existsSync(APPIMAGE_FILE) && sha256(APPIMAGE_FILE) === bridgeSha, `5d. ${APPIMAGE_FILE}, the single app's path, is the bridge AppImage`);
        let link = '';
        try { link = readlinkSync(join(HOME, '.local', 'bin', 'genie')); } catch { /* none */ }
        check(link.startsWith(join(CODE, 'launcher')), '5e. ~/.local/bin/genie leads to the installed launcher', link);
    }
    await sleep(8_000);
    clearInterval(shooter);
    shooter = null;
    clearNotifications();
    shot(name('after'));

    step('6', CASE === 'unchanged' ? 'the host was adopted: every pid kept' : 'the host was changed: the bridge\'s host, every agent restored once');
    const recAfter = hostRecord();
    const stateHost = state()?.tracks?.host ?? {};
    const map = parents();
    if (CASE === 'unchanged') {
        check(recAfter?.pid === hostBefore && (await keyOf(hostBefore)) === hostBeforeKey, `6a. the same host process (pid ${hostBefore}, the same start)`, `host.json pid ${recAfter?.pid}`);
        const stubsAfter = await stubKeys();
        for (const k of stubsBefore) check(stubsAfter.includes(k), `6b. provider ${k} kept running through the migration`);
        for (const k of stubsAfter) check(stubsBefore.includes(k), `6c. provider ${k} is one from before, none started again`);
        check(stateHost.current === 'adopted' && stateHost.previous === BUILD, `6d. state.json records host.current = adopted, the bridge's host ${BUILD} waiting as previous`, JSON.stringify(stateHost));
    } else {
        const gone = await until(async () => (await keyOf(hostBefore)) !== hostBeforeKey, 60_000, 1_000);
        check(gone === true, `6a. ${BASE}'s host (pid ${hostBefore}) drained and went`);
        const newHost = await until(() => { const r = hostRecord(); return r && r.pid !== hostBefore && alive(r.pid) ? r : null; }, 120_000, 1_000);
        const newExe = newHost ? executableOf(newHost.pid) : '';
        check(Boolean(newHost) && newExe.startsWith(join(CODE, 'host', BUILD)), `6b. the bridge's host runs from its own folder (${join(CODE, 'host', BUILD)})`, newExe);
        check(newHost?.build === BUILD && stateHost.current === BUILD, `6c. the host is the bridge's ${BUILD}, state.json's current`, `host.json ${newHost?.build}, state ${JSON.stringify(stateHost)}`);
        if (MARK) check(readOr(join(RUNTIME, 'lifecycle.log')).includes(`host build mark: ${MARK}`), `6d. the new host says the bridge build's mark '${MARK}'`);
        else console.log('  (no GENIE_TEST_HOST_MARK in this build: the new host is told apart by its folder and build)');
        await sleep(15_000);
        const now = await processesNamed('stub-codex.mjs') ?? [];
        const revived = now.filter((p) => !stubsBefore.includes(p.key));
        for (const k of stubsBefore) check(!now.some((p) => p.key === k), `6e. provider ${k} ended with the drain`);
        const agentsBefore = new Set(stubsBefore.map((k) => k.split('@')[0])).size;
        check(revived.length === agentsBefore, `6f. every agent that was running came back exactly once (${agentsBefore})`, `${revived.length} new provider(s): ${revived.map((p) => p.key).join(' ')}`);
        for (const p of revived) check(descends(p.pid, newHost?.pid ?? -1, map), `6g. agent provider ${p.pid} runs under the bridge's host`);
        const record = readJson(join(RUNTIME, 'running-at-quit.json'));
        check(!Array.isArray(record) || record.length === 0, '6h. the drain\'s record is spent by the restore', JSON.stringify(record));
    }

    step('7', 'the logon entry replaced, never doubled; the settings carried over');
    const entries = genieEntries();
    const launcherExe = WIN ? join(INSTALL_DIR, 'Genie.exe') : join(HOME, '.local', 'bin', 'genie');
    check(entries.length === 1, '7a. one logon entry runs Genie', JSON.stringify(entries));
    const e = entries[0]?.data ?? '';
    check(e.includes(`"${launcherExe}" --logon`) && !e.includes('--hidden') && !e.includes('Genie.AppImage'), `7b. it is the launcher's: "${launcherExe}" --logon`, e.split(/\r?\n/).find((l) => /Exec=|Genie\.exe/.test(l)) ?? e);
    if (WIN) check(entries[0]?.name === 'Genie', '7c. the Run value is the launcher\'s own (Genie); the single app\'s is gone', entries.map((x) => x.name).join(', '));
    const logonJson = readJson(join(RUNTIME, 'logon.json'));
    check(logonJson?.setting === true && logonJson?.startMinimized === true, '7d. start on logon and start minimised carried over', JSON.stringify(logonJson));
    check(existsSync(join(GHOME, 'data')) || existsSync(GHOME), '7e. the data root is kept');

    step('8', 'the agent in a client window of the installed build, over the same launcher');
    const closed = await wireCall(RUNTIME, 'launcher.closeUi', []);
    console.log(`  launcher.closeUi: ${JSON.stringify(closed).slice(0, 160)}`);
    await until(async () => ((await processesNamed('genie-client') ?? []).length === 0), 30_000, 1_000);
    const session = await openClient({ label: 'after', id: '8', port: CLIENT_PORT, launcherExe: WIN ? join(INSTALL_DIR, 'Genie.exe') : join(HOME, '.local', 'bin', 'genie'), hostBuild: hostRecord()?.build ?? BUILD, program: clientExe });
    if (CASE === 'unchanged') {
        const t = spawnSync(process.execPath, ['scripts/update-ticks-after-cdp.mjs'], { stdio: 'inherit', timeout: 240_000, windowsHide: true, env: { ...process.env, UPDATE_TICKS_FILE: ticksFile, CDP_PORT: String(CLIENT_PORT), CDP_OWN_PID: String(session.app.pid) } });
        check(t.status === 0, '8a. the agent streamed through the migration: every tick, in order, the same provider');
    } else {
        // The drain runs with no turn mid-flight (as the host-update row's), so there is no ledger to follow: the restore is
        // proven at the OS (6f, 6g), and this window is photographed linked to the bridge's host.
        check(Boolean(session.cdp), "8a. a client window of the installed build linked to the bridge's host");
    }
    clearNotifications();
    shot(name('agent'));
    if (!WIN) {
        step('9', 'the AppImage at the single app\'s path only reaches the launcher now');
        const pid = launcherRecord()?.pid;
        const again = sh(APPIMAGE_FILE, [], { timeout: 60_000, env: { ...process.env, APPIMAGE_SILENT_INSTALL: '' } });
        await sleep(3_000);
        check(again.status === 0 && launcherRecord()?.pid === pid && alive(pid), '9a. running it again asks the running launcher, and starts no second one', `exit ${again.status}, launcher ${pid} -> ${launcherRecord()?.pid}`);
    }
    session.cdp?.close();
    session.app.kill();
}

/** The desktop's own notifications dismissed before a photograph (mako on the Linux VM; best effort). */
function clearNotifications() {
    if (!WIN) spawnSync('makoctl', ['dismiss', '--all'], { timeout: 5_000 });
}

/** A child run to its end without blocking the event loop (bounded at 15 min): `{status}`. */
function spawnAsync(file, args, options) {
    return new Promise((done) => {
        const child = spawn(file, args, options);
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 900_000);
        child.once('exit', (code) => { clearTimeout(t); done({ status: code }); });
        child.once('error', () => { clearTimeout(t); done({ status: null }); });
    });
}

/** beta.66.1's page on its debugger port. */
async function connectPage(port) {
    const page = await targetOn(port, 'page', 120_000);
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl, `${BASE} page`);
    const ok = await until(() => cdp.evaluate('typeof (window.genieTest ?? window.genie) === "object" && document.readyState === "complete"', 5_000), 90_000);
    if (ok !== true) throw new Error(`${BASE}'s page never loaded window.genie`);
    return cdp;
}

try {
    await main();
} catch (error) {
    check(false, `the row stopped at step ${run.current}`, error instanceof Error ? error.message : String(error));
}
console.log(`\n[${since()}] ${run.failures.length ? `FAILED: ${run.failures.join('; ')}` : 'every check passed'}`);
await endAll().catch(() => {});
teardown();
console.log(`### migrate-single-install=${run.failures.length ? 'FAIL' : 'PASS'} ${CASE} ${OS}`);
process.exit(run.failures.length ? 1 : 0);
