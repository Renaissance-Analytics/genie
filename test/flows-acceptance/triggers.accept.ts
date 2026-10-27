import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultConfigFor, getNodeKind } from '@particle-academy/fancy-flow/engine';
import { describe, expect, it } from 'vitest';
import { flowSummary } from '../../src/core/flow-canvas.js';
import { flowReach } from '../../src/core/flow-reach.js';
import { SCHEDULE_PRESETS, nextRunWords } from '../../src/core/flow-schedule.js';
import { arm, disarm, edge, kindCase, nextRun, node, runNow, runsOf, save, TestClock, useGenie, WS, type Genie } from './harness.js';

/**
 * EVERY TRIGGER, END TO END (the owner, 2026-10-27). Each flow is saved the way the canvas saves it, armed the way the
 * person arms it, and started by the thing that starts it in Genie: the person's Run now, the scheduler's one timer on a
 * real `setTimeout` (its "now" set by the test, its timer not faked), and a file landing in a real folder under the real
 * recursive watch. What each run did is read from the run Genie recorded.
 */

/** A Schedule node as the PALETTE drops it — the kind's own defaults, which the canvas fills in — with the person's cron. */
function scheduleNode(id: string, cron: string, extra: Record<string, unknown> = {}) {
    return node(id, '@particle-academy/schedule_trigger', { ...defaultConfigFor(getNodeKind('@particle-academy/schedule_trigger')!), cron, ...extra });
}
const logStep = (id: string, message: string, x = 240) => node(id, '@particle-academy/log', { level: 'info', message }, x);
const local = (y: number, m: number, d: number, h: number, min: number, s = 0) => new Date(y, m - 1, d, h, min, s).getTime();

describe('Manual: the person’s Run now', () => {
    const genie = useGenie();

    kindCase('@particle-academy/manual_trigger', 'Run now runs a flow that is NOT armed, recorded as manual, and its steps get what fired', genie, async () => {
        const g = genie();
        const id = await save(g, 'by hand', [node('t', '@particle-academy/manual_trigger'), logStep('l', 'started at {{ $json.firedAt }}')], [edge('t', 'l')]);
        expect(g.services.flows.get(id)!.armed).toBe(false);
        const run = await runNow(g, id);
        expect(run).toMatchObject({ trigger: 'manual', outcome: 'ran', nodes: { t: 'ran', l: 'ran' } });
        expect(run.log).toEqual([expect.stringMatching(/^started at \d{4}-\d\d-\d\dT/)]);
    });

    it('a second Run now while the first is still going is HELD, never a second copy beside it', async () => {
        const g = genie();
        const id = await save(g, 'slow', [node('t', '@particle-academy/manual_trigger'), node('w', '@particle-academy/wait', { mode: 'duration', duration: '1s' }, 240), logStep('l', 'done', 480)], [edge('t', 'w'), edge('w', 'l')]);
        // `runNow` resolves with the NEXT run recorded for the flow, and the held one is recorded first: the first run's own
        // record is read from the store.
        void runNow(g, id).catch(() => {});
        await new Promise((r) => setTimeout(r, 100));
        const second = await runNow(g, id);
        expect(second).toMatchObject({ trigger: 'manual', outcome: 'held', reason: 'the previous run of "slow" is still going; this one was not started beside it' });
        const runs = await runsOf(g, id, 2);
        expect(runs.map((r) => r.outcome)).toEqual(['held', 'ran']);
        expect(runs[1]).toMatchObject({ log: ['done'] });
    });
});

