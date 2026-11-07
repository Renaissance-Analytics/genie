import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLEAN_EXIT_FILE, CRASH_LOOP_MS, UNKNOWN_CAUSE, safeModeWords } from '../src/core/safe-mode.js';
import { SafeMode } from '../src/main/safe-mode-host.js';

/**
 * CRASH DETECTION, CUT 2: THE CLEAN-EXIT MARKER (spec .ai/plans/genie-crash-safe-mode-reporting-spec.md §1, §2; Tynn #386).
 *
 * `runtime/clean-exit.json` is written LAST by genie-host's own end — a normal quit and "Shut down everything" (the window
 * asks the host to end), an update's install (the host ends for the installer), the idle exit — and REMOVED at the host's
 * boot. Its absence at the next boot means the last run did not end cleanly, and that start is in SAFE MODE.
 * Two unclean ends within 10 minutes are a crash loop: safe mode is kept across restarts until the person leaves it.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const runtimeDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'safe-mode-')); dirs.push(d); return d; };
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 6, 23, 12, 0);

/** One run of the host: it opens safe mode at boot, and ends cleanly (writes the marker) or not (it is killed). */
function run(dir: string, at: number, end: 'clean' | 'crash', agents: readonly string[] = []): SafeMode {
    const mode = SafeMode.open(dir, { now: () => at, pid: 1000 + Math.round(at / MIN) });
    mode.beat(agents);
    if (end === 'clean') mode.writeCleanExit('a window asked');
    return mode;
}

describe('the marker: written last by a clean end, removed at boot', () => {
    it('a clean end writes runtime/clean-exit.json; the next boot REMOVES it and is not in safe mode', () => {
        const dir = runtimeDir();
        const first = SafeMode.open(dir, { now: () => T0, pid: 11 });
        // CONTROL: the boot itself writes no marker; only the end does.
        expect(existsSync(join(dir, CLEAN_EXIT_FILE))).toBe(false);
        first.writeCleanExit('an update is installing');
        const marker = JSON.parse(readFileSync(join(dir, CLEAN_EXIT_FILE), 'utf8')) as { at: number; reason: string; pid: number };
        expect(marker).toMatchObject({ at: T0, reason: 'an update is installing', pid: 11 });
        const next = SafeMode.open(dir, { now: () => T0 + 60 * MIN, pid: 12 });
        expect(existsSync(join(dir, CLEAN_EXIT_FILE))).toBe(false);
        expect(next.active()).toBe(false);
    });

    it('the very first boot with this Genie (nothing on disk yet) is NOT safe mode — there was no run to end', () => {
        const dir = runtimeDir();
        expect(SafeMode.open(dir, { now: () => T0, pid: 1 }).active()).toBe(false);
    });

    it('a MISSING marker after a run means safe mode: when the last run was last alive, its agents, the cause unknown', () => {
        const dir = runtimeDir();
        run(dir, T0 - 30 * MIN, 'clean');
        // This run is killed (no marker): its last sign of life is its last beat.
        run(dir, T0, 'crash', ['agent_a', 'agent_b']);
        const next = SafeMode.open(dir, { now: () => T0 + 4 * MIN, pid: 3 });
        expect(next.active()).toBe(true);
        expect(next.view()).toMatchObject({ active: true, at: T0, cause: UNKNOWN_CAUSE, crashLoop: false, agents: ['agent_a', 'agent_b'] });
    });

    it('a safe-mode start that then quits cleanly: the start after it is normal again', () => {
        const dir = runtimeDir();
        run(dir, T0 - 60 * MIN, 'clean');
        run(dir, T0 - 30 * MIN, 'crash');
        const safe = run(dir, T0, 'clean');
        expect(safe.active()).toBe(true);
        expect(SafeMode.open(dir, { now: () => T0 + MIN, pid: 4 }).active()).toBe(false);
    });

    it('the record it keeps is unreadable: the start is treated as unclean, never as a first run', () => {
        const dir = runtimeDir();
        run(dir, T0 - 30 * MIN, 'clean');
        run(dir, T0 - 10 * MIN, 'crash');
        writeFileSync(join(dir, 'safe-mode.json'), '{ not json');
        expect(SafeMode.open(dir, { now: () => T0, pid: 5 }).active()).toBe(true);
    });
});

