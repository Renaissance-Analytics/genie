import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';
import { scheduleStagingSweep } from '../src/main/host-staging-sweep.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4d E (Tynn #955). The window composes nothing: main no longer calls composeWindowServices
 * and passes it no host input (the supervisor, hosting and flows replicas, ptys, Genie 1's database, Caddy, PHP, the
 * front door). Once A (#1043) and D (#1046) are in, nothing main read off the composition was live but its own teardown;
 * the one piece of host work it did that ran nowhere else, the sweep of old local staging, moves to genie-host. The
 * WindowServices types move out of compose.ts to the modules genie-host's features use. Done: no move:2g row left but
 * `stores` (2g-4e, #1007, retires it).
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

describe('1. the window composes nothing', () => {
    it('main never calls composeWindowServices, holds no composition and shuts none down', () => {
        const main = code(src('src/main/main.ts'));
        expect(main).not.toMatch(/composeWindowServices|composeWith\(|from '\.\/compose\.js'/);
        expect(main).not.toMatch(/\bservices\?\.shutdown\(\)|let services: /);
        // The inputs that were host work: none is built in the window to hand over.
        expect(main).not.toMatch(/\bcaddyBin:|\bsiteProbe:|\bv1Services:|\bv1Flows:|\bv1CaDirs:|\bresolvePhpCgi:|\bphpWorkerEnv:/);
    });

    it('a trust verdict reaches the window only through genie-host’s features push (features-host re-pushes on one)', () => {
        expect(code(src('src/main/main.ts'))).not.toMatch(/onTrustVerdict/);
        expect(code(src('src/main/features-host.ts'))).toMatch(/trust\.onVerdict\(/);
    });

    it('the window’s tools take no hosting, trust verdict or service exec: sites and services are genie-host’s', () => {
        const main = code(src('src/main/main.ts'));
        expect(main).not.toMatch(/hosting: composed|untrustedNow|serviceExec: runServiceExec/);
    });

    it('compose.ts exports no window composition', () => {
        expect(code(src('src/main/compose.ts'))).not.toMatch(/export async function composeWindowServices/);
    });
});

describe('2. no engine replica of the stores, supervisor, hosting or flows is read in the window', () => {
    it('their rows are gone, and nothing is still to move: the Tynn watches left in #934 task #1474', () => {
        const uses = WINDOW_ENGINE_INVENTORY.map(([use]) => use);
        for (const gone of ['flows', 'hosting', 'stores', 'supervisor']) expect(uses, gone).not.toContain(gone);
        expect(WINDOW_ENGINE_INVENTORY.filter(([, verdict]) => verdict.startsWith('move:'))).toEqual([]);
        // CONTROL: the same read sees the rows that are still there.
        expect(uses).toContain('welcome');
        expect(uses).toContain('browserCall');
    });

    it('main reads no stores(), supervisor(), hosting() or flows() off any engine client', () => {
        expect(code(src('src/main/main.ts'))).not.toMatch(/\.(stores|supervisor|hosting|flows)\(\)/);
    });
});

describe('3. genie-host sweeps old local staging itself', () => {
    function rig() {
        let scheduled: (() => Promise<void>) | null = null;
        const sweep = vi.fn(async (_home: string, _deps: { signal?: AbortSignal }) => {});
        const warn = vi.fn();
        const stop = scheduleStagingSweep('/home/u/.genie', {
            sweep, warn,
            schedule: (work) => { scheduled = work; return () => { scheduled = null; }; },
        });
        return { sweep, warn, stop, run: () => scheduled?.() ?? null, isScheduled: () => scheduled !== null };
    }

    it('schedules one sweep of its own home, once, after boot', async () => {
        const r = rig();
        expect(r.sweep).not.toHaveBeenCalled(); // scheduled, not run inline at boot
        expect(r.isScheduled()).toBe(true);
        await r.run();
        await r.run();
        expect(r.sweep).toHaveBeenCalledTimes(1);
        expect(r.sweep.mock.calls[0]![0]).toBe('/home/u/.genie');
        expect(r.sweep.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    });

    it('at shutdown it is unscheduled and a sweep under way is told to stop', async () => {
        const r = rig();
        let signal: AbortSignal | undefined;
        r.sweep.mockImplementation(async (_h, deps) => { signal = deps.signal; });
        await r.run();
        r.stop();
        expect(r.isScheduled()).toBe(false);
        expect(signal?.aborted).toBe(true);
    });

    it('a failed sweep is said, and never thrown; one ended by shutdown is not', async () => {
        const r = rig();
        r.sweep.mockRejectedValueOnce(new Error('EACCES'));
        await expect(r.run()).resolves.toBeUndefined();
        expect(r.warn).toHaveBeenCalledTimes(1);
        const s = rig();
        s.sweep.mockImplementation(async () => { s.stop(); throw new Error('aborted'); });
        await s.run();
        expect(s.warn).not.toHaveBeenCalled();
    });

    it('wired: genie-host schedules it over LocalStagingArea.sweepOld for its home, and stops it at shutdown', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/\n\s*stopStagingSweep = scheduleStagingSweep\(home, \{ sweep: \(h, d\) => LocalStagingArea\.sweepOld\(h, d\)/);
        // Declared before anything can shut down, so an early shutdown finds the no-op, never an unmade const.
        expect(host.indexOf('let stopStagingSweep = (): void => {};')).toBeLessThan(host.indexOf('async function shutdown(why: string)'));
        const shutdown = host.slice(host.indexOf('async function shutdown(why: string)'));
        expect(shutdown).toMatch(/stopStagingSweep\(\);/);
        // CONTROL: compose no longer sweeps; one sweeper, genie-host's.
        expect(code(src('src/main/compose.ts'))).not.toMatch(/sweepOld\(/);
    });
});

describe('4. the WindowServices types live beside genie-host’s features, not in compose.ts', () => {
    it('no host-side module imports its services type from compose.js', () => {
        for (const file of ['src/main/feature-controls.ts', 'src/main/feature-ipc.ts', 'src/main/feature-machine.ts', 'src/main/hosting-actions.ts']) {
            expect(code(src(file)), file).not.toMatch(/from '\.\/compose\.js'/);
            expect(code(src(file)), file).toMatch(/from '\.\/host-services\.js'/);
        }
    });

    it('host-services.ts declares them, and compose.ts takes them from there (for the tests that compose)', () => {
        const types = code(src('src/main/host-services.ts'));
        expect(types).toMatch(/export (interface|type) ComposedServices\b/);
        expect(types).toMatch(/export type WindowServices\b/);
        expect(code(src('src/main/compose.ts'))).toMatch(/from '\.\/host-services\.js'/);
        expect(code(src('src/main/compose.ts'))).not.toMatch(/export interface ComposedServices\b/);
    });
});

describe('5. compose.ts is the TESTS’ composition: nothing in src/ composes with it', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const path = join(dir, e.name);
        return e.isDirectory() ? files(path) : /\.(ts|tsx|mts|cts)$/.test(e.name) ? [path] : [];
    });
    const all = files(resolve(root, 'src')).map((p) => relative(root, p).replace(/\\/g, '/'));
    // composeWith / composeWindowServices from compose.js, or the tests' compose-alone helper, anywhere but compose.ts.
    const composes = (text: string) => /\b(composeWith|composeWindowServices)\b/.test(text) || /compose-alone/.test(text);

    it('no production file composes services or imports compose-alone (the guard)', () => {
        const offenders = all.filter((f) => f !== 'src/main/compose.ts' && composes(code(src(f))));
        expect(offenders).toEqual([]);
    });

    it('CONTROL: the gauge finds the composition where it is, and reads every source file', () => {
        expect(all).toContain('src/main/compose.ts');
        expect(all).toContain('src/main/genie-host.ts');
        expect(all.length).toBeGreaterThan(300);
        expect(composes(code(src('src/main/compose.ts')))).toBe(true);
        // The pattern reads an import as written: a line that composes is caught.
        expect(composes("import { composeWith } from './compose.js';")).toBe(true);
        expect(composes("import { composeAlone } from '../../test/helpers/compose-alone.js';")).toBe(true);
    });
});
