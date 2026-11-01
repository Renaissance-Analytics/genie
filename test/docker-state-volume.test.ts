import { describe, expect, it } from 'vitest';
import { ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';

/**
 * DOCKER IS ASKED WHEN SOMETHING CHANGED, NOT ON EVERY LOOK (genie#1397). The owner's beta.54 lifecycle.log: 216 main
 * blocks in `docker container inspect` (engine state) and 23 in `docker version`. Every feature snapshot and every
 * readiness poll spawned the Docker CLI again for a state that had not changed.
 *
 * Now the driver WATCHES: one long-lived `docker events` stream, and an engine's state is read once and then again only
 * when Docker reports an event for that container. A slow fallback asks again after a minute anyway, and much sooner
 * when the stream is down. Genie's own changes (start, stop) are read again at once. Without a watch, every look still
 * asks (what tests and a caller with no events port get).
 *
 * The scenario: one running engine, a boot's readiness polls plus a session's feature snapshots, 50 looks of Docker's
 * availability and the engine's state. BEFORE: 50 `docker version` + 50 `docker container inspect`. AFTER: one each,
 * plus one inspect per real event.
 */

const RUNNING = '[{"State":{"Status":"running","StartedAt":"2026-11-01T00:00:00Z"}}]';
const EXITED = '[{"State":{"Status":"exited"}}]';

function docker() {
    const calls: string[] = [];
    let state = RUNNING;
    const run: DockerRunner = async (args) => {
        calls.push(args[0] === 'version' ? 'version' : args.slice(0, 2).join(' '));
        if (args[0] === 'version') return { stdout: '28.1.0\n', exitCode: 0 };
        if (args[0] === 'container' && args[1] === 'inspect') return { stdout: state, exitCode: 0 };
        return { stdout: '', exitCode: 0 };
    };
    return { run, calls, set: (s: string) => { state = s; }, count: (what: string) => calls.filter((c) => c === what).length };
}

/** `driver.watch(port)` where the driver has one; a driver without it keeps asking on every look (and reads red here by count). */
function watchIfAble(driver: ServiceDriver, port: ReturnType<typeof events>['port']): void {
    (driver as unknown as { watch?: (p: typeof port) => void }).watch?.call(driver, port);
}

/** A `docker events` stream the test drives: lines pushed in, an end it can cause. */
function events() {
    let line: ((text: string) => void) | null = null;
    let end: ((reason: string) => void) | null = null;
    const started: string[][] = [];
    return {
        port: (args: readonly string[], onLine: (text: string) => void, onEnd: (reason: string) => void) => {
            started.push([...args]);
            line = onLine;
            end = onEnd;
            return { stop: () => { line = null; } };
        },
        push: (name: string, action: string) => line?.(JSON.stringify({ Type: 'container', Action: action, Actor: { ID: 'abc', Attributes: { name } } })),
        end: (reason = 'daemon gone') => end?.(reason),
        started,
    };
}

describe('Docker state is read on change, not on every look (genie#1397)', () => {
    it('50 looks at a quiet engine: one docker version and one container inspect (before: 50 of each)', async () => {
        const d = docker();
        const e = events();
        let now = 0;
        const driver = new ServiceDriver(d.run, { now: () => now, schedule: () => () => {} });
        watchIfAble(driver, e.port);
        for (let i = 0; i < 50; i += 1) {
            now += 1_000; // a look a second: well inside the slow fallback
            expect(await driver.available()).toEqual({ ok: true, version: '28.1.0' });
            expect((await driver.status('genie-postgres-17')).state).toBe('running');
        }
        expect(e.started[0]).toEqual(['events', '--format', '{{json .}}', '--filter', 'type=container']);
        expect(d.count('version')).toBe(1);
        expect(d.count('container inspect')).toBe(1);
    });

    it('an event for the container is read once, and shows; an event for another container reads nothing', async () => {
        const d = docker();
        const e = events();
        const driver = new ServiceDriver(d.run, { now: () => 0, schedule: () => () => {} });
        watchIfAble(driver, e.port);
        expect((await driver.status('genie-postgres-17')).state).toBe('running');
        e.push('someone-elses-nginx', 'start');
        await driver.status('genie-postgres-17');
        expect(d.count('container inspect')).toBe(1);
        d.set(EXITED);
        e.push('genie-postgres-17', 'die');
        expect((await driver.status('genie-postgres-17')).state).toBe('exited');
        await driver.status('genie-postgres-17');
        expect(d.count('container inspect')).toBe(2);
    });

    it('looks at the same moment share one inspect', async () => {
        const d = docker();
        const driver = new ServiceDriver(d.run, { now: () => 0, schedule: () => () => {} });
        watchIfAble(driver, events().port);
        await Promise.all(Array.from({ length: 10 }, () => driver.status('genie-redis-7')));
        expect(d.count('container inspect')).toBe(1);
    });

    it('the slow fallback: a minute after its read, a quiet engine is asked again', async () => {
        const d = docker();
        let now = 0;
        const driver = new ServiceDriver(d.run, { now: () => now, schedule: () => () => {} });
        watchIfAble(driver, events().port);
        await driver.status('genie-postgres-17');
        now = 59_000;
        await driver.status('genie-postgres-17');
        expect(d.count('container inspect')).toBe(1);
        now = 61_000;
        await driver.status('genie-postgres-17');
        expect(d.count('container inspect')).toBe(2);
    });

    it('the stream ends (Docker stopped): nothing is trusted, looks ask again within seconds, and the watch is started again', async () => {
        const d = docker();
        const e = events();
        let now = 0;
        const scheduled: Array<() => void> = [];
        const driver = new ServiceDriver(d.run, { now: () => now, schedule: (fn) => { scheduled.push(fn); return () => {}; } });
        watchIfAble(driver, e.port);
        await driver.available();
        await driver.status('genie-postgres-17');
        e.end();
        await driver.available();
        await driver.status('genie-postgres-17');
        expect(d.count('version')).toBe(2);
        expect(d.count('container inspect')).toBe(2);
        now += 2_000;
        await driver.status('genie-postgres-17');
        expect(d.count('container inspect')).toBe(2);
        now += 4_000;
        await driver.status('genie-postgres-17');
        expect(d.count('container inspect')).toBe(3);
        expect(scheduled.length).toBe(1);
        scheduled[0]!();
        expect(e.started.length).toBe(2);
    });

    it("Genie's own stop is read again at once, before any event arrives", async () => {
        const d = docker();
        const driver = new ServiceDriver(d.run, { now: () => 0, schedule: () => () => {} });
        watchIfAble(driver, events().port);
        expect((await driver.status('genie-postgres-17')).state).toBe('running');
        d.set(EXITED);
        await driver.stop('genie-postgres-17');
        expect((await driver.status('genie-postgres-17')).state).toBe('exited');
    });

    it('CONTROL: with no watch, every look asks (what a driver without an events port does)', async () => {
        const d = docker();
        const driver = new ServiceDriver(d.run);
        for (let i = 0; i < 5; i += 1) await driver.status('genie-postgres-17');
        expect(d.count('container inspect')).toBe(5);
    });
});
