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
            // Login + INTERACTIVE shell so the user's full env loads, then run
            // the command. Interactive (-i) is required because some setups
            // expose tools only via interactive shell config (~/.bashrc): e.g.
            // Laravel Herd installs `php` as a Git Bash alias, and nvm/asdf
            // shims + PATH tweaks live there too — a non-interactive login
            // shell skips all of that, so `php` would be "command not found".
            // node-pty allocates a real pty (tty), so -i won't emit a
            // "no job control in this shell" warning.
            return ['-lic', command];
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
