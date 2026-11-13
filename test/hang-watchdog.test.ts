import { describe, expect, it } from 'vitest';
import type { CrashHeader, CrashRecord, RunningAgentNote } from '../src/core/crash-record.js';
import { mainStalls, runningAgentNote } from '../src/core/crash-record.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { HangWatchdog } from '../src/main/hang-watchdog.js';

/**
 * THE HANG WATCHDOG (Tynn story #386; spec `.ai/plans/genie-crash-safe-mode-reporting-spec.md` §1). Two of the owner's
 * crashes on 2026-11-06 were window-main HANGS: lifecycle.log silent for about 4 minutes, then a new boot, and nothing
 * else anywhere. The third was a sudden death with no hang. So genie-host, which survives the window, hears a heartbeat
 * from window main every second and:
 *  - after 30 s with no beat from a connected window, writes a `hang` record and ends the frozen window;
 *  - writes `rss window=<MB> host=<MB>` to lifecycle.log every 60 s, so a sudden death leaves the last reading behind;
 *  - records a window connection that drops without a clean goodbye, and whose process is gone, as `lost`.
 * Every "nothing" row below sits beside the same rig producing the something.
 */

const MB = 1024 * 1024;
const HEADER: CrashHeader = { schema: 1, version: '2.0.0-beta.60', build: '2.0.0-beta.60+abc123def456', os: 'linux', osRelease: '6.1.0', arch: 'x64', uptimeS: 42 };

function rig(options: { agents?: () => RunningAgentNote[]; alive?: (pid: number) => boolean; lifecycle?: () => string[]; exitOf?: (pid: number) => { code: number | null; signal: string | null } | null; ownExit?: (pid: number, since: number) => { reason: string; code: number | null } | null } = {}) {
    let t = 1_700_000_000_000;
    let tick: (() => void) | null = null;
    const records: CrashRecord[] = [];
    const killed: number[] = [];
    const lines: string[] = [];
    const dog = new HangWatchdog({
        now: () => t,
        every: (fn) => { tick = fn; return () => { tick = null; }; },
        write: (record) => { records.push(record); },
        kill: (pid) => { killed.push(pid); return Promise.resolve(true); },
        alive: options.alive ?? (() => false),
        hostRss: () => 300 * MB,
        agents: options.agents ?? (() => []),
        lifecycle: options.lifecycle ?? (() => ['2026-11-06T10:00:00.000Z boot pid=4242 version=t', '2026-11-06T10:00:01.000Z stall main ms=1800 route=/', '2026-11-06T10:00:02.000Z host stall main ms=1200 route=-']),
        log: (line) => lines.push(line),
        header: () => HEADER,
        ...(options.exitOf ? { exitOf: options.exitOf } : {}),
        ...(options.ownExit ? { ownExit: options.ownExit } : {}),
    });
    dog.start();
    /** One second of the clock, with the watchdog's own tick (as its 1 s interval would). */
    const second = (n = 1, beat?: () => void) => { for (let i = 0; i < n; i++) { t += 1000; beat?.(); tick?.(); } };
    /** The clock moves with no tick at all (the machine asleep, or the host's own loop held). */
    const jump = (ms: number) => { t += ms; };
    return { dog, records, killed, lines, second, jump, now: () => t, started: () => tick !== null };
}

