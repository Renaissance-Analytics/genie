import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hardenProcess, resolveProgram } from '../src/core/program-lookup.js';
import { configureInProcessBackend, inProcessBackend, resolveDefaultShell } from '@particle-academy/fancy-term-host';
import { fancyTermPort } from '../src/main/fancy-term-port.js';
import { providerLaunchOptions } from '../src/main/session-host.js';
import { gitFileStatus, gitLogSince, gitShowHead, gitTreeStatus } from '../src/main/git-ports.js';
import { repoStatus } from '../src/main/repo-git.js';

/** How a program is found on Windows: by a whole path, from Genie's own PATH, whatever the working folder is. */
const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';

describe('hardenProcess', () => {
    it('on Windows: the variable, and a folder of its own', () => {
        const env: NodeJS.ProcessEnv = {};
        const went: string[] = [];
        hardenProcess({ platform: 'win32', env, home: () => 'C:\\Users\\a', chdir: (to) => went.push(to) });
        expect(env[VARIABLE]).toBe('1');
        expect(went).toEqual(['C:\\Users\\a']);
    });

    it('elsewhere: nothing', () => {
        const env: NodeJS.ProcessEnv = {};
        const went: string[] = [];
        hardenProcess({ platform: 'linux', env, home: () => '/home/a', chdir: (to) => went.push(to) });
        expect(env).toEqual({});
        expect(went).toEqual([]);
    });

    it('a folder it cannot go to is no reason not to start', () => {
        const env: NodeJS.ProcessEnv = {};
        expect(() => hardenProcess({ platform: 'win32', env, home: () => 'C:\\gone', chdir: () => { throw new Error('ENOENT'); } })).not.toThrow();
        expect(env[VARIABLE]).toBe('1');
    });
});

