import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StallWatchdog } from '../src/main/stall-watchdog.js';
import { watchRendererStalls, type StallReport } from '../src/main/renderer-stalls.js';

/**
 * A FREEZE LEAVES A TRACE (beta.53; the owner, 2026-10-31: "everything in genie was frozen for 2 or 3 minutes", and
 * lifecycle.log had nothing after the boot). The watchdog writes to the lifecycle log:
 *  - main's event loop held over 1 s, with the route on screen and the renderer requests main was in the middle of;
 *  - a renderer request (`ipcRenderer.invoke`) main took over 1 s to answer — once while it still waits, once when it ends;
 *  - an outbound HTTP call over 5 s, by host — the same two ways;
 *  - what a renderer reports about itself: a long task, or frames not presented, over 1 s;
 *  - a renderer that stopped answering, and a Chromium child process (the GPU) that went away.
 * Every "logs nothing" below sits beside the same measurement just over its threshold.
 */

function rig(route: string | null = 'genie://workspace/lag') {
    let t = 1_000_000;
    let tick: (() => void) | null = null;
    const lines: string[] = [];
    const dog = new StallWatchdog({
        log: (l) => lines.push(l),
        now: () => t,
        every: (fn) => { tick = fn; return () => { tick = null; }; },
        routeOf: () => route,
    });
    const advance = (ms: number, beat = true) => { t += ms; if (beat) tick?.(); };
    return { dog, lines, advance, started: () => tick !== null };
}

describe('main event loop held', () => {
    it('a gap of over 1 s between heartbeats is logged with how long and the route on screen; a shorter one is not', () => {
        const r = rig();
        r.dog.start();
        expect(r.started()).toBe(true);
        r.advance(200); r.advance(900);
        expect(r.lines).toEqual([]);
        r.advance(1_400);
        expect(r.lines).toHaveLength(1);
        expect(r.lines[0]).toMatch(/^stall main ms=\d+ route=genie:\/\/workspace\/lag/);
        // The gap beyond one heartbeat: 1400 - 200.
        expect(r.lines[0]).toContain('ms=1200');
    });

    it('tells whoever reads main’s stack sample (stall-profile.ts) about each block, with its length; not about a short gap', () => {
        const told: number[] = [];
        let t = 0;
        let tick: (() => void) | null = null;
        const dog = new StallWatchdog({ log: () => {}, now: () => t, every: (fn) => { tick = fn; return () => {}; }, onMainStall: (ms) => told.push(ms) });
        dog.start();
        t += 700; tick!();
        expect(told).toEqual([]);
        t += 2_200; tick!();
        expect(told).toEqual([2_000]);
    });

    it('names the renderer requests main was in the middle of when the loop was held', () => {
        const r = rig();
        r.dog.start();
        r.advance(200);
        const done = r.dog.ipc('genie:workspace-repos');
        r.advance(3_000);
        expect(r.lines.find((l) => l.startsWith('stall main'))).toMatch(/during=genie:workspace-repos/);
        done();
    });
});

describe('a renderer request main is slow to answer', () => {
    it('over 1 s: logged once while it still waits (a hang that never ends still shows), then when it ends', () => {
        const r = rig();
        r.dog.start();
        const done = r.dog.ipc('genie:snapshot');
        for (let i = 0; i < 6; i += 1) r.advance(200);
        const waiting = r.lines.filter((l) => l.startsWith('ipc waiting'));
        expect(waiting).toHaveLength(1);
        expect(waiting[0]).toMatch(/channel=genie:snapshot ms=1\d\d\d/);
        r.advance(200); r.advance(200);
        expect(r.lines.filter((l) => l.startsWith('ipc waiting'))).toHaveLength(1);
        done();
        expect(r.lines.at(-1)).toMatch(/^ipc slow channel=genie:snapshot ms=1600/);
    });

    it('under 1 s: nothing', () => {
        const r = rig();
        r.dog.start();
        const done = r.dog.ipc('genie:snapshot');
        r.advance(200); r.advance(200); r.advance(500);
        done();
        expect(r.lines).toEqual([]);
    });
});

describe('an outbound call', () => {
    it('over 5 s: the host, while it waits and when it ends; under 5 s: nothing', () => {
        const r = rig();
        r.dog.start();
        const quick = r.dog.net('tynn.ai');
        for (let i = 0; i < 21; i += 1) r.advance(200);
        quick();
        expect(r.lines).toEqual([]);
        const slow = r.dog.net('relay.tynn.ai');
        for (let i = 0; i < 26; i += 1) r.advance(200);
        expect(r.lines.filter((l) => l.startsWith('net waiting'))).toEqual([expect.stringMatching(/^net waiting host=relay\.tynn\.ai ms=5\d\d\d/)]);
        slow();
        expect(r.lines.at(-1)).toMatch(/^net slow host=relay\.tynn\.ai ms=5200/);
    });
});

