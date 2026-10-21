import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openLifecycleLog } from '../src/main/lifecycle-log.js';

/**
 * THE LIFECYCLE LOG (hosting plan 1.6; lifecycle review F10). The installed app wrote no log file: the sweep and the
 * refused reaps went to `console.log`, which nobody sees, so the owner's question — "did the restart leave the old
 * Claude running?" — could not be settled from evidence. Every spawn, kill, verified exit, refusal and sweep is now one
 * line in `~/.genie/runtime/lifecycle.log`, rotated.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'genie2-lifelog-')); dirs.push(d); return d; };

describe('openLifecycleLog', () => {
    it('appends one timestamped line per event, in order', () => {
        const dir = tempDir();
        const log = openLifecycleLog(dir, { now: () => Date.UTC(2026, 9, 20, 12, 0, 0) });
        log('spawn agent=agent_01 run=1 pids=100(cmd.exe),101(claude.exe)');
        log('refused agent=agent_01 run=1 reason=Refusing to reap 40 processes');
        const text = readFileSync(join(dir, 'lifecycle.log'), 'utf8');
        expect(text).toBe(
            '2026-10-20T12:00:00.000Z spawn agent=agent_01 run=1 pids=100(cmd.exe),101(claude.exe)\n' +
            '2026-10-20T12:00:00.000Z refused agent=agent_01 run=1 reason=Refusing to reap 40 processes\n',
        );
    });

    it('a line never spans lines: a newline inside an event is flattened', () => {
        const dir = tempDir();
        const log = openLifecycleLog(dir, { now: () => 0 });
        log('refused reason=one\ntwo');
        expect(readFileSync(join(dir, 'lifecycle.log'), 'utf8').trim().split('\n')).toHaveLength(1);
    });

    it('rotates past the size cap: the old log is kept as lifecycle.log.1, the new one starts empty', () => {
        const dir = tempDir();
        const log = openLifecycleLog(dir, { now: () => 0, maxBytes: 200 });
        for (let i = 0; i < 10; i++) log(`spawn agent=agent_${i} ${'x'.repeat(30)}`);
        expect(existsSync(join(dir, 'lifecycle.log.1'))).toBe(true);
        expect(readFileSync(join(dir, 'lifecycle.log'), 'utf8').length).toBeLessThanOrEqual(200);
        expect(readFileSync(join(dir, 'lifecycle.log'), 'utf8')).toContain('agent_9');
    });

    it('a log that cannot be written never throws into the caller (a stop must not fail on its own log)', () => {
        const log = openLifecycleLog(join(tempDir(), 'missing', '\0bad'), { now: () => 0 });
        expect(() => log('spawn agent=x')).not.toThrow();
    });
});