describe('Schedule: the scheduler’s timer fires an armed flow', () => {
    const clock = new TestClock();
    // Each test starts minutes from any schedule here being due, so nothing fires before the test puts the clock there.
    const genie = useGenie(() => { clock.set(local(2026, 10, 27, 10, 2, 30)); return { clock }; });

    /** Arm, then put the clock `leadMs` before `due` and let the scheduler plan from there. */
    async function armAt(g: Genie, flowId: string, due: number, leadMs = 400): Promise<void> {
        await arm(g, flowId);
        clock.set(due - leadMs);
        g.services.flowScheduler.plan();
    }

    kindCase('@particle-academy/schedule_trigger', 'a Schedule dropped from the palette fires at its minute in THIS MACHINE’S LOCAL TIME, once, and hands the step the cron that fired', genie, async () => {
        const g = genie();
        const id = await save(g, 'nightly', [scheduleNode('t', '0 3 * * *'), logStep('l', 'fired {{ $json.cron }} ({{ $json.timezone }})')], [edge('t', 'l')]);
        const due = local(2026, 10, 27, 3, 0);
        await armAt(g, id, due);
        // What the inspector promises (nextRunWords, local time) and what the scheduler plans are the same instant.
        expect(g.services.flowScheduler.nextDue()).toEqual({ flowId: id, at: due });
        expect(flowReach(g.services.flows.get(id)!.document, clock.now()).schedule?.nextMs).toBe(due);
        const run = await nextRun(g, id);
        expect(run).toMatchObject({ trigger: 'schedule', outcome: 'ran', nodes: { t: 'ran', l: 'ran' }, log: ['fired 0 3 * * * (local)'] });
        // The timer was planned again, for the next day's 03:00 — local, across nothing.
        expect(g.services.flowScheduler.nextDue()).toEqual({ flowId: id, at: local(2026, 10, 28, 3, 0) });
    });

    it('each preset: the label it is listed under and the next run the scheduler plans (local time), and one fires for real', async () => {
        const g = genie();
        // Saturday 31 October 2026, 08:59:30 local.
        const now = local(2026, 10, 31, 8, 59, 30);
        const expected: Record<string, number> = {
            '*/15 * * * *': local(2026, 10, 31, 9, 0),
            '0 * * * *': local(2026, 10, 31, 9, 0),
            '0 3 * * *': local(2026, 11, 1, 3, 0),
            '0 9 * * *': local(2026, 10, 31, 9, 0),
            '0 9 * * 1-5': local(2026, 11, 2, 9, 0),
            '0 9 * * 1': local(2026, 11, 2, 9, 0),
        };
        expect(Object.keys(expected).sort()).toEqual(SCHEDULE_PRESETS.map((p) => p.cron).sort());
        const ids = new Map<string, string>();
        for (const preset of SCHEDULE_PRESETS) {
            const id = await save(g, preset.label, [scheduleNode('t', preset.cron), logStep('l', '{{ $json.cron }}')], [edge('t', 'l')]);
            ids.set(preset.cron, id);
            expect(flowSummary(g.services.flows.get(id)!.document, now).trigger).toBe(preset.label);
            expect(nextRunWords(preset.cron, now)).toMatch(/^Next run: /);
        }
        for (const preset of SCHEDULE_PRESETS) {
            const id = ids.get(preset.cron)!;
            await arm(g, id);
            clock.set(now);
            g.services.flowScheduler.plan();
            expect(g.services.flowScheduler.nextDue(), preset.label).toEqual({ flowId: id, at: expected[preset.cron] });
            await disarm(g, id);
        }
        const every15 = ids.get('*/15 * * * *')!;
        await armAt(g, every15, local(2026, 10, 31, 9, 0));
        expect(await nextRun(g, every15)).toMatchObject({ trigger: 'schedule', outcome: 'ran', log: ['*/15 * * * *'] });
    });

    it('daylight saving, spring forward: 02:30 does not exist on 8 March, so it runs at 03:30 — once — and at 02:30 the next day', async () => {
        const g = genie();
        const id = await save(g, 'spring', [scheduleNode('t', '30 2 * * *', { timezone: 'America/New_York' }), logStep('l', 'ran')], [edge('t', 'l')]);
        const due = Date.parse('2026-03-08T07:30:00Z'); // 03:30 EDT
        await armAt(g, id, due);
        expect(g.services.flowScheduler.nextDue()).toEqual({ flowId: id, at: due });
        expect(await nextRun(g, id)).toMatchObject({ trigger: 'schedule', outcome: 'ran' });
        expect(g.services.flowScheduler.nextDue()).toEqual({ flowId: id, at: Date.parse('2026-03-09T06:30:00Z') });
        expect(g.services.flows.get(id)!.runs).toHaveLength(1);
    });

    it('daylight saving, fall back: 01:30 happens twice on 1 November; it runs at the FIRST only, then the next day', async () => {
        const g = genie();
        const id = await save(g, 'autumn', [scheduleNode('t', '30 1 * * *', { timezone: 'America/New_York' }), logStep('l', 'ran')], [edge('t', 'l')]);
        const first = Date.parse('2026-11-01T05:30:00Z'); // 01:30 EDT
        await armAt(g, id, first);
        expect(await nextRun(g, id)).toMatchObject({ trigger: 'schedule', outcome: 'ran' });
        // Not 06:30Z (01:30 EST, the repeated hour): the next day's 01:30 EST.
        expect(g.services.flowScheduler.nextDue()).toEqual({ flowId: id, at: Date.parse('2026-11-02T06:30:00Z') });
    });

    it('at one instant every ARMED flow due runs; a flow never armed, and one disarmed, do not', async () => {
        const g = genie();
        const make = (name: string) => save(g, name, [scheduleNode('t', '*/5 * * * *'), logStep('l', name)], [edge('t', 'l')]);
        const a = await make('a');
        const b = await make('b');
        const never = await make('never armed');
        const off = await make('disarmed');
        await arm(g, off);
        await disarm(g, off);
        await arm(g, b);
        const due = local(2026, 10, 27, 10, 5);
        await armAt(g, a, due);
        const [ra, rb] = await Promise.all([nextRun(g, a), nextRun(g, b)]);
        expect(ra).toMatchObject({ trigger: 'schedule', outcome: 'ran', log: ['a'] });
        expect(rb).toMatchObject({ trigger: 'schedule', outcome: 'ran', log: ['b'] });
        await new Promise((r) => setTimeout(r, 500));
        expect(g.services.flows.get(never)!.runs).toEqual([]);
        expect(g.services.flows.get(off)!.runs).toEqual([]);
    });
});

