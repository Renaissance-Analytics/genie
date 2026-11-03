import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { slowWriteLine } from '../src/main/private-credentials.js';
import { HelperLost, WindowsHelper, type HelperChild } from '../src/main/windows-helper.js';

/**
 * A STUCK HELPER MUST NOT COST EVERY WRITE (batch HH: one Windows test took 65 minutes, and the helper was the first suspect). A write waits out the helper's deadline and then launches, and that is right once. Without a limit a burst of writes pays
 * it each, restarting a helper each time. So: one restart, then it rests and writes launch directly, at once. An answer ends it.
 */
class Stuck extends EventEmitter implements HelperChild {
    readonly pid = 1;
    readonly stdout = new EventEmitter();
    readonly written: string[] = [];
    readonly stdin = { write: (text: string) => { this.written.push(text); return true; }, end: () => {} };
    kill(): boolean { this.emit('exit', null, 'SIGTERM'); return true; }
    answers(): void { this.stdout.emit('data', Buffer.from(`DONE ${/^(\d+) /.exec(this.written.at(-1) ?? '')?.[1]} 0\n`)); }
}
function rig(deadlineMs = 5) {
    let at = 1_000;
    const children: Stuck[] = [];
    const lines: string[] = [];
    const helper = new WindowsHelper({ deadlineMs, restMs: 300_000, now: () => at, log: (line) => lines.push(line), spawn: () => { const child = new Stuck(); children.push(child); return child; } });
    return { helper, children, lines, advance: (ms: number) => { at += ms; } };
}
const lost = async (request: { completed: Promise<unknown> }) => { await expect(request.completed).rejects.toBeInstanceOf(HelperLost); };
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

describe('a helper that does not answer', () => {
    it('a burst of writes: two helpers at most, and those after them are told at once', async () => {
        const r = rig();
        const requests = Array.from({ length: 20 }, () => r.helper.run('Do-Work'));
        const began = performance.now();
        for (const request of requests) await lost(request);
        expect(r.children).toHaveLength(2);
        // Two deadlines of 5 ms, not twenty. A wide margin for a loaded machine; the count above is the claim.
        expect(performance.now() - began).toBeLessThan(5_000);
    });

    it('resting: no helper is started, and a write is told in this turn of the loop', async () => {
        const r = rig();
        await lost(r.helper.run('a'));
        await lost(r.helper.run('b'));
        expect(r.children).toHaveLength(2);
        await lost(r.helper.run('c'));
        expect(r.children).toHaveLength(2);
    });

    it('it says it is resting, and why', async () => {
        const r = rig();
        await lost(r.helper.run('a'));
        await lost(r.helper.run('b'));
        expect(r.lines.join('\n')).toMatch(/resting/);
        expect(r.lines.join('\n')).toMatch(/no answer within 5 ms/);
    });

    it('after the rest, one try; failing, it rests again at once', async () => {
        const r = rig();
        await lost(r.helper.run('a'));
        await lost(r.helper.run('b'));
        r.advance(300_001);
        await lost(r.helper.run('c'));
        expect(r.children).toHaveLength(3);
        await lost(r.helper.run('d'));
        expect(r.children).toHaveLength(3);
    });

    it('a helper that answers ends it: one loss is forgiven by the next answer', async () => {
        const r = rig(50);
        await lost(r.helper.run('a'));
        const second = r.helper.run('b');
        await settle();
        r.children[1]!.answers();
        await second.completed;
        const third = r.helper.run('c');
        await settle();
        r.children[1]!.stdin.end();
        r.children[1]!.emit('exit', 1, null);
        await lost(third);
        // Not resting: that was one loss since an answer, so a new helper is tried.
        void r.helper.run('d').completed.catch(() => {});
        await settle();
        expect(r.children).toHaveLength(3);
        r.helper.stop();
    });

    it('CONTROL: a helper that exits while idle is no loss', async () => {
        const r = rig(50);
        for (let n = 0; n < 4; n += 1) {
            const request = r.helper.run('x');
            await settle();
            r.children.at(-1)!.answers();
            await request.completed;
            r.children.at(-1)!.emit('exit', 0, null);
        }
        expect(r.children).toHaveLength(4);
        expect(r.lines.join('\n')).not.toMatch(/resting/);
    });

    it('starting one that holds the loop is said: CreateProcess runs on the thread that asks, and it has held one for minutes', async () => {
        let at = 0;
        const lines: string[] = [];
        const helper = new WindowsHelper({ deadlineMs: 50, now: () => at, log: (line) => lines.push(line), spawn: () => { at += 7_000; return new Stuck(); } });
        void helper.run('x').completed.catch(() => {});
        await settle();
        expect(lines.join('\n')).toMatch(/starting it held this thread 7000 ms/);
        helper.stop();
    });
});

describe('a slow write says so', () => {
    it('over 5 s: how long, which way it went and why, with no path and no value', () => {
        expect(slowWriteLine(5_200, 'helper', null)).toBe('PRIVATE_FILE_SLOW_WRITE 5200 ms through the helper');
        expect(slowWriteLine(21_000, 'helper, then a launch', 'no answer within 20000 ms')).toBe('PRIVATE_FILE_SLOW_WRITE 21000 ms through the helper, then a launch: no answer within 20000 ms');
    });

    it('under 5 s: nothing', () => {
        expect(slowWriteLine(4_999, 'helper', null)).toBeNull();
    });

    it('wired: every attempt is timed, and the launch says if starting it held the thread', () => {
        const source = readFileSync('src/main/private-credentials.ts', 'utf8');
        expect(source.slice(source.indexOf('async function withHelperOrALaunch'), source.indexOf('function startWindowsAcl'))).toMatch(/slowWriteLine\(/);
        expect(source.slice(source.indexOf('function startWindowsAcl'), source.indexOf('async function restrict('))).toMatch(/held this thread/);
    });

    it('wired: the shared helper speaks, where a host writes its log', () => {
        expect(readFileSync('src/main/private-credentials.ts', 'utf8')).toMatch(/log: options\.log \?\? /);
    });
});
