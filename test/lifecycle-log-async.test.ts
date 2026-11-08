import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

describe('a host killed outright leaves whole lines, in order', () => {
    it('killed 12 times while logging in fast bursts: every time, only whole lines, a prefix of what it logged', async () => {
        for (let i = 0; i < 12; i += 1) {
            const dir = runtimeDir();
            const child = run(dir, 'stream');
            await new Promise<void>((resolve, reject) => {
                let said = '';
                child.stdout!.on('data', (d: Buffer) => { said += d.toString('utf8'); if (said.includes('LOGGING')) resolve(); });
                child.once('exit', (code) => reject(new Error(`the logger ended by itself (${code})`)));
            });
            // Somewhere in its stream of writes: never the same moment twice.
            await new Promise((r) => setTimeout(r, 40 + ((i * 37) % 160)));
            const gone = new Promise((r) => child.once('exit', r));
            child.kill('SIGKILL');
            await gone;
            // The rotated file (past 1 MiB) and the current one, read as one run.
            const rotated = text(dir, 'lifecycle.log.1');
            const body = text(dir);
            // Whole lines only: each file ends with a newline, and every line is a stamped, numbered line.
            expect(body.endsWith('\n'), `kill ${i + 1}: a torn last line`).toBe(true);
            for (const line of `${rotated}${body}`.split('\n').filter(Boolean)) expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z seq=\d+ x*$/);
            const got = [...seqs(rotated), ...seqs(body)];
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
