import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ENGINE_PROTOCOL } from '../src/core/engine-protocol.js';
import { linkToHost, type EngineLaunchPorts } from '../src/main/engine-launch.js';
import { HOST_WAIT_ACTIONS_AFTER_MS, HOST_WAIT_SHOW_AFTER_MS, HostRestart, HostWait, type HostWaitView } from '../src/main/host-wait-window.js';
import { HostWaitScreen } from '../src/renderer/components/HostWaitScreen.js';

/**
 * NO SILENT FOREVER (the coordinator's ruling on Tynn #700): the window keeps waiting while its host lives, and from 60 s
 * the wait also offers "Open the log" and "Restart Genie's host", each with progress, then its outcome in words. Restart
 * ends that host and starts a new one, and the same wait goes on. Quit stays the window's close.
 */
const src = (p: string) => readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

describe('when the actions appear', () => {
    it('not before 60 s; from 60 s, and they stay', () => {
        const views: HostWaitView[] = [];
        const wait = new HostWait({ open: (v) => views.push(v), update: (v) => views.push(v), close: () => {} }, { openLog: async () => null, restart: async () => ({ ok: true }) });
        wait.progress(HOST_WAIT_SHOW_AFTER_MS);
        wait.progress(HOST_WAIT_ACTIONS_AFTER_MS - 1);
        wait.progress(HOST_WAIT_ACTIONS_AFTER_MS);
        expect(views.map((v) => v.actions)).toEqual([false, false, true]);
        expect(HOST_WAIT_ACTIONS_AFTER_MS).toBe(60_000);
        expect(views[2]!.title).toBe('Starting Genie’s host…');
    });
});

describe('what each action does, said', () => {
    const rig = (openLog: () => Promise<string | null>, restart: () => Promise<{ ok: true } | { ok: false; reason: string }>) => {
        const views: HostWaitView[] = [];
        const wait = new HostWait({ open: (v) => views.push(v), update: (v) => views.push(v), close: () => {} }, { openLog, restart });
        wait.progress(HOST_WAIT_ACTIONS_AFTER_MS);
        return { views, wait, last: () => views.at(-1)! };
    };

    it('Open the log: busy while it opens, then nothing to say; a log that cannot open says why', async () => {
        let done!: (v: string | null) => void;
        const r = rig(() => new Promise((ok) => { done = ok; }), async () => ({ ok: true }));
        const acting = r.wait.act('open-log');
        expect(r.last().busy).toBe('open-log');
        done(null);
        await acting;
        expect(r.last()).toMatchObject({ busy: null, outcome: null });
        const f = rig(async () => 'no app opens .log files', async () => ({ ok: true }));
        await f.wait.act('open-log');
        expect(f.last()).toMatchObject({ busy: null, outcome: { ok: false, text: 'Genie could not open the log: no app opens .log files' } });
    });

    it('Restart: busy while it restarts, then that it started again and the wait goes on; a failure in its words', async () => {
        const r = rig(async () => null, async () => ({ ok: true }));
        const acting = r.wait.act('restart');
        expect(r.last().busy).toBe('restart');
        await acting;
        expect(r.last()).toMatchObject({ busy: null, actions: true, outcome: { ok: true, text: 'Genie’s host was started again. Waiting for it.' } });
        const f = rig(async () => null, async () => ({ ok: false, reason: 'the host process could not be started' }));
        await f.wait.act('restart');
        expect(f.last()).toMatchObject({ outcome: { ok: false, text: 'the host process could not be started' } });
    });

    it('one at a time: a press while one runs starts nothing', async () => {
        let calls = 0;
        const r = rig(async () => null, () => { calls += 1; return new Promise(() => {}); });
        void r.wait.act('restart');
        void r.wait.act('restart');
        await r.wait.act('open-log');
        expect(calls).toBe(1);
    });
});

