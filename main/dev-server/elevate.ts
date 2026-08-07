/**
 * Running a command with OS elevation, for the privileged bits of host-native
 * hosting (story #238): installing the Genie CA into the trust store and writing
 * the OS hosts file.
 *
 * Two paths, one contract:
 *   - Already privileged (root on Linux/CI, or an elevated Windows process) →
 *     spawn DIRECTLY. This is what the Ubuntu CI E2E runs, so it's the tested,
 *     load-bearing path.
 *   - Not privileged (a normal local machine) → spawn through the OS elevation
 *     launcher (UAC `Start-Process -Verb RunAs` / `pkexec` / `osascript` admin),
 *     which prompts the user once. Only the user's own run validates this.
 *
 * Every operation is spawned with an argv array (no shell), and a non-zero exit is
 * surfaced LOUDLY — never a silent "trusted"/"resolves" when it didn't.
 */

export interface PrivilegedRun {
    cmd: string;
    args: string[];
}

export interface ElevateDeps {
    platform: NodeJS.Platform;
    /** Whether the current process can run the command without a prompt. */
    isElevated: () => boolean;
    /** Spawn directly (already privileged). */
    spawnDirect: (cmd: string, args: string[]) => Promise<{ code: number; stderr?: string }>;
    /** Spawn through the OS elevation launcher (prompts the user). */
    spawnElevated: (cmd: string, args: string[]) => Promise<{ code: number; stderr?: string }>;
}

export async function runPrivileged(
    run: PrivilegedRun,
    deps: ElevateDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = deps.isElevated()
        ? await deps.spawnDirect(run.cmd, run.args)
        : await deps.spawnElevated(run.cmd, run.args);
    if (r.code === 0) return { ok: true };
    return { ok: false, error: r.stderr?.trim() || `command exited ${r.code}` };
}

/** Whether the current process can already run privileged commands without a
 *  prompt. On Windows we assume NOT (route through UAC) — a normal dev process is
 *  unelevated, and an already-elevated one still runs RunAs fine (no re-prompt). */
export function isProcessElevated(platform: NodeJS.Platform = process.platform): boolean {
    if (platform === 'win32') return false;
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** The argv that runs `cmd args` elevated, per OS. Linux uses pkexec (clean argv);
 *  Windows wraps in PowerShell `Start-Process -Verb RunAs`; macOS uses osascript's
 *  administrator prompt. Values are our own controlled paths, but are quoted for
 *  the shells that need it. */
export function elevationLauncherArgv(cmd: string, args: string[], platform: NodeJS.Platform): string[] {
    if (platform === 'win32') {
        const ps = [cmd, ...args].map((a) => `'${a.replace(/'/g, "''")}'`);
        const fileArg = ps[0];
        const argList = ps.slice(1).join(',');
        const inner = argList
            ? `Start-Process -FilePath ${fileArg} -ArgumentList ${argList} -Verb RunAs -Wait`
            : `Start-Process -FilePath ${fileArg} -Verb RunAs -Wait`;
        return ['powershell', '-NoProfile', '-Command', inner];
    }
    if (platform === 'darwin') {
        const shell = [cmd, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
        return ['osascript', '-e', `do shell script "${shell.replace(/"/g, '\\"')}" with administrator privileges`];
    }
    return ['pkexec', cmd, ...args];
}
