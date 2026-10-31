import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runServiceExec } from '../src/main/service-exec.js';

/**
 * `services exec` STOPS ITS OWN PROCESS TREE, AND ONLY THAT TREE, when its MCP call goes away (genie#1360).
 *
 * Real processes, as the command really runs: through the platform shell, a node "migration" that starts a child of
 * its own (a worker) and then waits. Two such commands run at once; one call's signal aborts. Its whole tree ends —
 * the worker included, which a kill of the shell alone leaves running on Windows, and on POSIX when the shell has
 * exec'd or forked — while the other command's tree runs on untouched. Then the other is aborted too, as the control
 * that the same gauge sees a tree end.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-exec-abort-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A path as the shell reads one word (cmd.exe and sh alike). */
const q = (path: string): string => `"${path}"`;
/**
 * This very node, by path (a login shell's PATH may not have it). cmd.exe's `/s` strips the first and last quote of a
 * line that STARTS with one, so on Windows the line starts with `call` instead.
 */
const NODE = process.platform === 'win32' ? `call ${q(process.execPath)}` : q(process.execPath);
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function pidsIn(file: string, ms = 30_000): Promise<{ parent: number; worker: number }> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        try {
            const [parent, worker] = (await readFile(file, 'utf8')).trim().split(' ').map(Number);
            if (parent && worker) return { parent, worker };
        } catch { /* not yet written */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${file} was never written`);
}

async function gone(pid: number, ms = 30_000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (!alive(pid)) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
}

describe('services exec — an aborted call stops its process tree, and only that tree (genie#1360)', () => {
    it('the aborted command’s shell, process and worker all end; the other command’s tree keeps running', async () => {
        const script = join(dir, 'migrate.cjs');
        await writeFile(script, [
            "const { spawn } = require('node:child_process');",
            "const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            "require('node:fs').writeFileSync(process.argv[2], `${process.pid} ${worker.pid}`);",
            'setInterval(() => {}, 1000);',
        ].join('\n'));
        const one = new AbortController();
        const two = new AbortController();
        const first = runServiceExec({ command: `${NODE} ${q(script)} ${q(join(dir, 'one'))}`, cwd: dir, env: {}, timeoutMs: 600_000, signal: one.signal });
        const second = runServiceExec({ command: `${NODE} ${q(script)} ${q(join(dir, 'two'))}`, cwd: dir, env: {}, timeoutMs: 600_000, signal: two.signal });
        const a = await pidsIn(join(dir, 'one'));
        const b = await pidsIn(join(dir, 'two'));
        // POSITIVE CONTROL: the gauge sees all four running before anything is aborted.
        expect([a.parent, a.worker, b.parent, b.worker].map(alive)).toEqual([true, true, true, true]);

        one.abort();
        const r = await first;
        expect(r.aborted).toBe(true);
        expect(r.timedOut).toBe(false);
        expect(await gone(a.parent)).toBe(true);
        expect(await gone(a.worker)).toBe(true);
        // ONLY THAT TREE: the other command's process and worker run on.
        expect(alive(b.parent)).toBe(true);
        expect(alive(b.worker)).toBe(true);

        two.abort();
        expect((await second).aborted).toBe(true);
        expect(await gone(b.parent)).toBe(true);
        expect(await gone(b.worker)).toBe(true);
    }, 120_000);

    it('a call already aborted runs nothing', async () => {
        const gone = new AbortController();
        gone.abort();
        const marker = join(dir, 'ran');
        await writeFile(join(dir, 'mark.cjs'), "require('node:fs').writeFileSync(process.argv[2], 'x');");
        const r = await runServiceExec({ command: `${NODE} ${q(join(dir, 'mark.cjs'))} ${q(marker)}`, cwd: dir, env: {}, timeoutMs: 60_000, signal: gone.signal });
        expect(r.aborted).toBe(true);
        await new Promise((res) => setTimeout(res, 500));
        await expect(readFile(marker, 'utf8')).rejects.toThrow();
    });
});
