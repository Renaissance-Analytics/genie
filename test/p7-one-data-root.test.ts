import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { systemProcessTree, type ProcessInfo } from '../src/core/process-tree.js';
import { LoginHost } from '../src/main/login-host.js';
import { nodeEnvelopePorts } from '../src/main/envelope-fs.js';
import * as launch from '../src/main/engine-launch.js';
import * as paths from '../src/main/paths.js';

/**
 * P7.1 — EVERY PATH FROM THE ONE ROOT (`.ai/plans/genie-2-host-split-2026-10-31.md`, "P7 build spec: one data root", item 1).
 *
 * Genie's data root is GENIE_HOME (default `~/.genie`). The OSA home, the browser process's stores and `.process`, the login
 * scratch and envelope staging all derive from it: scratch under `<root>/cache/tmp`, one folder per process, created at once
 * with no process-table read, and the folders of processes that are gone swept DEFERRED (#1595: a cold Windows process-table
 * read measured 2.8 s), cancelled on shutdown. Nothing host-side names `homedir()`/`tmpdir()` but `paths.ts` and the
 * exceptions named in the guard below, each with its reason.
 */

const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });
const tempRoot = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };

// The modules this PR adds or reshapes, loaded by a path the type checker does not follow, so each row fails on its own.
interface PathsP7 {
    genieRoot(env: Record<string, string | undefined>, home: string): string;
    osaHomeDir(root: string): string;
    scratchDir(root: string): string;
}
interface ScratchModule {
    scratchArea(root: string, own?: { pid: number; started: number }): { readonly root: string; directory(): string };
    sweepOldScratch(root: string, deps: { readProcesses: () => Promise<readonly ProcessInfo[] | null>; signal?: AbortSignal; pid?: number }): Promise<void>;
    scheduleScratchSweep(root: string, deps: { schedule: (work: () => Promise<void>) => () => void; readProcesses: () => Promise<readonly ProcessInfo[] | null>; pid?: number }): () => void;
}
const p7 = paths as unknown as PathsP7;
async function scratchModule(): Promise<ScratchModule> { const path: string = '../src/main/scratch-area.js'; return import(path) as Promise<ScratchModule>; }
const row = (pid: number): ProcessInfo => ({ pid, ppid: 1, started: 1_000, name: 'node' });

describe('the one root', () => {
    const fakeHome = resolve('/', 'p7-fake-home', 'wish');

    it('is GENIE_HOME when it is set, and <home>/.genie when it is unset or empty', () => {
        const root = resolve('/', 'p7-root', 'genie-home');
        expect(p7.genieRoot({ GENIE_HOME: root }, fakeHome)).toBe(root);
        expect(p7.genieRoot({}, fakeHome)).toBe(join(fakeHome, '.genie'));
        expect(p7.genieRoot({ GENIE_HOME: '' }, fakeHome)).toBe(join(fakeHome, '.genie'));
    });

    it('the OSA home and the scratch are under the root, whatever the person’s home is', () => {
        const root = resolve('/', 'p7-root', 'genie-home');
        expect(p7.osaHomeDir(root)).toBe(join(root, 'osa'));
        expect(p7.scratchDir(root)).toBe(join(root, 'cache', 'tmp'));
    });
});

