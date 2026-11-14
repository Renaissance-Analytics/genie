import { describe, expect, it } from 'vitest';
import { UpdateHost, type UpdaterPort } from '../src/main/updater.js';
import { runUpdaterHelper, type UpdaterLinkClient } from '../src/main/updater-helper.js';
import type { UpdaterEvent } from '../src/main/updates-host.js';

/**
 * Tynn #729: the helper must not idle out while an upgrade is pending (prepare -> install/release), and the host must
 * confirm the helper is still there before it stops anything irreversible.
 */

const IDLE = 120_000;

function helperRig() {
    const calls: string[] = [];
    const log: string[] = [];
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    let listener: (event: UpdaterEvent) => void = () => {};
    let closer: () => void = () => {};
    let quit = 0;
    let installs = 0;
    const client: UpdaterLinkClient = {
        call: async (method) => { calls.push(method); return null; },
        onEvent: (l) => { listener = l; return () => {}; },
        onClose: (l) => { closer = l; },
        close: () => {},
    };
    const port: UpdaterPort = {
        configure: () => {},
        check: async () => ({ version: '2.0.0' }),
        download: async () => {},
        quitAndInstall: () => { installs += 1; },
    };
    runUpdaterHelper({
        link: async () => client,
        port,
        pid: 900,
        processes: async () => [],
        alive: () => false,
        sleep: async () => {},
        now: () => 0,
        quit: () => { quit += 1; },
        recordFailure: () => {},
        relaunch: () => {},
        log: (line) => { log.push(line); },
        idleMs: IDLE,
        caseInsensitive: false,
        schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    });
    let id = 1;
    const request = async (op: string, wait?: unknown): Promise<void> => {
        listener({ kind: 'request', id: id++, op, ...(wait ? { wait } : {}) } as UpdaterEvent);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
    };
    /** The idle timer(s) that are still live reach their time. */
    const idleElapses = async (): Promise<void> => {
        for (const t of timers.filter((x) => !x.cancelled && x.ms === IDLE)) t.fn();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
    };
    const linked = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
    return { request, idleElapses, linked, closeLink: () => closer(), quit: () => quit, installs: () => installs, log };
}

describe('the helper holds an upgrade lease from prepare (#729)', () => {
    it('control: with no upgrade pending the helper still leaves when idle', async () => {
        const r = helperRig();
        await r.linked();
        await r.idleElapses();
        expect(r.quit()).toBe(1);
    });

    it('a drain longer than the idle time does not end the helper, and the install still runs', async () => {
        const r = helperRig();
        await r.linked();
        await r.request('prepare');
        await r.idleElapses();
        expect(r.quit()).toBe(0);
        await r.request('install', { pids: [], installDir: '', boundMs: 1000 });
        expect(r.installs()).toBe(1);
    });

    it('an explicit release ends the lease: the helper then leaves when idle', async () => {
        const r = helperRig();
        await r.linked();
        await r.request('prepare');
        await r.idleElapses();
        expect(r.quit()).toBe(0);
        await r.request('release');
        await r.idleElapses();
        expect(r.quit()).toBe(1);
    });

    it('the lease never outlives the host: a closed link still ends the helper', async () => {
        const r = helperRig();
        await r.linked();
        await r.request('prepare');
        r.closeLink();
        expect(r.quit()).toBe(1);
    });
});

describe('the host confirms the helper before stopping anything (#729)', () => {
    function hostRig(prepareFailsOn: number) {
        const order: string[] = [];
        let prepares = 0;
        const port: UpdaterPort = {
            configure: () => {},
            check: async () => ({ version: '2.0.0' }),
            download: async () => {},
            prepareInstall: async () => { prepares += 1; order.push(`prepare ${prepares}`); if (prepares === prepareFailsOn) throw new Error('Genie’s updater went away before it answered'); },
            releaseInstall: async () => { order.push('release'); },
            quitAndInstall: () => { order.push('install'); },
        };
        const host = new UpdateHost({
            port,
            installDir: '/install',
            ownPid: 1,
            processes: () => [],
            kill: () => false,
            agents: { live: () => [{ id: 'a', name: 'atlas' }], stopAll: () => { order.push('stop agents'); } },
            stopHosted: async () => { order.push('stop hosting'); },
            defer: (fn) => fn(),
        });
        return { host, order };
    }

    it('control: a helper that is there at both asks installs, with the helper told twice before anything stops', async () => {
        const { host, order } = hostRig(0);
        await host.check(); await host.download();
        await host.install();
        expect(order.slice(0, 3)).toEqual(['prepare 1', 'prepare 2', 'stop agents']);
        expect(order).toContain('install');
    });

    it('a helper gone at install time leaves everything running, says why, and installs nothing', async () => {
        const { host, order } = hostRig(2);
        await host.check(); await host.download();
        const result = await host.install();
        expect(order).not.toContain('stop agents');
        expect(order).not.toContain('stop hosting');
        expect(order).not.toContain('install');
        expect(result!.report).toMatch(/Not installed: .*went away/);
        expect(result!.report).toMatch(/Nothing was stopped/);
        expect(host.state().phase).toBe('error');
    });

    it('a failed install gives the helper its lease back', async () => {
        const { host, order } = hostRig(2);
        await host.check(); await host.download();
        await host.install();
        expect(order).toContain('release');
    });
});