describe('every process starts with it', () => {
    const firstImport = (file: string) => /^\s*import\s+[^;]*?['"]([^'"]+)['"]/m.exec(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'))?.[1];
    it.each(['src/main/entry.ts', 'src/main/spawn-host.ts'])('%s imports it before anything else', (file) => {
        expect(firstImport(file)).toMatch(/process-start\.js$/);
    });
});

describe('resolveProgram, on any OS, with a fake machine', () => {
    const machine = (files: readonly string[], path: string, pathExt = '.COM;.EXE;.BAT;.CMD') => ({ platform: 'win32' as const, env: { PATH: path, PATHEXT: pathExt, SystemRoot: 'C:\\Windows' }, isFile: (p: string) => files.includes(p.toLowerCase()) });

    it('a whole path found on PATH', () => {
        expect(resolveProgram('git', machine(['c:\\git\\cmd\\git.exe'], 'C:\\Windows\\System32;C:\\Git\\cmd'))).toBe('C:\\Git\\cmd\\git.exe');
    });

    it('a relative PATH entry is not looked in', () => {
        expect(resolveProgram('git', machine(['.\\git.exe', 'c:\\git\\git.exe'], '.;bin;;C:\\Git'))).toBe('C:\\Git\\git.exe');
    });

    it('the first absolute entry wins, in PATH order', () => {
        expect(resolveProgram('git', machine(['c:\\a\\git.exe', 'c:\\b\\git.exe'], 'C:\\a;C:\\b'))).toBe('C:\\a\\git.exe');
    });

    it('quotes around an entry are the entry', () => {
        expect(resolveProgram('git', machine(['c:\\a b\\git.exe'], '"C:\\a b"'))).toBe('C:\\a b\\git.exe');
    });

    it('only what Windows would start without a shell: a .cmd of that name is not it', () => {
        expect(resolveProgram('npm', machine(['c:\\node\\npm.cmd'], 'C:\\node'))).toMatch(/^C:\\Windows\\System32\\npm(\.exe)?$/);
    });

    it('not found: a whole path that does not exist, so it fails as not found, never a search', () => {
        expect(resolveProgram('nothing', machine([], 'C:\\Windows\\System32'))).toBe('C:\\Windows\\System32\\nothing.exe');
    });

    it.each([['cmd', 'cmd.exe'], ['cmd.exe', 'cmd.exe'], ['reg', 'reg.exe'], ['taskkill', 'taskkill.exe'], ['netsh', 'netsh.exe'], ['where', 'where.exe']])('%s is the system\'s, whatever PATH says', (name, file) => {
        expect(resolveProgram(name, machine(['c:\\first\\cmd.exe', 'c:\\first\\reg.exe', 'c:\\first\\taskkill.exe', 'c:\\first\\netsh.exe', 'c:\\first\\where.exe'], 'C:\\first'))).toBe(`C:\\Windows\\System32\\${file}`);
    });

    it.each([['powershell'], ['powershell.exe']])('%s is the system\'s', (name) => {
        expect(resolveProgram(name, machine(['c:\\first\\powershell.exe'], 'C:\\first'))).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    });

    it('a SystemRoot that is not a whole path is not believed', () => {
        expect(resolveProgram('cmd', { ...machine([], ''), env: { PATH: '', SystemRoot: 'evil' } })).toBe('C:\\Windows\\System32\\cmd.exe');
    });

    it('a name with a folder in it is the caller\'s: nothing is looked up', () => {
        expect(resolveProgram('C:\\x\\y.exe', machine([], ''))).toBe('C:\\x\\y.exe');
        expect(resolveProgram('.\\y.exe', machine([], ''))).toBe('.\\y.exe');
    });

    it('elsewhere: the name, for the OS to find', () => {
        expect(resolveProgram('git', { platform: 'linux', env: { PATH: '/usr/bin' }, isFile: () => true })).toBe('git');
    });
});

describe("a person's terminal and everyone else's", () => {
    const backend = () => {
        const made: Array<Record<string, unknown>> = [];
        return { made, port: fancyTermPort({ create: (o: Record<string, unknown>) => { made.push(o); return { id: String(o.id), pid: 1, shell: 'cmd', existing: false, scrollback: '' }; }, on: () => {}, kill: () => {}, write: () => {}, resize: () => {}, getScrollback: () => '' } as never, { defaultShell: () => ({ command: 'cmd', args: [] }) }) };
    };
    const envOf = (made: Array<Record<string, unknown>>) => made[0]!['env'] as Record<string, string | undefined>;

    it("a person's: the variable is taken off, so it behaves as Windows does", () => {
        const b = backend();
        b.port.open({ cwd: '/w', personal: true });
        expect(Object.hasOwn(envOf(b.made), VARIABLE)).toBe(true);
        expect(envOf(b.made)[VARIABLE]).toBeUndefined();
    });

    it('the engine is handed a whole path on Windows, for a line, a split command and a plain shell; elsewhere the name', () => {
        const opens = (platform: NodeJS.Platform, spawn: Record<string, unknown>) => {
            const made: Array<Record<string, unknown>> = [];
            const port = fancyTermPort({ create: (o: Record<string, unknown>) => { made.push(o); return { id: String(o.id), pid: 1, shell: 'x', existing: false, scrollback: '' }; }, on: () => {}, kill: () => {}, write: () => {}, resize: () => {}, getScrollback: () => '' } as never, { platform, defaultShell: () => ({ command: 'cmd', args: [] }) });
            port.open({ cwd: '/w', ...spawn } as never);
            return String(made[0]!['shell']);
        };
        expect(opens('win32', { command: 'echo hi', shell: true })).toMatch(/^[A-Za-z]:.*\\System32\\cmd\.exe$/);
        expect(opens('win32', {})).toMatch(/^[A-Za-z]:.*\\System32\\cmd\.exe$/);
        expect(opens('win32', { command: 'nothing-by-this-name arg' })).toMatch(/^[A-Za-z]:.*\\nothing-by-this-name\.exe$/);
        expect(opens('linux', { command: 'tool arg' })).toBe('tool');
    });

    it("an agent's or Genie's: it stays as inherited", () => {
        const b = backend();
        b.port.open({ cwd: '/w', command: 'x', shell: true });
        expect(Object.hasOwn(envOf(b.made), VARIABLE)).toBe(false);
    });

    it('wired: the tab, Take Over, the scratch terminal and a remote person are personal; an agent is not', () => {
        for (const file of ['src/main/main.ts', 'src/main/take-over-host.ts', 'src/main/scratch-terminal.ts', 'src/main/host-api.ts']) expect(readFileSync(file, 'utf8'), file).toMatch(/personal: true/);
        expect(readFileSync('src/main/mcp-tools-more.ts', 'utf8')).not.toMatch(/personal/);
    });
});

describe('a provider, whose environment is an allow-list', () => {
    it('gets the variable when this process has it', () => {
        const was = process.env[VARIABLE];
        process.env[VARIABLE] = '1';
        try {
            const options = providerLaunchOptions(undefined, {}, { execPath: 'x', electron: false });
            expect(options.allowEnv).toContain(VARIABLE);
            expect(options.parentEnv?.[VARIABLE]).toBe('1');
        } finally { if (was === undefined) delete process.env[VARIABLE]; else process.env[VARIABLE] = was; }
    });
});

describe('no bare name is spawned', () => {
    const code = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = `${dir}/${name}`; return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : []; });
    const BARE = /\b(?:execFile|execFileSync|execFileAsync|execFileText|spawn|spawnSync|promisify\(execFile\))\(\s*['"`]/;
    it.each([["execFile('git', [])"], ["execFileSync('powershell', [])"], ['spawn("netsh", args)'], ["promisify(execFile)('taskkill', [])"], ["execFileText('tailscale', [])"]])('the reading sees %s', (text) => { expect(text).toMatch(BARE); });
    it('the reading leaves a resolved one', () => { expect("execFile(resolveProgram('git'), [])").not.toMatch(BARE); });

    it('under src/main and src/core', () => {
        expect(['src/main', 'src/core'].flatMap(walk).filter((file) => BARE.test(code(file)))).toEqual([]);
    });

    it('the central runner resolves, and a line given to a shell stays a line', () => {
        const source = code('src/main/spawn-exec.ts');
        expect(source).toMatch(/resolveProgram\(/);
        expect(source).toMatch(/options\.shell === true \? binary : resolveProgram\(binary\)/);
    });

    it('the shell line names the system cmd', () => {
        expect(code('src/core/shell-launch.ts')).toMatch(/resolveProgram\('cmd\.exe'\)/);
    });
});

/** Real Windows. A program from the folder says so through the hook, which a real git never reads; a bare --version would not reach it. */
describe.skipIf(process.platform !== 'win32')('on Windows, through the real functions', () => {
    let folder: string;
    let mark: string;
    let hook: string;
    const before = process.env.NODE_OPTIONS;
    const ran = () => existsSync(mark);
    const quiet = (work: Promise<unknown>) => work.catch(() => null);
    beforeEach(() => {
        folder = mkdtempSync(join(tmpdir(), 'lookup-'));
        mark = join(folder, 'mark.txt');
        hook = join(folder, 'hook.cjs');
        writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(mark)}, process.execPath);\nprocess.exit(0);\n`);
        for (const name of ['git.exe', 'reg.exe', 'taskkill.exe']) copyFileSync(process.execPath, join(folder, name));
        process.env.NODE_OPTIONS = `--require ${JSON.stringify(hook)}`;
        // Set on a machine, it would hide what these look for: resolving must hold with it gone.
        delete process.env[VARIABLE];
    });
    afterEach(() => {
        if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before;
        rmSync(folder, { recursive: true, force: true });
    });

    it('CONTROL: run by its path it does say so, so the mark can be seen', async () => {
        await new Promise((done) => { execFile(join(folder, 'git.exe'), ['status'], { cwd: folder, windowsHide: true }, () => done(null)); });
        expect(ran()).toBe(true);
    });

    it('gitTreeStatus', async () => { await quiet(gitTreeStatus(folder)); expect(ran()).toBe(false); });
    it('gitFileStatus', async () => { await quiet(gitFileStatus(folder, 'a.txt')); expect(ran()).toBe(false); });
    it('gitShowHead', async () => { await quiet(gitShowHead(folder, 'a.txt')); expect(ran()).toBe(false); });
    it('gitLogSince', async () => { await quiet(gitLogSince(folder, 0)); expect(ran()).toBe(false); });
    it('repoStatus', async () => { await quiet(repoStatus(folder, '.')); expect(ran()).toBe(false); });

    /** Each in a node of its own, whose own environment and folder are the question. */
    const inChild = (script: string, env: NodeJS.ProcessEnv, cwd: string) => {
        const file = join(tmpdir(), `lookup-child-${process.pid}-${Date.now()}.cjs`);
        writeFileSync(file, script);
        const clean = { ...env };
        delete clean.NODE_OPTIONS;
        try { return spawnSync(process.execPath, [file], { cwd, env: { ...clean, HOOK: hook }, encoding: 'utf8', timeout: 30_000, windowsHide: true }); } finally { rmSync(file, { force: true }); }
    };
    const without = () => { const env = { ...process.env }; delete env[VARIABLE]; return env; };
    const bare = (name: string, cwd: string | null, extra = '') => `require('node:child_process').execFile(${JSON.stringify(name)}, ['status'], { ${cwd ? `cwd: ${JSON.stringify(cwd)}, ` : ''}windowsHide: true, env: { ...process.env, NODE_OPTIONS: '--require ' + JSON.stringify(process.env.HOOK)${extra} } }, () => {});\n`;

    it('MEASURE not set: a bare name with a working folder finds the folder', () => {
        inChild(bare('git', folder), without(), tmpdir());
        console.log(`### lookup not-set-with-cwd ran=${ran()}`);
        // CONTROL for every 'false' below: with no variable and a bare name, Windows does look there. This is what the rest is protecting against.
        expect(ran()).toBe(true);
    });
    it('MEASURE set only in the spawn\'s env option', () => {
        inChild(bare('git', folder, `, ${VARIABLE}: '1'`), without(), tmpdir());
        console.log(`### lookup env-option-only ran=${ran()}`);
    });
    it('MEASURE set in the parent', () => {
        inChild(bare('git', folder), { ...without(), [VARIABLE]: '1' }, tmpdir());
        console.log(`### lookup set-in-parent ran=${ran()}`);
    });
    it('MEASURE not set: no working folder, the process itself started there', () => {
        inChild(bare('reg', null), without(), folder);
        console.log(`### lookup not-set-process-cwd ran=${ran()}`);
    });
    it('MEASURE set in the parent: the same', () => {
        inChild(bare('reg', null), { ...without(), [VARIABLE]: '1' }, folder);
        console.log(`### lookup set-process-cwd ran=${ran()}`);
    });
    it('MEASURE a PATH in the env option naming the folder, set in the parent', () => {
        inChild(bare('git', tmpdir(), `, PATH: ${JSON.stringify(`${folder}${delimiter}${process.env.PATH ?? ''}`)}`), { ...without(), [VARIABLE]: '1' }, tmpdir());
        console.log(`### lookup env-path-beats-variable ran=${ran()}`);
    });
    it('MEASURE cmd, not set', () => {
        spawnSync(process.env.ComSpec!, ['/d', '/c', 'git status'], { cwd: folder, env: { ...without(), NODE_OPTIONS: process.env.NODE_OPTIONS }, windowsHide: true });
        console.log(`### lookup cmd-not-set ran=${ran()}`);
    });
    it('MEASURE cmd, inherited', () => {
        spawnSync(process.env.ComSpec!, ['/d', '/c', 'git status'], { cwd: folder, env: { ...without(), NODE_OPTIONS: process.env.NODE_OPTIONS, [VARIABLE]: '1' }, windowsHide: true });
        expect(ran()).toBe(false);
    });
    it('MEASURE a folder-relative name still runs, under the variable', () => {
        spawnSync(process.env.ComSpec!, ['/d', '/c', '.\\git.exe status'], { cwd: folder, env: { ...without(), NODE_OPTIONS: process.env.NODE_OPTIONS, [VARIABLE]: '1' }, windowsHide: true });
        expect(ran()).toBe(true);
    });
    it('MEASURE an empty value counts', () => {
        spawnSync(process.env.ComSpec!, ['/d', '/c', 'git status'], { cwd: folder, env: { ...without(), NODE_OPTIONS: process.env.NODE_OPTIONS, [VARIABLE]: '' }, windowsHide: true });
        console.log(`### lookup empty-value ran=${ran()}`);
    });
    it("a real pty: a person's terminal has no variable, and an agent's has it", async () => {
        const settings = { get: (key: string) => (key === 'track_cwd' ? 'off' : key === 'detached_terminals' ? 'off' : undefined) };
        configureInProcessBackend({ settings, snapshots: { writeSnapshot: () => null, readSnapshot: () => null, deleteSnapshot: () => {}, encrypting: () => false } } as never);
        const pty = fancyTermPort(inProcessBackend(), { defaultShell: () => resolveDefaultShell(settings) });
        const was = process.env[VARIABLE];
        process.env[VARIABLE] = '1';
        const say = (personal: boolean) => new Promise<string>((resolve) => {
            let out = '';
            const opened = pty.open({ cwd: folder, command: `cmd.exe /d /c if defined ${VARIABLE} (echo HAS-IT) else (echo HAS-NOT)`, ...(personal ? { personal: true } : {}) });
            const offData = pty.onData((id, data) => { if (id === opened.id) out += data; });
            const offExit = pty.onExit((id) => { if (id !== opened.id) return; offData(); offExit(); resolve(out); });
        });
        try {
            // The title carries the command line, so only what it printed on a line of its own counts.
            const lines = (out: string) => out.replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
            expect(lines(await say(true))).toMatch(/HAS-NOT/);
            expect(lines(await say(false))).toMatch(/HAS-IT/);
        } finally { if (was === undefined) delete process.env[VARIABLE]; else process.env[VARIABLE] = was; }
    }, 30_000);

    it('resolving finds the real one with a PATH of its own', () => {
        const dir = join(folder, 'on path');
        mkdirSync(dir);
        copyFileSync(process.execPath, join(dir, 'tool.exe'));
        expect(resolveProgram('tool', { platform: 'win32', env: { PATH: dir, SystemRoot: process.env.SystemRoot } })).toBe(join(dir, 'tool.exe'));
    });
});
