import { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startSpawnHost, type SpawnHostClient } from '../src/main/spawn-host-client.js';

/*
 * THE GENIE BROWSER, STARTED BY genie-host's SPAWN-HOST CHILD (Tynn #535). genie-host created it on its own thread, once a
 * session: in the UI-lag row that start coincided with a 238 ms genie-host gap on the Linux runner. Through a real
 * spawn-host child here: this process creates nothing, the process starts with its output in its log, and it runs on
 * after the child that started it is gone (detached, as it was when genie-host started it).
 */
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
let client: SpawnHostClient | null = null;
let root = '';
let started = 0;

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'browser-through-child-')); });
afterEach(() => { if (started > 0 && alive(started)) process.kill(started); started = 0; });
afterAll(async () => { await client?.stop(); rmSync(root, { recursive: true, force: true }); });

describe('a detached start through the spawn host', () => {
    it('this process creates nothing; the started process logs, and outlives the child that started it', async () => {
        client = startSpawnHost({ entry: fixture('git-spawn-host.ts'), execArgv: ['--import', 'tsx'] });
        await client.exec(process.execPath, ['-e', '0'], { env: { ELECTRON_RUN_AS_NODE: '1' } }); // warm: the child is up
        const log = join(root, 'logs', 'genie-browser.log');
        const script = 'console.log("browser up " + process.pid); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);';
        const created: string[] = [];
        const proto = ChildProcess.prototype as unknown as { spawn: (this: ChildProcess, options: { file?: string }) => unknown };
        const original = proto.spawn;
        proto.spawn = function (options) { created.push(String(options?.file ?? '?')); return original.call(this, options); };
        let pid: number | null;
        try {
            const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
            pid = await client.spawnDetached(process.execPath, ['-e', script], env, log);
        } finally { proto.spawn = original; }
        expect(created).toEqual([]);
        expect(typeof pid).toBe('number');
        started = pid!;
        await vi.waitFor(() => { expect(existsSync(log) && readFileSync(log, 'utf8')).toContain(`browser up ${pid}`); }, { timeout: 10_000, interval: 100 });
        // CONTROL: it runs while the child runs.
        expect(alive(pid!)).toBe(true);
        await client.stop();
        client = null;
        await new Promise((r) => setTimeout(r, 1_000));
        expect(alive(pid!)).toBe(true);
    }, 60_000);
});
