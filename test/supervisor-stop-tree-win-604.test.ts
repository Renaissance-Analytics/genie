// CI: WINDOWS ONLY (supervisor.stop ending a process tree is measured through the real Windows pty and its job object; the Linux pty helper is covered by fancy-pty-lifecycle)
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { startSpawnHost, type SpawnHostClient } from '../src/main/spawn-host-client.js';

/**
 * THE SUPERVISOR'S REAL STOP ENDS A WHOLE PROCESS TREE ON WINDOWS (Tynn #604: the Playwright server is `node cli.js`, which starts
 * a driver and browsers). No other test proves it: fancy-pty-lifecycle and host-pty-fds are Linux (/proc) and kill the CONTROLLER,
 * not a supervised stop. Here the REAL spawn host (Electron as Node) makes a pty for a supervised process; its node child starts
 * a grandchild that outlives its parent on purpose (detached); `supervisor.stop` must leave neither.
 *
 * Windows only; runs in the gate's windows unit row and on the Windows test VM, never on the owner's desktop.
 */

const electron = createRequire(import.meta.url)('electron') as unknown as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function alive(pid: number): boolean { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }
async function until<T>(what: string, fn: () => Promise<T | null | false> | T | null | false, ms: number): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v as T;
        if (Date.now() > end) throw new Error(`timed out: ${what}`);
        await sleep(100);
    }
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const killAll = (...pids: number[]) => { for (const p of pids) if (p > 0) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } };

describe.skipIf(process.platform !== 'win32')('supervisor.stop on Windows (real spawn host, real pty)', () => {
    it('ends the process AND the grandchild it started, within 5 s', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'sup-stop-tree-'));
        cleanups.push(() => rm(dir, { recursive: true, force: true }));
        const pidFile = join(dir, 'pids.json');
        const script = join(dir, 'tree.cjs');
        // The parent starts a detached grandchild (as a server starts its driver and browsers), records both pids, then idles.
        await writeFile(script, [
            "const { spawn } = require('node:child_process');",
            "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
            "require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, grandchild: g.pid }));",
            'setInterval(() => {}, 1000);',
        ].join('\n'));
        const client: SpawnHostClient = startSpawnHost({
            entry: resolve('src/main/spawn-host.ts'), execPath: electron, execArgv: ['--import', 'tsx'], env: { GENIE_SPAWN_PROFILE: 'terminals' },
            pidAlive: alive, log: () => {},
        });
        cleanups.push(() => client.stop(1_000));
        const supervisor = new ProcessSupervisor(client.ptyPort(), { now: () => Date.now(), schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }, { pidAlive: alive });
        supervisor.start({ id: 'tree', workspaceId: 'w', name: 'tree', command: `"${process.execPath.replace(/"/g, '')}" "${script}" "${pidFile}"`, cwd: dir, restart: 'never' });
        const { parent, grandchild } = await until('the tree to start', async () => {
            try { const p = JSON.parse(await readFile(pidFile, 'utf8')) as { parent: number; grandchild: number }; return p.parent > 0 && p.grandchild > 0 ? p : null; } catch { return null; }
        }, 60_000);
        cleanups.push(() => killAll(parent, grandchild));
        // CONTROL: both run before the stop, so "gone" after it means the stop did it.
        expect([alive(parent), alive(grandchild)]).toEqual([true, true]);
        supervisor.stop('tree');
        const gone = await until('both to end', () => (!alive(parent) && !alive(grandchild) ? true : null), 5_000).catch(() => false);
        console.log(`[supervisor-stop-tree-604] after stop: parent ${parent} ${alive(parent) ? 'ALIVE' : 'gone'}, grandchild ${grandchild} ${alive(grandchild) ? 'ALIVE' : 'gone'}`);
        expect(gone).toBe(true);
    }, 120_000);
});
