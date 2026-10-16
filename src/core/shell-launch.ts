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
