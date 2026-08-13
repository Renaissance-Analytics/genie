import type { HostToolName } from './toolchain-detect';

/**
 * PURE. "What would updating this tool walk into RIGHT NOW?"
 *
 * The Dev Tools Update button replaces a binary that other LIVE things are
 * running on, and the exposures are not the same shape:
 *
 *   - **claude-code / codex** — `npm i -g` overwrites the very executable a
 *     running agent is executing. On Windows that write can fail outright (the
 *     file is locked); where it succeeds, an agent is left half-replaced
 *     mid-turn. This one can lose the user's work, so it is REFUSED rather than
 *     warned about.
 *   - **node** — every agent TUI runs ON node, so swapping the runtime under a
 *     working agent is the same hazard one level down. Also refused.
 *   - **docker** — updating Docker Desktop restarts the engine, which stops
 *     every running container: a workspace's database, its sites.
 *   - **git / php / composer** — an in-flight command or a running dev server
 *     can break, but nothing is being overwritten mid-execution. Warn, name what
 *     is live, and let the human decide.
 *
 * The output NAMES what is at risk, for the same reason `stopEngineWarning`
 * lists workspaces instead of asking "are you sure": a confirmation that cannot
 * say what it would break trains people to click through the one that matters.
 * A `warn` with nothing to name is downgraded to `safe` — noise costs the same
 * attention as a real warning and spends it on nothing.
 */

export interface ToolchainActivity {
    /** Agent terminals MID-TURN right now, by label. */
    busyAgents: string[];
    /** Terminals with a LIVE pty. Presence, not activity — but see the git rule:
     *  on Windows presence alone aborts the Git installer. */
    openTerminals: number;
    /** Which OS this is. Only Windows has the Git Bash problem. */
    platform?: NodeJS.Platform | string;
    /** Host-native dev servers currently running, by site name. */
    runningSites: string[];
    /** Service engines currently running, by label. */
    runningEngines: string[];
}

/** `blocked` — refuse; `warn` — confirm naming the cost; `safe` — just do it. */
export type UpdateRisk = 'blocked' | 'warn' | 'safe';

export interface ToolchainUpdateRisk {
    risk: UpdateRisk;
    /** The sentence shown to the human. Empty when `safe`. */
    reason: string;
    /** Exactly what is at stake — never a count alone. */
    affected: string[];
}

const SAFE: ToolchainUpdateRisk = { risk: 'safe', reason: '', affected: [] };

/** Tools whose update overwrites something an agent is actively executing. */
const AGENT_CRITICAL: ReadonlySet<HostToolName> = new Set(['claude-code', 'codex', 'node']);

const list = (names: string[]): string =>
    names.length === 1
        ? names[0]!
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export function toolchainUpdateRisk(
    tool: HostToolName,
    activity: ToolchainActivity,
): ToolchainUpdateRisk {
    // 1. The refusal: replacing what a working agent is running on.
    if (AGENT_CRITICAL.has(tool) && activity.busyAgents.length > 0) {
        const who = list(activity.busyAgents);
        return {
            risk: 'blocked',
            affected: [...activity.busyAgents],
            reason:
                tool === 'node'
                    ? `${who} ${activity.busyAgents.length === 1 ? 'is' : 'are'} mid-turn, and agents run ON Node — updating it now would pull the runtime out from under them. Wait until they finish.`
                    : `${who} ${activity.busyAgents.length === 1 ? 'is' : 'are'} mid-turn. Updating replaces the binary they are running, which fails on Windows and corrupts the turn elsewhere. Wait until they finish.`,
        };
    }

    // 2. GIT ON WINDOWS. Git Bash ships WITH Git for Windows, so every open
    //    terminal is holding files the installer must replace — and the
    //    installer does not degrade, it ABORTS:
    //
    //        bash.exe (PID 25992) …  Please terminate those processes and retry.
    //        Got EAbort exception.
    //
    //    (from the installer's own log, after this failed for real.) It fails
    //    DETERMINISTICALLY, so offering it would be a button that always fails —
    //    worse than no button. Refuse, and say what to close.
    if (tool === 'git' && activity.platform === 'win32' && activity.openTerminals > 0) {
        const n = activity.openTerminals;
        return {
            risk: 'blocked',
            affected: [`${n} open terminal${n === 1 ? '' : 's'}`],
            reason:
                `Genie has ${n} terminal${n === 1 ? '' : 's'} open, and they run Git Bash — the ` +
                'Git for Windows installer refuses to replace files while those are running, so ' +
                `it would abort. Close ${n === 1 ? 'it' : 'them'} and try again (or update Git ` +
                'outside Genie).',
        };
    }

    // 3. Docker: the update restarts the engine, taking containers with it.
    if (tool === 'docker' && activity.runningEngines.length > 0) {
        return {
            risk: 'warn',
            affected: [...activity.runningEngines],
            reason: `Updating Docker restarts its engine, which will STOP ${list(
                activity.runningEngines,
            )}. Any workspace using them loses its database or site until they start again.`,
        };
    }

    // 3. php / composer: the sites running on them.
    if ((tool === 'php' || tool === 'composer') && activity.runningSites.length > 0) {
        return {
            risk: 'warn',
            affected: [...activity.runningSites],
            reason: `${list(activity.runningSites)} ${
                activity.runningSites.length === 1 ? 'is' : 'are'
            } running on PHP right now — updating it can break ${
                activity.runningSites.length === 1 ? 'that site' : 'those sites'
            } until you restart ${activity.runningSites.length === 1 ? 'it' : 'them'}.`,
        };
    }

    // 4. git: an agent could be mid-command. Worth saying, not worth refusing.
    if (tool === 'git' && activity.busyAgents.length > 0) {
        return {
            risk: 'warn',
            affected: [...activity.busyAgents],
            reason: `${list(activity.busyAgents)} ${
                activity.busyAgents.length === 1 ? 'is' : 'are'
            } working right now — if a git command is in flight it may fail. It is safer once they are idle.`,
        };
    }

    return SAFE;
}
