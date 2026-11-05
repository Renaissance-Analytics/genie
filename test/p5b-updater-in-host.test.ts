import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { entryFor } from '../src/core/entry-mode.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { spawnUpdaterProcess } from '../src/main/engine-launch.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import type { UpdaterPort } from '../src/main/updater.js';
import { connectUpdaterLink, runUpdaterHelper } from '../src/main/updater-helper.js';
import { hostDrainAgents, updaterHelperEnv, UpdatesService, type HelperLaunch, type UpdaterConfig } from '../src/main/updates-host.js';
import type { RunningProcess } from '../src/main/upgrade.js';

/**
 * P5b: THE UPDATER IN GENIE-HOST. The host owns the updater's state, its schedule and the install; a small Electron helper
 * (Genie's own executable in its `--updater` mode, started detached by the host, with its own user data and its own token
 * hello) does the library's four calls. The window holds a replica. Here the helper is the REAL helper's rules
 * (updater-helper.ts) over the real engine protocol, with a FAKE library behind it and a fake machine for its processes.
 */

const TOKEN = 'updates-token';
const INSTALL = '/opt/genie';
const HOST = 100;
const WINDOW = process.pid;
const RENDERER = 4243;
const HELPER = 900;
const HELPER_GPU = 901;
const BROWSER = 600;
const ORPHAN = 501;
const tick = async (n = 40) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 1)); };
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

const exe = `${INSTALL}/genie`;
const PROCS: RunningProcess[] = [
    { pid: HOST, executable: exe, parentPid: 1 },
    { pid: WINDOW, executable: exe, parentPid: 1 },
    { pid: RENDERER, executable: exe, parentPid: WINDOW },
    { pid: HELPER, executable: exe, parentPid: 1 },
    { pid: HELPER_GPU, executable: exe, parentPid: HELPER },
    { pid: BROWSER, executable: exe, parentPid: 1 },
    { pid: ORPHAN, executable: `${INSTALL}/resources/OpenConsole.exe`, parentPid: null },
    { pid: 777, executable: '/usr/bin/bash', parentPid: 1 },
];

function rig(options: { killFails?: readonly number[] } = {}) {
    /** Whether a helper the host starts comes up and links; and how to make the linked one go away. */
    const helpers = { comeUp: true, drop: [] as Array<() => void> };
    const order: string[] = [];
    const logs: string[] = [];
    const configured: UpdaterConfig[] = [];
    const calls: string[] = [];
    const machine = { alive: new Set(PROCS.map((p) => p.pid)), t: 0, onSleep: () => {}, quitAt: null as number | null };
    const listed = async () => PROCS.filter((p) => machine.alive.has(p.pid));
    const lib: UpdaterPort = {
        configure: (c) => { configured.push({ ...c }); },
        check: async () => { calls.push('check'); return { version: '2.0.1' }; },
        download: async (progress) => { calls.push('download'); progress(40); progress(100); },
        quitAndInstall: () => { calls.push('quitAndInstall'); order.push('quitAndInstall'); machine.quitAt = machine.t; },
    };
    const launches: HelperLaunch[] = [];
    let server: SessionEngineServer | null = null;
    const startFakeHelper = (): void => {
        const [h, raw] = memoryPair();
        server!.accept(h, { local: true });
        helpers.drop.push(() => raw.close());
        runUpdaterHelper({
            link: () => connectUpdaterLink(raw, TOKEN),
            port: lib,
            pid: HELPER,
            processes: listed,
            alive: (pid) => machine.alive.has(pid),
            sleep: async (ms) => { machine.t += ms; machine.onSleep(); await Promise.resolve(); },
            now: () => machine.t,
            quit: () => { order.push('helper quit'); },
            log: (line) => { logs.push(line); },
            caseInsensitive: false,
            // The helper's idle exit never fires in a test: its link stays for the next request.
            schedule: () => () => {},
        });
    };
    const service = new UpdatesService({
        host: {
            installDir: INSTALL,
            ownPid: HOST,
            processes: listed,
            kill: (pid) => {
                if (options.killFails?.includes(pid)) return false;
                order.push(`kill ${pid}`);
                machine.alive.delete(pid);
                return true;
            },
            caseInsensitive: false,
            clock: () => 5,
            channel: 'stable',
            agents: { live: () => [{ id: 'a1', name: 'Ada' }], stopAll: async () => { order.push('drain agents'); } },
            stopHosted: async () => { order.push('stop hosted'); },
        },
        startHelper: (launch) => { launches.push(launch); if (helpers.comeUp) startFakeHelper(); },
        defaultLaunch: { file: exe, args: ['--updater'] },
        windowConnected: () => server?.windowConnected() ?? false,
        exit: () => { order.push('host exit'); machine.alive.delete(HOST); },
        defer: (fn) => { fn(); },
        helperPatienceMs: 50,
        installWaitMs: 30_000,
        log: (line) => { logs.push(line); },
    });
    const home = mkdtempSync(join(tmpdir(), 'p5b-updates-'));
    server = new SessionEngineServer({ token: TOKEN, build: 't', updates: service });
    server.attach(new SessionHost({ userData: home, driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() }));
    const theServer = server;
    const window = async (local = true) => {
        const [h, raw] = memoryPair();
        theServer.accept(h, { local });
        const frames: string[] = [];
        const t: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage((m) => { frames.push(m); l(m); }), onClose: (l) => raw.onClose(l), close: () => raw.close() };
        const client = new SessionEngineClient({});
        expect(await client.connect(t, TOKEN)).toMatchObject({ ok: true });
        return { client, replica: client.updates(), frames, close: () => t.close() };
    };
    return { service, server: theServer, window, order, logs, configured, calls, machine, launches, helpers };
}