describe('the scratch area: one folder per process, made at once, the gone ones swept later', () => {
    it('this process’s folder is under <root>/cache/tmp and exists before any process-table read', async () => {
        const { scratchArea } = await scratchModule();
        const root = tempRoot('genie-p7-scratch-');
        const read = vi.spyOn(systemProcessTree, 'read');
        const area = scratchArea(root);
        const dir = area.directory();
        expect(dirname(dir)).toBe(p7.scratchDir(root));
        expect(basename(dir)).toMatch(new RegExp(`^${process.pid}-[1-9][0-9]*$`));
        expect(statSync(dir).isDirectory()).toBe(true);
        expect(area.directory()).toBe(dir);
        expect(read).not.toHaveBeenCalled();
        if (process.platform !== 'win32') expect(statSync(dir).mode & 0o077).toBe(0);
    });

    it('the deferred sweep removes a gone process’s folder and keeps a live one’s, this process’s and anything not a process folder', async () => {
        const { scratchArea, sweepOldScratch } = await scratchModule();
        const root = tempRoot('genie-p7-sweep-');
        const tmp = p7.scratchDir(root);
        const own = scratchArea(root).directory();
        const gone = join(tmp, '424242-5'); const live = join(tmp, '515151-5'); const other = join(tmp, 'not-a-process');
        for (const d of [gone, live, other]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'left.txt'), 'x'); }
        // Positive control: the folder the sweep must remove is there before it runs.
        expect(existsSync(gone)).toBe(true);
        await sweepOldScratch(root, { readProcesses: async () => [row(process.pid), row(515151)] });
        expect(existsSync(gone)).toBe(false);
        expect(existsSync(live)).toBe(true);
        expect(existsSync(own)).toBe(true);
        expect(existsSync(other)).toBe(true);
    });

    it('with no process table, the sweep removes nothing', async () => {
        const { sweepOldScratch } = await scratchModule();
        const root = tempRoot('genie-p7-sweep-null-');
        const gone = join(p7.scratchDir(root), '424242-5');
        mkdirSync(gone, { recursive: true });
        await sweepOldScratch(root, { readProcesses: async () => null });
        expect(existsSync(gone)).toBe(true);
    });

    it('is scheduled, not run, at start; run, it sweeps; stopped (shutdown) before it runs, it reads no table and removes nothing', async () => {
        const { scheduleScratchSweep } = await scratchModule();
        const runs = async (stopFirst: boolean) => {
            const root = tempRoot('genie-p7-schedule-');
            const gone = join(p7.scratchDir(root), '424242-5');
            mkdirSync(gone, { recursive: true });
            let work: (() => Promise<void>) | null = null;
            const readProcesses = vi.fn(async () => [row(process.pid)] as readonly ProcessInfo[]);
            const stop = scheduleScratchSweep(root, { schedule: (w) => { work = w; return () => { work = null; }; }, readProcesses });
            expect(work).toBeTypeOf('function');
            expect(readProcesses).not.toHaveBeenCalled();
            const scheduled = work as unknown as () => Promise<void>;
            if (stopFirst) stop();
            await scheduled();
            return { gone: existsSync(gone), read: readProcesses.mock.calls.length };
        };
        // Control: not stopped, the scheduled work sweeps the gone folder.
        expect(await runs(false)).toEqual({ gone: false, read: 1 });
        expect(await runs(true)).toEqual({ gone: true, read: 0 });
    });
});

describe('the login scratch and envelope staging come from the caller’s root', () => {
    it('a login runs in a folder under the scratch it is given, and nothing is made in the OS temp folder', () => {
        const scratch = tempRoot('genie-p7-login-');
        const before = readdirSync(tmpdir()).filter((n) => n.startsWith('genie-login-p7probe-'));
        const opened: Array<{ cwd: string }> = [];
        const host = new LoginHost({
            terminals: { open: ((o: { cwd: string }) => { opened.push(o); return { id: 't1', pid: 1, shell: 'sh' }; }) as never, onExit: (() => () => {}) as never },
            openWindow: () => {},
            runStatus: async () => 1,
            onSignedIn: () => {},
            scratch: () => scratch,
        });
        expect(host.start('p7probe')).toEqual({ ok: true, terminalId: 't1' });
        expect(dirname(opened[0]!.cwd)).toBe(scratch);
        expect(existsSync(opened[0]!.cwd)).toBe(true);
        expect(readdirSync(tmpdir()).filter((n) => n.startsWith('genie-login-p7probe-'))).toEqual(before);
    });

    it('Import from Git stages under the folder it is given, owns it, and removes it', async () => {
        const base = tempRoot('genie-p7-stage-');
        const env = nodeEnvelopePorts({ stagingBase: () => base });
        const stage = await env.staging.make();
        expect(dirname(stage)).toBe(base);
        expect(env.staging.owns(stage)).toBe(true);
        expect(env.staging.owns(join(tmpdir(), 'genie-import-elsewhere'))).toBe(false);
        await env.staging.remove(stage);
        expect(existsSync(stage)).toBe(false);
    });
});

// --- THE SOURCE GUARD ------------------------------------------------------------------------------------------------

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

/** The static import graph from an entry (test/genie-host-no-electron.test.ts's walk). */
function graph(entry: string): Set<string> {
    const seen = new Set<string>();
    const walk = (file: string): void => {
        if (seen.has(file) || !existsSync(file)) return;
        seen.add(file);
        for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
            const spec = m[1] ?? m[2];
            if (spec && spec.startsWith('.')) walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
        }
    };
    walk(resolve(entry));
    return seen;
}

/**
 * HOST-SIDE CODE: everything genie-host's entry reaches by static import, plus the two processes the host starts (the
 * browser process and the updater helper) and theirs. The login scratch and envelope staging are the window's (main.ts),
 * named here because the spec names them: they must take their folder from their caller, never default to the OS temp.
 */
