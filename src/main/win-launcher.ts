import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcherLink } from '../core/launcher-link.js';

/**
 * genie-launch.exe (the launcher, native/launcher, Rust: its `detach`, `job` and `pipe-owner-only` modes; #1628, #1639, Tynn #1058): how Genie starts a process on Windows when what it
 * inherits, or what it starts, matters. `detach` starts genie-host inheriting only its log and NUL (never the window's
 * other handles, a DevTools socket among them); `job` runs a git read inside a kill-on-close job object, so ending the read
 * ends everything it started however it started it.
 *
 * Where it is: first the launcher that started this process (GENIE_LAUNCHER_EXE, core/launcher-link.ts: Genie.exe in the
 * NSIS folder, Tynn #1058 L3, where these modes now live); then, in the single-app install, `resources/bin`
 * (electron-builder's extraResources) — read from the process's own
 * resources path, or from GENIE_RESOURCES in genie-host (the window passes it); in a dev or CI tree, `build/win-launcher`
 * (scripts/build-win-launcher.mjs). `null` off Windows, or where it was not built (a dev machine with no MSVC): the
 * caller then starts the process with Node's spawn, as before.
 */
export const WIN_LAUNCHER = 'genie-launch.exe';

export function winLauncherPath(options: {
    readonly platform?: NodeJS.Platform;
    /** The launcher that started this process; absent = GENIE_LAUNCHER_EXE's. */
    readonly launcher?: string | null;
    readonly resources?: readonly (string | undefined)[];
    readonly devRoot?: string;
    readonly exists?: (path: string) => boolean;
} = {}): string | null {
    if ((options.platform ?? process.platform) !== 'win32') return null;
    const exists = options.exists ?? existsSync;
    const resources = options.resources ?? [(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath, process.env['GENIE_RESOURCES']];
    const devRoot = options.devRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const launcher = options.launcher === undefined ? launcherLink(process.env)?.launcherExe ?? null : options.launcher;
    const candidates = [
        ...(launcher ? [launcher] : []),
        ...resources.filter((r): r is string => typeof r === 'string' && r.length > 0).map((r) => join(r, 'bin', WIN_LAUNCHER)),
        join(devRoot, 'build', 'win-launcher', WIN_LAUNCHER),
    ];
    return candidates.find((p) => exists(p)) ?? null;
}
