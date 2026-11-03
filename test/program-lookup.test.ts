import '../src/main/program-lookup.js';
import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitFileStatus, gitLogSince, gitShowHead, gitTreeStatus } from '../src/main/git-ports.js';
import { repoStatus } from '../src/main/repo-git.js';

/** Windows: how a bare program name is found when a working folder is given. */
const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';

describe.skipIf(process.platform !== 'win32')('Windows program lookup', () => {
    let folder: string;
    let mark: string;
    let hook: string;
    const before = process.env.NODE_OPTIONS;
    const ran = () => existsSync(mark);
    const wait = (work: Promise<unknown>) => work.catch(() => null);
    beforeEach(() => {
        folder = mkdtempSync(join(tmpdir(), 'lookup-'));
        mark = join(folder, 'mark.txt');
        hook = join(folder, 'hook.cjs');
        writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(mark)}, process.execPath);\nprocess.exit(0);\n`);
        for (const name of ['git.exe', 'reg.exe']) copyFileSync(process.execPath, join(folder, name));
        // A program from here says so by this; a real git does not read it.
        process.env.NODE_OPTIONS = `--require ${JSON.stringify(hook)}`;
    });
    afterEach(() => {
        if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before;
        rmSync(folder, { recursive: true, force: true });
    });
    const bare = (cwd: string, name = 'git') => new Promise((done) => { execFile(name, ['--version'], { cwd, windowsHide: true }, () => done(null)); });

    it('CONTROL: a program named by its path in the folder runs, so the mark can be seen', async () => {
        await new Promise((done) => { execFile(join(folder, 'git.exe'), ['--version'], { cwd: folder, windowsHide: true }, () => done(null)); });
        expect(ran()).toBe(true);
    });

    it('.\\name still runs what is in the folder, as a person means it to', () => {
        spawnSync('cmd.exe', ['/d', '/c', '.\\git.exe --version'], { cwd: folder, windowsHide: true });
        expect(ran()).toBe(true);
    });

    it('this process has the variable set', () => {
        expect(process.env[VARIABLE]).toBe('1');
    });

    it('a bare name with a working folder', async () => { await bare(folder); expect(ran()).toBe(false); });
    it('gitTreeStatus', async () => { await wait(gitTreeStatus(folder)); expect(ran()).toBe(false); });
    it('gitFileStatus', async () => { await wait(gitFileStatus(folder, 'a.txt')); expect(ran()).toBe(false); });
    it('gitShowHead', async () => { await wait(gitShowHead(folder, 'a.txt')); expect(ran()).toBe(false); });
    it('gitLogSince', async () => { await wait(gitLogSince(folder, 0)); expect(ran()).toBe(false); });
    it('repoStatus', async () => { await wait(repoStatus(folder, '.')); expect(ran()).toBe(false); });

    it('a child that inherits it: cmd finds the same way', () => {
        spawnSync('cmd.exe', ['/d', '/c', 'git --version'], { cwd: folder, windowsHide: true });
        expect(ran()).toBe(false);
    });

    /** Measured, so the fix rests on what was seen. Each in a node of its own, whose environment is what is being asked about. */
    const inChild = (script: string, env: NodeJS.ProcessEnv, cwd: string) => {
        const child = join(folder, 'child.cjs');
        mkdirSync(join(folder, 'elsewhere'), { recursive: true });
        writeFileSync(child, script);
        const clean = { ...env };
        delete clean.NODE_OPTIONS;
        return spawnSync(process.execPath, [child], { cwd, env: { ...clean, HOOK: hook }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    };
    const run = (extra: string) => `const { execFile } = require('node:child_process');\nexecFile('git', ['--version'], { cwd: ${JSON.stringify(folder)}, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '--require ' + JSON.stringify(process.env.HOOK)${extra} } }, () => {});\n`;
    const withoutVariable = () => { const env = { ...process.env }; delete env[VARIABLE]; return env; };

    it('MEASURE: set only in the spawn\'s env option, a bare name still finds the folder', () => {
        inChild(run(`, ${VARIABLE}: '1'`), withoutVariable(), join(folder));
        console.log(`### lookup env-option-only ran-from-folder=${ran()}`);
    });

    it('MEASURE: set in the parent, it does not', () => {
        inChild(run(''), { ...withoutVariable(), [VARIABLE]: '1' }, join(folder));
        expect(ran()).toBe(false);
    });

    it('MEASURE: not set, no working folder given, and the process itself started in the folder: its own lookups', () => {
        const script = `const { execFile } = require('node:child_process');\nexecFile('reg', ['query', 'x'], { windowsHide: true, env: { ...process.env, NODE_OPTIONS: '--require ' + JSON.stringify(process.env.HOOK) } }, () => {});\n`;
        inChild(script, withoutVariable(), folder);
        console.log(`### lookup process-cwd-no-option ran-from-folder=${ran()}`);
    });

    it('MEASURE: with it set, the same', () => {
        const script = `const { execFile } = require('node:child_process');\nexecFile('reg', ['query', 'x'], { windowsHide: true, env: { ...process.env, NODE_OPTIONS: '--require ' + JSON.stringify(process.env.HOOK) } }, () => {});\n`;
        inChild(script, { ...withoutVariable(), [VARIABLE]: '1' }, folder);
        expect(ran()).toBe(false);
    });

    it('the reading of the mark reads what it wrote', async () => {
        await new Promise((done) => { execFile(join(folder, 'git.exe'), [], { windowsHide: true }, () => done(null)); });
        expect(readFileSync(mark, 'utf8')).toContain('git.exe');
    });
});
