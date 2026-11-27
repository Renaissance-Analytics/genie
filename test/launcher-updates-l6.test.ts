import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LAUNCHER_LINK_METHODS } from '../src/core/engine-protocol.js';
import { launcherHostUpdate, launcherUpdaterPort } from '../src/main/launcher-updates.js';
import { UpdateHost } from '../src/main/updater.js';
import { UpdatesService, type UpdatesCaller } from '../src/main/updates-host.js';

/**
 * THE HOST'S UPDATES FROM ITS LAUNCHER (Tynn #1058 L6; the spec's "What leaves the host"). A host the launcher started
 * keeps UpdateHost (its state machine, its drain, its replica: the Updates UI does not change) and gets its updates from
 * the launcher (`launcher.check`), never from the `--updater` helper, which stays only in the bridge release. Installing
 * a host update ends in `launcher.apply {track: host, afterPid}` (the launcher swaps once this host has gone); a
 * client-only one asks for the client alone and the host stays. The launcher may ask the host to install (its tray, its
 * Updates window), and `host.update` from a paired owner is the launcher's, not the stub.
 */

type Row = { track: string; current: string; state: string; offer: { build: string } | null; withClient?: string };
const HOST_READY: Row[] = [
    { track: 'host', current: '2026.11.25-1', state: 'ready', offer: { build: '2026.11.26-1' }, withClient: '2026.11.26-1' },
    { track: 'client', current: '2026.11.25-1', state: 'up-to-date', offer: null },
];
const CLIENT_READY: Row[] = [
    { track: 'host', current: '2026.11.25-1', state: 'up-to-date', offer: null },
    { track: 'client', current: '2026.11.25-1', state: 'ready', offer: { build: '2026.11.26-1' } },
];
const NOTHING: Row[] = [{ track: 'host', current: '2026.11.25-1', state: 'up-to-date', offer: null }];

function fakeLauncher(rows: Row[]) {
    const calls: { method: string; args: readonly unknown[] }[] = [];
    const call = async (method: string, args: readonly unknown[] = []) => {
        calls.push({ method, args });
        if (method === 'launcher.check' || method === 'launcher.updates') return { ok: true as const, value: { tracks: rows } };
        if (method === 'launcher.apply') return { ok: true as const, value: { accepted: true } };
        return { ok: false as const, reason: `no ${method}` };
    };
    return { calls, call };
}

const ticks = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

const hostOptions = { installDir: '/opt/genie', ownPid: 10, processes: () => [], kill: () => true, caseInsensitive: false, running: { build: '2026.11.25-1', protocol: 4 }, agents: { live: () => [], stopAll: async () => {} }, stopHosted: async () => {} };

describe('the launcher feeds the host’s updater (L6)', () => {
    it('a ready host is a host update, at its build', async () => {
        const l = fakeLauncher(HOST_READY);
        const found = await launcherUpdaterPort(l.call, 4242).check();
        expect(found?.version).toBe('2026.11.26-1');
        expect(found && 'scope' in found ? found.scope : null).toMatchObject({ kind: 'full' });
        expect(l.calls.map((c) => c.method)).toEqual(['launcher.check']);
    });

    it('only a client ready is client-only: the host keeps running', async () => {
        const found = await launcherUpdaterPort(fakeLauncher(CLIENT_READY).call, 4242).check();
        expect(found?.version).toBe('2026.11.26-1');
        expect(found && 'scope' in found ? found.scope : null).toEqual({ kind: 'client-only' });
    });

    it('nothing ready is no offer; a launcher that refuses is said', async () => {
        expect(await launcherUpdaterPort(fakeLauncher(NOTHING).call, 4242).check()).toBeNull();
        const refusing = async () => ({ ok: false as const, reason: 'the feed could not be reached' });
        await expect(launcherUpdaterPort(refusing, 4242).check()).rejects.toThrow('the feed could not be reached');
    });

    it('installing a host update asks the launcher to swap once this host has gone', async () => {
        const l = fakeLauncher(HOST_READY);
        const port = launcherUpdaterPort(l.call, 4242);
        await port.check();
        await port.quitAndInstall();
        expect(l.calls.at(-1)).toEqual({ method: 'launcher.apply', args: [{ track: 'host', afterPid: 4242 }] });
    });

    it('a client-only install asks for the client alone', async () => {
        const l = fakeLauncher(CLIENT_READY);
        const port = launcherUpdaterPort(l.call, 4242);
        await port.check();
        await port.quitAndInstall();
        expect(l.calls.at(-1)).toEqual({ method: 'launcher.apply', args: [{ track: 'client' }] });
    });

    it('UpdateHost takes the scope the port states (a track build carries no bundle hash to compare)', async () => {
        const host = new UpdateHost({ ...hostOptions, port: { configure() {}, check: async () => ({ version: '2026.11.26-1', scope: { kind: 'client-only' as const } }), download: async () => {}, quitAndInstall() {} } });
        await host.check();
        expect(host.state().scope).toEqual({ kind: 'client-only' });
    });
});