const ENTRIES = ['src/main/genie-host.ts', 'src/main/browser-process.ts', 'src/main/updater-process.ts'];
const NAMED = ['src/main/login-host.ts', 'src/main/envelope-fs.ts'];
const hostSide = (): string[] => {
    const all = new Set<string>();
    for (const e of ENTRIES) for (const f of graph(e)) all.add(f);
    for (const f of NAMED) all.add(resolve(f));
    return [...all].filter((f) => f.endsWith('.ts'));
};
const rel = (file: string): string => file.slice(resolve('.').length + 1).replace(/\\/g, '/');

/** Code lines only: a `//` comment line, a block comment's lines and a trailing `// …` say nothing the guard counts. */
function codeLines(file: string): Array<{ line: number; text: string }> {
    const out: Array<{ line: number; text: string }> = [];
    let inBlock = false;
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((raw, i) => {
        let text = raw.trim();
        if (inBlock) { if (text.includes('*/')) { inBlock = false; text = text.slice(text.indexOf('*/') + 2).trim(); } else return; }
        if (text.startsWith('/*')) { if (!text.includes('*/')) { inBlock = true; return; } text = text.slice(text.indexOf('*/') + 2).trim(); }
        if (text.startsWith('//') || text.startsWith('*') || text === '') return;
        out.push({ line: i + 1, text: text.replace(/\s\/\/\s.*$/, '') });
    });
    return out;
}

const OS_PATHS = /\bhomedir\b|\btmpdir\b|\bos\.tmpdir\b/;

/** The one module that names the person's home: GENIE_HOME's default (~/.genie) is derived there and nowhere else. */
const PATHS = 'src/main/paths.ts';

/**
 * THE EXCEPTIONS, each a file, the exact code lines allowed in it, and why. Neither writes a byte of Genie's data.
 */
const EXCEPTIONS: Record<string, { lines: string[]; why: string }> = {
    // RCE-on-open hardening (genie#1569's family): on Windows every process moves its working folder to the person's home,
    // so no program is ever resolved from an untrusted folder it was started in. A working folder, not a write.
    'src/core/program-lookup.ts': {
        lines: ["import { homedir } from 'node:os';", 'export function hardenProcess(ports: ProcessPorts = { platform: process.platform, env: process.env, home: homedir, chdir: (to) => process.chdir(to) }): void {'],
        why: 'the process working folder is the person’s home, never one it was started in (Windows program lookup)',
    },
    // A provider CLI's model list is asked outside any project, from the person's home, where that CLI's own settings and
    // account live: the spec's "provider CLIs' own homes". A working folder for a short-lived ask, not a write of Genie's.
    'src/main/session-host.ts': {
        lines: ["import { homedir } from 'node:os';", 'return { ...providerLaunchOptions(providerBinary(provider, env, ports), {}, runtime), cwd: homedir(), timeoutMs: MODEL_LIST_TIMEOUT_MS };'],
        why: 'a provider’s model list is asked from its own home, outside any project',
    },
};