describe('what a renderer reports', () => {
    it('a long task or frames not presented over 1 s, with its route and window; anything under, or malformed, is dropped', () => {
        const r = rig();
        r.dog.renderer({ kind: 'longtask', ms: 1_850, route: '#genie://dashboard?group=workspace' }, 'index');
        r.dog.renderer({ kind: 'frames', ms: 4_000, route: '#genie://workspace/lag' }, 'index');
        expect(r.lines).toEqual([
            'stall renderer kind=longtask ms=1850 window=index route=#genie://dashboard?group=workspace',
            'stall renderer kind=frames ms=4000 window=index route=#genie://workspace/lag',
        ]);
        r.dog.renderer({ kind: 'longtask', ms: 999, route: '' }, 'index');
        r.dog.renderer({ kind: 'nonsense', ms: 5_000 }, 'index');
        r.dog.renderer({ kind: 'frames', ms: 'lots' }, 'index');
        r.dog.renderer(null, 'index');
        expect(r.lines).toHaveLength(2);
    });

    it('a route is cut short and stripped of line breaks: a renderer cannot write lines of its own into the log', () => {
        const r = rig();
        r.dog.renderer({ kind: 'frames', ms: 2_000, route: `#a\nboot pid=1 ${'x'.repeat(2_000)}` }, 'index');
        expect(r.lines).toHaveLength(1);
        expect(r.lines[0]).not.toContain('\n');
        expect(r.lines[0]!.length).toBeLessThan(400);
    });
});

describe('a renderer that stops answering, a child process that goes', () => {
    it('unresponsive, then responsive with how long; a GPU process gone with its reason', () => {
        const r = rig();
        r.dog.unresponsive('index', true);
        r.advance(7_000, false);
        r.dog.unresponsive('index', false);
        r.dog.processGone({ type: 'GPU', reason: 'crashed', exitCode: -1 });
        expect(r.lines).toEqual([
            'renderer unresponsive window=index',
            'renderer responsive window=index after_ms=7000',
            'process gone type=GPU reason=crashed exit=-1',
        ]);
    });
});

describe('wired into Genie', () => {
    const main = readFileSync('src/main/main.ts', 'utf8');
    const preload = readFileSync('src/main/preload.ts', 'utf8');
    it('main starts it on the lifecycle log, times every invoke handler, and takes the renderers’ reports', () => {
        expect(main).toMatch(/new StallWatchdog\(/);
        expect(main).toMatch(/timeIpcHandlers\(/);
        expect(main).toMatch(/ipcMain\.on\('genie:renderer-stall'/);
        expect(main).toMatch(/'child-process-gone'/);
        expect(main).toMatch(/'unresponsive'/);
        expect(main).toMatch(/watchOutboundCalls\(/);
    });
    it('every window reports its long tasks and frame gaps (the preload all of them load)', () => {
        expect(preload).toMatch(/watchRendererStalls\(/);
        expect(preload).toMatch(/'genie:renderer-stall'/);
    });
});

describe('a window watching itself (renderer-stalls.ts, run by the preload)', () => {
    function page() {
        let t = 0;
        let visible = true;
        let frameCb: ((t: number) => void) | null = null;
        let longCb: ((ms: number) => void) | null = null;
        let visCb: (() => void) | null = null;
        const sent: StallReport[] = [];
        watchRendererStalls((r) => sent.push(r), {
            requestAnimationFrame: (cb) => { frameCb = cb; },
            now: () => t,
            visible: () => visible,
            route: () => '#genie://dashboard',
            observeLongTasks: (cb) => { longCb = cb; },
            onVisibilityChange: (cb) => { visCb = cb; },
        });
        return {
            sent,
            frameAfter: (ms: number) => { t += ms; const cb = frameCb; frameCb = null; cb?.(t); },
            longTask: (ms: number) => longCb?.(ms),
            hide: () => { visible = false; visCb?.(); },
            show: () => { visible = true; visCb?.(); },
        };
    }

    it('no frame for over 1 s while visible is reported; frames 16 ms apart, and a 900 ms gap, are not', () => {
        const p = page();
        p.frameAfter(16); p.frameAfter(16); p.frameAfter(900);
        expect(p.sent).toEqual([]);
        p.frameAfter(2_500);
        expect(p.sent).toEqual([{ kind: 'frames', ms: 2_500, route: '#genie://dashboard' }]);
    });

    it('a gap across a hide (no frames by design) is not a stall', () => {
        const p = page();
        p.frameAfter(16);
        p.hide();
        p.show();
        p.frameAfter(60_000);
        expect(p.sent).toEqual([]);
        p.frameAfter(1_200);
        expect(p.sent).toEqual([{ kind: 'frames', ms: 1_200, route: '#genie://dashboard' }]);
    });

    it('a long task over 1 s is reported with the route; one under is not', () => {
        const p = page();
        p.longTask(400);
        p.longTask(1_700.4);
        expect(p.sent).toEqual([{ kind: 'longtask', ms: 1_700, route: '#genie://dashboard' }]);
    });
});
