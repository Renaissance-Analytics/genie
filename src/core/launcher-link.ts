import { isAbsolute } from 'node:path';
import { parseTrackBuild } from './protocol-version.js';

/**
 * A CLIENT THE LAUNCHER STARTED (Tynn #1058 L3). The launcher (native/launcher) starts genie-client from its track folder
 * (the Genie browser too: the client build the browser's manifest names, with --genie-browser) and tells it two things:
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

/**
 * WHERE THE LAUNCHER'S TRAY OPENS GENIE (Tynn #1058 L5): "Needs you: N" opens the Dashboard (the Deck merged into it, Tynn
 * #730), where a held login's Resume, a signed-out login's Log in and a paused account's Try again live; Settings… and Task
 * Manager… open those. The launcher hands the client `--show <route>`; only these routes are taken, anything else is ignored.
 */
export const LAUNCHER_SHOW_ROUTES = ['genie://dashboard', 'genie://settings', 'genie://hosting?tab=processes'] as const;
export type LauncherShowRoute = (typeof LAUNCHER_SHOW_ROUTES)[number];

/** The route a `--show <route>` in this argv asks for, when it is one the tray offers; `null` otherwise. */
export function launcherShowRoute(argv: readonly string[]): LauncherShowRoute | null {
    const at = argv.lastIndexOf('--show');
    const route = at >= 0 ? argv[at + 1] : undefined;
    return (LAUNCHER_SHOW_ROUTES as readonly string[]).includes(route ?? '') ? (route as LauncherShowRoute) : null;
}