describe('genie-host hears window main beat, and records a hang', () => {
    it('no beat for 30 s from a connected window: a hang record with its fields, and the window pid is ended', () => {
        const r = rig();
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        const lastBeat = r.now();
        r.second(29);
        expect(r.records).toEqual([]);
        expect(r.killed).toEqual([]);
        r.second(1);
        expect(r.records).toHaveLength(1);
        const record = r.records[0]!;
        expect(record.kind).toBe('hang');
        // THE COMMON HEADER: which Genie, which machine, how long the host had run (schema 1).
        expect(record).toMatchObject(HEADER);
        if (record.kind !== 'hang') throw new Error('not a hang');
        expect(record.windowPid).toBe(4242);
        expect(record.lastBeatAt).toBe(new Date(lastBeat).toISOString());
        expect(record.at).toBe(new Date(r.now()).toISOString());
        // The last lifecycle lines, main's own stall lines from them (the host's are not main's), memory, agents.
        expect(record.lifecycle).toContain('2026-11-06T10:00:00.000Z boot pid=4242 version=t');
        expect(record.stalls).toEqual([{ at: '2026-11-06T10:00:01.000Z', ms: 1800, route: '/', stack: null }]);
        expect(Array.isArray(record.memory)).toBe(true);
        expect(record.agents).toEqual([]);
        expect(r.killed).toEqual([4242]);
        // Said once: the frozen window is ended once, recorded once.
        r.second(30);
        expect(r.records).toHaveLength(1);
        expect(r.killed).toEqual([4242]);
    });

    it('CONTROL: beats arriving every second → no record and nothing ended, for minutes', () => {
        const r = rig();
        const beat = () => r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        beat();
        r.second(180, beat);
        expect(r.records.filter((x) => x.kind === 'hang')).toEqual([]);
        expect(r.killed).toEqual([]);
    });

    it('a window that never beat is not watched (a connection that is not a window, or an older build)', () => {
        const r = rig();
        r.second(120);
        expect(r.records).toEqual([]);
        expect(r.killed).toEqual([]);
    });

    it('a gap in the HOST’s own clock (sleep, the host held) PAUSES the wait instead of ending a window that was asleep too', () => {
        const r = rig();
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        r.second(5);
        // 10 minutes pass with no tick at all (the machine slept; the window slept too, so no beat), then it ticks again.
        r.jump(600_000);
        r.second(1);
        expect(r.records).toEqual([]);
        expect(r.killed).toEqual([]);
        // And it is still watching: 30 s more with no beat is a hang.
        r.second(30);
        expect(r.records.map((x) => x.kind)).toEqual(['hang']);
    });

    /*
     * THE WAIT PAUSES, IT DOES NOT START AGAIN (omarchy-test, hang-cdp, 2026-11-06: genie-host's loop came 8–12 s late
     * twice in every 40 s hold, each restarting every window's wait, so 30 s of silence was never reached and a real hang
     * went uncaught). Only the host's own stalled time comes off a window's silence: a window silent for 30 s of the host's
     * awake time is a hang, however many times the host's loop was late in between. A sleep is one large stalled span, so
     * a window that beats after it is not.
     */
    it('(a) repeated 8–12 s jumps of the host\'s clock during a 60 s silence still end in a hang record', () => {
        const r = rig();
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        r.second(5);
        // Three times: the host's loop held 9–11 s (the next tick that late), then 10 s of ordinary ticks. 65 s of wall time,
        // 38 s of it with the host awake and the window silent throughout.
        for (const held of [9_000, 11_000, 10_000]) { r.jump(held); r.second(1); r.second(10); }
        expect(r.records.map((x) => x.kind)).toEqual(['hang']);
        expect(r.killed).toEqual([4242]);
        // Each late tick was said, with what the host itself spent meanwhile.
        expect(r.lines.filter((l) => /clock jumped/.test(l))).toHaveLength(3);
        expect(r.lines.find((l) => /clock jumped/.test(l))).toMatch(/the window waits are judged again after 3000 ms/);
    });

    /*
     * THE SECOND HOLD ON A LOADED MACHINE (omarchy-test, the 61.2 gate's hang row, 2026-11-12: H2 failed twice). In a 40 s
     * hold genie-host's loop came 3.5, 8.4 and 11.6 s late (lifecycle.log `host stall main`), so taking the host's stalled
     * time off left about 16 s of silence and the hang was never recorded, though the window was silent all 40 s. A stall
     * says nothing about the window: beats it sent meanwhile wait in the socket and land just after the late tick. So a
     * late tick holds judgment for a few seconds, for those beats; then the window's real silence is what counts.
     */
    it('(c) the 61.2 gate\'s second hold: stalls of 3.5, 8.4 and 11.6 s inside a 40 s silence still end in a hang', () => {
        const r = rig();
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        r.second(7);
        r.jump(3_500); r.second(1);
        r.second(8);
        r.jump(8_400); r.second(1);
        r.second(3);
        r.jump(11_600); r.second(1);
        // About 40 s since the last beat, 16 s of it with the host awake.
        r.second(4);
        expect(r.records.map((x) => x.kind)).toEqual(['hang']);
        expect(r.killed).toEqual([4242]);
    });

    it('CONTROL for (c): a host stall with the window\'s beats queued behind it is not a hang', () => {
        const r = rig();
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        r.second(5);
        for (const held of [3_500, 8_400, 11_600, 25_000]) {
            // The late tick comes first; the beats the window sent meanwhile are read just after it.
            r.jump(held); r.second(1);
            r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
            r.second(4, () => r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB }));
        }
        expect(r.records).toEqual([]);
    });

    it('(d) after a sleep, a window that beats within a couple of seconds of waking is not ended', () => {
        const r = rig();
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        r.second(20);
        r.jump(600_000);
        r.second(2);
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        r.second(20, () => r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB }));
        expect(r.records).toEqual([]);
    });

    /*
     * A LONG SLEEP IS NOT A HOST STALL (review of #1885). A late tick holds judgment only 3 s, then counts silence from the
     * window's last beat BEFORE the gap. After the machine slept for minutes, a window that is slow to wake (a loaded
     * machine, a throttled window) and has not beaten within those 3 s would be declared hung and its pid killed: a false
     * hang ends the owner's window. So a gap far beyond any loop stall (the machine slept) gives every window a full wait
     * from the wake; silence before the sleep does not count. The repeated short stalls of (c) are still not sleeps.
     */
    for (const [before, after] of [[20, 5], [20, 8], [25, 8], [29, 12]] as const) {
        it(`(e) a window silent ${before} s before a 10-minute sleep and beating ${after} s after waking is not ended`, () => {
            const r = rig();
            r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
            r.second(before);
            r.jump(600_000);
            r.second(after);
            r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
            r.second(60, () => r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB }));
            expect(r.records).toEqual([]);
            expect(r.killed).toEqual([]);
        });
    }

    it('CONTROL for (e): a window still silent well past the wake grace after a long sleep IS a hang, and is ended', () => {
        const r = rig();
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        r.second(20);
        r.jump(600_000);
        // Well past any wake grace (and every case of (e)), still nothing recorded: the wait runs from the wake.
        r.second(20);
        expect(r.records).toEqual([]);
        expect(r.killed).toEqual([]);
        // 30 s of silence since the wake (its first tick was the first of those 20 s): a hang.
        r.second(11);
        expect(r.records.map((x) => x.kind)).toEqual(['hang']);
        expect(r.killed).toEqual([4242]);
    });

    it('CONTROL for (a): the same jumps with the window beating between them: no hang', () => {
        const r = rig();
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        r.second(5);
        for (const held of [9_000, 11_000, 10_000]) { r.jump(held); r.second(1); r.second(10, () => r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB })); }
        expect(r.records).toEqual([]);
    });

    it('(b) one 10-minute sleep, the window beating again right after it: no hang', () => {
        const r = rig();
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        r.second(20);
        r.jump(600_000);
        r.second(1);
        r.second(40, () => r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB }));
        expect(r.records).toEqual([]);
        expect(r.killed).toEqual([]);
    });

    it('a dropped window\'s grace pauses the same way: the host held is not the window gone', () => {
        const r = rig({ alive: () => false });
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        r.dog.dropped('conn-1');
        r.second(3);
        r.jump(600_000);
        r.second(1);
        expect(r.records).toEqual([]);
    });

    it('the running agents go in with the current turn’s last tool NAME and its byte size, and NO content', () => {
        const SECRET_OUTPUT = 'TOOL-OUTPUT-SECRET-7f3a';
        const SECRET_INPUT = 'TOOL-INPUT-SECRET-91bc';
        const SECRET_TITLE = 'TOOL-TITLE-SECRET-22de';
        const SECRET_MESSAGE = 'MESSAGE-SECRET-5c0d';
        const rows: TimedEvent[] = [
            { id: 'a:1', at: 1, event: { kind: 'message', speaker: 'you', peerName: null, text: SECRET_MESSAGE } },
            { id: 'a:2', at: 2, event: { kind: 'tool', toolCallId: 't1', name: 'Bash', title: SECRET_TITLE, status: 'completed', toolKind: 'execute', rawInput: { command: SECRET_INPUT }, output: SECRET_OUTPUT, outputBytes: 238_000 } },
            { id: 'a:3', at: 3, event: { kind: 'message', speaker: 'agent', peerName: null, text: SECRET_MESSAGE } },
        ];
        const note = runningAgentNote('tynn-slave', rows);
        expect(note).toEqual({ name: 'tynn-slave', lastTool: 'Bash', lastToolBytes: 238_000 });
        const r = rig({ agents: () => [note] });
        r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        r.second(30);
        expect(r.records).toHaveLength(1);
        const text = JSON.stringify(r.records[0]);
        expect(text).toContain('tynn-slave');
        expect(text).toContain('Bash');
        for (const secret of [SECRET_OUTPUT, SECRET_INPUT, SECRET_TITLE, SECRET_MESSAGE]) expect(text).not.toContain(secret);
    });

    it('a turn’s last tool is the CURRENT turn’s: a tool before the person’s last prompt is not it', () => {
        const rows: TimedEvent[] = [
            { id: 'a:1', at: 1, event: { kind: 'tool', toolCallId: 't0', name: 'Read', title: null, status: 'completed', toolKind: 'read', rawInput: null, output: 'abcd' } },
            { id: 'a:2', at: 2, event: { kind: 'message', speaker: 'you', peerName: null, text: 'next' } },
        ];
        expect(runningAgentNote('a', rows)).toEqual({ name: 'a', lastTool: null, lastToolBytes: null });
        // With no outputBytes the size is the output's own bytes (UTF-8).
        const one: TimedEvent[] = [{ id: 'a:1', at: 1, event: { kind: 'tool', toolCallId: 't0', name: 'Read', title: null, status: 'completed', toolKind: 'read', rawInput: null, output: 'abcé' } }];
        expect(runningAgentNote('a', one)).toEqual({ name: 'a', lastTool: 'Read', lastToolBytes: 5 });
    });
});

