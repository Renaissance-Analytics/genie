/**
 * Shape the shell args that run a Process spec's command non-interactively.
 *
 * A Process reuses the terminal pty backend, but instead of an interactive
 * login shell it runs a single command line (`artisan queue:work`, etc.) and
 * its lifecycle is tracked as a service. We pick the right "run this command"
 * invocation per shell family so the command's stdout/stderr stream into the
 * same xterm view a terminal uses.
 *
 * Pure + shell-family-detected by executable basename, so it's unit-testable.
 */
export function buildProcessArgs(shell: string, command: string): string[] {
    const base = shell
        .replace(/\\/g, '/')
        .split('/')
        .pop()!
        .toLowerCase()
        .replace(/\.exe$/, '');

    switch (base) {
        case 'bash':
        case 'zsh':
            // Login shell so the user's env (nvm, asdf, PATH tweaks) loads, then
            // run the command. The runner is non-interactive (no -i).
            return ['-lc', command];
        case 'sh':
        case 'dash':
            return ['-c', command];
        case 'pwsh':
        case 'powershell':
            return ['-NoProfile', '-Command', command];
        case 'cmd':
            return ['/c', command];
        default:
            // Best effort — POSIX `-c` is the most widely supported.
            return ['-c', command];
    }
}
