import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { listModelsOptionsFor, providerBinary } from '../src/main/session-host.js';

/*
 * Tynn #577. A client's agent settings: "Couldn't get claude's list of models: could not start claude: the provider is
 * a batch file that is not an npm shim; give the path of its .exe instead". prism-acp refuses it, rightly: running a
 * .cmd needs cmd.exe, which interprets arguments. Genie finds the real program behind the wrapper and passes its whole
 * path, never running a batch file. When it can't, the message names the file found and offers a picker for the .exe,
 * kept per provider. Agent start and the model list share the one resolution.
 *
 * Windows paths on a fake disk: this is decided by strings and file checks, so it holds on any runner.
 */
const load = async () => { const path: string = '../src/core/provider-program.js'; return import(path) as Promise<any>; };
const loadChoice = async () => { const path: string = '../src/main/provider-choice.js'; return import(path) as Promise<any>; };
const loadView = async () => { const path: string = '../src/renderer/components/ProviderProgramChoice.js'; return import(path) as Promise<any>; };

const HOME = 'C:\\Users\\client';
const LOCAL = `${HOME}\\AppData\\Local`;
const BIN = 'C:\\tools\\bin';
const WRAPPER = `${BIN}\\claude.cmd`;
const NATIVE = `${HOME}\\.local\\bin\\claude.exe`;
const NPM_SHIM_TEXT = '@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
const env = { PATH: `${BIN};C:\\Windows`, PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: HOME, LOCALAPPDATA: LOCAL, APPDATA: `${HOME}\\AppData\\Roaming` };

/** A fake disk: path → text ('' for a binary). Windows paths compare without regard to case. */
function ports(files: Record<string, string>, chosen: string | null = null) {
    const disk = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
    return { platform: 'win32' as const, env, isFile: (p: string) => disk.has(p.toLowerCase()), readText: (p: string) => disk.get(p.toLowerCase()) ?? '', chosen: () => chosen };
}
const wrapper = (text = '@echo off\r\nsome-launcher claude %*\r\n') => ({ [WRAPPER]: text });

describe('finding the real program behind a batch wrapper', () => {
    it('prefers the native install', async () => {
        const { resolveProviderProgram } = await load();
        expect(resolveProviderProgram('claude', ports({ ...wrapper(), [NATIVE]: '' }))).toMatchObject({ kind: 'found', path: NATIVE });
    });

    it('reads the .exe a hand-made or Scoop wrapper names, without running it', async () => {
        const { resolveProviderProgram } = await load();
        const exe = `${HOME}\\scoop\\apps\\claude\\current\\claude.exe`;
        expect(resolveProviderProgram('claude', ports({ ...wrapper(`@echo off\r\n@"${exe}" %*\r\n`), [exe]: '' }))).toMatchObject({ kind: 'found', path: exe });
    });

    it('expands %USERPROFILE% and %~dp0, and takes the script a pnpm-style wrapper gives node', async () => {
        const { resolveProviderProgram } = await load();
        const script = 'C:\\tools\\global\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
        const text = '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" "%~dp0\\..\\global\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n) ELSE (\r\n  node "%~dp0\\..\\global\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)\r\n';
        expect(resolveProviderProgram('claude', ports({ ...wrapper(text), [script]: '', [`${BIN}\\node.exe`]: '' }))).toMatchObject({ kind: 'found', path: script });
        const exe = `${HOME}\\apps\\claude.exe`;
        expect(resolveProviderProgram('claude', ports({ ...wrapper('"%USERPROFILE%\\apps\\claude.exe" %*\r\n'), [exe]: '' }))).toMatchObject({ kind: 'found', path: exe });
    });

    it.each([
        ['Scoop', `${HOME}\\scoop\\apps\\claude-code\\current\\claude.exe`],
        ['Volta', `${LOCAL}\\Volta\\tools\\image\\packages\\@anthropic-ai\\claude-code\\node_modules\\@anthropic-ai\\claude-code\\cli.js`],
        ['pnpm', `${LOCAL}\\pnpm\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js`],
    ])('looks where %s installs it', async (_name, path) => {
        const { resolveProviderProgram } = await load();
        expect(resolveProviderProgram('claude', ports({ ...wrapper(), [path]: '' }))).toMatchObject({ kind: 'found', path });
    });

    it('never answers with a batch file or an interpreter a wrapper names', async () => {
        const { resolveProviderProgram } = await load();
        const other = 'C:\\tools\\inner.cmd', ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
        const text = `@call "${other}" %*\r\n"${ps}" -File C:\\tools\\claude.ps1 %*\r\n`;
        expect(resolveProviderProgram('claude', ports({ ...wrapper(text), [other]: '', [ps]: '' }))).toEqual({ kind: 'wrapper', file: WRAPPER });
    });

    it('CONTROL: an .exe first on PATH, an npm shim, nothing on PATH, and any other platform are left to the driver', async () => {
        const { resolveProviderProgram } = await load();
        expect(resolveProviderProgram('claude', ports({ [`${BIN}\\claude.exe`]: '', [WRAPPER]: 'x' }))).toEqual({ kind: 'default' });
        expect(resolveProviderProgram('claude', ports({ ...wrapper(NPM_SHIM_TEXT), [NATIVE]: '' }))).toEqual({ kind: 'default' });
        expect(resolveProviderProgram('claude', ports({}))).toEqual({ kind: 'default' });
        expect(resolveProviderProgram('claude', { ...ports({ ...wrapper(), [NATIVE]: '' }), platform: 'linux' })).toEqual({ kind: 'default' });
    });
});

