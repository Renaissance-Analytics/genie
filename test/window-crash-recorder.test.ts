import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { CrashRecord } from '../src/core/crash-record.js';
import { WindowCrashRecorder, startHeartbeat, type WindowBeat } from '../src/main/window-crash-recorder.js';

/**
 * WINDOW MAIN'S LAST-KNOWN STATE (Tynn story #386). The third crash on 2026-11-06 was a sudden death with no hang: a
 * 26 s gap, no Windows event, no dump. So evidence has to exist BEFORE the end, and every exit path window main can catch
 * writes a small record `{ kind: 'exit', reason, code, at, rssMb, agents }` — synchronously, never throwing, no content.
 */

const MB = 1024 * 1024;

function rig(options: { agents?: () => string[]; failWrite?: boolean } = {}) {
    const written: Array<{ file: string; record: CrashRecord }> = [];
    const removed: string[] = [];
    let n = 0;
    const recorder = new WindowCrashRecorder({
        now: () => Date.UTC(2026, 10, 6, 10, 0, 0, 0),
        pid: 4242,
        rss: () => 640 * MB,
        agents: options.agents ?? (() => ['tynn', 'tynn-slave']),
        write: (record) => {
            if (options.failWrite) throw new Error('disk full');
            const file = `f${++n}`;
            written.push({ file, record });
            return file;
        },
        remove: (file) => { removed.push(file); },
    });
    const proc = new EventEmitter();
    const app = new EventEmitter();
    recorder.install(proc, app);
    return { recorder, proc, app, written, removed, records: () => written.map((w) => w.record) };
}

describe('every exit path window main can catch writes its record', () => {
    it('process exit with a code: kind exit, the code, the time, the last RSS and the running agents’ NAMES', () => {
        const r = rig();
        r.proc.emit('exit', 7);
        expect(r.records()).toEqual([{ kind: 'exit', at: '2026-11-06T10:00:00.000Z', pid: 4242, reason: 'exit', code: 7, rssMb: 640, agents: ['tynn', 'tynn-slave'] }]);
    });

    it('an uncaught exception and an unhandled rejection: recorded (its type only — never its message), once each', () => {
        const r = rig();
        const SECRET = 'MESSAGE-CONTENT-SECRET-1d2e';
        r.proc.emit('uncaughtException', new TypeError(SECRET));
        r.proc.emit('uncaughtException', new TypeError(SECRET));
        r.proc.emit('unhandledRejection', new RangeError(SECRET), Promise.resolve());
        expect(r.records().map((x) => x.kind === 'exit' ? `${x.reason}:${x.error ?? ''}` : x.kind)).toEqual(['uncaught-exception:TypeError', 'unhandled-rejection:RangeError']);
        expect(JSON.stringify(r.records())).not.toContain(SECRET);
    });

    it('a renderer or the GPU gone: recorded with its type and reason; a clean exit of a child is not a crash', () => {
        const r = rig();
        r.app.emit('render-process-gone', {}, {}, { reason: 'crashed', exitCode: -1073741819 });
        r.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'oom', exitCode: 5 });
        r.app.emit('child-process-gone', {}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 });
        expect(r.records().map((x) => (x.kind === 'exit' ? [x.reason, x.code] : x.kind))).toEqual([
            ['render-process-gone:renderer:crashed', -1073741819],
            ['child-process-gone:GPU:oom', 5],
        ]);
    });

    it('before-quit writes the last-known state FIRST; a quit that finishes cleanly takes it back and writes no exit', () => {
        const r = rig();
        r.recorder.beforeQuit();
        r.recorder.beforeQuit();
        expect(r.records().map((x) => (x.kind === 'exit' ? x.reason : x.kind))).toEqual(['before-quit']);
        r.recorder.cleanQuit();
        expect(r.removed).toEqual(['f1']);
        r.proc.emit('exit', 0);
        expect(r.records()).toHaveLength(1);
    });

    it('CONTROL: a quit that never finished cleanly keeps its before-quit record, and its exit is recorded too', () => {
        const r = rig();
        r.recorder.beforeQuit();
        r.proc.emit('exit', 0);
        expect(r.removed).toEqual([]);
        expect(r.records().map((x) => (x.kind === 'exit' ? `${x.reason}:${x.code}` : x.kind))).toEqual(['before-quit:null', 'exit:0']);
    });

    it('never throws: a write that fails, or agents that cannot be read, leaves the exit path running', () => {
        const r = rig({ failWrite: true, agents: () => { throw new Error('registry gone'); } });
        expect(() => r.proc.emit('exit', 1)).not.toThrow();
        expect(() => r.proc.emit('uncaughtException', new Error('x'))).not.toThrow();
        expect(() => r.recorder.beforeQuit()).not.toThrow();
        const ok = rig({ agents: () => { throw new Error('registry gone'); } });
        ok.proc.emit('exit', 2);
        expect(ok.records()).toEqual([expect.objectContaining({ reason: 'exit', code: 2, agents: [] })]);
    });
});

describe('the heartbeat window main sends genie-host', () => {
    it('every second, no reply wanted: its pid and its own RSS; bye says the quit was clean and stops it', () => {
        const sent: WindowBeat[] = [];
        let tick: (() => void) | null = null;
        const beat = startHeartbeat({ send: (b) => sent.push(b), pid: 4242, rss: () => 512 * MB, every: (fn, ms) => { expect(ms).toBe(1000); tick = fn; return () => { tick = null; }; } });
        // The first beat goes at once: the host watches a window from its first beat.
        expect(sent).toEqual([{ pid: 4242, rss: 512 * MB }]);
        tick!();
        tick!();
        expect(sent).toHaveLength(3);
        beat.bye();
        expect(sent[3]).toEqual({ pid: 4242, rss: 512 * MB, bye: true });
        expect(tick).toBeNull();
    });

    it('a send that throws (the link down) never escapes the timer', () => {
        let tick: (() => void) | null = null;
        startHeartbeat({ send: () => { throw new Error('not connected'); }, pid: 1, rss: () => 1, every: (fn) => { tick = fn; return () => { tick = null; }; } });
        expect(() => tick!()).not.toThrow();
    });
});
