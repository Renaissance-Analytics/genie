import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnHostProcess } from '../src/main/engine-launch.js';

/*
 * THE LAUNCHER IS NEVER WAITED FOR ON WINDOW MAIN (#1628 review). spawnHostProcess runs on window main when it starts
 * genie-host, and this week's crash work was window main held (#1576/#1595: a synchronous child start, 4.4 s cold). The
 * launcher's `detach` prints the host's pid and exits; the window awaits that, asynchronously. A source guard holds every
 * caller of the launcher to it, and a timing row holds spawnHostProcess: it returns at once while the launcher still runs.
 */
const codeOf = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
}

describe('the launcher, asynchronously', () => {
    it('no caller of genie-launch.exe starts it synchronously, and engine-launch has no synchronous child start at all', () => {
        const callers = files('src').filter((f) => /winLauncherPath\(/.test(codeOf(f)) && !f.endsWith('win-launcher.ts'));
        // CONTROL: the scan finds the two callers.
        expect(callers.map((f) => f.replace(/\\/g, '/')).sort()).toEqual(['src/main/engine-launch.ts', 'src/main/git-ports.ts']);
        for (const f of callers) expect(codeOf(f), f).not.toMatch(/(execFileSync|spawnSync|execSync)\(\s*(launcher|winLauncherPath\(\))/);
        expect(codeOf('src/main/engine-launch.ts')).not.toMatch(/\b(execFileSync|spawnSync|execSync)\b/);
    });
});

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

describe.skipIf(process.platform === 'win32')('spawnHostProcess returns at once while the launcher runs', () => {
    it('a launcher that takes 600 ms: the call returns in well under that, and the pid it prints is the answer', async () => {
        dir = mkdtempSync(join(tmpdir(), 'host-spawn-async-'));
        const launcher = join(dir, 'slow-launch.sh');
        // Stands in for genie-launch.exe's `detach`: it takes its time, then prints a pid.
        writeFileSync(launcher, '#!/bin/sh\nsleep 0.6\necho 4242\n');
        chmodSync(launcher, 0o755);
        const lines: string[] = [];
        const started = performance.now();
        const pending = spawnHostProcess({ execPath: process.execPath, hostScript: 'host.js', logsDir: join(dir, 'logs'), env: {}, genieHome: dir, build: 't' }, launcher, (l) => lines.push(l));
        const returned = performance.now() - started;
        expect(returned).toBeLessThan(200);
        expect(await pending).toBe(4242);
        expect(performance.now() - started).toBeGreaterThanOrEqual(550);
        expect(lines).toEqual(['host spawn via=genie-launch pid=4242']);
    });
});