describe('A file is added: a file landing in the workspace starts the armed flows it matches', () => {
    const genie = useGenie();
    const fileFlow = (g: Genie, name: string, trigger: Record<string, unknown>) =>
        save(g, name, [node('t', 'genie/file_added', { workspace: WS, ...trigger }), logStep('l', 'got {{ $json.relPath }} ({{ $json.sizeBytes }} bytes)')], [edge('t', 'l')]);
    /** Arm, and give the recursive watch a moment to be in place. */
    const armWatched = async (g: Genie, id: string) => { await arm(g, id); await new Promise((r) => setTimeout(r, 300)); };
    /** Long enough for a settle (250 ms per reading) and the de-duplication window (500 ms) to have passed twice. */
    const quiet = () => new Promise((r) => setTimeout(r, 1500));
    const write = async (g: Genie, rel: string, content: string | Buffer) => { await mkdir(join(g.ws, rel, '..'), { recursive: true }); await writeFile(join(g.ws, rel), content); };
    const files = (g: Genie, id: string) => g.services.flows.get(id)!.runs.map((r) => r.file).sort();

    kindCase('genie/file_added', 'a file landing in the workspace runs the flow once, as a file run naming it, and the steps get the file', genie, async () => {
        const g = genie();
        const id = await fileFlow(g, 'any file', {});
        await armWatched(g, id);
        await write(g, 'inbox/report.txt', 'hello');
        const [run] = await runsOf(g, id, 1);
        expect(run).toMatchObject({ trigger: 'file', file: 'inbox/report.txt', outcome: 'ran', nodes: { t: 'ran', l: 'ran' }, log: ['got inbox/report.txt (5 bytes)'] });
    });

    it('folder: only a file inside the folder (CONTROL: one outside it, written first)', async () => {
        const g = genie();
        const id = await fileFlow(g, 'inbox only', { folder: 'inbox' });
        await armWatched(g, id);
        await write(g, 'other/a.txt', 'a');
        await write(g, 'inbox/deep/b.txt', 'b');
        await runsOf(g, id, 1);
        await quiet();
        expect(files(g, id)).toEqual(['inbox/deep/b.txt']);
    });

    it('extensions: case and a leading dot ignored; another extension does not start it', async () => {
        const g = genie();
        const id = await fileFlow(g, 'images', { extensions: 'png, .JPG' });
        await armWatched(g, id);
        await write(g, 'a.txt', 'a');
        await write(g, 'b.png', 'b');
        await write(g, 'c.jpg', 'c');
        await runsOf(g, id, 2);
        await quiet();
        expect(files(g, id)).toEqual(['b.png', 'c.jpg']);
    });

    it('minimum size: read once the file stops growing — a file written in pieces past the minimum fires; a small one does not', async () => {
        const g = genie();
        const id = await fileFlow(g, 'big', { minSizeBytes: 1000 });
        await armWatched(g, id);
        await write(g, 'small.bin', Buffer.alloc(10));
        await write(g, 'grow.bin', Buffer.alloc(0));
        for (let i = 0; i < 4; i++) {
            await new Promise((r) => setTimeout(r, 40));
            await appendFile(join(g.ws, 'grow.bin'), Buffer.alloc(500));
        }
        const [run] = await runsOf(g, id, 1);
        expect(run).toMatchObject({ file: 'grow.bin', log: ['got grow.bin (2000 bytes)'] });
        await quiet();
        expect(files(g, id)).toEqual(['grow.bin']);
    });

    it('de-duplication: one file created in several writes is ONE run', async () => {
        const g = genie();
        const id = await fileFlow(g, 'once', {});
        await armWatched(g, id);
        await write(g, 'notes.md', '# notes\n');
        for (let i = 0; i < 5; i++) await appendFile(join(g.ws, 'notes.md'), `line ${i}\n`);
        await runsOf(g, id, 1);
        await quiet();
        expect(files(g, id)).toEqual(['notes.md']);
    });

    it('a file the flow MOVES does not start it again where it lands (CONTROL: the first run moved it)', async () => {
        const g = genie();
        const id = await save(g, 'bins out', [
            node('t', 'genie/file_added', { workspace: WS, extensions: 'bin' }),
            node('m', 'genie/file_move', { workspace: WS, from: '{{in.path}}', to: '.untracked' }, 240),
        ], [edge('t', 'm')]);
        await armWatched(g, id);
        await write(g, 'uploads/big.bin', Buffer.alloc(64));
        const [run] = await runsOf(g, id, 1);
        expect(run).toMatchObject({ trigger: 'file', file: 'uploads/big.bin', outcome: 'ran' });
        expect(existsSync(join(g.ws, '.untracked', 'big.bin'))).toBe(true);
        expect(existsSync(join(g.ws, 'uploads', 'big.bin'))).toBe(false);
        await quiet();
        expect(files(g, id)).toEqual(['uploads/big.bin']);
    });

    it('a DISARMED flow never runs, and .git / node_modules / vendor are never a file being added (CONTROL: the armed flow runs for the real one)', async () => {
        const g = genie();
        const on = await fileFlow(g, 'armed', { extensions: 'log' });
        const off = await fileFlow(g, 'not armed', { extensions: 'log' });
        await armWatched(g, on);
        await write(g, 'node_modules/pkg/x.log', 'x');
        await write(g, 'vendor/y.log', 'y');
        await write(g, 'app.log', 'z');
        await runsOf(g, on, 1);
        await quiet();
        expect(files(g, on)).toEqual(['app.log']);
        expect(g.services.flows.get(off)!.runs).toEqual([]);
    });
});
