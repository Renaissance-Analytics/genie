import type { HostToolName } from './toolchain-detect';
import { AGENT_CLI_IDS, agentCliDef, agentCliToolByProvider } from '../agents/agent-cli-catalog';

/**
 * PURE. "What would installing or updating this tool walk into RIGHT NOW?"
 *
 * The Dev Tools button replaces a binary that other LIVE things are running on,
 * and the exposures are not the same shape:
 *
 *   - **an agent CLI** — `npm i -g` overwrites the very executable a running
 *     agent is executing. On Windows that write can fail outright (the file is
 *     locked); where it succeeds, an agent is left half-replaced mid-turn. This
 *     one can lose the user's work, so it is REFUSED rather than warned about —
 *     but only for the agents actually running THAT CLI (see below).
 *   - **node** — every agent TUI runs ON node, so swapping the runtime under a
 *     working agent is the same hazard one level down. Refused for ANY busy
 *     agent: this is the one case where the blanket rule is the true one.
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
 *
 * ## Two things this used to get wrong (genie#448)
 *
 * The refusal read `AGENT_CRITICAL.has(tool) && activity.busyAgents.length > 0`
 * — *"is this an agent CLI?"* AND *"is ANY agent busy?"*, with **nothing joining
 * the two**. A busy Claude agent therefore blocked Codex, Gemini, Kilo and every
 * other CLI in the catalog, including ones no agent had ever run. While the set
 * was the hand-written `claude-code, codex` that was almost always right by
 * accident; once #437 derived it from the catalog it became almost always wrong.
 * The set was never the problem — a hand-written one would have left the NEWEST
 * CLIs as the only ones overwritable mid-turn — so the fix is to join the busy
 * agent to the tool it runs, not to shrink what is protected.
 *
 * And every sentence above says *replacing*. **Installing a tool that is not on
 * the machine replaces nothing**, so no turn can be corrupted and the refusal
 * cannot apply. The owner met both defects at once: the Genie TUI row said "Not
 * installed" and refused to install it because two Claude agents were mid-turn.
 */

/**
 * One agent that is mid-turn: who it is, and which catalog tool it is running.
 *
 * The tool is what makes a refusal a real conflict rather than a coincidence,
 * and it is OPTIONAL because it is genuinely unknowable for some terminals: a
 * `custom` agent IS its command line, and an older spec may never have recorded
 * `meta.agent` at all. An agent with no tool is still counted for `node` (it
 * runs on the runtime whatever its CLI) and still named in the git warning, but
 * it is never blamed for a specific CLI — a refusal that cannot say what the
 * conflict is WITH is exactly the false refusal this rule exists to stop being.
 */
export interface BusyAgent {
    /** The terminal's label — a human has to recognise who this is. */
    label: string;
    /** The catalog tool this agent's provider runs, when Genie knows it. */
    tool?: HostToolName;
}

