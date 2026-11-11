import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openLifecycleLog } from '../src/main/lifecycle-log.js';

/*
 * genie-host's LIFECYCLE LOG, WRITTEN OFF ITS THREAD (Tynn #548). Profiled on genie#1709's Windows real-window run: one
 * genie-host gap of 537.8 ms was 546 ms inside appendFileSync (src/main/lifecycle-log.ts), during a write-heavy build —
 * the class of #538 (the safe-mode beat). With `async` (genie-host's), a line is queued and the call returns; lines are
 * written in order, a rotation included; an exit — process.exit or an uncaught error — writes every line queued before
 * it; and a host killed outright leaves only whole lines, in order, a prefix of what it logged.
 */
type AsyncLog = ((line: string) => void) & { flush(): Promise<void> };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const runtimeDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'lifelog-async-')); dirs.push(d); return d; };
const open = (dir: string, over: Record<string, unknown> = {}) => openLifecycleLog(dir, { now: () => 0, async: true, ...over } as never) as unknown as AsyncLog;
const text = (dir: string, name = 'lifecycle.log') => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
const seqs = (body: string): number[] => body.split('\n').filter(Boolean).map((l) => Number(/ seq=(\d+)/.exec(l)?.[1] ?? NaN));
const fixture = fileURLToPath(new URL('./fixtures/lifecycle-logger.ts', import.meta.url));
const run = (dir: string, ...args: string[]) => spawn(process.execPath, ['--import', 'tsx', fixture, dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

describe('the lifecycle log, off the host\'s thread', () => {
    it('returns before anything is written; the line is there once flushed', async () => {
        const dir = runtimeDir();
        const log = open(dir);
        log('host boot pid=1');
        // Nothing written on the caller's thread.
        expect(text(dir)).toBe('');
        expect(typeof log.flush).toBe('function');
        await log.flush();
        expect(text(dir)).toBe('1970-01-01T00:00:00.000Z host boot pid=1\n');
    });

    it('many lines, logged in one go, are written in order and every one of them, across a rotation', async () => {
        const dir = runtimeDir();
        const log = open(dir, { maxBytes: 4_000 });
        for (let n = 1; n <= 300; n += 1) log(`seq=${n} ${'z'.repeat(n % 41)}`);
        await log.flush();
        const all = [...seqs(text(dir, 'lifecycle.log.1')), ...seqs(text(dir))];
        // Rotated (the older lines in .1), and what is left of the run is whole and in order.
        expect(existsSync(join(dir, 'lifecycle.log.1'))).toBe(true);
        expect(all).toEqual(Array.from({ length: all.length }, (_, i) => 300 - all.length + 1 + i));
        expect(all.at(-1)).toBe(300);
    });

    it('CONTROL: without async (the window), a line is written before the call returns, as before', () => {
        const dir = runtimeDir();
        openLifecycleLog(dir, { now: () => 0 })('host boot pid=1');
        expect(text(dir)).toBe('1970-01-01T00:00:00.000Z host boot pid=1\n');
    });
});

describe('an exit writes every line queued before it', () => {
    it('process.exit right after logging 500 lines: all 500 are there, in order', async () => {
        const dir = runtimeDir();
        const child = run(dir, 'exit', '500');
        expect(await new Promise((r) => child.once('exit', r))).toBe(0);
        expect(seqs(text(dir))).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    }, 60_000);

    it('an uncaught error right after logging 200 lines: all 200 are there, in order', async () => {
        const dir = runtimeDir();
        const child = run(dir, 'throw', '200');
        expect(await new Promise((r) => child.once('exit', r))).not.toBe(0);
        expect(seqs(text(dir))).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    }, 60_000);
});

/*
 * A WRITE CUT BY A KILL (the coordinator, C3's CI run: kill 11 left a torn last line). A write to a file is NOT atomic
 * against SIGKILL: the kernel copies it a page at a time and stops at a fatal signal, so a batch can be cut mid-line on any
 * page boundary, whatever its size. What a kill can leave is mended where it can be: when the log is next opened (the next
 * host start), a last line without its newline is the cut tail of a write that never finished, and it is dropped before
 * anything is written after it. So the file the next start reads, and writes to, holds whole lines only.
 */
describe('a cut tail is mended when the log is next opened', () => {
    it.each([true, false])('async=%s: a last line without its newline is dropped before the first new line; the rest is kept', async (async) => {
        const dir = runtimeDir();
        const whole = '2026-11-08T12:00:00.000Z seq=1 x\n2026-11-08T12:00:00.001Z seq=2 xx\n';
        writeFileSync(join(dir, 'lifecycle.log'), `${whole}2026-11-08T12:00:00.002Z seq=3 xx`);
        const log = openLifecycleLog(dir, { now: () => 0, ...(async ? { async: true } : {}) } as never) as unknown as AsyncLog;
        log('host boot pid=2');
        await log.flush?.();
        expect(text(dir)).toBe(`${whole}1970-01-01T00:00:00.000Z host boot pid=2\n`);
    });

    it('CONTROL: a log that ends whole is not touched', async () => {
        const dir = runtimeDir();
        const whole = '2026-11-08T12:00:00.000Z seq=1 x\n';
        writeFileSync(join(dir, 'lifecycle.log'), whole);
        const log = open(dir);
        log('host boot pid=2');
        await log.flush();
        expect(text(dir)).toBe(`${whole}1970-01-01T00:00:00.000Z host boot pid=2\n`);
    });
});

describe('a host killed outright leaves whole lines, in order, once the next start opens the log', () => {
    it('killed 12 times while logging in fast bursts: every time, after the next start, only whole lines, a prefix of what it logged', async () => {
        for (let i = 0; i < 12; i += 1) {
            const dir = runtimeDir();
            const child = run(dir, 'stream');
            await new Promise<void>((resolve, reject) => {
                let said = '';
                child.stdout!.on('data', (d: Buffer) => { said += d.toString('utf8'); if (said.includes('LOGGING')) resolve(); });
                child.once('exit', (code) => reject(new Error(`the logger ended by itself (${code})`)));
            });
            // Only once a batch has reached the file: a kill before the first write leaves nothing, and proves nothing.
            const file = join(dir, 'lifecycle.log');
            for (const end = Date.now() + 30_000; Date.now() < end && !(existsSync(file) && statSync(file).size > 0);) await new Promise((r) => setTimeout(r, 5));
            // Somewhere in its stream of writes: never the same moment twice.
            await new Promise((r) => setTimeout(r, 40 + ((i * 37) % 160)));
            const gone = new Promise((r) => child.once('exit', r));
            child.kill('SIGKILL');
            await gone;
            // The next start opens the log and writes its first line.
            const next = open(dir);
            next('host boot pid=2');
            await next.flush();
            // The rotated file (past 1 MiB) and the current one, read as one run.
            const rotated = text(dir, 'lifecycle.log.1');
            const body = text(dir);
            // Whole lines only: the file ends with the next start's line, and every line before it is a stamped, numbered line.
            expect(body.endsWith('1970-01-01T00:00:00.000Z host boot pid=2\n'), `kill ${i + 1}: the next start's line is not whole and last`).toBe(true);
            const logged = `${rotated}${body}`.split('\n').filter(Boolean).slice(0, -1);
            for (const line of logged) expect(line, `kill ${i + 1}`).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z seq=\d+ x*$/);
            const got = logged.map((l) => Number(/ seq=(\d+)/.exec(l)?.[1] ?? NaN));
            // CONTROL: it got far enough to write lines at all.
            expect(got.length, `kill ${i + 1}: nothing written`).toBeGreaterThan(0);
            // In order, none missing: from 1 when nothing rotated away, else a run with no gap.
            const first = rotated === '' ? 1 : got[0]!;
            expect(got).toEqual(Array.from({ length: got.length }, (_, n) => first + n));
        }
    }, 180_000);
});

describe('genie-host writes its lifecycle log off its thread', () => {
    it('opens it with async', () => {
        const host = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8');
        expect(host).toMatch(/const lifecycleLog = openLifecycleLog\(runtime, \{ async: true \}\);/);
    });
});
