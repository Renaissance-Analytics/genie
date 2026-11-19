import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { endMarkedChildren, markedChildRunning } from './helpers/marked-children.js';

/**
 * A TEST ENDS ONLY ITS OWN CHILDREN (Tynn #919). spawn-host-responsive failed on Windows with the Docker read answering
 * 'absent': its spawn host child was killed mid-call (exit 1, no signal, nothing on stderr; queue item 1119-180839-a2ee1d)
 * 7 ms after git-read-limit's "keeps starting children" test ended in another worker. That test's afterEach ended every
 * pid its hook's children had written, if `process.kill(pid, 0)` said it was alive. Windows hands a dead node's pid to
 * the next node quickly, so the pid was by then our spawn host's. A pid alone is not a process.
 *
 * So a marked child is the SAME process only when the process holding its pid started no later than its marker was
 * written: the child writes the marker after it starts, and a process that took its pid afterwards started after the
 * child ended, so after the marker.
 */

const roots: string[] = [];
const held: ChildProcess[] = [];
afterEach(() => {
    for (const c of held.splice(0)) { try { c.kill(); } catch { /* gone */ } }
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function marksDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'marked-children-919-'));
    roots.push(root);
    const marks = join(root, 'marks');
    mkdirSync(marks);
    return marks;
}
/** A node process we hold by its handle (so this test ends it whatever the helper does). */
function node(code: string, ...args: string[]): ChildProcess {
    const c = spawn(process.execPath, ['-e', code, ...args], { stdio: 'ignore', windowsHide: true });
    held.push(c);
    return c;
}
const exited = (c: ChildProcess) => new Promise<void>((done) => { if (c.exitCode !== null || c.signalCode !== null) done(); else c.once('exit', () => done()); });

describe('a test ends only its own marked children (Tynn #919)', () => {
    it('CONTROL: its own child, marked by itself, is running, and is ended', async () => {
        const marks = marksDir();
        const child = node('require("fs").writeFileSync(require("path").join(process.argv[1], String(process.pid)), ""); setInterval(() => {}, 1000);', marks);
        await vi.waitFor(() => expect(existsSync(join(marks, String(child.pid)))).toBe(true), { timeout: 15_000, interval: 50 });
        expect(markedChildRunning(child.pid!, join(marks, String(child.pid)))).toBe(true);
        expect(endMarkedChildren(marks)).toEqual([child.pid]);
        await exited(child);
    }, 30_000);

    it('THE FAILURE: a pid that another process holds now (its marker older than that process) is not ended', async () => {
        const marks = marksDir();
        const other = node('setInterval(() => {}, 1000);');
        await vi.waitFor(() => expect(other.pid).toBeGreaterThan(0), { timeout: 5_000 });
        // A child with this pid marked itself a minute ago and has ended; the pid is someone else's now.
        const marker = join(marks, String(other.pid));
        writeFileSync(marker, '');
        const past = new Date(Date.now() - 60_000);
        utimesSync(marker, past, past);
        expect(markedChildRunning(other.pid!, marker)).toBe(false);
        expect(endMarkedChildren(marks)).toEqual([]);
        await new Promise((r) => setTimeout(r, 500));
        expect(other.exitCode).toBeNull();
        expect(other.signalCode).toBeNull();
    }, 30_000);

    it('a machine that cannot be read is not guessed at: unknown, and nothing is ended', () => {
        const marks = marksDir();
        writeFileSync(join(marks, '4242'), '');
        const killed: number[] = [];
        const io = { snapshot: () => null, kill: (pid: number) => { killed.push(pid); } };
        expect(markedChildRunning(4242, join(marks, '4242'), io)).toBeNull();
        expect(endMarkedChildren(marks, io)).toEqual([]);
        expect(killed).toEqual([]);
    });
});
