import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALIVE_FILE } from '../src/core/safe-mode.js';
import { startBeat } from '../src/main/safe-mode-beat.js';
import { SafeMode } from '../src/main/safe-mode-host.js';

/*
 * THE BANNER LISTS WHAT WAS RUNNING, EVEN RIGHT AFTER A START (Tynn #386; scripts/safe-mode-cdp.mjs D8). The sign of life
 * (`runtime/alive.json`) was beaten at boot and then every 15 s, so agents a restore had just started — the owner's crash
 * loop came as agents came back — were on no beat when the run died: the next start's banner listed none, and offered none.
 * Now every change to the started set beats at once, beside the 15 s one. And a sign of life that was cut mid-write (or is
 * partial) never reads as "nothing was running" while the one before it is good.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const runtimeDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'safe-mode-beat-')); dirs.push(d); return d; };
const T0 = Date.UTC(2026, 10, 6, 18, 0, 0);

/** Sessions that start and stop on demand, telling their listeners as SessionHost does. No timer ever fires. */
function sessions() {
    const started = new Set<string>();
    const listeners = new Set<() => void>();
    const tell = () => { for (const l of [...listeners]) l(); };
    return {
        started: () => [...started],
        onChange: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        start: (id: string) => { started.add(id); tell(); },
        stop: (id: string) => { started.delete(id); tell(); },
        /** Any other event of a running session (a streamed delta): the set did not change. */
        event: () => tell(),
    };
}
const noTimer = () => () => {};

describe('genie-host: an agent started, then an unclean end before the 15 s beat', () => {
    it('is listed on the next start, and offered there', () => {
        const dir = runtimeDir();
        const host = SafeMode.open(dir, { now: () => T0, pid: 11 });
        const s = sessions();
        startBeat({ started: s.started, onChange: s.onChange, beat: (ids) => host.beat(ids), every: noTimer });
        // CONTROL: before the start, the beat says nothing runs.
        expect(JSON.parse(readFileSync(join(dir, ALIVE_FILE), 'utf8')).agents).toEqual([]);
        s.start('agent_a');
        s.start('agent_b');
        // ...and the run dies here: no clean exit, no timer.
        const next = SafeMode.open(dir, { now: () => T0 + 10_000, pid: 12 });
        expect(next.view()).toMatchObject({ active: true, agents: ['agent_a', 'agent_b'] });
    });

    it('a stop is beaten too: what the person stopped is not offered', () => {
        const dir = runtimeDir();
        const host = SafeMode.open(dir, { now: () => T0, pid: 11 });
        const s = sessions();
        startBeat({ started: s.started, onChange: s.onChange, beat: (ids) => host.beat(ids), every: noTimer });
        s.start('agent_a');
        s.start('agent_b');
        s.stop('agent_a');
        expect(SafeMode.open(dir, { now: () => T0 + 10_000, pid: 12 }).view().agents).toEqual(['agent_b']);
    });

    it('a session event that changes nothing writes nothing (a stream of deltas is not a stream of writes)', () => {
        const dir = runtimeDir();
        const writes: string[][] = [];
        const s = sessions();
        startBeat({ started: s.started, onChange: s.onChange, beat: (ids) => { writes.push([...ids]); }, every: noTimer });
        s.start('agent_a');
        for (let i = 0; i < 20; i++) s.event();
        expect(writes).toEqual([[], ['agent_a']]);
        expect(dir).toBeTruthy();
    });
});

describe('a sign of life cut mid-write never reads as "nothing was running"', () => {
    for (const [what, text] of [['torn (cut mid-write)', '{"at":1793987823089,"pid":11,"agents":["agent_'], ['partial (no agents)', '{"at":1793987823089,"pid":11}'], ['empty', '']] as const) {
        it(`${what} next to a good previous one: the previous one's agents are listed`, () => {
            const dir = runtimeDir();
            const host = SafeMode.open(dir, { now: () => T0, pid: 11 });
            host.beat(['agent_a']);
            host.beat(['agent_a', 'agent_b']);
            writeFileSync(join(dir, ALIVE_FILE), text);
            const next = SafeMode.open(dir, { now: () => T0 + 10_000, pid: 12 });
            expect(next.view().active).toBe(true);
            expect(next.view().agents.length).toBeGreaterThan(0);
            expect(next.view().agents).toEqual(expect.arrayContaining(['agent_a']));
        });
    }
});

describe('wired', () => {
    it('genie-host beats its sessions through startBeat: every change, and the 15 s timer', () => {
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        expect(host).toMatch(/startBeat\(\{ started: \(\) => host\.startedIds\(\), onChange: \(l\) => host\.subscribe\(\(\) => l\(\)\), beat: \(ids\) => \{ safeMode\.beat\(ids\); \} \}\)/);
        expect(host).not.toMatch(/setInterval\(\(\) => \{ safeMode\.beat\(/);
    });
    it('the no-host window beats its own sessions through startBeat', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/startBeat\(\{ started: \(\) => \(registry\?\.listAgents\(\) \?\? \[\]\)\.filter\(\(a\) => host\?\.probe\(a\.id\)\?\.running === true\)\.map\(\(a\) => a\.id\), onChange: \(l\) => \(host instanceof SessionHost \? host\.subscribe\(\(\) => l\(\)\) : \(\) => \{\}\), beat: \(ids\) => \{ windowSafe\?\.beat\(ids\); \} \}\)/);
        expect(main).not.toMatch(/setInterval\(\(\) => \{ windowSafe\?\.beat\(/);
    });
});
