import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdShellLine, verbatimShellLaunch } from '../src/core/shell-launch.js';
import { runServiceExec } from '../src/main/service-exec.js';

/**
 * A LINE GIVEN TO cmd VERBATIM IS WRAPPED, EVERY TIME. Under \`/s\` cmd takes off a line's first and last quote when it starts with one. So \`"C:\\dir with space\\tool.exe" --flag\` lost the only quotes it had, and ran \`C:\\dir\`, or a \`dir.exe\` someone had
 * planted beside the folder, instead of the tool. One outer pair, which /s takes off, leaves the line as it was written; that is what Node's own shell: true does. \`services exec\` has been verbatim and unwrapped since beta.29.
 */
describe('the line', () => {
    it('gets one outer pair of quotes, and nothing inside it changes', () => {
        expect(cmdShellLine('echo hi')).toBe('"echo hi"');
        expect(cmdShellLine('"C:\\a b\\t.exe" "x y" && echo %PATH%')).toBe('""C:\\a b\\t.exe" "x y" && echo %PATH%"');
    });

    it('Windows: cmd, verbatim, wrapped', () => {
        expect(verbatimShellLaunch('win32', () => ({ command: 'unused', args: [] }), 'echo hi')).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c', '"echo hi"'], windowsVerbatimArguments: true });
    });

    it("elsewhere: the person's login shell, as it was, and nothing wrapped", () => {
        expect(verbatimShellLaunch('linux', () => ({ command: '/bin/zsh', args: [] }), 'echo "hi"')).toEqual({ command: '/bin/zsh', args: ['-lc', 'echo "hi"'], windowsVerbatimArguments: false });
    });

    it('wired: services exec launches through it, and nothing under src/main is verbatim on its own', () => {
        const source = readFileSync('src/main/service-exec.ts', 'utf8');
        expect(source).toMatch(/verbatimShellLaunch\(/);
        expect(source).toMatch(/windowsVerbatimArguments: launch\.windowsVerbatimArguments/);
    });
});

/** Real cmd.exe, through the real path. The stubs print a marker a person's command line does not contain. */
describe.skipIf(process.platform !== 'win32')('on Windows, through services exec', () => {
    let base: string;
    let real: string;
    const run = async (command: string) => (await runServiceExec({ command, cwd: base, env: { SERVICE_EXEC_PROBE: 'from-the-env' }, timeoutMs: 25_000 })).output;
    beforeEach(() => {
        base = mkdtempSync(join(tmpdir(), 'exec-quoting-'));
        mkdirSync(join(base, 'plant dir'));
        // What /s leaves behind runs this: the first word of the path, up to its space.
        writeFileSync(join(base, 'plant.cmd'), '@echo off\r\necho PLANTED-RAN %*\r\n');
        real = join(base, 'plant dir', 'real.cmd');
        writeFileSync(real, '@echo off\r\necho REAL-RAN %*\r\n');
    });
    afterEach(() => rmSync(base, { recursive: true, force: true }));

    it('an absolute quoted path with a space: the tool runs, and what is planted beside the folder never does', async () => {
        const out = await run(`"${real}" --flag`);
        expect(out).not.toContain('PLANTED-RAN');
        expect(out).toContain('REAL-RAN --flag');
    });

    it('a relative quoted path with a space: the same, from the working folder', async () => {
        const out = await run('"plant dir\\real.cmd" --flag');
        expect(out).not.toContain('PLANTED-RAN');
        expect(out).toContain('REAL-RAN --flag');
    });

    it('a quoted program and a quoted argument: each stays whole', async () => {
        const out = await run(`"${real}" "two words"`);
        expect(out).not.toContain('PLANTED-RAN');
        expect(out).toContain('REAL-RAN "two words"');
    });

    it.each([
        ['a plain command', 'echo plain-line', 'plain-line'],
        ['two commands', 'echo one&& echo two', 'two'],
        ['a pipe', 'echo piped | findstr piped', 'piped'],
        ['a variable', 'echo %SERVICE_EXEC_PROBE%', 'from-the-env'],
    ])('CONTROL: %s still does what it did', async (_, command, expected) => {
        expect(await run(command)).toContain(expected);
    });

    it('CONTROL: a call before a quoted path, as the abort tests write it, still does what it did', async () => {
        expect(await run(`call "${real}" x`)).toContain('REAL-RAN x');
    });
});
