import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { execInProcess } from '../src/main/spawn-exec.js';

/*
 * Tynn #698 story 2: A COMMAND GENIE RUNS CAN NEITHER WAIT ON A PROMPT NOR OUTLIVE ITS LIMIT. The Toolchain's Update sat on
 * "Starting": `execFile` left the child's stdin an open pipe, so anything that asked a question waited the whole 30-minute
 * limit, and the limit ended only the direct child (on Windows, cmd.exe), leaving npm and what it started running.
 *
 * Real processes (Node itself), because the point is what the OS does with them. Run on the test VMs only.
 */
const dir = mkdtempSync(join(tmpdir(), 'genie-spawn-exec-hardening-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a command Genie runs', () => {
    it('reads end-of-input at once: a question it asks is answered by nothing, never waited on', async () => {
        const started = Date.now();
        const r = await execInProcess(process.execPath, ['-e', "process.stdin.on('end',()=>{console.log('eof');process.exit(0)});process.stdin.resume()"], { timeoutMs: 15_000 });
        expect(r.stdout.trim()).toBe('eof');
        expect(Date.now() - started).toBeLessThan(10_000);
    }, 20_000);

    it('at its limit, ends what it started too, and still says it timed out', async () => {
        const pidFile = join(dir, 'grandchild.pid');
        // The child starts a grandchild that runs forever, writes its pid, and runs forever itself.
        const script = [
            "const { spawn } = require('node:child_process');",
            "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
            'setInterval(() => {}, 1000);',
        ].join('\n');
        const run = execInProcess(process.execPath, ['-e', script], { timeoutMs: 4_000 });
        const settled = run.then(() => 'resolved', (error: { code?: string }) => error.code ?? 'rejected');
        let grandchild = 0;
        try {
            for (let i = 0; i < 60 && !existsSync(pidFile); i += 1) await sleep(50);
            grandchild = Number(readFileSync(pidFile, 'utf8'));
            // CONTROL: the grandchild is running before the limit, so "gone after" is a measurement.
            expect(alive(grandchild)).toBe(true);
            expect(await settled).toBe('ETIMEDOUT');
            let gone = false;
            for (let i = 0; i < 100 && !gone; i += 1) { gone = !alive(grandchild); if (!gone) await sleep(100); }
            expect(gone).toBe(true);
        } finally {
            if (grandchild > 0 && alive(grandchild)) process.kill(grandchild);
        }
    }, 30_000);
});
