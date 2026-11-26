import { isAbsolute } from 'node:path';
import { parseTrackBuild } from './protocol-version.js';

/**
 * A CLIENT THE LAUNCHER STARTED (Tynn #1058 L3). The launcher (native/launcher) starts genie-client and genie-browser from
 * their own track folders and tells each two things:
 *
 *  - GENIE_LAUNCHER_EXE: the launcher's own program, whose `detach`, `job` and `pipe-owner-only` modes were genie-launch.exe's
 *    (win-launcher.ts finds them there first);
 *  - GENIE_LAUNCHER_HOST_BUILD: the host build to link to (the running host's, else the installed one).
 *
 * Such a client carries no host bundle (the client package holds no host.js), so it makes no host copy and adopts the host
 * of that build. The client's start and replace branches go altogether in L4. The host is told GENIE_LAUNCHER_EXE too.
 */
export const LAUNCHER_ENV = ['GENIE_LAUNCHER_EXE', 'GENIE_LAUNCHER_HOST_BUILD'] as const;

export interface LauncherLink {
    /** The launcher's program, an absolute path. */
    readonly launcherExe: string;
    /** The host build the launcher named; `null` when it named none (a client-only install). */
    readonly hostBuild: string | null;
}

/** What the launcher told this process; `null` when no launcher started it (a dev run, the single-app install). */
export function launcherLink(env: Readonly<Record<string, string | undefined>>): LauncherLink | null {
    const exe = env.GENIE_LAUNCHER_EXE;
    if (typeof exe !== 'string' || exe.length === 0 || !(isAbsolute(exe) || /^[A-Za-z]:\\/.test(exe))) return null;
    const build = env.GENIE_LAUNCHER_HOST_BUILD;
    const hostBuild = typeof build === 'string' && !build.includes('+') && parseTrackBuild(build) !== null ? build : null;
    return { launcherExe: exe, hostBuild };
}