describe('a crash loop keeps safe mode until the person leaves it', () => {
    it('two unclean ends within 10 minutes: safe mode survives a CLEAN restart, until Leave safe mode', () => {
        const dir = runtimeDir();
        run(dir, T0 - 60 * MIN, 'clean');
        run(dir, T0, 'crash');
        run(dir, T0 + 5 * MIN, 'crash');
        const looping = run(dir, T0 + 7 * MIN, 'clean');
        expect(looping.view()).toMatchObject({ active: true, crashLoop: true });
        // Restarted cleanly, it is STILL in safe mode: the loop is kept.
        const kept = run(dir, T0 + 20 * MIN, 'clean');
        expect(kept.view()).toMatchObject({ active: true, crashLoop: true });
        kept.leave();
        expect(kept.active()).toBe(false);
        kept.writeCleanExit('a window asked');
        expect(SafeMode.open(dir, { now: () => T0 + 30 * MIN, pid: 6 }).active()).toBe(false);
    });

    it('CONTROL: two unclean ends 20 minutes apart are not a loop — one safe start each, normal after a clean restart', () => {
        const dir = runtimeDir();
        run(dir, T0 - 60 * MIN, 'clean');
        run(dir, T0, 'crash');
        // Ended uncleanly at T0; this run is alive from T0 + 20 min, and is killed too.
        const first = run(dir, T0 + CRASH_LOOP_MS + 10 * MIN, 'crash');
        expect(first.view()).toMatchObject({ active: true, crashLoop: false });
        const second = run(dir, T0 + CRASH_LOOP_MS + 12 * MIN, 'clean');
        expect(second.view()).toMatchObject({ active: true, crashLoop: false });
        expect(SafeMode.open(dir, { now: () => T0 + 60 * MIN, pid: 7 }).active()).toBe(false);
    });

    it('Leave safe mode is told to every listener once, and is kept on disk', () => {
        const dir = runtimeDir();
        run(dir, T0 - 60 * MIN, 'clean');
        run(dir, T0, 'crash');
        const safe = SafeMode.open(dir, { now: () => T0 + MIN, pid: 8 });
        const told: boolean[] = [];
        safe.onChange((view) => told.push(view.active));
        safe.leave();
        safe.leave();
        expect(told).toEqual([false]);
        expect(JSON.parse(readFileSync(join(dir, 'safe-mode.json'), 'utf8'))).toMatchObject({ kept: false });
    });
});

describe('the banner’s words', () => {
    it('names the time and the cause, and that nothing was started', () => {
        const words = safeModeWords({ active: true, at: T0, cause: UNKNOWN_CAUSE, crashLoop: false, agents: [], processes: [], sites: [] }, (at) => (at === T0 ? '11:12 PM' : '?'));
        expect(words).toBe('Genie didn’t shut down cleanly at 11:12 PM (unknown). Nothing was started.');
    });
});

describe('who writes it: genie-host, LAST, on every end it makes', () => {
    const host = readFileSync(resolve('src/main/genie-host.ts'), 'utf8');
    const shutdown = host.slice(host.indexOf('async function shutdown(why: string)'), host.indexOf('process.on(\'SIGTERM\''));

    it('shutdown() writes the marker as its last step, right before process.exit(0)', () => {
        const steps = shutdown.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('//'));
        const exit = steps.indexOf('process.exit(0);');
        expect(exit).toBeGreaterThan(0);
        expect(steps[exit - 1]).toBe('safeMode.writeCleanExit(why);');
        // CONTROL: written once, in shutdown only.
        expect(host.split('writeCleanExit(').length - 1).toBe(1);
    });

    it('the update install, the window’s quit and the idle exit all end through shutdown()', () => {
        expect(host).toMatch(/exit: \(\) => \{ void shutdown\('an update is installing'\); \}/);
        expect(host).toMatch(/onShutdown: \(\) => void shutdown\('a window asked'\)/);
        expect(host).toMatch(/if \(step\.exit\) void shutdown\(/);
    });

    it('safe mode is opened right after the endpoint is bound — a second host that exits never removes the marker', () => {
        const bound = host.indexOf('if (!bound) {');
        const opened = host.indexOf('SafeMode.open(runtime');
        expect(bound).toBeGreaterThan(0);
        expect(opened).toBeGreaterThan(bound);
        expect(opened).toBeLessThan(host.indexOf('spawnLedger.sweep('));
    });

    it('the window never writes it: "Just close the UI" leaves the host running, and that run has not ended', () => {
        const main = readFileSync(resolve('src/main/main.ts'), 'utf8');
        expect(main).not.toContain('writeCleanExit');
        expect(main).not.toContain(CLEAN_EXIT_FILE);
    });
});
