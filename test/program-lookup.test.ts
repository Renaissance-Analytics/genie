import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { platformArgv } from '../src/core/toolchain.js';
import { execInProcess } from '../src/main/spawn-exec.js';
import { findBatchFile, hardenProcess, notFoundWords, resolveProgram, systemProgram } from '../src/core/program-lookup.js';
import { open as openEngine } from '@particle-academy/fancy-pty';
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

describe('the engine in the lock', () => {
    it('is at least the one whose bare names stay out of the working folder', () => {
        const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version?: string }> };
        const [major, minor] = (lock.packages['node_modules/@particle-academy/fancy-pty']?.version ?? '0.0.0').split('.').map(Number);
        expect(major! > 0 || minor! >= 4).toBe(true);
    });
});

describe('every process starts with it', () => {
    const firstImport = (file: string) => /^\s*import\s+[^;]*?['"]([^'"]+)['"]/m.exec(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'))?.[1];
    it.each(['src/main/entry.ts', 'src/main/spawn-host.ts', 'src/main/genie-host.ts'])('%s imports it before anything else', (file) => {
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

describe('the words for a name that would not start', () => {
    const on = (files: string[], path: string) => ({ platform: 'win32' as const, env: { PATH: path, SystemRoot: 'C:\\Windows' }, isFile: (p: string) => files.includes(p.toLowerCase()) });
    it('a batch file on PATH is found now, by name or with its extension', () => {
        expect(findBatchFile('npm', on(['c:\\node\\npm.cmd'], 'C:\\node'))).toBe('C:\\node\\npm.cmd');
        expect(findBatchFile('npm.cmd', on(['c:\\node\\npm.cmd'], 'C:\\node'))).toBe('C:\\node\\npm.cmd');
        expect(findBatchFile('npm', on([], 'C:\\node'))).toBeNull();
    });
    it('nothing: says not found, and a batch file only in a relative PATH entry does not count', () => {
        expect(notFoundWords('npm', on(['node\\npm.cmd'], 'node'))).toBe('"npm" was not found on this machine\'s PATH, so nothing was started.');
    });
});

describe("a person's terminal and everyone else's", () => {
    const backend = () => {
        const made: Array<Record<string, unknown>> = [];
        return { made, port: fancyTermPort({ create: (o: Record<string, unknown>) => { made.push(o); return { id: String(o.id), pid: 1, shell: 'cmd', existing: false, scrollback: '' }; }, on: () => {}, kill: () => {}, write: () => {}, resize: () => {}, getScrollback: () => '' } as never, { defaultShell: () => ({ command: 'cmd', args: [] }) }) };
    };
    const envOf = (made: Array<Record<string, unknown>>) => made[0]!['env'] as Record<string, string | undefined>;

    it('the engine is never handed an empty environment, which it cannot start on Windows: an empty one still carries the terminal id', () => {
        const b = backend();
        b.port.open({ cwd: '/w', env: {} });
        expect(Object.keys(envOf(b.made)).length).toBeGreaterThan(0);
    });

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
        expect(opens('linux', { command: 'tool arg' })).toBe('tool');
    });

    it('a name that is not on this machine: it says so in words, naming what was asked for and no path it invented, and the engine is never called', () => {
        const made: Array<Record<string, unknown>> = [];
        const port = fancyTermPort({ create: (o: Record<string, unknown>) => { made.push(o); return { id: String(o.id), pid: 1, shell: 'x', existing: false, scrollback: '' }; }, on: () => {}, kill: () => {}, write: () => {}, resize: () => {}, scrollback: () => '', attach: () => null } as never, { defaultShell: () => ({ command: 'cmd.exe', args: [] }), platform: 'win32' });
        let words = '';
        try { port.open({ cwd: '/w', command: 'nothing-by-this-name arg' }); } catch (error) { words = (error as Error).message; }
        expect(words).toMatch(/"nothing-by-this-name" was not found/);
        expect(words).not.toMatch(/System32|\.exe/);
        expect(made).toEqual([]);
    });

    it("an agent's or Genie's: it stays as inherited", () => {
        const b = backend();
        b.port.open({ cwd: '/w', command: 'x', shell: true });
        expect(Object.hasOwn(envOf(b.made), VARIABLE)).toBe(false);
    });

    it('wired: the tab, Take Over, the scratch terminal and a remote person are personal; an agent is not', () => {
        expect(/localTerminals: createNativeTerminalPort\(\{/.test(readFileSync('src/main/main.ts', 'utf8'))).toBe(true);
        for (const file of ['src/main/local-terminal-native.ts', 'src/main/take-over-host.ts', 'src/main/scratch-terminal.ts', 'src/main/host-api.ts']) expect(/personal: true/.test(readFileSync(file, 'utf8')), file).toBe(true);
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

describe('a system program by its whole path, for text another program runs', () => {
    const env = { SystemRoot: 'D:\\Win' };
    it.each([
        ['powershell', 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
        ['powershell.exe', 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
        ['certutil', 'D:\\Win\\System32\\certutil.exe'],
    ])('%s', (name, whole) => { expect(systemProgram(name, env)).toBe(whole); });

    it('with no usable SystemRoot, the usual folder', () => {
        expect(systemProgram('certutil', {})).toBe('C:\\Windows\\System32\\certutil.exe');
        expect(systemProgram('certutil', { SystemRoot: 'relative' })).toBe('C:\\Windows\\System32\\certutil.exe');
    });

    it('a name it does not know is refused, not guessed', () => {
        expect(() => systemProgram('caddy', env)).toThrow(/caddy/);
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

    // What the spawn rows above cannot see: a program named inside text that another program runs.
    const IN_A_SCRIPT = [/-FilePath\s+'[^'\\/$]+'/, /(?<!&)&\s+'?[a-zA-Z][\w.-]*'?\s+-/];
    const namesOneInAScript = (text: string) => IN_A_SCRIPT.some((reading) => reading.test(text));
    it.each([
        ["Start-Process -FilePath 'powershell.exe' -Verb RunAs"],
        ["Start-Process -Wait -FilePath 'powershell' -ArgumentList @()"],
        ['$null = & certutil -generateSSTFromWU $sst'],
        ["& 'certutil' -addstore"],
    ])('the reading catches a bare name in a script: %s', (text) => { expect(namesOneInAScript(text)).toBe(true); });
    it.each([
        ["Start-Process -FilePath 'C:\\Windows\\System32\\cmd.exe'"],
        ['Start-Process -FilePath ${psQuote(path)}'],
        ['one && two -x'],
    ])('the reading leaves: %s', (text) => { expect(namesOneInAScript(text)).toBe(false); });

    it('no script under src/main and src/core names a program bare', () => {
        expect(['src/main', 'src/core'].flatMap(walk).filter((file) => namesOneInAScript(code(file)))).toEqual([]);
    });

    it('the central runner resolves, and a line given to a shell stays a line', () => {
        const source = code('src/main/spawn-exec.ts');
        expect(source).toMatch(/resolveProgram\(/);
        expect(source).toMatch(/options\.shell === true \? binary : resolveProgram\(binary\)/);
    });

    it('the shell line names the system cmd', () => {
        expect(code('src/core/shell-launch.ts')).toMatch(/resolveProgram\('cmd\.exe',/);
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
        rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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

    /** The engine itself, with none of Genie's resolving in front of it: what it printed, once it has ended. */
    const throughTheEngine = (argv: string[]) => new Promise<string>((resolve) => {
        let out = '';
        const pty = openEngine({ argv, cwd: folder, env: { ...process.env } as Record<string, string>, cols: 80, rows: 24 });
        pty.onData((chunk) => { out += chunk.toString('utf8'); });
        pty.onError((error) => { resolve(`${out}${error.message}`); });
        pty.onExit(() => { resolve(out); });
    });

    it('the engine: a bare name runs the installed program, not the one in the working folder', async () => {
        // Not --version: node answers that before it loads the hook, so the planted copy could run and leave no mark.
        const out = await throughTheEngine(['git', 'status']);
        expect(ran()).toBe(false);
        // It did run something: the real one, in a folder that is no repo.
        expect(out).toMatch(/not a git repository/);
    }, 30_000);

    it('the engine: a bare name found only in the working folder does not run', async () => {
        copyFileSync(process.execPath, join(folder, 'onlyhere.exe'));
        await throughTheEngine(['onlyhere', 'status']);
        expect(ran()).toBe(false);
    }, 30_000);

    it('CONTROL the engine: by its whole path it runs, so the two above can see', async () => {
        await throughTheEngine([join(folder, 'git.exe'), 'status']);
        expect(ran()).toBe(true);
    }, 30_000);

    /** The engine in a node of its own, whose current folder is the planted one: a relative name means that folder, not the `cwd` option. */
    const engineStartedInTheFolder = (program: string) => {
        const entry = join(process.cwd(), 'node_modules', '@particle-academy', 'fancy-pty', 'dist', 'index.cjs');
        const script = `const { open } = require(${JSON.stringify(entry)});
const pty = open({ argv: [${JSON.stringify(program)}, 'status'], cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '--require ' + JSON.stringify(process.env.HOOK) }, cols: 80, rows: 24 });
let out = '';
pty.onData((chunk) => { out += chunk.toString('utf8'); });
const end = () => { process.stdout.write(out); process.exit(0); };
pty.onError((error) => { out += error.message; end(); });
pty.onExit(end);`;
        return inChild(script, without(), folder);
    };

    it('the engine, started in the folder: a bare name runs the installed program, not the one beside it', () => {
        const child = engineStartedInTheFolder('git');
        expect(ran()).toBe(false);
        expect(child.stdout).toMatch(/not a git repository/);
    }, 40_000);

    it('CONTROL the engine, started in the folder: asked for that folder by name, it runs it, so the row above can see', () => {
        engineStartedInTheFolder('.\\git.exe');
        expect(ran()).toBe(true);
    }, 40_000);

    /** Through the real port and the real engine: what a person would read, and whether anything ran. */
    const openedThroughThePort = (command: string, cwd: string, until: (() => Promise<void>) | null = null) => {
        const settings = { get: (key: string) => (key === 'track_cwd' ? 'off' : key === 'detached_terminals' ? 'off' : undefined) };
        configureInProcessBackend({ settings, snapshots: { writeSnapshot: () => null, readSnapshot: () => null, deleteSnapshot: () => {}, encrypting: () => false } } as never);
        const port = fancyTermPort(inProcessBackend(), { defaultShell: () => resolveDefaultShell(settings) });
        try { const opened = port.open({ cwd, command }); if (until === null) port.kill(opened.id); else void until().finally(() => port.kill(opened.id)); return ''; } catch (error) { return (error as Error).message; }
    };

    it('a batch file on PATH really starts through the engine, from a folder with a space in its name, and gets its arguments', async () => {
        const tools = join(folder, 'tools with a space');
        mkdirSync(tools);
        // Not this folder's own: it stands for npm's folder under Program Files.
        writeFileSync(join(tools, 'batchtool.cmd'), `@echo %1 %2> "${mark}"\r\n`);
        const was = process.env.PATH;
        process.env.PATH = `${tools};${was}`;
        try {
            const arrived = async () => { for (let i = 0; i < 100 && !ran(); i += 1) await new Promise((r) => setTimeout(r, 100)); };
            expect(openedThroughThePort('batchtool run dev', tmpdir(), arrived)).toBe('');
            await arrived();
            await new Promise((r) => setTimeout(r, 200));
            expect(readFileSync(mark, 'utf8').trim()).toBe('run dev');
        } finally {
            process.env.PATH = was;
        }
    });

    it('the toolchain: a shim with a space in its path really runs, gets its arguments and reports its exit code; a planted one in the working folder does not', async () => {
        const tools = join(folder, 'tools with a space');
        mkdirSync(tools);
        const answer = join(folder, 'answer.txt');
        writeFileSync(join(tools, 'npm.cmd'), `@echo %1 %2> "${answer}"\r\n@exit /b 7\r\n`);
        writeFileSync(join(folder, 'npm.cmd'), `@echo ran> "${mark}"\r\n`);
        const was = process.env.PATH;
        process.env.PATH = `${tools};${was}`;
        try {
            const [binary, args] = platformArgv('npm', ['run', 'dev'], 'win32');
            const result = await execInProcess(binary, args, { cwd: folder });
            expect(readFileSync(answer, 'utf8').trim()).toBe('run dev');
            expect(result.exitCode).toBe(7);
            expect(ran()).toBe(false);
        } finally {
            process.env.PATH = was;
        }
    });

    it('a batch file and a program of that name in the working folder: not run, and not mentioned as if they were found', async () => {
        writeFileSync(join(folder, 'plantedtool.cmd'), `@echo ran> "${mark}"\r\n`);
        copyFileSync(process.execPath, join(folder, 'plantedtool.exe'));
        const words = openedThroughThePort('plantedtool status', folder);
        await new Promise((r) => setTimeout(r, 1_500));
        expect(words).toMatch(/"plantedtool" was not found/);
        expect(ran()).toBe(false);
    });

    it('a name in the folder when Genie itself started there: the same', async () => {
        writeFileSync(join(folder, 'plantedtool.cmd'), `@echo ran> "${mark}"\r\n`);
        const was = process.cwd();
        process.chdir(folder);
        try {
            const words = openedThroughThePort('plantedtool status', folder);
            await new Promise((r) => setTimeout(r, 1_500));
            expect(words).toMatch(/"plantedtool" was not found/);
            expect(ran()).toBe(false);
        } finally { process.chdir(was); }
    });

    it('resolving finds the real one with a PATH of its own', () => {
        const dir = join(folder, 'on path');
        mkdirSync(dir);
        copyFileSync(process.execPath, join(dir, 'tool.exe'));
        expect(resolveProgram('tool', { platform: 'win32', env: { PATH: dir, SystemRoot: process.env.SystemRoot } })).toBe(join(dir, 'tool.exe'));
    });
});