describe('the contract, over the protocol, with the helper doing the library calls', () => {
    it('a window’s check starts the helper on demand; the library answers; the window’s replica equals the host’s state', async () => {
        const r = rig();
        const w = await r.window();
        const answered = await w.replica.check();
        await tick();
        expect(r.launches).toEqual([{ file: exe, args: ['--updater'] }]);
        expect(r.calls).toEqual(['check']);
        expect(r.service.dump()).toMatchObject({ phase: 'available', version: '2.0.1' });
        expect(answered).toEqual(r.service.dump());
        expect(w.replica.state()).toEqual(r.service.dump());
    });

    it('download: the progress and the end reach the window; still ONE helper, and the replica equals the host', async () => {
        const r = rig();
        const w = await r.window();
        await w.replica.check();
        const seen: number[] = [];
        w.replica.onChange((s) => { if (s.percent !== null) seen.push(s.percent); });
        expect(await w.replica.download()).toBe(true);
        await tick();
        expect(r.calls).toEqual(['check', 'download']);
        expect(r.launches).toHaveLength(1);
        expect(r.service.dump()).toMatchObject({ phase: 'downloaded', version: '2.0.1', percent: 100 });
        expect(seen).toContain(40);
        expect(w.replica.state()).toEqual(r.service.dump());
    });

    it('the helper’s link is not a window: it is never counted, never sent the dump, and may call nothing but the updater', async () => {
        const r = rig();
        await r.service.call('check', [], { window: true });
        await tick();
        expect(r.calls).toEqual(['check']);
        expect(r.server.clients).toBe(0);
        expect(r.server.windowConnected()).toBe(false);
        expect(r.server.localWindowConnected()).toBe(false);
    });

    it('updater state travels only on LOCAL links: a non-local link gets no dump and cannot drive it', async () => {
        const r = rig();
        const local = await r.window(true);
        const other = await r.window(false);
        expect(local.frames.some((f) => f.includes('"updates.dump"'))).toBe(true);
        expect(other.frames.some((f) => f.includes('"updates.'))).toBe(false);
        await expect(other.replica.check()).rejects.toThrow(/local/i);
        await local.replica.check();
        await tick();
        expect(other.frames.some((f) => f.includes('"updates.'))).toBe(false);
        expect(r.calls).toEqual(['check']);
    });
});

