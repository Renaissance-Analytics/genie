import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WIN_LAUNCHER, winLauncherPath } from '../src/main/win-launcher.js';

/*
 * genie-launch.exe (native/win-launcher/genie-launch.c; #1628, #1639). Where Genie finds it, that CI really builds it (a
 * Windows build that quietly fell back to Node's spawn would pass the rows that depend on it for the wrong reason), and
 * what each mode does with a real child: its output and exit code through `job`, a pid that is the child's through
 * `detach`. What it keeps out — the window's handles, the hook's children — is held by hang-cdp's Windows step and the git
 * limit's rows (test/git-read-limit.test.tsx), which failed without it.
 */
describe('where Genie finds genie-launch.exe', () => {
    const at = (...p: string[]) => join('C:', ...p);
    it('off Windows: nowhere (Node\'s spawn, as before)', () => {
        expect(winLauncherPath({ platform: 'linux', exists: () => true })).toBeNull();
    });
    it('packaged: resources/bin, from the process\'s resources path or GENIE_RESOURCES (genie-host)', () => {
        const seen = new Set([join(at('Genie', 'resources'), 'bin', WIN_LAUNCHER)]);
        expect(winLauncherPath({ platform: 'win32', resources: [undefined, at('Genie', 'resources')], devRoot: at('nowhere'), exists: (p) => seen.has(p) })).toBe(join(at('Genie', 'resources'), 'bin', WIN_LAUNCHER));
    });
    it('a dev or CI tree: build/win-launcher; and not built at all: null', () => {
        const dev = join(at('src', 'genie'), 'build', 'win-launcher', WIN_LAUNCHER);
        expect(winLauncherPath({ platform: 'win32', resources: [], devRoot: at('src', 'genie'), exists: (p) => p === dev })).toBe(dev);
        expect(winLauncherPath({ platform: 'win32', resources: [], devRoot: at('src', 'genie'), exists: () => false })).toBeNull();
    });
});

describe.skipIf(process.platform !== 'win32')('genie-launch.exe, the real one (Windows)', () => {
    let dir = '';
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

    it('CI built it: the tree finds it (a fallback to Node\'s spawn on CI would hide its absence)', () => {
        if (process.env.CI !== 'true') return;
        expect(winLauncherPath()).not.toBeNull();
    });

    it('job: the child\'s output and its exit code come through as its own', () => {
        const launcher = winLauncherPath();
        if (launcher === null) return;
        const r = spawnSync(launcher, ['job', process.execPath, '-e', 'process.stdout.write("out:" + process.argv.slice(1).join("|")); process.stderr.write("err"); process.exit(7)', 'a b', 'c"d', 'e\\'], { encoding: 'utf8', windowsHide: true });
        expect(r.status).toBe(7);
        expect(r.stdout).toBe('out:a b|c"d|e\\');
        expect(r.stderr).toBe('err');
    });

    it('job: ending the launcher ends what the child started, however detached (the job closes)', async () => {
        const launcher = winLauncherPath();
        if (launcher === null) return;
        dir = mkdtempSync(join(tmpdir(), 'win-launcher-'));
        const mark = join(dir, 'grandchild.pid');
        // The child starts a DETACHED grandchild (out of its own process group) and waits for ever.
        const script = `const { spawn } = require('child_process'); const g = spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', ${JSON.stringify(mark)}], { detached: true, stdio: 'ignore' }); g.unref(); setInterval(() => {}, 1000);`;
        const parent = (await import('node:child_process')).spawn(launcher, ['job', process.execPath, '-e', script], { stdio: 'ignore', windowsHide: true });
        const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
        let grandchild = 0;
        for (let i = 0; i < 100 && grandchild === 0; i++) { await new Promise((r) => setTimeout(r, 100)); try { grandchild = Number(readFileSync(mark, 'utf8')); } catch { /* not yet */ } }
        expect(grandchild).toBeGreaterThan(0);
        expect(alive(grandchild)).toBe(true);
        execFileSync('taskkill', ['/F', '/PID', String(parent.pid)], { stdio: 'ignore' });
        for (let i = 0; i < 100 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 100));
        expect(alive(grandchild)).toBe(false);
    }, 30_000);

    it('detach: prints the pid of the child it started, which runs on with only its log', async () => {
        const launcher = winLauncherPath();
        if (launcher === null) return;
        dir = mkdtempSync(join(tmpdir(), 'win-launcher-'));
        const log = join(dir, 'child.log');
        const pid = Number(execFileSync(launcher, ['detach', log, process.execPath, '-e', 'console.log("ran " + process.pid); setTimeout(() => {}, 1500)'], { encoding: 'utf8', windowsHide: true }).trim());
        expect(pid).toBeGreaterThan(0);
        for (let i = 0; i < 50 && !readFileSync(log, { encoding: 'utf8', flag: 'a+' }).includes('ran'); i++) await new Promise((r) => setTimeout(r, 100));
        expect(readFileSync(log, 'utf8')).toContain(`ran ${pid}`);
    }, 20_000);
});