describe('main\u2019s stalls, structured from lifecycle.log', () => {
    it('each `stall main` line is {at, ms, route, stack}; a stack line that follows is its SIGNATURE, at most 12 frames, no values', () => {
        const frames = Array.from({ length: 15 }, (_, i) => `fn${i} main.js:${i + 1}`);
        const lines = [
            '2026-11-06T10:00:00.000Z stall main ms=1200 route=-',
            '2026-11-06T10:00:01.000Z host stall main ms=1500 route=-',
            '2026-11-06T10:00:02.000Z stall main ms=16600 route=/workspace/ws during=agents.history',
            `2026-11-06T10:00:02.100Z stall main stack ms=16590 top=fn0 main.js:1 stack=${frames.join(' < ')}`,
            '2026-11-06T10:00:03.000Z stall main ms=1100 route=/',
            '2026-11-06T10:00:03.100Z stall main stack ms=1090 top=encode x stack=encode ndjson.js:9 < send({"text":"MESSAGE-SECRET"}) a.js:1 < (anonymous) b.js:2',
        ];
        const stalls = mainStalls(lines);
        expect(stalls).toEqual([
            { at: '2026-11-06T10:00:00.000Z', ms: 1200, route: null, stack: null },
            { at: '2026-11-06T10:00:02.000Z', ms: 16600, route: '/workspace/ws', stack: frames.slice(0, 12).join(' < ') },
            { at: '2026-11-06T10:00:03.000Z', ms: 1100, route: '/', stack: 'encode ndjson.js:9 < ? < (anonymous) b.js:2' },
        ]);
        expect(JSON.stringify(stalls)).not.toContain('MESSAGE-SECRET');
    });
});