describe('with no window open', () => {
    it('the host checks AND downloads on its schedule, with no window', async () => {
        const r = rig();
        const fire: Array<() => void> = [];
        r.service.startAutoCheck((fn) => { fire.push(fn); return () => {}; }, { initialMs: 1, intervalMs: 1 });
        fire[0]!();
        await tick();
        expect(r.server.windowConnected()).toBe(false);
        expect(r.calls).toEqual(['check', 'download']);
        expect(r.service.dump()).toMatchObject({ phase: 'downloaded', version: '2.0.1' });
        // A window that opens now finds it downloaded.
        const w = await r.window();
        expect(w.replica.state()).toMatchObject({ phase: 'downloaded', version: '2.0.1' });
    });

    it('CONTROL: with a window open the schedule only checks — downloading stays the person’s click', async () => {
        const r = rig();
        await r.window();
        const fire: Array<() => void> = [];
        r.service.startAutoCheck((fn) => { fire.push(fn); return () => {}; }, { initialMs: 1, intervalMs: 1 });
        fire[0]!();
        await tick();
        expect(r.calls).toEqual(['check']);
        expect(r.service.dump().phase).toBe('available');
    });

    it('install with no window is refused, in words, and nothing is stopped', async () => {
        const r = rig();
        await r.service.call('check', [], { window: true });
        await r.service.call('download', [], { window: true });
        await expect(r.service.call('install', [], { window: false })).rejects.toThrow(/window/);
        await tick();
        expect(r.order).toEqual([]);
        expect(r.calls).not.toContain('quitAndInstall');
        expect(r.service.dump().phase).toBe('downloaded');
    });
});

