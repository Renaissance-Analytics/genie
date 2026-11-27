import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STOP_PROGRESS_FILE, stopProgress, type StopProgressRecord } from '../src/core/stop-progress.js';

/*
 * TYNN #1079: "Shut down everything" ended genie-host 5 s in while it was still stopping 122 processes, so the host never
 * wrote its clean-exit marker and its next boot read a crash. The launcher now waits as long as the host's stop keeps
 * moving (native/launcher/src/host.rs, tests/control.rs "a slow but clean stop"); the host says its progress in
 * `<runtime>/host-stopping.json` at each step of its shutdown and as its processes go.
 */
function recorder() {
    const writes: { file: string; record: StopProgressRecord }[] = [];
    let t = 1000;
    const progress = stopProgress(join('home', '.genie', 'runtime'), { pid: 77, now: () => (t += 5), write: (file, text) => { writes.push({ file, record: JSON.parse(text) as StopProgressRecord }); } });
    return { progress, writes };
}

describe('the host says its stop as it goes', () => {
    it('each step is written whole to <runtime>/host-stopping.json: the pid, the step, what is left in it, when', () => {
        const { progress, writes } = recorder();
        progress.step('agents', 3);
        progress.step('processes', 122);
        progress.step('processes', 121);
        progress.step('hosting');
        expect(writes.map((w) => w.file)).toEqual(Array(4).fill(join('home', '.genie', 'runtime', STOP_PROGRESS_FILE)));
        expect(writes.map((w) => [w.record.pid, w.record.step, w.record.remaining])).toEqual([[77, 'agents', 3], [77, 'processes', 122], [77, 'processes', 121], [77, 'hosting', 0]]);
        expect(writes[3]!.record.at).toBeGreaterThan(writes[0]!.record.at);
    });

    it('the same step with the same count left is not written again: progress is change, never a clock', () => {
        const { progress, writes } = recorder();
        progress.step('processes', 5);
        progress.step('processes', 5);
        progress.step('processes', 5);
        progress.step('processes', 4);
        expect(writes.map((w) => w.record.remaining)).toEqual([5, 4]);
    });

    it('genie-host says it at every step of its shutdown, and as its kept processes go', () => {
        const src = readFileSync(join(__dirname, '..', 'src', 'main', 'genie-host.ts'), 'utf8');
        const body = src.slice(src.indexOf('async function shutdown(why: string)'));
        const shutdown = body.slice(0, body.indexOf('\n    }\n'));
        for (const step of ['agents', 'terminals', 'processes', 'hosting', 'exit']) expect(shutdown, step).toContain(`'${step}'`);
        expect(shutdown).toMatch(/stopping\.step\(/);
        // The kept processes are counted while they stop: one fewer is progress.
        expect(src).toMatch(/onStopProgress|processesLeft/);
    });
});