describe('RSS every 60 s, as one lifecycle line', () => {
    it('`rss window=<MB> host=<MB>` once a minute on the fake clock, from the newest beat’s reading', () => {
        const r = rig();
        const beat = () => r.dog.beat('conn-1', { pid: 4242, rss: 512 * MB });
        beat();
        r.second(59, beat);
        expect(r.lines.filter((l) => l.startsWith('rss '))).toEqual([]);
        r.second(1, beat);
        expect(r.lines.filter((l) => l.startsWith('rss '))).toEqual(['rss window=512 host=300']);
        r.second(60, beat);
        expect(r.lines.filter((l) => l.startsWith('rss '))).toEqual(['rss window=512 host=300', 'rss window=512 host=300']);
        // The samples are what a hang record carries.
        expect(r.dog.samples()).toHaveLength(2);
        expect(r.dog.samples()[0]).toMatchObject({ windowMb: 512, hostMb: 300 });
    });

    it('with no window beating, the host still says its own: `window=-`', () => {
        const r = rig();
        r.second(60);
        expect(r.lines.filter((l) => l.startsWith('rss '))).toEqual(['rss window=- host=300']);
    });

    it('the samples kept are bounded (the newest 60)', () => {
        const r = rig();
        r.second(61 * 60);
        expect(r.dog.samples()).toHaveLength(60);
    });
});