export interface ToolchainActivity {
    /** Agent terminals MID-TURN right now, with the tool each one is running. */
    busyAgents: BusyAgent[];
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

/** The tool being acted on, as distinct from what else is live on the machine. */
export interface ToolchainTarget {
    /**
     * Is this tool ON THE MACHINE right now?
     *
     * `false` means the button is an INSTALL, and an install has nothing to
     * replace, restart or lock — so none of the rules below can apply to it.
     * Read from the toolchain probe at the moment of the click, never from the
     * renderer: a guard the protected surface can tell to stand down is not one.
     */
    installed: boolean;
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

/**
 * Tools whose update overwrites something an agent may be actively executing.
 *
 * DERIVED from the agent-CLI catalog. This used to name `claude-code` and
 * `codex` by hand, which was complete only while the toolchain knew of exactly
 * those two. Once Genie could install more agent CLIs, a hand-written set would
 * have become a hole with the worst possible shape — the NEW CLIs would have
 * been the only ones you could overwrite mid-turn, i.e. the refusal would
 * protect everything except what it had not been told about.
 *
 * `node` is deliberately NOT in here any more (it was, as `AGENT_CRITICAL`, back
 * when membership and the predicate were treated as one question). Being an
 * agent CLI means "block the agents running THIS ONE"; being the runtime means
 * "block ANY busy agent". Two different rules that only looked like one while
 * the set had two entries. See {@link toolchainUpdateRisk}.
 */
const AGENT_CLI_TOOLS: ReadonlySet<HostToolName> = new Set<HostToolName>(AGENT_CLI_IDS);

/** provider → the catalog tool it launches. Built once; the catalog is static. */
const TOOL_BY_PROVIDER: Partial<Record<string, HostToolName>> = agentCliToolByProvider();

/**
 * The busy-agent record for one working terminal.
 *
 * This is the join that was being thrown away: `ipc.ts` mapped a working
 * terminal straight to a LABEL, one line before the guard needed to know which
 * CLI that terminal was running. It lives here, pure, so the join itself can be
 * tested without an Electron main process behind it.
 */
export function busyAgentOf(label: string, provider?: string | null): BusyAgent {
    const tool = provider ? TOOL_BY_PROVIDER[provider] : undefined;
    return tool ? { label, tool } : { label };
}

const list = (names: string[]): string =>
    names.length === 1
        ? names[0]!
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The refusal names people, so it has to read like a sentence about them. */
const are = (n: number): string => (n === 1 ? 'is' : 'are');
const they = (n: number): string => (n === 1 ? 'it' : 'they');
const finish = (n: number): string => (n === 1 ? 'it finishes' : 'they finish');

export function toolchainUpdateRisk(
    tool: HostToolName,
    activity: ToolchainActivity,
    target: ToolchainTarget,
): ToolchainUpdateRisk {
    // 0. NOTHING TO REPLACE. Every rule below is about a binary already running,
    //    an engine already up, or files an installer must overwrite. A tool that
    //    is absent has none of those: installing it cannot corrupt a turn, stop a
    //    container, or lose an in-flight command. Refusing anyway is how the
    //    owner ended up unable to install the Genie TUI because Claude was busy.
    if (!target.installed) return SAFE;

    // 1. THE RUNTIME. Every agent CLI runs ON node, so any mid-turn agent is
    //    exposed — including one whose own CLI Genie could not identify. This is
    //    the one place a blanket rule is the correct rule, and it says so.
    if (tool === 'node' && activity.busyAgents.length > 0) {
        const names = activity.busyAgents.map((a) => a.label);
        return {
            risk: 'blocked',
            affected: names,
            reason:
                `${list(names)} ${are(names.length)} mid-turn, and every agent CLI runs ON Node — ` +
                'updating it now would pull the runtime out from under them. Wait until ' +
                `${finish(names.length)}.`,
        };
    }

    // 2. THE CLI ITSELF — and only for the agents actually running it. A busy
    //    Claude agent says nothing about whether replacing Codex is safe, and
    //    pretending otherwise made the refusal a non-sequitur on every row but
    //    one. Naming the TOOL as well as the agent is what makes the sentence
    //    actionable instead of a puzzle.
    if (AGENT_CLI_TOOLS.has(tool)) {
        const running = activity.busyAgents.filter((a) => a.tool === tool);
        if (running.length > 0) {
            const names = running.map((a) => a.label);
            const n = names.length;
            const label = agentCliDef(tool)?.label ?? tool;
            return {
                risk: 'blocked',
                affected: names,
                reason:
                    `${list(names)} ${are(n)} mid-turn running ${label}. Updating replaces the ` +
                    `binary ${they(n)} ${are(n)} running, which fails on Windows and corrupts ` +
                    `the turn elsewhere. Wait until ${finish(n)}.`,
            };
        }
    }

    // 3. GIT ON WINDOWS. Git Bash ships WITH Git for Windows, so every open
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

    // 4. Docker: the update restarts the engine, taking containers with it.
    if (tool === 'docker' && activity.runningEngines.length > 0) {
        return {
            risk: 'warn',
            affected: [...activity.runningEngines],
            reason: `Updating Docker restarts its engine, which will STOP ${list(
                activity.runningEngines,
            )}. Any workspace using them loses its database or site until they start again.`,
        };
    }

    // 5. php / composer: the sites running on them.
    if ((tool === 'php' || tool === 'composer') && activity.runningSites.length > 0) {
        return {
            risk: 'warn',
            affected: [...activity.runningSites],
            reason: `${list(activity.runningSites)} ${are(activity.runningSites.length)} running on PHP right now — updating it can break ${
                activity.runningSites.length === 1 ? 'that site' : 'those sites'
            } until you restart ${activity.runningSites.length === 1 ? 'it' : 'them'}.`,
        };
    }

    // 6. git: an agent could be mid-command. Worth saying, not worth refusing —
    //    and unlike rule 2 this one does apply to EVERY busy agent, because any
    //    of them can have a git command in flight whatever TUI it runs.
    if (tool === 'git' && activity.busyAgents.length > 0) {
        const names = activity.busyAgents.map((a) => a.label);
        return {
            risk: 'warn',
            affected: names,
            reason: `${list(names)} ${are(names.length)} working right now — if a git command is in flight it may fail. It is safer once they are idle.`,
        };
    }

    return SAFE;
}
