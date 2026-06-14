import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

/** Coarse shell family, derived from the executable name, used to decide which
 *  OSC-7 prompt hook (if any) we can inject. */
export type ShellKind = 'powershell' | 'bash' | 'zsh' | 'fish' | 'cmd' | 'other';

export function shellKind(command: string): ShellKind {
    const base = path.basename(command).toLowerCase();
    if (base.includes('pwsh') || base.includes('powershell')) return 'powershell';
    if (base.startsWith('zsh')) return 'zsh';
    if (base.startsWith('bash')) return 'bash';
    if (base.startsWith('fish')) return 'fish';
    if (base.startsWith('cmd')) return 'cmd';
    return 'other';
}

/**
 * Build the env additions that make a shell emit OSC-7 cwd reports on every
 * prompt, so resumed terminals know where they were (Tier 1.5). Gated by the
 * `track_cwd` setting (default ON). Returns {} when tracking is off or the
 * shell can't be hooked via env — the manager then degrades to the static cwd.
 *
 * Design notes:
 *   - We APPEND to existing prompt machinery, never replace it, so a user's
 *     own prompt survives.
 *   - bash:  PROMPT_COMMAND runs before each prompt — prepend our printf.
 *   - zsh:   ZDOTDIR can't carry a precmd via env cleanly, but bash-style
 *     PROMPT_COMMAND isn't honored; instead we rely on the widely-supported
 *     `chpwd`-via-precmd being unavailable from env, so for zsh we set a
 *     PROMPT_COMMAND-like hook through the `precmd_functions` route which zsh
 *     does NOT read from env. So zsh degrades unless the user's rc emits OSC-7.
 *     (Kept minimal — see Learnings.) We still try bash-style for zsh-in-bash-
 *     compat shells.
 *   - PowerShell: there's no env-var prompt hook; PowerShell reads $PROFILE.
 *     We inject GENIE_OSC7=1 and rely on a one-line shim only when a profile
 *     opts in. Practically, PowerShell here degrades to static cwd unless the
 *     user adds the documented `prompt` shim. (See Learnings.)
 *
 * The portable, reliable case is bash (Git Bash on Windows, bash/zsh-in-bash
 * mode on POSIX), which is Genie's default Windows shell — so the common path
 * is covered.
 */
export function cwdHookEnv(command: string): Record<string, string> {
    const settings = getAllSettings();
    if (settings.track_cwd === 'off') return {};

    const kind = shellKind(command);
    const host = os.hostname();

    if (kind === 'bash') {
        // Emit OSC-7 from PROMPT_COMMAND. \033]7;file://HOST$PWD\007 — $PWD is
        // already absolute. PROMPT_COMMAND is read from the environment by
        // interactive bash, and we PREPEND so any existing value still runs.
        // Single-quoted so $PWD expands at prompt time, not now.
        const emit = `printf '\\033]7;file://${host}%s\\033\\\\' "$PWD"`;
        // Existing PROMPT_COMMAND (if the user has one in their rc) is chained
        // after ours via the trailing separator. bash treats PROMPT_COMMAND as
        // a command string; "; " keeps both.
        return { PROMPT_COMMAND: `${emit}${process.env.PROMPT_COMMAND ? '; ' + process.env.PROMPT_COMMAND : ''}` };
    }

    // zsh / fish / powershell / cmd: no clean env-only, non-clobbering hook.
    // Degrade silently to the static cwd (the spec's `cwd`). A future tier can
    // ship a real rc/profile shim.
    return {};
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
