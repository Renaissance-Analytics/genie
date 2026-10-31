import { rmdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeServiceExec, runServiceExec } from '../src/main/service-exec.js';
import { systemProcessTree, type ProcessInfo, type ProcessTree } from '../src/core/process-tree.js';

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

    /*
     * genie#1372, MEASURED on genie-test-windows before this test existed: no process of an aborted command survived
     * (33 aborts, a WMI reading after each), but in 10 of them the command's folder was still EBUSY the moment the abort
     * resolved — `process.kill(pid, 0)` already said every reaped pid was dead, and a removal ~2 s later succeeded. On
     * Windows a terminated process has its exit code before it has finished exiting (its handles, its current
     * directory). So "stopped" was reported while the tree was still going away, and a caller that reuses or removes
     * the folder next — main's `unit (windows)` CI, run 41190299126 — hits EBUSY. Stopped has to mean EXITED: once the
     * abort resolves, the shell and everything under it are gone and the folder is free, at the first try.
     */
    it('once an abort resolves, the command has EXITED: its shell is gone and its folder can be removed at once (genie#1372)', async () => {
        const script = join(dir, 'migrate.cjs');
        await writeFile(script, [
            "const { spawn } = require('node:child_process');",
            "const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            "require('node:fs').writeFileSync(process.argv[2], `${process.pid} ${worker.pid} ${process.ppid}`);",
            'setInterval(() => {}, 1000);',
        ].join('\n'));
        // Twelve aborts, each command in its OWN empty folder (its pid file lives elsewhere), so the removal measures
        // exactly the processes whose current directory it is. Before the fix ~30% of single aborts left it busy.
        const busy: string[] = [];
        for (let i = 0; i < 12; i += 1) {
            const cwd = join(dir, `cwd-${i}`);
            await mkdir(cwd);
            const pidFile = join(dir, `pids-${i}`);
            const ac = new AbortController();
            const run = runServiceExec({ command: `${NODE} ${q(script)} ${q(pidFile)}`, cwd, env: {}, timeoutMs: 600_000, signal: ac.signal });
            const { parent, worker } = await pidsIn(pidFile);
            // The shell: the script's parent — unless a POSIX shell exec'd node, when the parent is this very process.
            const shell = Number((await readFile(pidFile, 'utf8')).trim().split(' ')[2]);
            expect([parent, worker].map(alive)).toEqual([true, true]);
            ac.abort();
            expect((await run).aborted).toBe(true);
            // No waiting from here on: the abort's resolution is the claim under test.
            const left = [parent, worker, ...(shell && shell !== process.pid ? [shell] : [])].filter(alive);
            if (left.length > 0) busy.push(`#${i}: still alive ${left.join(' ')}`);
            try { rmdirSync(cwd); } catch (e) { busy.push(`#${i}: ${(e as NodeJS.ErrnoException).code} removing its folder`); }
        }
        expect(busy).toEqual([]);
    }, 300_000);

    it('a process of the tree that will not exit is NAMED in the result, and the call still ends (genie#1372)', async () => {
        // The real machine's readings, plus one member that never leaves them: a phantom child of the command's shell.
        let phantom: ProcessInfo | null = null;
        const tree: ProcessTree = {
            ...systemProcessTree,
            read: async () => {
                const now = await systemProcessTree.read!();
                if (!now) return now;
                const shell = now.find((p) => p.ppid === process.pid && p.pid === shellPid);
                if (shell && !phantom) phantom = { pid: 4_000_001, ppid: shell.pid, started: shell.started, name: 'phantom.exe' };
                return phantom ? [...now, phantom] : now;
            },
            reap: (targets, now, limit) => systemProcessTree.reap!(targets.filter((t) => t !== phantom && t.pid !== phantom?.pid), now, limit),
        };
        let shellPid = -1;
        const script = join(dir, 'wait.cjs');
        await writeFile(script, "require('node:fs').writeFileSync(process.argv[2], `${process.pid} ${process.ppid}`); setInterval(() => {}, 1000);");
        const ac = new AbortController();
        const run = makeServiceExec(tree)({ command: `${NODE} ${q(script)} ${q(join(dir, 'p'))}`, cwd: dir, env: {}, timeoutMs: 600_000, signal: ac.signal });
        const { parent, worker: ppid } = await pidsIn(join(dir, 'p'));
        shellPid = ppid === process.pid ? parent : ppid;
        ac.abort();
        const r = await run;
        expect(r.aborted).toBe(true);
        expect(r.output).toContain('still running after the stop: 4000001(phantom.exe)');
        expect(await gone(parent)).toBe(true);
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