describe('the source guard: every host-side path from the one root', () => {
    const files = hostSide();
    const hits = (pattern: RegExp) => files.flatMap((f) => codeLines(f).filter((l) => pattern.test(l.text)).map((l) => ({ file: rel(f), ...l })));

    it('reads the host’s whole graph and the named files (positive control: the scanner finds paths.ts’s homedir)', () => {
        const names = files.map(rel);
        for (const f of ['src/main/session-host.ts', 'src/main/paths.ts', 'src/main/browser-process.ts', 'src/main/updater-process.ts', 'src/main/login-host.ts', 'src/main/envelope-fs.ts', 'src/main/host-mcp.ts']) expect(names).toContain(f);
        expect(hits(OS_PATHS).some((h) => h.file === PATHS)).toBe(true);
    });

    it('names homedir()/tmpdir()/os.tmpdir nowhere but paths.ts and the named exceptions', () => {
        const offenders = hits(OS_PATHS).filter((h) => h.file !== PATHS && !(EXCEPTIONS[h.file]?.lines.includes(h.text) ?? false)).map((h) => `${h.file}:${h.line}: ${h.text}`);
        expect(offenders).toEqual([]);
    });

    it('every exception is still there, as written (a stale exception is a hole)', () => {
        for (const [file, { lines }] of Object.entries(EXCEPTIONS)) {
            const text = codeLines(resolve(file)).map((l) => l.text);
            for (const line of lines) expect(text, `${file}: ${line}`).toContain(line);
        }
    });

    it('reads GENIE_HOME in paths.ts only: one place decides the root', () => {
        const offenders = hits(/\benv\.GENIE_HOME\b|\benv\[['"]GENIE_HOME['"]\]/).filter((h) => h.file !== 'src/main/paths.ts').map((h) => `${h.file}:${h.line}: ${h.text}`);
        expect(offenders).toEqual([]);
    });

    it('never asks for ~/.genie or its OSA folder with no root: genieHome() and osaHomeDir() are always given one', () => {
        const offenders = hits(/\bgenieHome\(\)|\bosaHomeDir\(\)/).filter((h) => h.file !== 'src/main/paths.ts').map((h) => `${h.file}:${h.line}: ${h.text}`);
        expect(offenders).toEqual([]);
    });
});

describe('the window wires its scratch from its root, and stops the sweep on quit', () => {
    const main = readFileSync('src/main/main.ts', 'utf8');
    it('the login and Import from Git take the scratch area’s folder; the sweep is scheduled and stopped in before-quit', () => {
        expect(main).toMatch(/scratchArea\(genieRoot\(\)\)/);
        expect(main).toMatch(/new LoginHost\(\{[\s\S]{0,400}scratch: \(\) => /);
        expect(main).toMatch(/nodeEnvelopePorts\(\{ stagingBase: /);
        expect(main).toMatch(/scheduleScratchSweep\(genieRoot\(\)/);
        const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"));
        expect(beforeQuit.slice(0, 3000)).toMatch(/scratchSweepStop\?\.\(\)/);
    });
});

/**
 * #1605: THE WINDOW READS ITS ROOT THROUGH genieRoot() TOO, so every Genie process has one reader of GENIE_HOME, and the
 * window passes that same root to the host. Before, a GENIE_HOME set for the whole app was overridden by the window's
 * default (`genieHome()`, ~/.genie) when it started the host.
 */
interface HostSpawnSpec { file: string; args: readonly string[]; options: { env: Record<string, string | undefined>; detached: boolean } }
const hostSpawnSpec = (launch as unknown as { hostSpawnSpec(ports: { execPath: string; hostScript: string; env: Record<string, string | undefined>; genieHome: string; build: string }): HostSpawnSpec }).hostSpawnSpec;

describe('the window’s root is genieRoot(), and the host is started on that same root (#1605)', () => {
    const fakeHome = resolve('/', 'p7-fake-home', 'wish');

    it('with GENIE_HOME set for the app, the window’s root and the host’s GENIE_HOME are both that value', () => {
        const set = resolve('/', 'p7-app-root', 'genie');
        const env = { GENIE_HOME: set, PATH: 'p' };
        const root = p7.genieRoot(env, fakeHome);
        const spec = hostSpawnSpec({ execPath: 'genie-exe', hostScript: 'host.js', env, genieHome: root, build: 'b1' });
        expect(root).toBe(set);
        expect(spec.options.env['GENIE_HOME']).toBe(set);
        expect(spec.options.env['ELECTRON_RUN_AS_NODE']).toBe('1');
        expect(spec.options.env['GENIE_HOST_BUILD']).toBe('b1');
        expect(spec).toMatchObject({ file: 'genie-exe', args: ['host.js'], options: { detached: true } });
    });

    it('control: with no GENIE_HOME, the root is <home>/.genie as before, and the host is told that', () => {
        const root = p7.genieRoot({ PATH: 'p' }, fakeHome);
        expect(root).toBe(join(fakeHome, '.genie'));
        expect(hostSpawnSpec({ execPath: 'genie-exe', hostScript: 'host.js', env: { PATH: 'p' }, genieHome: root, build: 'b1' }).options.env['GENIE_HOME']).toBe(join(fakeHome, '.genie'));
    });

    it('the window (main.ts) and the doctor never call genieHome(): every root they use is genieRoot(), the host’s launch included', () => {
        for (const file of ['src/main/main.ts', 'src/main/doctor.ts']) {
            const offenders = codeLines(resolve(file)).filter((l) => /\bgenieHome\(\)/.test(l.text)).map((l) => `${file}:${l.line}: ${l.text}`);
            expect(offenders).toEqual([]);
        }
        const main = codeLines(resolve('src/main/main.ts')).map((l) => l.text).join('\n');
        // Positive control: the window does name its root, through genieRoot().
        expect(main).toMatch(/genieHome: genieRoot\(\),/);
        expect(main).toMatch(/runtimeDir: runtimeDir\(genieRoot\(\)\),/);
    });

    it('spawnHostProcess starts the host from hostSpawnSpec, the one place its environment is made', () => {
        const src = readFileSync('src/main/engine-launch.ts', 'utf8');
        const body = src.slice(src.indexOf('export async function spawnHostProcess'), src.indexOf('export async function linkToRunningHost'));
        // CONTROL: the slice is the function (an empty one matches nothing and proves nothing).
        expect(body).toMatch(/^export async function spawnHostProcess/);
        expect(body).toMatch(/hostSpawnSpec\(ports\)/);
        expect(body).not.toMatch(/GENIE_HOME:/);
    });
});