describe('what the person chose', () => {
    const choice = 'D:\\tools\\claude.exe';

    it('a stored .exe wins over the wrapper and what Genie would find', async () => {
        const { resolveProviderProgram } = await load();
        expect(resolveProviderProgram('claude', ports({ ...wrapper(), [NATIVE]: '', [choice]: '' }, choice))).toMatchObject({ kind: 'found', path: choice });
    });

    it('a stored file that is gone, or is not an .exe, is not used', async () => {
        const { resolveProviderProgram } = await load();
        expect(resolveProviderProgram('claude', ports({ ...wrapper() }, choice))).toEqual({ kind: 'wrapper', file: WRAPPER });
        expect(resolveProviderProgram('claude', ports({ ...wrapper(), 'D:\\tools\\claude.cmd': '' }, 'D:\\tools\\claude.cmd'))).toEqual({ kind: 'wrapper', file: WRAPPER });
    });

    const dirs: string[] = [];
    afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

    it('is kept per provider, and a non-.exe is refused', async () => {
        const { readProviderChoice, writeProviderChoice } = await loadChoice();
        const dir = mkdtempSync(join(tmpdir(), 'genie-provider-choice-')); dirs.push(dir);
        const file = join(dir, 'provider-programs.json');
        expect(writeProviderChoice(file, 'claude', 'D:\\a\\claude.exe')).toEqual({ ok: true });
        expect(writeProviderChoice(file, 'codex', 'D:\\b\\codex.exe')).toEqual({ ok: true });
        expect(readProviderChoice(file, 'claude')).toBe('D:\\a\\claude.exe');
        expect(readProviderChoice(file, 'codex')).toBe('D:\\b\\codex.exe');
        expect(writeProviderChoice(file, 'claude', 'D:\\a\\claude.cmd')).toMatchObject({ ok: false });
        expect(readProviderChoice(file, 'claude')).toBe('D:\\a\\claude.exe');
        expect(readProviderChoice(join(dir, 'missing.json'), 'claude')).toBeNull();
    });
});

describe('when nothing can be found', () => {
    it('the message names the file it found and is recognised as one a picker answers', async () => {
        const { providerProgramProblem, isProviderProgramProblem } = await load();
        const words = providerProgramProblem('claude', ports(wrapper()));
        expect(words).toContain(WRAPPER);
        expect(words).toMatch(/\.exe/);
        expect(isProviderProgramProblem(words)).toBe(true);
        expect(providerProgramProblem('claude', ports({ ...wrapper(), [NATIVE]: '' }))).toBeNull();
        expect(isProviderProgramProblem('could not start claude: spawn EINVAL')).toBe(false);
    });

    it('the settings offer the picker with that message, and only with that message', async () => {
        const { ProviderProgramChoice } = await loadView();
        const { providerProgramProblem } = await load();
        const reason = providerProgramProblem('claude', ports(wrapper()));
        const html = renderToStaticMarkup(createElement(ProviderProgramChoice, { provider: 'claude', reason, onChoose: async () => ({ ok: true }) }));
        expect(html).toContain('data-action="provider-choose-program"');
        expect(html).toContain('claude');
        expect(renderToStaticMarkup(createElement(ProviderProgramChoice, { provider: 'claude', reason: 'signed out', onChoose: async () => ({ ok: true }) }))).toBe('');
    });
});

describe('one resolution', () => {
    const call = providerBinary as unknown as (provider: string, env: Record<string, string | undefined>, ports?: unknown) => string | undefined;
    const models = listModelsOptionsFor as unknown as (provider: string, env: Record<string, string | undefined>, runtime: unknown, ports?: unknown) => { binary?: string };
    const runtime = { execPath: 'C:\\genie\\node.exe', electron: false };

    it('agent start and the model list get the same program', () => {
        const disk = ports({ ...wrapper(), [NATIVE]: '' });
        expect(call('claude', env, disk)).toBe(NATIVE);
        expect(models('claude', env, runtime, disk).binary).toBe(NATIVE);
    });

    it('CONTROL: GENIE2_<PROVIDER>_BINARY still wins', () => {
        const disk = ports({ ...wrapper(), [NATIVE]: '' });
        expect(call('claude', { ...env, GENIE2_CLAUDE_BINARY: 'D:\\mine\\claude.exe' }, disk)).toBe('D:\\mine\\claude.exe');
    });

    it('the window can choose it: the channel is registered, listed and wired to the settings', () => {
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
        const inventory = readFileSync(new URL('../src/core/ipc-inventory.ts', import.meta.url), 'utf8');
        const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
        const view = readFileSync(new URL('../src/renderer/components/AgentView.tsx', import.meta.url), 'utf8');
        expect(main).toMatch(/ipcMain\.handle\('genie:provider-choose-program'/);
        expect(inventory).toContain("['genie:provider-choose-program', 'window-port']");
        expect(app).toContain('onChooseProviderProgram');
        expect(view).toContain('<ProviderProgramChoice');
    });
});
