import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cmdLineVariables, ptyShellLaunch } from '../src/core/shell-launch.js';

/**
 * genie#1428, A LINE WITH A QUOTE RUNS IN A WINDOWS TERMINAL. Measured on genie-test-windows (batch HH, #1431): a pty's
 * engine joins its argv by the C runtime's rules, so each `"` of a line handed to `cmd /d /s /c` as an argument reached
 * cmd as `\"`, which cmd does not read as a quote. No line with a quote in it ran, spaces or not (CONTROL included), and
 * wrapping the line failed the same way. A pty has no windowsVerbatimArguments.
 *
 * The remedy measured on the same VM (job T1-ii, "env+vars", every row RAN: a quoted path with and without spaces, a
 * quoted spaced argument, `&&` with a quote, a pipe, a %VARIABLE%): the argv carries NO quote at all. cmd gets
 * `%GENIE_SHELL_LINE%`, and the line is in the environment. cmd expands it before it reads quotes, so its quotes are real
 * quotes. cmd expands only once, so each %NAME% the environment defines is replaced in the line first; an undefined one
 * stays as written, as cmd /c leaves it.
 */
const shell = () => ({ command: '/bin/bash', args: ['-l'] });

describe('ptyShellLaunch', () => {
    it('Windows: no quote in the argv; the line, as written, in GENIE_SHELL_LINE', () => {
        const line = '"C:\\Program Files\\PHP\\php.exe" artisan queue:work';
        const launch = ptyShellLaunch('win32', shell, line, {});
        expect(launch.args).toEqual(['/d', '/s', '/c', '%GENIE_SHELL_LINE%']);
        expect(launch.args.join(' ')).not.toContain('"');
        expect(launch.env).toEqual({ GENIE_SHELL_LINE: line });
        expect(launch.command.toLowerCase()).toMatch(/cmd\.exe$/);
    });

    it('Windows: a %NAME% the environment defines is replaced in the line (cmd expands once); an undefined one stays', () => {
        const launch = ptyShellLaunch('win32', shell, 'echo %APP_DIR% %NOT_SET% && dir', { APP_DIR: 'C:\\w\\app' });
        expect(launch.env.GENIE_SHELL_LINE).toBe('echo C:\\w\\app %NOT_SET% && dir');
    });

    it('elsewhere: the login shell with -lc, exactly as before, and no variable added', () => {
        expect(ptyShellLaunch('linux', shell, 'cd app && "./run me"', {})).toEqual({ command: '/bin/bash', args: ['-lc', 'cd app && "./run me"'], env: {} });
    });
});

describe('cmdLineVariables', () => {
    it('Windows names are case-insensitive, as cmd reads them', () => {
        expect(cmdLineVariables('%Path_X% %path_x%', { PATH_X: 'v' }, 'win32')).toBe('v v');
    });
    it('a lone % and %% are left as written', () => {
        expect(cmdLineVariables('50% done %% here', { done: 'x' }, 'win32')).toBe('50% done %% here');
    });
});

describe('the pty launch uses it (fancy-term-port.ts)', () => {
    const src = readFileSync(new URL('../src/main/fancy-term-port.ts', import.meta.url), 'utf8');
    it('a line run through the shell goes through ptyShellLaunch, and its env reaches the engine', () => {
        expect(src).toMatch(/ptyShellLaunch\(/);
        expect(src).not.toMatch(/[^.\w]shellLaunch\(/);
        expect(src).toMatch(/\.\.\.launchEnv/);
    });
});
