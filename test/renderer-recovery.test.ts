import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RENDERER_RELOAD_MAX, RENDERER_RELOAD_WINDOW_MS, recoverRenderer, rendererErrorPage, type RendererNotice } from '../src/main/renderer-recovery.js';
import { WindowCrashRecorder } from '../src/main/window-crash-recorder.js';
import type { CrashRecord } from '../src/core/crash-record.js';
import { UNKNOWN_HEADER } from '../src/core/crash-record.js';

/*
 * A WINDOW'S PAGE THAT DIES IS BROUGHT BACK (Tynn #386; the owner's machine, 2026-11-06 21:04:35: `process gone
 * type=renderer:index reason=oom exit=-536870904`. Main lived on, nothing reloaded the page, and the window was a black
 * rectangle for 3.5 hours). Any end of the page but a clean exit reloads it — or makes the window again if the reload
 * throws — at most 3 times in 10 minutes, the hang relaunch's cap; then a plain page with Restart Genie and Send a crash
 * report, never a dead window. Each reload leaves a notice (when, why, the page's last memory) and a crash record.
 */
function contents() {
    const e = new EventEmitter() as EventEmitter & { reloads: number; loaded: string[]; destroyed: boolean; reloadThrows: boolean };
    e.reloads = 0; e.loaded = []; e.destroyed = false; e.reloadThrows = false;
    const c = Object.assign(e, {
        reload: () => { if (e.reloadThrows) throw new Error('reload failed'); e.reloads += 1; },
        loadURL: (url: string) => { e.loaded.push(url); },
        isDestroyed: () => e.destroyed,
    });
    return c;
}
function rig() {
    let t = 1_793_000_000_000;
    const c = contents();
    const reloaded: RendererNotice[] = [];
    const gaveUp: RendererNotice[] = [];
    const lines: string[] = [];
    let recreated = 0;
    recoverRenderer({
        contents: c, now: () => t, rendererMb: () => 812,
        onReloaded: (n) => reloaded.push(n), onGaveUp: (n) => gaveUp.push(n),
        errorPage: (n) => rendererErrorPage(n), recreate: () => { recreated += 1; }, log: (l) => lines.push(l),
    });
    const gone = (reason: string) => c.emit('render-process-gone', {}, { reason, exitCode: -536870904 });
    return { c, reloaded, gaveUp, lines, gone, recreated: () => recreated, later: (ms: number) => { t += ms; }, now: () => t };
}

describe('the page that ended is brought back', () => {
    it('out of memory: the page is reloaded, with a notice that says when, why and its last memory', () => {
        const r = rig();
        r.gone('oom');
        expect(r.c.reloads).toBe(1);
        expect(r.reloaded).toEqual([{ at: r.now(), reason: 'oom', rendererMb: 812, reloads: 1 }]);
        expect(r.lines.join('\n')).toMatch(/page ended reason=oom renderer_mb=812: reloaded \(1 of 3/);
    });

    it('crashed or killed: the same; a clean exit is not an end to bring back (CONTROL)', () => {
        const r = rig();
        r.gone('clean-exit');
        expect(r.c.reloads).toBe(0);
        expect(r.reloaded).toEqual([]);
        r.gone('crashed');
        r.gone('killed');
        expect(r.c.reloads).toBe(2);
        expect(r.reloaded.map((n) => n.reason)).toEqual(['crashed', 'killed']);
    });

    it(`a reload that throws makes the window again`, () => {
        const r = rig();
        r.c.reloadThrows = true;
        r.gone('oom');
        expect(r.recreated()).toBe(1);
        expect(r.reloaded).toHaveLength(1);
    });

    it(`after ${RENDERER_RELOAD_MAX} in 10 minutes: no more reloads — a plain page with Restart Genie and Send a crash report`, () => {
        const r = rig();
        for (let i = 0; i < RENDERER_RELOAD_MAX; i++) { r.gone('oom'); r.later(60_000); }
        expect(r.c.reloads).toBe(RENDERER_RELOAD_MAX);
        r.gone('oom');
        expect(r.c.reloads).toBe(RENDERER_RELOAD_MAX);
        expect(r.gaveUp).toHaveLength(1);
        expect(r.c.loaded).toHaveLength(1);
        const page = decodeURIComponent(r.c.loaded[0]!.replace(/^data:text\/html;charset=utf-8,/, ''));
        expect(page).toContain('Restart Genie');
        expect(page).toContain('Send a crash report');
        expect(page).toContain('genie-recover:restart');
        expect(page).toContain('genie-recover:report');
    });

    it('the cap is per 10 minutes: past it, an end reloads again', () => {
        const r = rig();
        for (let i = 0; i < RENDERER_RELOAD_MAX; i++) r.gone('oom');
        r.later(RENDERER_RELOAD_WINDOW_MS + 1);
        r.gone('oom');
        expect(r.c.reloads).toBe(RENDERER_RELOAD_MAX + 1);
        expect(r.gaveUp).toEqual([]);
    });

    it('a window already gone is left alone', () => {
        const r = rig();
        r.c.destroyed = true;
        r.gone('oom');
        expect(r.c.reloads).toBe(0);
        expect(r.reloaded).toEqual([]);
    });
});

describe('the crash record says what grew', () => {
    it('render-process-gone (oom) is recorded with the page\'s last known memory', () => {
        const records: CrashRecord[] = [];
        const recorder = new WindowCrashRecorder({ pid: 9, rss: () => 300 * 1024 * 1024, agents: () => ['atlas'], write: (r) => { records.push(r); return 'f'; }, remove: () => {}, header: () => UNKNOWN_HEADER, rendererMb: () => 812 });
        const proc = new EventEmitter();
        const app = new EventEmitter();
        recorder.install(proc, app);
        app.emit('render-process-gone', {}, {}, { reason: 'oom', exitCode: -536870904 });
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ kind: 'exit', reason: 'render-process-gone:renderer:oom', rendererMb: 812 });
    });
});

describe('wired', () => {
    it('main brings back the main window\'s page, and the notice reaches every snapshot', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/recoverRenderer\(\{[^]*?contents: win\.webContents,/);
        expect(main).toMatch(/registry\.setRendererNotice\(/);
    });
});