describe('a window connection that drops without a clean goodbye is LOST', () => {
    it('dropped, no goodbye, its process gone after the grace → a lost record with the last beat and RSS', () => {
        const r = rig({ alive: () => false });
        r.dog.beat('conn-1', { pid: 4242, rss: 700 * MB });
        const lastBeat = r.now();
        r.second(2);
        r.dog.dropped('conn-1');
        r.second(9);
        expect(r.records).toEqual([]);
        r.second(1);
        expect(r.records).toHaveLength(1);
        const record = r.records[0]!;
        expect(record).toMatchObject({ ...HEADER, kind: 'lost', windowPid: 4242, lastBeatAt: new Date(lastBeat).toISOString(), lastRssMb: 700 });
        // Nothing is ended for a window that is already gone.
        expect(r.killed).toEqual([]);
    });

    it('CONTROL: a window that said goodbye is not lost', () => {
        const r = rig({ alive: () => false });
        r.dog.beat('conn-1', { pid: 4242, rss: 700 * MB });
        r.dog.beat('conn-1', { pid: 4242, rss: 700 * MB, bye: true });
        r.dog.dropped('conn-1');
        r.second(60);
        expect(r.records).toEqual([]);
    });

    it('CONTROL: a link that dropped while the window still runs (it reconnects) is not lost', () => {
        const r = rig({ alive: () => true });
        r.dog.beat('conn-1', { pid: 4242, rss: 700 * MB });
        r.dog.dropped('conn-1');
        r.second(60);
        expect(r.records).toEqual([]);
    });

    it('CONTROL: the host shutting down (it writes the clean-exit marker) records no lost window', () => {
        const r = rig({ alive: () => false });
        r.dog.beat('conn-1', { pid: 4242, rss: 700 * MB });
        r.dog.shuttingDown();
        r.dog.dropped('conn-1');
        r.second(60);
        expect(r.records).toEqual([]);
    });

    it('the window the watchdog ended for a hang is not recorded again as lost', () => {
        const r = rig({ alive: () => false });
        r.dog.beat('conn-1', { pid: 4242, rss: 700 * MB });
        r.second(30);
        r.dog.dropped('conn-1');
        r.second(60);
        expect(r.records.map((x) => x.kind)).toEqual(['hang']);
    });
});

