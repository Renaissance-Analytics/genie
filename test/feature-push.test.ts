import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import type { EngineStatusView } from '../src/core/engine-reconcile.js';

/**
 * A SITE'S STATE REACHES THE WINDOW PROMPTLY (genie#1393). The owner, after clicking Retry: "after a minute or so the ui
 * refreshed to show me it was running". The site had answered within seconds of the restart.
 *
 * Measured cause, in this file:
 *
 * 1. EVERY snapshot, the click's own answer and every push, waited for Docker: `docker version`, then one `docker
 *    container inspect` per engine, each allowed 20 s (DOCKER_QUERY_TIMEOUT_MS). The Hosting tab's state was hostage to
 *    Docker, which is slowest exactly when Genie has just started a dozen sites.
 * 2. The snapshots raced. The click's answer (built when the site was `starting`) could land AFTER the push built when
 *    it answered (`running`), and the window kept whichever came last, so it showed `starting` until something else
 *    happened to push. Every supervisor transition started another snapshot, each spawning its own Docker reads, so at
 *    boot there were dozens at once.
 */

const pty: PtyPort = {
    open: (o) => ({ id: `term_${Math.random()}`, pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-push-'));
    await mkdir(join(dir, 'acme'), { recursive: true });
    await writeFile(join(dir, 'acme', 'project.json'), `${JSON.stringify({ name: 'acme', repos: [] }, null, 2)}\n`, 'utf8');
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: async () => ({ stdout: '', exitCode: 0 }), workspaces: () => [{ id: 'acme', path: join(dir, 'acme') }], portFree: async () => true });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

const PG = { id: 'pg', engine: 'postgres' } as unknown as EngineStatusView['instance'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a snapshot never waits on a slow Docker for long (genie#1393)', () => {
    it('MEASURED: with Docker taking 4 s, a snapshot after the first comes back within the wait (not 4 s), carrying the last read', async () => {
        let slow = false;
        const reads: string[] = [];
        const s = { ...services, engineStatuses: async (): Promise<EngineStatusView[]> => {
            reads.push(slow ? 'slow' : 'fast');
            if (slow) await sleep(4_000);
            return [{ instance: PG, status: slow ? 'exited' : 'running' }];
        } } as ComposedServices;
        const late: number[] = [];
        const ports = { engineStatusWaitMs: 300, onEngineStatusesLate: () => { late.push(Date.now()); } };
        const first = await featureSnapshot(s, state(), ports);
        expect(first.services!.instances).toEqual([{ instance: PG, status: 'running' }]);
        slow = true;
        const t0 = Date.now();
        const second = await featureSnapshot(s, state(), ports);
        const took = Date.now() - t0;
        expect(took).toBeLessThan(1_500);
        // The last read Docker gave, not a made-up status.
        expect(second.services!.instances).toEqual([{ instance: PG, status: 'running' }]);
        // When Docker does answer, a fresh push is asked for, so the Services tab catches up.
        await sleep(4_300);
        expect(late).toHaveLength(1);
        const third = await featureSnapshot({ ...s, engineStatuses: async () => [{ instance: PG, status: 'exited' as const }] } as ComposedServices, state(), ports);
        expect(third.services!.instances).toEqual([{ instance: PG, status: 'exited' }]);
    }, 15_000);

    it('a late answer that changes NOTHING asks for no push: a Docker that is merely slow must not push forever (each push reads it again)', async () => {
        let slow = false;
        const s = { ...services, engineStatuses: async (): Promise<EngineStatusView[]> => {
            if (slow) await sleep(800);
            return [{ instance: PG, status: 'running' }];
        } } as ComposedServices;
        const late: number[] = [];
        const ports = { engineStatusWaitMs: 100, onEngineStatusesLate: () => { late.push(Date.now()); } };
        await featureSnapshot(s, state(), ports);
        slow = true;
        await featureSnapshot(s, state(), ports);
        await sleep(1_000);
        expect(late).toEqual([]);
    });

    it('POSITIVE CONTROL: a Docker that answers within the wait is read fresh, every snapshot', async () => {
        let n = 0;
        const s = { ...services, engineStatuses: async (): Promise<EngineStatusView[]> => [{ instance: PG, status: ++n % 2 ? 'running' : 'exited' }] } as ComposedServices;
        const ports = { engineStatusWaitMs: 300 };
        expect((await featureSnapshot(s, state(), ports)).services!.instances[0]!.status).toBe('running');
        expect((await featureSnapshot(s, state(), ports)).services!.instances[0]!.status).toBe('exited');
    });
});

describe('snapshots are ordered (genie#1393)', () => {
    it('every snapshot carries a sequence number taken when it STARTED, so the window can drop one older than what it shows', async () => {
        // The older one is held on its Docker read; the newer one, started after it, finishes FIRST. A number taken at the
        // end would order them backwards.
        let release: () => void = () => {};
        const held = { ...services, engineStatuses: () => new Promise<EngineStatusView[]>((r) => { release = () => r([]); }) } as ComposedServices;
        const quick = { ...services, engineStatuses: async (): Promise<EngineStatusView[]> => [] } as ComposedServices;
        const older = featureSnapshot(held, state(), { engineStatusWaitMs: 60_000 });
        const newer = await featureSnapshot(quick, state(), { engineStatusWaitMs: 60_000 });
        release();
        const old = await older;
        expect(typeof old.seq).toBe('number');
        expect(newer.seq!).toBeGreaterThan(old.seq!);
    });

    it('the window keeps the NEWER snapshot whichever lands last (renderer newestSnapshot)', async () => {
        const { newestSnapshot } = await import('../src/renderer/features.js');
        const a = { seq: 5 } as never;
        const b = { seq: 7 } as never;
        expect(newestSnapshot(a, b)).toBe(b);
        expect(newestSnapshot(b, a)).toBe(b);
        // A snapshot with no number (a remote host on an older Genie) is taken as it comes.
        expect(newestSnapshot(b, { seq: undefined } as never)).toEqual({ seq: undefined });
    });

    it('the window applies pushes AND the click\'s own answer through newestSnapshot (App.tsx)', () => {
        const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
        expect(app).toMatch(/features\.subscribe\(\(d\) => \{ if \(live\) setData\(\(cur\) => newestSnapshot\(cur, d\)\)/);
        expect(app).toMatch(/onFeature=\{\(action\) =>[\s\S]{0,400}?setFeatures\(\(cur\) => newestSnapshot\(cur, data\)\)/);
    });
});

describe('pushes are one at a time, the latest state always last (core/latest-push.ts)', () => {
    it('pushes during a build coalesce into ONE more build, deliveries keep order, and the last delivered is the newest state', async () => {
        const { LatestPush } = await import('../src/core/latest-push.js');
        let version = 0;
        const builds: number[] = [];
        const delivered: number[] = [];
        const push = new LatestPush<number>({
            build: async () => { const v = version; builds.push(v); await sleep(50); return v; },
            deliver: (v) => { delivered.push(v); },
        });
        version = 1; push.request();
        version = 2; push.request();
        version = 3; push.request();
        version = 4; push.request();
        await sleep(250);
        expect(builds).toEqual([1, 4]);
        expect(delivered).toEqual([1, 4]);
        // Idle again: the next request builds at once.
        version = 5; push.request();
        await sleep(100);
        expect(delivered).toEqual([1, 4, 5]);
    });

    it('a build that throws does not stop later pushes', async () => {
        const { LatestPush } = await import('../src/core/latest-push.js');
        let fail = true;
        const delivered: string[] = [];
        const push = new LatestPush<string>({ build: async () => { if (fail) throw new Error('boom'); return 'ok'; }, deliver: (v) => { delivered.push(v); }, onError: () => {} });
        push.request();
        await sleep(20);
        fail = false;
        push.request();
        await sleep(20);
        expect(delivered).toEqual(['ok']);
    });

    it('main pushes the feature snapshot through LatestPush, and asks again when Docker answers late', () => {
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
        expect(main).toMatch(/new LatestPush<FeatureData>\(/);
        expect(main).toMatch(/onEngineStatusesLate: \(\) => pushFeatures\(\)/);
    });
});