describe('a host with a launcher installs through it, never through the helper', () => {
    const run = async (rows: Row[]) => {
        const l = fakeLauncher(rows);
        let helpers = 0;
        let exited = 0;
        const service = new UpdatesService({
            host: hostOptions,
            port: launcherUpdaterPort(l.call, 10),
            startHelper: () => { helpers += 1; },
            defaultLaunch: { file: 'genie', args: ['--updater'] },
            windowConnected: () => false,
            exit: () => { exited += 1; },
            defer: (fn) => { fn(); },
        } as ConstructorParameters<typeof UpdatesService>[0]);
        const launcher = { window: false, launcher: true } as UpdatesCaller;
        await service.call('install', [], launcher);
        await ticks();
        return { calls: l.calls, helpers, exited };
    };

    it('the launcher may ask for the install with no window open; the host drains, asks for the swap, and exits', async () => {
        const { calls, helpers, exited } = await run(HOST_READY);
        expect(helpers).toBe(0);
        expect(calls).toContainEqual({ method: 'launcher.apply', args: [{ track: 'host', afterPid: 10 }] });
        expect(exited).toBe(1);
    });

    it('a client-only update through the launcher leaves this host running', async () => {
        const { calls, helpers, exited } = await run(CLIENT_READY);
        expect(helpers).toBe(0);
        expect(calls).toContainEqual({ method: 'launcher.apply', args: [{ track: 'client' }] });
        expect(exited).toBe(0);
    });
});

describe('the launcher’s link to the host, and host.update', () => {
    it('the launcher may ask the host’s updater (engine.updates), and the server says it is the launcher asking', () => {
        expect(LAUNCHER_LINK_METHODS).toContain('engine.updates');
        const server = readFileSync('src/main/session-engine-server.ts', 'utf8');
        expect(server).toMatch(/conn\.launcher \? \{ window: false, launcher: true, connection: conn\.id \}/);
    });

    it('host.update with a launcher starts the install and says so: never the stub', async () => {
        const asked: string[] = [];
        const service = { call: async (m: string) => { asked.push(m); return m === 'check' ? { phase: 'available', version: '2026.11.26-1' } : null; } };
        const answer = await launcherHostUpdate(service, 'alphar')({ label: 'owner phone', connectionId: 'c1' });
        expect(answer.stub).toBeUndefined();
        expect(answer.started).toBe(true);
        expect(answer.reason).toContain('2026.11.26-1');
        await ticks();
        expect(asked).toEqual(['check', 'install']);
    });

    it('with nothing to install, host.update says so and starts nothing', async () => {
        const asked: string[] = [];
        const service = { call: async (m: string) => { asked.push(m); return m === 'check' ? { phase: 'none', version: null } : null; } };
        const answer = await launcherHostUpdate(service, 'alphar')({ label: 'owner phone', connectionId: 'c1' });
        expect(answer.started).toBe(false);
        expect(answer.stub).toBeUndefined();
        expect(answer.reason).toContain('alphar is up to date');
        expect(asked).toEqual(['check']);
    });
});
