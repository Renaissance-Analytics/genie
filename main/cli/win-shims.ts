import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Windows PowerShell + cmd support for the bundled tynn-cli toolkit.
 *
 * The toolkit is a set of bash scripts (`resetme`, `puse`, …). On Windows,
 * `install.sh` already makes them reachable from Git Bash via `~/.bashrc`, but
 * cmd.exe and PowerShell don't source `.bashrc` and can't run a bare bash
 * script. To make the SAME commands usable from those shells we generate a
 * `.cmd` wrapper per command that invokes the resolved Git Bash to run the
 * underlying script, forwarding all arguments. Both cmd.exe AND PowerShell
 * execute `.cmd` files found on PATH (PATHEXT includes `.CMD`), so a single
 * `.cmd` per command covers both shells — no `.ps1` needed.
 *
 * The shim directory is then added to the Windows *User* PATH persistently via
 * `[Environment]::SetEnvironmentVariable('Path', …, 'User')` — NOT `setx`, which
 * silently truncates PATH at 1024 chars. The merge is idempotent + additive:
 * an existing entry is never duplicated, and no existing entry is ever dropped.
 *
 * The pure helpers (path conversion, shim content, PATH merge) are exported so
 * they can be unit-tested without a Windows box or a real registry.
 */

/**
 * Convert a Windows-style absolute path (`C:\Users\me\x`) to the MSYS/Git-Bash
 * form (`/c/Users/me/x`) that Git Bash resolves via its mount table. Already-
 * POSIX paths are returned with back-slashes normalised. Pure.
 */
export function toBashPath(winPath: string): string {
    const fwd = winPath.replace(/\\/g, '/');
    const m = /^([A-Za-z]):\/(.*)$/.exec(fwd);
    if (m) {
        return `/${m[1].toLowerCase()}/${m[2]}`;
    }
    return fwd;
}

/** The `.cmd` filename for a bin command (`resetme` → `resetme.cmd`). Pure. */
export function shimFileName(command: string): string {
    return `${command}.cmd`;
}

/**
 * The content of a `.cmd` shim: invoke Git Bash on the underlying script,
 * forwarding every argument verbatim via `%*`. `bashExe` is kept in Windows
 * form (cmd calls it as a program); the script path is converted to the bash
 * form Git Bash understands. Pure so the exact shape is unit-testable.
 */
export function winShimContent(bashExe: string, scriptWinPath: string): string {
    const script = toBashPath(scriptWinPath);
    // CRLF line endings — conventional for .cmd. `@echo off` keeps the wrapper
    // silent; the trailing `%*` forwards all args (with their original quoting).
    return `@echo off\r\n"${bashExe}" "${script}" %*\r\n`;
}

/**
 * Build the full set of shim files for a list of bin commands: filename →
 * content. `binDir` is the Windows-form directory holding the scripts. Pure.
 */
export function buildShimSet(
    commands: string[],
    bashExe: string,
    binDir: string,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const cmd of commands) {
        out[shimFileName(cmd)] = winShimContent(bashExe, path.join(binDir, cmd));
    }
    return out;
}

/** Normalise a Windows PATH entry for comparison: forward→back slashes, drop a
 *  trailing separator, lower-case (Windows paths are case-insensitive). Pure. */
function normalizeWinPathEntry(p: string): string {
    return p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Idempotently ensure `entry` is present in a PATH string. Returns the possibly-
 * updated value and whether it changed. NEVER duplicates an existing entry and
 * NEVER drops or reorders existing entries — it only appends `entry` when
 * absent, preserving the original string's formatting exactly otherwise. Pure.
 */
export function mergePathEntry(
    current: string,
    entry: string,
    delimiter = ';',
): { value: string; changed: boolean } {
    const target = normalizeWinPathEntry(entry);
    const already = current
        .split(delimiter)
        .some((p) => p.trim() !== '' && normalizeWinPathEntry(p) === target);
    if (already) return { value: current, changed: false };
    if (current === '') return { value: entry, changed: true };
    const sep = current.endsWith(delimiter) ? '' : delimiter;
    return { value: `${current}${sep}${entry}`, changed: true };
}

/** Marker written into the install dir to record which build installed it. */
export interface InstallMarker {
    version: string;
    installedAt: number;
}

/**
 * Whether an existing install marker matches the current build — the "already
 * installed?" test that makes the startup install idempotent (skip when the
 * toolkit was already installed by THIS Genie version). Pure.
 */
export function isInstallCurrent(
    marker: InstallMarker | null,
    currentVersion: string,
): boolean {
    return !!marker && marker.version === currentVersion;
}

// --- impure Windows-only orchestration --------------------------------------

/**
 * (Re)generate the `.cmd` shims into `<dest>/win-shims`, one per file in
 * `<dest>/bin`. Returns the shim directory + the commands shimmed, or null when
 * there's no bin dir. The shim dir is wiped + recreated so a removed command
 * leaves no stale shim (it holds only Genie-generated files — never user data).
 */
export function writeWinShims(
    dest: string,
    bashExe: string,
): { shimDir: string; commands: string[] } | null {
    const binDir = path.join(dest, 'bin');
    let commands: string[];
    try {
        commands = fs
            .readdirSync(binDir, { withFileTypes: true })
            .filter((d) => d.isFile())
            .map((d) => d.name);
    } catch {
        return null;
    }
    if (commands.length === 0) return null;
    const shimDir = path.join(dest, 'win-shims');
    try {
        fs.rmSync(shimDir, { recursive: true, force: true });
    } catch {
        /* best-effort — recreate below regardless */
    }
    fs.mkdirSync(shimDir, { recursive: true });
    const shims = buildShimSet(commands, bashExe, binDir);
    for (const [name, content] of Object.entries(shims)) {
        fs.writeFileSync(path.join(shimDir, name), content, 'utf8');
    }
    return { shimDir, commands };
}

/** Run a PowerShell command, resolving with its stdout (stderr appended to the
 *  reject reason). Uses Windows PowerShell (always present) not `pwsh`. */
function runPowerShell(
    command: string,
    extraEnv?: Record<string, string>,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', command],
            { env: { ...process.env, ...extraEnv }, windowsHide: true },
        );
        let out = '';
        let err = '';
        child.stdout?.on('data', (d) => (out += d.toString()));
        child.stderr?.on('data', (d) => (err += d.toString()));
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve(out);
            else reject(new Error(err.trim() || `powershell exit ${code}`));
        });
    });
}

/**
 * Ensure `dir` is on the Windows *User* PATH, persistently + idempotently.
 * Reads the current User PATH via `[Environment]::GetEnvironmentVariable`,
 * merges in TS (so the idempotency rules are unit-tested), and writes it back
 * only when it actually changed. The new value is passed to PowerShell through
 * an env var (not an argument) to sidestep any length/quoting limits. Returns
 * whether the PATH was modified. New shells inherit it; already-open shells
 * need a restart.
 */
export async function ensureUserPathContains(
    dir: string,
): Promise<{ changed: boolean }> {
    // GetEnvironmentVariable returns $null when the User Path is unset → empty.
    const raw = await runPowerShell(
        "[Environment]::GetEnvironmentVariable('Path','User')",
    );
    const current = raw.replace(/\r?\n$/, '');
    const { value, changed } = mergePathEntry(current, dir);
    if (!changed) return { changed: false };
    await runPowerShell(
        "[Environment]::SetEnvironmentVariable('Path', $env:GENIE_NEW_USER_PATH, 'User')",
        { GENIE_NEW_USER_PATH: value },
    );
    return { changed: true };
}
