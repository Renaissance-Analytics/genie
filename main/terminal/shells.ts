import fs from 'node:fs';
import path from 'node:path';
import { getAllSettings } from '../db';

/**
 * Shell detection + default-shell resolution for the terminal subsystem.
 *
 * Mirrors main/editors.ts: probe well-known install paths, return what's
 * actually present. Ids line up with fancy-term's BUILTIN_SHELLS so the
 * renderer can map detections straight onto ShellProfile entries
 * (cmd · powershell · pwsh · git-bash · bash · zsh · wsl).
 *
 * Default policy (Windows): Git Bash when detected — it's the shell the
 * Tynn toolchain assumes — then pwsh, then Windows PowerShell, then cmd.
 * On macOS/Linux the user's $SHELL wins, falling back to bash.
 */

export interface ShellInfo {
    /** Stable id, matches fancy-term BUILTIN_SHELLS where possible. */
    id: string;
    /** Display label, e.g. "Git Bash". */
    label: string;
    /** Absolute executable path (or bare command when resolved via PATH). */
    command: string;
    /** Default args for an interactive session. */
    args: string[];
}

function firstExisting(paths: string[]): string | null {
    for (const p of paths) {
        try {
            if (p && fs.existsSync(p)) return p;
        } catch {
            /* permission race — treat as absent */
        }
    }
    return null;
}

function windowsCandidates(): Array<Omit<ShellInfo, 'command'> & { paths: string[] }> {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 =
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';

    return [
        {
            id: 'git-bash',
            label: 'Git Bash',
            args: ['--login', '-i'],
            paths: [
                path.join(programFiles, 'Git', 'bin', 'bash.exe'),
                path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
                localAppData
                    ? path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe')
                    : '',
            ],
        },
        {
            id: 'pwsh',
            label: 'PowerShell 7',
            args: ['-NoLogo'],
            paths: [
                path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
                localAppData
                    ? path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe')
                    : '',
            ],
        },
        {
            id: 'powershell',
            label: 'Windows PowerShell',
            args: ['-NoLogo'],
            paths: [
                path.join(
                    systemRoot,
                    'System32',
                    'WindowsPowerShell',
                    'v1.0',
                    'powershell.exe',
                ),
            ],
        },
        {
            id: 'cmd',
            label: 'Command Prompt',
            args: [],
            paths: [process.env.COMSPEC ?? path.join(systemRoot, 'System32', 'cmd.exe')],
        },
        {
            id: 'wsl',
            label: 'WSL',
            args: [],
            paths: [path.join(systemRoot, 'System32', 'wsl.exe')],
        },
    ];
}

function unixCandidates(): Array<Omit<ShellInfo, 'command'> & { paths: string[] }> {
    return [
        {
            id: 'zsh',
            label: 'zsh',
            args: ['-l'],
            paths: ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'],
        },
        {
            id: 'bash',
            label: 'bash',
            args: ['-l'],
            paths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'],
        },
        {
            id: 'fish',
            label: 'fish',
            args: ['-l'],
            paths: ['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish'],
        },
    ];
}

export function detectShells(): ShellInfo[] {
    const candidates =
        process.platform === 'win32' ? windowsCandidates() : unixCandidates();
    const found: ShellInfo[] = [];
    for (const c of candidates) {
        const command = firstExisting(c.paths);
        if (command) found.push({ id: c.id, label: c.label, command, args: c.args });
    }

    // Unix: surface the user's login shell even if it isn't in the probe
    // list (e.g. a Homebrew bash that lives somewhere exotic).
    if (process.platform !== 'win32') {
        const login = process.env.SHELL;
        if (login && !found.some((s) => s.command === login) && fs.existsSync(login)) {
            found.unshift({
                id: path.basename(login),
                label: path.basename(login),
                command: login,
                args: ['-l'],
            });
        }
    }
    return found;
}

/** Default policy: Git Bash > pwsh > powershell > cmd (win); $SHELL > bash (unix). */
export function defaultShellId(detected: ShellInfo[]): string | null {
    const order =
        process.platform === 'win32'
            ? ['git-bash', 'pwsh', 'powershell', 'cmd']
            : detected.map((s) => s.id); // unix list is already priority-ordered
    for (const id of order) {
        if (detected.some((s) => s.id === id)) return id;
    }
    return detected[0]?.id ?? null;
}

/**
 * Split a manual "executable line" into command + args. Honors double
 * quotes around the executable path ("C:\Program Files\Git\bin\bash.exe"
 * --login -i). Single-token lines pass through untouched.
 */
export function parseCommandLine(line: string): { command: string; args: string[] } {
    const trimmed = line.trim();
    if (!trimmed) return { command: '', args: [] };
    const tokens: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(trimmed))) tokens.push(m[1] ?? m[2]);
    return { command: tokens[0] ?? '', args: tokens.slice(1) };
}

/**
 * Resolve the user's configured default shell to a concrete spawn target.
 * Reads the `terminal_shell` setting (a detected id, or 'custom' paired
 * with `terminal_custom_cmd`). Anything unresolvable falls back to the
 * detection-based default so the terminal always opens SOMETHING.
 */
export function resolveDefaultShell(): { command: string; args: string[] } {
    const settings = getAllSettings();
    const detected = detectShells();

    if (settings.terminal_shell === 'custom') {
        const parsed = parseCommandLine(settings.terminal_custom_cmd ?? '');
        if (parsed.command) return parsed;
    }

    const pick =
        detected.find((s) => s.id === settings.terminal_shell) ??
        detected.find((s) => s.id === defaultShellId(detected));
    if (pick) return { command: pick.command, args: pick.args };

    // Nothing detected (bare container?) — legacy platform fallbacks.
    if (process.platform === 'win32') {
        return { command: process.env.COMSPEC ?? 'cmd.exe', args: [] };
    }
    return { command: process.env.SHELL ?? '/bin/bash', args: [] };
}
