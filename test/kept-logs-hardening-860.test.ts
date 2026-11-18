import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_MAX_LINES } from '../src/core/output-tail.js';
import { KEPT_TEXT_MAX, withRun, type ProcessSchedule } from '../src/core/scheduled-task.js';
import { KEPT_LOG_MAX_BYTES, KeptProcessLogs } from '../src/main/kept-process-logs.js';
import { ProcessBook } from '../src/main/process-book.js';
import type { ProcessSpec, ProcessStatus } from '../src/main/process-supervisor.js';

/**
 * KEPT LOGS HOLD WHAT PROCESSES PRINTED, AND THAT CAN BE A SECRET (Tynn #860 review). So each kept file is a bounded tail
 * (lines AND bytes), goes with its process, lives only under Genie's runtime folder — owner-only where the OS allows, and
 * never outside its folder whatever the process id — and a scheduled run's recorded text is capped too.
 */

function fakeSupervisor() {
    const statuses = new Map<string, ProcessStatus>();
    const logs = new Map<string, string>();
    const changes = new Set<(s: ProcessStatus) => void>();
    const outputs = new Set<(id: string, data: string) => void>();
    const set = (s: ProcessStatus) => { statuses.set(s.id, s); for (const l of changes) l(s); };
    return {
        print: (id: string, data: string) => { logs.set(id, (logs.get(id) ?? '') + data); for (const l of outputs) l(id, data); },
        start: (spec: ProcessSpec): ProcessStatus => { if (!logs.has(spec.id)) logs.set(spec.id, ''); const s: ProcessStatus = { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 1, exitCode: null, restarts: 0, since: 0 }; set(s); return s; },
        stop: () => true,
        forget: (id: string) => { logs.delete(id); return statuses.delete(id); },
        list: () => [...statuses.values()],
        status: (id: string) => statuses.get(id) ?? null,
        // As the real supervisor's tail reads: the text it holds (its own bound is by lines and characters).
        readLog: (id: string, lines?: number) => {
            const text = logs.get(id);
            if (text === undefined) return null;
            const all = text.replace(/\n$/, '').split('\n');
            const take = lines === undefined ? all : all.slice(-lines);
            return { text: take.join('\n'), lines: take.length, dropped: 0 };
        },
        onChange: (l: (s: ProcessStatus) => void) => { changes.add(l); return () => { changes.delete(l); }; },
        onOutput: (l: (id: string, data: string) => void) => { outputs.add(l); return () => { outputs.delete(l); }; },
    };
}

let home: string;
let dir: string;
let sup: ReturnType<typeof fakeSupervisor>;
const now = { schedule: (fn: () => void) => { fn(); return () => {}; } };
const spec = (id: string): ProcessSpec => ({ id, workspaceId: 'ws', name: id, command: 'x', cwd: tmpdir(), restart: 'never' });

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-860-hard-'));
    dir = join(home, 'runtime', 'process-logs');
    sup = fakeSupervisor();
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const keptFile = async (id: string) => JSON.parse(await readFile(join(dir, `${encodeURIComponent(id)}.json`), 'utf8')) as { text: string; lines: number; dropped: number };

describe('a kept log is a bounded tail: lines AND bytes', () => {
    it('many lines of multi-byte output: the file is at most KEPT_LOG_MAX_BYTES and LOG_MAX_LINES, and says what it cut', async () => {
        const logs = await KeptProcessLogs.open(dir, { supervisor: sup, owns: () => true, ...now });
        sup.start(spec('p1'));
        // 3 000 lines of 100 two-byte characters: under the character bound per line, far over any byte bound in total.
        sup.print('p1', `${'é'.repeat(100)}\n`.repeat(3_000));
        await logs.flush();
        const kept = await keptFile('p1');
        expect(Buffer.byteLength(kept.text, 'utf8')).toBeLessThanOrEqual(KEPT_LOG_MAX_BYTES);
        expect(kept.lines).toBeLessThanOrEqual(LOG_MAX_LINES);
        expect(kept.dropped).toBeGreaterThan(0);
        // What a reader gets is bounded the same way.
        expect(Buffer.byteLength(logs.read('p1')!.text, 'utf8')).toBeLessThanOrEqual(KEPT_LOG_MAX_BYTES);
    });

    it('one long line (within the tail\'s character bound, over the byte bound) is cut to its end, within the bytes', async () => {
        const logs = await KeptProcessLogs.open(dir, { supervisor: sup, owns: () => true, ...now });
        sup.start(spec('p1'));
        // 100 000 three-byte characters: 300 000 bytes. (A line past the tail's CHARACTER bound is dropped whole by the
        // tail itself, which would make this vacuous — the first RED run showed exactly that, so the line is sized here.)
        sup.print('p1', `${'€'.repeat(100_000)}END`);
        await logs.flush();
        const kept = await keptFile('p1');
        expect(Buffer.byteLength(kept.text, 'utf8')).toBeLessThanOrEqual(KEPT_LOG_MAX_BYTES);
        expect(kept.text.endsWith('€END')).toBe(true);
        expect(kept.text.length).toBeGreaterThan(50_000);
    });

    it('across restarts the joined log stays within the bound', async () => {
        const first = await KeptProcessLogs.open(dir, { supervisor: sup, owns: () => true, ...now });
        sup.start(spec('p1'));
        sup.print('p1', `${'é'.repeat(100)}\n`.repeat(1_500));
        await first.flush();
        const sup2 = fakeSupervisor();
        const second = await KeptProcessLogs.open(dir, { supervisor: sup2, owns: () => true, ...now });
        sup2.start(spec('p1'));
        sup2.print('p1', `${'ü'.repeat(100)}\n`.repeat(1_500));
        await second.flush();
        const kept = await keptFile('p1');
        expect(Buffer.byteLength(kept.text, 'utf8')).toBeLessThanOrEqual(KEPT_LOG_MAX_BYTES);
        expect(kept.text.endsWith('ü'.repeat(100))).toBe(true);
    });

    it('CONTROL: a small log is kept whole, nothing counted as cut', async () => {
        const logs = await KeptProcessLogs.open(dir, { supervisor: sup, owns: () => true, ...now });
        sup.start(spec('p1'));
        sup.print('p1', 'one\ntwo\n');
        await logs.flush();
        expect(await keptFile('p1')).toMatchObject({ text: 'one\ntwo', lines: 2, dropped: 0 });
    });
});