describe('the install order', () => {
    it('drain, then the hosted stop, then the teardown scan, then the helper’s install, then the host exits; the helper waits for every Genie process', async () => {
        const r = rig();
        const w = await r.window();
        await w.replica.check();
        await w.replica.download();
        // The window and its renderer end 2 s into the helper's wait.
        r.machine.onSleep = () => { if (r.machine.t >= 2_000) { r.machine.alive.delete(WINDOW); r.machine.alive.delete(RENDERER); } };
        const result = await w.replica.install();
        await tick(200);
        // The teardown leaves the host's, the window's and the helper's trees; the browser and the orphan are ended.
        expect(r.order).toEqual(['drain agents', 'stop hosted', `kill ${BROWSER}`, `kill ${ORPHAN}`, 'host exit', 'quitAndInstall']);
        expect(result?.report).toMatch(/Ada/);
        expect(r.machine.quitAt).toBeGreaterThanOrEqual(2_000);
        expect(r.calls.filter((c) => c === 'quitAndInstall')).toHaveLength(1);
    });

    it('the window process still alive past the bound: fails in words, and the installer is NEVER run onto a mapped Genie', async () => {
        const r = rig();
        const w = await r.window();
        await w.replica.check();
        await w.replica.download();
        await w.replica.install();
        await tick(400);
        expect(r.order).toContain('host exit');
        expect(r.calls).not.toContain('quitAndInstall');
        expect(r.logs.join('\n')).toMatch(new RegExp(`not installed[\\s\\S]*${WINDOW}|${WINDOW}[\\s\\S]*not installed`, 'i'));
        expect(r.order.at(-1)).toBe('helper quit');
    });

    it('a browser process the teardown could not end holds the install too: named, and not installed', async () => {
        const r = rig({ killFails: [BROWSER] });
        const w = await r.window();
        await w.replica.check();
        await w.replica.download();
        r.machine.onSleep = () => { r.machine.alive.delete(WINDOW); r.machine.alive.delete(RENDERER); };
        await w.replica.install();
        await tick(400);
        expect(r.calls).not.toContain('quitAndInstall');
        expect(r.logs.join('\n')).toMatch(new RegExp(`${BROWSER}`));
    });

    it('no helper can be reached: a check says so in words', async () => {
        const r = rig();
        r.helpers.comeUp = false;
        await expect(r.service.call('check', [], { window: true })).resolves.toMatchObject({ phase: 'error', error: expect.stringMatching(/updater/i) });
        expect(r.launches).toHaveLength(1);
    });

    it('the helper went and none comes back: the install says so BEFORE anything is stopped, and the window is not told to quit', async () => {
        const r = rig();
        const w = await r.window();
        let told = 0;
        w.replica.onInstalling(() => { told += 1; });
        await w.replica.check();
        await w.replica.download();
        for (const drop of r.helpers.drop) drop();
        r.helpers.comeUp = false;
        await tick();
        await w.replica.install();
        await tick();
        // The dropped helper left (its link closed outside an install); nothing was drained, stopped or killed.
        expect(r.order).toEqual(['helper quit']);
        expect(r.service.dump()).toMatchObject({ phase: 'error', error: expect.stringMatching(/updater/i) });
        expect(told).toBe(0);
    });

    it('the host’s drain records who comes back, ON DISK, before it ends a session', async () => {
        const writes: string[] = [];
        const drain = hostDrainAgents({
            agents: () => [{ id: 'a1', name: 'Ada' }, { id: 'a2', name: 'Bo' }, { id: 'a3', name: 'Cy' }],
            probe: (id) => (id === 'a1' ? { running: true, turnState: 'idle', inTurn: false } : id === 'a2' ? { running: true, turnState: 'working', inTurn: true } : null),
            writeRunningAtQuit: async (ids) => { writes.push(`running ${ids.join(',')}`); },
            writeInterruptedAtQuit: async (ids) => { writes.push(`interrupted ${ids.join(',')}`); },
            stopAll: async () => { writes.push('stop all'); },
        });
        expect(drain.live()).toEqual([{ id: 'a1', name: 'Ada' }, { id: 'a2', name: 'Bo' }]);
        await drain.stopAll();
        expect(writes).toEqual(['running a1,a2', 'interrupted a2', 'stop all']);
    });

    it('the window is told once its install is answered, so it records nothing over the host’s record and quits', async () => {
        const r = rig();
        const w = await r.window();
        let told = 0;
        w.replica.onInstalling(() => { told += 1; });
        await w.replica.check();
        // Refused (nothing downloaded): not told.
        expect(w.replica.install()).toBeNull();
        await w.replica.download();
        r.machine.onSleep = () => { r.machine.alive.delete(WINDOW); r.machine.alive.delete(RENDERER); };
        await w.replica.install();
        await tick();
        expect(told).toBe(1);
        const main = strip('src/main/main.ts');
        expect(main).toMatch(/onInstalling\(\(\) => \{[\s\S]{0,400}quit\.markRecorded\(\)[\s\S]{0,200}quit\.choose\('shut-down'\)[\s\S]{0,300}app\.quit\(\)/);
    });
});

describe('settings stay hot-swappable', () => {
    it('a channel change reaches the RUNNING helper’s configure, with no restart', async () => {
        const r = rig();
        const w = await r.window();
        await w.replica.check();
        expect(r.configured.at(-1)).toEqual({ allowPrerelease: false, autoDownload: false });
        r.service.setChannel('dev');
        await tick();
        expect(r.configured.at(-1)).toEqual({ allowPrerelease: true, autoDownload: false });
        w.replica.setChannel('stable');
        await tick();
        expect(r.configured.at(-1)).toEqual({ allowPrerelease: false, autoDownload: false });
        expect(r.launches).toHaveLength(1);
    });

    it('a helper started after a change is configured with the channel of now', async () => {
        const r = rig();
        r.service.setChannel('dev');
        await r.service.call('check', [], { window: true });
        await tick();
        expect(r.configured[0]).toEqual({ allowPrerelease: true, autoDownload: false });
    });
});

describe('the helper process', () => {
    it('--updater is the updater, taken lazily by the entry', () => {
        expect(entryFor(['Genie.exe', '--updater'])).toBe('updater');
        expect(entryFor(['electron', '.', '--updater'])).toBe('updater');
        expect(entryFor(['Genie.exe'])).toBe('main');
        expect(strip('src/main/entry.ts')).toMatch(/=== 'updater'[\s\S]*?import\('\.\/updater-process\.js'\)/);
    });

    it('(B) its own user data under the runtime folder, set before ready, and its own single-instance lock', () => {
        const src = strip('src/main/updater-process.ts');
        expect(src).toMatch(/app\.setPath\('userData', join\(runtimeDir\(home\), '\.updater'\)\)/);
        expect(src.indexOf("app.setPath('userData'")).toBeLessThan(src.indexOf('whenReady'));
        expect(src).toMatch(/requestSingleInstanceLock\(\)/);
        expect(src).toMatch(/linkToRunningHost\(/);
        expect(src).not.toMatch(/linkToHost\(/);
        expect(src).toMatch(/realElectronUpdaterPort\(\)/);
        expect(src).toMatch(/runUpdaterHelper\(/);
    });

    it('(A) started DETACHED, as an Electron (not as Node), with the AppImage’s environment', () => {
        const spawned: Array<{ file: string; args: readonly string[]; options: { detached?: boolean; env?: NodeJS.ProcessEnv } }> = [];
        let unref = 0;
        const fakeSpawn = ((file: string, args: readonly string[], options: { detached?: boolean; env?: NodeJS.ProcessEnv }) => {
            spawned.push({ file, args, options });
            return { pid: HELPER, on: () => {}, unref: () => { unref += 1; } };
        }) as never;
        const env = { PATH: '/usr/bin', APPIMAGE: '/home/w/Genie.AppImage', APPDIR: '/tmp/.mount_Genie', ELECTRON_RUN_AS_NODE: '1' };
        const pid = spawnUpdaterProcess({ file: exe, args: ['--updater'] }, { logsDir: mkdtempSync(join(tmpdir(), 'p5b-logs-')), env }, fakeSpawn);
        expect(pid).toBe(HELPER);
        expect(spawned).toHaveLength(1);
        expect(spawned[0]!.args).toEqual(['--updater']);
        expect(spawned[0]!.options.detached).toBe(true);
        expect(spawned[0]!.options.env?.APPIMAGE).toBe('/home/w/Genie.AppImage');
        expect(spawned[0]!.options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(unref).toBe(1);
    });

    it('APPIMAGE: the variable and the AppImage’s environment reach the helper from the host’s', () => {
        const env = updaterHelperEnv({ PATH: '/usr/bin', APPIMAGE: '/home/w/Genie.AppImage', APPDIR: '/tmp/.mount_Genie', ARGV0: 'Genie.AppImage', OWD: '/home/w', ELECTRON_RUN_AS_NODE: '1' }, '/home/w/.genie');
        expect(env).toMatchObject({ APPIMAGE: '/home/w/Genie.AppImage', APPDIR: '/tmp/.mount_Genie', ARGV0: 'Genie.AppImage', OWD: '/home/w', GENIE_HOME: '/home/w/.genie', PATH: '/usr/bin' });
        expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        // The host has it from the window that started it, and starts the helper with it.
        expect(strip('src/main/main.ts')).toMatch(/hostScript: join\(here, 'host\.js'\)[\s\S]{0,600}env: \{ \.\.\.process\.env,/);
        const host = strip('src/main/genie-host.ts');
        expect(host).toMatch(/spawnUpdaterProcess\([\s\S]{0,200}updaterHelperEnv\(process\.env, home\)/);
        expect(host).toMatch(/new UpdatesService\(/);
        expect(host).toMatch(/updates: updatesService/);
    });
});

/** Comments stripped BY LINE, so prose cannot satisfy a guard. */
function strip(file: string): string {
    return readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
}

/** A source file's imports: static (import/export … from, side-effect imports) and dynamic (`import('…')`). */
function importsOf(file: string): { readonly static: string[]; readonly dynamic: string[] } {
    const text = strip(file);
    const stat = [...text.matchAll(/(?:^|\n)\s*(?:import\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?|export\s+(?!type\s)(?:\*|\{)[^'";]*?\sfrom\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    const dyn = [...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!);
    return { static: stat, dynamic: dyn };
}

/** Every file and bare package reachable from `entry` (dynamic imports followed only when asked). */
function graph(entry: string, followDynamic: boolean): { files: Set<string>; packages: Set<string> } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const visit = (file: string): void => {
        const at = resolve(file);
        if (files.has(at)) return;
        files.add(at);
        const found = importsOf(at);
        for (const spec of [...found.static, ...(followDynamic ? found.dynamic : [])]) {
            if (spec.startsWith('.')) {
                const base = resolve(dirname(at), spec).replace(/\.js$/, '');
                const hit = ['.ts', '.tsx'].map((x) => base + x).find((p) => existsSync(p));
                if (hit) visit(hit);
            } else {
                packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
            }
        }
    };
    visit(entry);
    return { files, packages };
}

describe('electron-updater is the helper’s alone', () => {
    const port = resolve('src/main/electron-updater-port.ts');

    it('the helper mode’s import graph reaches it (the control)', () => {
        const helper = graph('src/main/updater-process.ts', false);
        expect(helper.packages.has('electron-updater')).toBe(true);
        expect(helper.files.has(port)).toBe(true);
    });

    it('genie-host’s graph never reaches it, static or dynamic', () => {
        const host = graph('src/main/genie-host.ts', true);
        expect(host.packages.has('electron-updater')).toBe(false);
        expect(host.files.has(port)).toBe(false);
    });

    it('main’s static graph never reaches it', () => {
        const main = graph('src/main/main.ts', false);
        expect(main.packages.has('electron-updater')).toBe(false);
        expect(main.files.has(port)).toBe(false);
    });

    it('only electron-updater-port.ts names the package', () => {
        const helper = graph('src/main/updater-process.ts', false);
        const naming = [...helper.files].filter((f) => importsOf(f).static.includes('electron-updater'));
        expect(naming).toEqual([port]);
    });
});