describe('Restart reaches the host the window is waiting for', () => {
    it('the hung host is ended, a new one started, and the window links to the new one', async () => {
        let clock = 0;
        const live = new Set<number>([42]);
        const killed: number[] = [];
        const spawned: number[] = [];
        let next = 42;
        const restart = new HostRestart();
        const record = (pid: number) => JSON.stringify({ pid, endpoint: `pipe-${pid}`, protocol: ENGINE_PROTOCOL, build: 'b1', startedAt: 1 });
        const ports: EngineLaunchPorts = {
            runtimeDir: '/rt', logsDir: '/logs', build: 'b1', hostScript: '/h.js', execPath: '/e', genieHome: '/home', env: {},
            now: () => clock,
            sleep: async (ms) => { clock += ms; if (clock === 70_000) void restart.request(); },
            alive: (pid) => live.has(pid),
            kill: (pid) => { killed.push(pid); live.delete(pid); },
            // Host 42 never gets ready; host 43, started by the restart, is ready 5 s after it starts.
            readFile: (file) => (live.has(43) && clock >= 75_100 ? (file === join('/rt', 'host.token') ? 'token' : file === join('/rt', 'host.json') ? record(43) : null) : null),
            spawnHost: () => { const pid = next++; spawned.push(pid); live.add(pid); return pid; },
            connectTo: async () => ({ send: () => {}, onMessage: () => () => {}, onClose: () => () => {}, close: () => {}, trusted: () => {} }),
            restart,
        };
        const link = await linkToHost(ports);
        expect(killed).toEqual([42]);
        expect(spawned).toEqual([42, 43]);
        expect(link.record.pid).toBe(43);
    });

    it('CONTROL: with no restart asked nothing is killed', async () => {
        let clock = 0;
        const ports: EngineLaunchPorts = {
            runtimeDir: '/rt', logsDir: '/logs', build: 'b1', hostScript: '/h.js', execPath: '/e', genieHome: '/home', env: {},
            now: () => clock, sleep: async (ms) => { clock += ms; },
            alive: () => clock < 3_000, kill: () => { throw new Error('nothing should be killed'); },
            readFile: () => null, spawnHost: () => 42, restart: new HostRestart(),
        };
        await expect(linkToHost(ports)).rejects.toThrow(/exited before it was ready/);
    });
});

describe('the screen', () => {
    const view = (over: Partial<HostWaitView> = {}): HostWaitView => ({ title: 'Starting Genie’s host…', detail: 'The first start can take a minute. 61 s so far.', actions: true, busy: null, outcome: null, ...over });
    const draw = (v: HostWaitView) => renderToStaticMarkup(<HostWaitScreen view={v} onAction={() => {}} />);

    it('the words, and from 60 s two buttons', () => {
        const html = draw(view());
        expect(html).toContain('Starting Genie’s host…');
        expect(html).toMatch(/<button[^>]*data-action="open-log"[^>]*>(?:<[^>]+>)*Open the log/);
        expect(html).toMatch(/<button[^>]*data-action="restart-host"[^>]*>(?:<[^>]+>)*Restart Genie’s host/);
    });

    it('CONTROL: before 60 s, no buttons', () => {
        expect(draw(view({ actions: false }))).not.toMatch(/<button/);
    });

    it('while one runs, it shows progress and neither can be pressed; an outcome is said', () => {
        const busy = draw(view({ busy: 'restart' }));
        expect(busy.match(/<button[^>]*data-action="restart-host"[^>]*>/)?.[0]).toMatch(/ disabled=""/);
        expect(busy.match(/<button[^>]*data-action="open-log"[^>]*>/)?.[0]).toMatch(/ disabled=""/);
        expect(draw(view({ outcome: { ok: false, text: 'the host process could not be started' } }))).toMatch(/role="alert"[^>]*>the host process could not be started/);
    });
});

describe('the window is wired to it', () => {
    it('a page of its own with its own preload, built like the question window', () => {
        expect(readFileSync('vite.config.ts', 'utf8')).toMatch(/'host-wait': 'host-wait\.html'/);
        expect(readFileSync('vite.preload.config.ts', 'utf8')).toMatch(/'host-wait-preload': 'src\/main\/host-wait-preload\.ts'/);
        expect(readFileSync('host-wait.html', 'utf8')).toContain('/src/renderer/host-wait-main.tsx');
        const preload = readFileSync('src/main/host-wait-preload.ts', 'utf8');
        expect(preload).toMatch(/exposeInMainWorld\('genieHostWait'/);
        expect(preload).not.toContain('genieLocalProtocol');
    });

    it('main opens it with that preload, answers its two actions, and the link takes Restart', () => {
        const main = src('src/main/main.ts');
        expect(main).toMatch(/preload: join\(here, 'host-wait-preload\.cjs'\)/);
        expect(main).toMatch(/loadWindowPage\(win\.webContents, 'host-wait'\)/);
        expect(main).toMatch(/ipcMain\.handle\('host-wait:act'/);
        expect(main).toMatch(/restart: hostRestart,/);
    });

    it('the gate runs the real-window check after build', () => {
        const linux = readFileSync('scripts/ci/linux.sh', 'utf8');
        const rows = linux.slice(linux.indexOf('ROWS=('), linux.indexOf(')', linux.indexOf('ROWS=(')));
        expect(rows).toMatch(/\bhost-late-ready\b/);
        expect(rows.indexOf('host-late-ready')).toBeGreaterThan(rows.indexOf('build'));
        expect(linux).toMatch(/row_host-late-ready\(\) \{ need_app && timeout \d+ node scripts\/host-late-ready-cdp\.mjs; \}/);
    });
});
