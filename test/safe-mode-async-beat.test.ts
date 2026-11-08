import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ALIVE_FILE, ALIVE_PREV_FILE, parseAlive } from '../src/core/safe-mode.js';
import { SafeMode } from '../src/main/safe-mode-host.js';

/*
 * genie-host's SAFE-MODE BEAT, WRITTEN OFF ITS THREAD (Tynn #538). The UI-lag row's host profile on the Windows runner
 * (genie#1720, run 42474191753): genie-host late 233 ms, its stack writeFileSync < SafeMode #writeAtomic < beat. Every beat
 * wrote two files synchronously on the host's thread. With `asyncBeat` (genie-host's), a beat returns at once and its
 * files are written in order (the previous record, then the current, each atomically); beats that come while one is being
 * written are folded into the latest. And a host killed at any moment, mid-write included, leaves a record the next start
 * reads.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const runtimeDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'safe-mode-async-')); dirs.push(d); return d; };
const read = (dir: string, name: string) => { try { return parseAlive(readFileSync(join(dir, name), 'utf8')); } catch { return null; } };

describe('the beat, off the host\'s thread', () => {
    it('returns before anything is written; its record is there once written', async () => {
        const dir = runtimeDir();
        const mode = SafeMode.open(dir, { now: () => 1_000, pid: 11, asyncBeat: true });
        mode.beat(['agent_a']);
        // Nothing written on the caller's thread: the record is not there yet.
        expect(read(dir, ALIVE_FILE)).toBeNull();
        await mode.flush();
        expect(read(dir, ALIVE_FILE)).toMatchObject({ pid: 11, agents: ['agent_a'] });
    });

    it('beats while one is written are folded into the latest; the previous record is the one written before it', async () => {
        const dir = runtimeDir();
        const mode = SafeMode.open(dir, { now: () => 1_000, pid: 11, asyncBeat: true });
        mode.beat(['a']);
        mode.beat(['b']);
        mode.beat(['c']);
        await mode.flush();
        expect(read(dir, ALIVE_FILE)?.agents).toEqual(['c']);
        expect(read(dir, ALIVE_PREV_FILE)?.agents).toEqual(['a']);
        // Each write atomic: no temporary file is left.
        expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('CONTROL: without asyncBeat (the no-host window), a beat is written before it returns, as before', () => {
        const dir = runtimeDir();
        SafeMode.open(dir, { now: () => 1_000, pid: 11 }).beat(['agent_a']);
        expect(read(dir, ALIVE_FILE)?.agents).toEqual(['agent_a']);
    });
});

describe('a host killed mid-write leaves a record the next start reads', () => {
    it('killed outright 12 times while beating without pause: every time, a whole record is there, and the next start reads its agents', async () => {
        const dir = runtimeDir();
        const fixture = fileURLToPath(new URL('./fixtures/safe-mode-beater.ts', import.meta.url));
        for (let i = 0; i < 12; i += 1) {
            const child = spawn(process.execPath, ['--import', 'tsx', fixture, dir], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
            await new Promise<void>((resolve, reject) => {
                let said = '';
                child.stdout!.on('data', (d: Buffer) => { said += d.toString('utf8'); if (said.includes('BEATING')) resolve(); });
                child.once('exit', (code) => reject(new Error(`the beater ended by itself (${code})`)));
            });
            // Somewhere in its stream of writes: never the same moment twice.
            await new Promise((r) => setTimeout(r, 40 + ((i * 37) % 160)));
            const gone = new Promise((r) => child.once('exit', r));
            child.kill('SIGKILL');
            await gone;
            const alive = read(dir, ALIVE_FILE) ?? read(dir, ALIVE_PREV_FILE);
            expect(alive, `kill ${i + 1}: no readable record`).not.toBeNull();
            expect(alive!.agents.length).toBeGreaterThan(0);
            // And the next start, reading what was left, offers those agents (no clean exit: safe mode).
            const next = SafeMode.open(dir, { now: () => Date.now(), pid: 99 });
            expect(next.view()).toMatchObject({ active: true });
            expect(next.view().agents.length).toBeGreaterThan(0);
            next.writeCleanExit('test');
            // CONTROL: the beater got far enough to write a record of its own (not only the boot's).
            expect(existsSync(join(dir, ALIVE_FILE))).toBe(true);
        }
    }, 120_000);
});
