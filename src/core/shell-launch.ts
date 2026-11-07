import { resolveProgram } from './program-lookup.js';

/**
 * A COMMAND LINE, RUN THE WAY A PERSON TYPES IT (moic, 2026-10-16): through the platform's shell, so `&&`, pipes,
 * quoting and `cd` work. Without it the line was split into argv and its first word run directly — `&&` reached the
 * program as an argument. Windows: `cmd.exe /d /s /c <line>` (`/s` keeps the line as given; `/d` skips AutoRun);
 * elsewhere the person's login shell with `-lc <line>`, so their PATH and profile apply.
 */
export function shellLaunch(platform: NodeJS.Platform, defaultShell: () => { command: string; args: string[] }, line: string): { command: string; args: string[] } {
    if (platform === 'win32') return { command: resolveProgram('cmd.exe', { platform, env: process.env }), args: ['/d', '/s', '/c', line] };
    return { command: defaultShell().command, args: ['-lc', line] };
}

/**
 * A LINE GIVEN TO cmd VERBATIM IS WRAPPED. Under `/s` cmd removes a line's first and last quote when it starts with one, so a line opening with a quoted path lost its quoting. One outer pair, which /s removes, leaves the line as written. Node's own `shell: true` does the same. Nothing inside is escaped: the caller owns what is in the line.
 */
export function cmdShellLine(line: string): string {
    return `"${line}"`;
}

/** The variable a Windows pty's shell line travels in (genie#1428). */
export const SHELL_LINE_VARIABLE = 'GENIE_SHELL_LINE';

/**
 * Each %NAME% the environment defines, replaced in a line the way cmd reads it (names case-insensitive on Windows). cmd
 * expands a variable's value only once, so a line passed as %GENIE_SHELL_LINE% would keep its own %NAME% literal: they
 * are expanded here first. An undefined name, a lone % and %% stay as written, as cmd /c leaves them.
 */
export function cmdLineVariables(line: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string {
    const lookup = (name: string): string | undefined => {
        if (platform !== 'win32') return env[name];
        const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
        return key === undefined ? undefined : env[key];
    };
    return line.replace(/%([^%\s=]+)%/g, (whole, name: string) => lookup(name) ?? whole);
}

/**
 * A SHELL LINE IN A PTY (genie#1428). A pty's engine joins its argv by the C runtime's rules, so a `"` in a line passed to
 * cmd as an argument reached it as `\"`, and no line with a quote ran (measured, genie-test-windows, batch HH). On Windows
 * the argv carries no quote: cmd runs `%GENIE_SHELL_LINE%`, the line is in the environment, and cmd expands it before it
 * reads quotes (measured, job T1-ii: every case ran). Elsewhere: `shellLaunch`, unchanged, and no variable.
 */
export function ptyShellLaunch(platform: NodeJS.Platform, defaultShell: () => { command: string; args: string[] }, line: string, env: Readonly<Record<string, string | undefined>>): { command: string; args: string[]; env: Record<string, string> } {
    if (platform !== 'win32') return { ...shellLaunch(platform, defaultShell, line), env: {} };
    const { command } = shellLaunch(platform, defaultShell, line);
    return { command, args: ['/d', '/s', '/c', `%${SHELL_LINE_VARIABLE}%`], env: { [SHELL_LINE_VARIABLE]: cmdLineVariables(line, env, platform) } };
}

/** `shellLaunch` for a spawn that can pass arguments verbatim. Windows' cmd gets the line wrapped; anywhere else nothing changes and the flag means nothing. */
export function verbatimShellLaunch(platform: NodeJS.Platform, defaultShell: () => { command: string; args: string[] }, line: string): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
    if (platform === 'win32') return { command: 'cmd.exe', args: ['/d', '/s', '/c', cmdShellLine(line)], windowsVerbatimArguments: true };
    return { ...shellLaunch(platform, defaultShell, line), windowsVerbatimArguments: false };
}