/**
 * A LOST RECORD SAYS WHICH WINDOW, AND HOW IT ENDED (Tynn issue #711). The owner's 61.2, 2026-11-12: two windows connected,
 * one stopped beating at 14:40:58 and its link dropped 10 s later; the record said its pid, its last beat and 368 MB, and
 * nothing that told the two windows apart or why the process ended. Now: the window (when it first beat, the route it
 * showed, its V8 heap against its limit, and how long it was silent before its link dropped), and its exit: the code and
 * signal genie-host saw for a window it started itself, else the window's own exit record, else plainly that neither was
 * seen and what that leaves (its exit handlers never ran: ended from outside, a native crash, or out of memory).
 */
describe('a lost record names the window and its exit (Tynn issue #711)', () => {
    const beat = { pid: 4242, rss: 700 * MB, route: 'genie://AlphaR/liftpoint/lift', heapUsed: 3_100 * MB, heapLimit: 4_096 * MB };

    it('the window: its first beat, the route it showed, its heap against its limit, and its silence before the drop', () => {
        const r = rig({ alive: () => false });
        r.dog.beat('conn-1', beat);
        const first = r.now();
        r.second(5, () => r.dog.beat('conn-1', beat));
        const lastBeat = r.now();
        r.second(9);
        r.dog.dropped('conn-1');
        const droppedAt = r.now();
        r.second(10);
        expect(r.records).toHaveLength(1);
        expect(r.records[0]).toMatchObject({
            kind: 'lost',
            windowPid: 4242,
            window: { pid: 4242, firstBeatAt: new Date(first).toISOString(), route: 'genie://AlphaR/liftpoint/lift', heapMb: 3100, heapLimitMb: 4096, silentMsBeforeDrop: droppedAt - lastBeat },
        });
    });

    it('a window genie-host started itself: the exit code and signal it saw', () => {
        const r = rig({ alive: () => false, exitOf: (pid) => (pid === 4242 ? { code: null, signal: 'SIGKILL' } : null) });
        r.dog.beat('conn-1', beat);
        r.dog.dropped('conn-1');
        r.second(10);
        expect(r.records[0]).toMatchObject({ kind: 'lost', exit: { code: null, signal: 'SIGKILL', seenBy: 'genie-host' } });
    });

    it('a window the person started: its own exit record, written since it first beat', () => {
        const since: number[] = [];
        const r = rig({ alive: () => false, ownExit: (pid, from) => { since.push(from); return pid === 4242 ? { reason: 'exit', code: 7 } : null; } });
        r.dog.beat('conn-1', beat);
        const first = r.now();
        r.dog.dropped('conn-1');
        r.second(10);
        expect(r.records[0]).toMatchObject({ kind: 'lost', exit: { code: 7, signal: null, seenBy: 'window', reason: 'exit' } });
        expect(since).toEqual([first]);
    });

    it('CONTROL: neither seen: no exit, and the record says what that leaves', () => {
        const r = rig({ alive: () => false, exitOf: () => null, ownExit: () => null });
        r.dog.beat('conn-1', beat);
        r.dog.dropped('conn-1');
        r.second(10);
        const record = r.records[0] as Extract<CrashRecord, { kind: 'lost' }>;
        expect(record.exit).toBeNull();
        expect(record.exitUnseen).toMatch(/exit handlers never ran/);
    });

    it('an older window’s beat (pid and RSS only) still makes a lost record, its window fields unknown', () => {
        const r = rig({ alive: () => false });
        r.dog.beat('conn-1', { pid: 4242, rss: 700 * MB });
        r.dog.dropped('conn-1');
        r.second(10);
        expect(r.records[0]).toMatchObject({ kind: 'lost', window: { pid: 4242, route: null, heapMb: null, heapLimitMb: null } });
    });
});