describe('a kept log lives only in its folder, owner-only, and goes with its process', () => {
    it.skipIf(process.platform === 'win32')('the folder is 0700 and each file 0600', async () => {
        const logs = await KeptProcessLogs.open(dir, { supervisor: sup, owns: () => true, ...now });
        sup.start(spec('p1'));
        sup.print('p1', 'token=abc\n');
        await logs.flush();
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        expect((await stat(join(dir, 'p1.json'))).mode & 0o777).toBe(0o600);
    });

    it('a process id that looks like a path stays inside the folder', async () => {
        const logs = await KeptProcessLogs.open(dir, { supervisor: sup, owns: () => true, ...now });
        const id = '../../escaped';
        sup.start(spec(id));
        sup.print(id, 'x\n');
        await logs.flush();
        expect(await readdir(dir)).toEqual([`${encodeURIComponent(id)}.json`]);
        await expect(stat(resolve(dir, '..', '..', 'escaped.json'))).rejects.toThrow();
        // Read back by the next Genie under the same id.
        expect((await KeptProcessLogs.open(dir, { supervisor: fakeSupervisor(), owns: () => true, ...now })).read(id)!.text).toBe('x');
    });

    it('a folder that cannot be made private keeps nothing on disk: the output stays in memory (written after; the break probe proves it)', async () => {
        const logs = await KeptProcessLogs.open(dir, { supervisor: sup, owns: () => true, ...now, restrictDir: async () => { throw new Error('ACL refused'); } });
        sup.start(spec('p1'));
        sup.print('p1', 'token=abc\n');
        await logs.flush();
        expect(await readdir(dir)).toEqual([]);
        expect(logs.read('p1')!.text).toBe('token=abc');
    });

    it('genie-host keeps them under its runtime folder (runtimeDir), never a workspace', () => {
        const host = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8');
        expect(host).toMatch(/const runtime = runtimeDir\(home\);/);
        expect(host).toMatch(/KeptProcessLogs\.open\(join\(runtime, 'process-logs'\),/);
    });

    it('removing a process from the book deletes its kept file from disk (written after the fix; the break probe proves it)', async () => {
        const logs = await KeptProcessLogs.open(dir, { supervisor: sup, owns: () => true, ...now });
        const book = await ProcessBook.open(home, { supervisor: sup, envFor: () => ({}), asleep: () => false, logs });
        const p = await book.create({ workspaceId: 'ws', workspacePath: home, name: 'worker', command: 'x', restart: 'never' });
        sup.print(p.id, 'secret\n');
        await logs.flush();
        expect(await readdir(dir)).toEqual([`${encodeURIComponent(p.id)}.json`]);
        await book.remove(p.id);
        expect(await readdir(dir)).toEqual([]);
    });
});

describe('a scheduled run\'s recorded text is capped', () => {
    const base: ProcessSchedule = { cron: '* * * * *', kind: 'agent-nudge' };
    it('`sent` and `reason` longer than KEPT_TEXT_MAX are cut, and say so', () => {
        const s = withRun(base, { at: 1, endedAt: 2, status: 'failed', sent: 'p'.repeat(KEPT_TEXT_MAX * 3), reason: 'r'.repeat(KEPT_TEXT_MAX * 3) });
        expect(s.runs![0]!.sent!.length).toBeLessThanOrEqual(KEPT_TEXT_MAX + 1);
        expect(s.runs![0]!.sent!.endsWith('…')).toBe(true);
        expect(s.runs![0]!.reason!.length).toBeLessThanOrEqual(KEPT_TEXT_MAX + 1);
    });
    it('CONTROL: short text is kept as it is', () => {
        expect(withRun(base, { at: 1, endedAt: 2, status: 'ok', sent: 'check the ticket queue' }).runs![0]!.sent).toBe('check the ticket queue');
    });
});
