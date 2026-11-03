/**
 * A COMMAND LINE, RUN THE WAY A PERSON TYPES IT (moic, 2026-10-16): through the platform's shell, so `&&`, pipes,
 * quoting and `cd` work. Without it the line was split into argv and its first word run directly — `&&` reached the
 * program as an argument. Windows: `cmd.exe /d /s /c <line>` (`/s` keeps the line as given; `/d` skips AutoRun);
 * elsewhere the person's login shell with `-lc <line>`, so their PATH and profile apply.
 */
export function shellLaunch(platform: NodeJS.Platform, defaultShell: () => { command: string; args: string[] }, line: string): { command: string; args: string[] } {
    if (platform === 'win32') return { command: 'cmd.exe', args: ['/d', '/s', '/c', line] };
    return { command: defaultShell().command, args: ['-lc', line] };
}

/**
 * A LINE GIVEN TO cmd VERBATIM, WRAPPED, EVERY TIME. Under `/s` cmd takes off a line's first and last quote when it starts with one, so `"C:\\dir with space\\tool.exe" --flag` lost the only quotes it had and ran whatever `C:\\dir` found, a planted
 * program included (measured on Windows CI through services exec, genie#1497's sibling). One outer pair, which /s takes off, leaves the line as written. Node's own `shell: true` does the same. Nothing inside is escaped: the caller owns what is in the line.
 */
export function cmdShellLine(line: string): string {
    return `"${line}"`;
}

/** `shellLaunch` for a spawn that can pass arguments verbatim. Windows' cmd gets the line wrapped; anywhere else nothing changes and the flag means nothing. */
export function verbatimShellLaunch(platform: NodeJS.Platform, defaultShell: () => { command: string; args: string[] }, line: string): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
    if (platform === 'win32') return { command: 'cmd.exe', args: ['/d', '/s', '/c', cmdShellLine(line)], windowsVerbatimArguments: true };
    return { ...shellLaunch(platform, defaultShell, line), windowsVerbatimArguments: false };
}
