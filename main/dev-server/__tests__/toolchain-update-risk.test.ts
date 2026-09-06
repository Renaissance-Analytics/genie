import { describe, expect, it } from 'vitest';
import {
    busyAgentOf,
    toolchainUpdateRisk,
    type ToolchainActivity,
} from '../toolchain-update-risk';
import { AGENT_CLI_IDS } from '../../agents/agent-cli-catalog';

/**
 * WHAT AN UPDATE WOULD WALK INTO (owner report, pre-beta.249).
 *
 * "Update" on this page replaces a binary that OTHER LIVE THINGS are running on,
 * and the failure modes are not symmetric:
 *
 *   - **claude-code / codex** — `npm i -g` overwrites the very executable a
 *     running agent is executing. On Windows that write can simply FAIL (the
 *     file is locked), and where it succeeds the agent is left half-replaced
 *     mid-turn. This is the one that can lose a user's work, so it BLOCKS.
 *   - **node** — every agent TUI runs ON node. Swapping the runtime under them
 *     is the same hazard one level down.
 *   - **docker** — updating Docker Desktop restarts the engine, which stops
 *     every running container: a workspace's database, its sites.
 *   - **git / php / composer** — a running dev server or an in-flight command
 *     can break, but nothing is being overwritten mid-execution, so these WARN
 *     with the names rather than refusing.
 *
 * Naming WHAT is at risk is the point — the same reason `stopEngineWarning`
 * lists the workspaces instead of saying "are you sure".
 */

const idle: ToolchainActivity = {
    busyAgents: [],
    openTerminals: 0,
    runningSites: [],
    runningEngines: [],
};

/** The tool is ON THE MACHINE — i.e. this is an UPDATE, the case every rule
 *  below is about. Installing an absent tool has its own describe block. */
const here = { installed: true };

describe('toolchainUpdateRisk', () => {
    it('is safe on a quiet machine, whatever the tool', () => {
        for (const tool of ['git', 'node', 'docker', 'claude-code', 'php'] as const) {
            expect(toolchainUpdateRisk(tool, idle, here).risk).toBe('safe');
        }
    });

    it('BLOCKS updating an agent TUI while an agent RUNNING IT is mid-turn', () => {
        // Overwriting the binary a running agent is executing: on Windows the
        // write fails outright, and elsewhere it corrupts a live turn.
        const r = toolchainUpdateRisk(
            'claude-code',
            {
                ...idle,
                busyAgents: [
                    { label: 'Guardian', tool: 'claude-code' },
                    { label: 'Tynn', tool: 'claude-code' },
                ],
            },
            here,
        );
        expect(r.risk).toBe('blocked');
        expect(r.affected).toEqual(['Guardian', 'Tynn']);
        expect(r.reason).toMatch(/mid-turn|working/i);
        // It has to name them — "are you sure" teaches nothing.
        expect(r.reason).toContain('Guardian');
    });

    it('BLOCKS updating codex mid-turn too — same mechanism', () => {
        expect(
            toolchainUpdateRisk(
                'codex',
                { ...idle, busyAgents: [{ label: 'a', tool: 'codex' }] },
                here,
            ).risk,
        ).toBe('blocked');
    });

    /**
     * EVERY agent CLI, not the two that were written down.
     *
     * The refusal listed `claude-code` and `codex` by hand, which was complete
     * only while the toolchain knew of exactly those two. The moment Genie could
     * install more of them, a hand-written set becomes a hole with the worst
     * possible shape: the new CLIs would be the ONLY ones you could overwrite
     * while their agent was mid-turn. Derived from the catalog, adding a CLI
     * cannot open that hole — and #448 narrowed the PREDICATE, never this set,
     * so the property still holds for all twenty-one.
     */
    it('BLOCKS updating ANY catalogued agent CLI whose own agent is mid-turn', () => {
        for (const tool of AGENT_CLI_IDS) {
            const r = toolchainUpdateRisk(
                tool,
                { ...idle, busyAgents: [{ label: 'Guardian', tool }] },
                here,
            );
            expect(r.risk, tool).toBe('blocked');
            expect(r.reason, tool).toContain('Guardian');
        }
    });

    it('BLOCKS updating node while agents are working, since the TUIs run on it', () => {
        expect(
            toolchainUpdateRisk(
                'node',
                { ...idle, busyAgents: [{ label: 'a', tool: 'claude-code' }] },
                here,
            ).risk,
        ).toBe('blocked');
    });

    it('does NOT block an agent TUI update just because a terminal is open', () => {
        // An open shell is not a running turn. Blocking on mere presence would
        // make the button useless on a normal machine.
        expect(
            toolchainUpdateRisk('claude-code', { ...idle, openTerminals: 4 }, here).risk,
        ).not.toBe('blocked');
    });

    it('WARNS about docker naming the containers a restart would stop', () => {
        const r = toolchainUpdateRisk(
            'docker',
            { ...idle, runningEngines: ['Postgres 16', 'Redis 7'] },
            here,
        );
        expect(r.risk).toBe('warn');
        expect(r.affected).toEqual(['Postgres 16', 'Redis 7']);
        expect(r.reason).toMatch(/restart|stop/i);
        expect(r.reason).toContain('Postgres 16');
    });

    it('WARNS about php naming the sites running on it', () => {
        const r = toolchainUpdateRisk('php', { ...idle, runningSites: ['tynn', 'docs'] }, here);
        expect(r.risk).toBe('warn');
        expect(r.affected).toEqual(['tynn', 'docs']);
        expect(r.reason).toContain('tynn');
    });

    it('WARNS about git while ANY agent is working, whatever CLI it runs', () => {
        // A git update cannot corrupt a running agent's own binary; an in-flight
        // command is the exposure, and that is a warning, not a refusal. Unlike
        // the CLI rule this one IS blanket — any agent can be running git.
        const r = toolchainUpdateRisk(
            'git',
            { ...idle, busyAgents: [{ label: 'Guardian', tool: 'claude-code' }] },
            here,
        );
        expect(r.risk).toBe('warn');
        expect(r.affected).toEqual(['Guardian']);
    });

    it('reports the WORST applicable risk when several things are live', () => {
        const r = toolchainUpdateRisk(
            'node',
            {
                busyAgents: [{ label: 'Guardian', tool: 'claude-code' }],
                openTerminals: 3,
                runningSites: ['tynn'],
                runningEngines: ['Postgres 16'],
            },
            here,
        );
        expect(r.risk).toBe('blocked');
    });

    it('never claims a risk it cannot name', () => {
        // A `warn` with an empty `affected` is just noise; if nothing relevant
        // is live the answer is `safe`.
        const r = toolchainUpdateRisk('docker', { ...idle, runningSites: ['tynn'] }, here);
        expect(r.risk).toBe('safe');
        expect(r.affected).toEqual([]);
    });
});

/**
 * GIT ON WINDOWS — open terminals are a HARD blocker, not a warning.
 *
 * Proven by the installer's own log after the owner tried it from the settings
 * page (winget downloaded, verified, elevated, then):
 *
 *     bash.exe (PID 25992) ... x18
 *     Please terminate those processes and retry.
 *     Got EAbort exception.
 *
 * Git Bash ships WITH Git for Windows, so every Genie terminal is holding the
 * files the installer has to replace. The installer does not degrade — it
 * ABORTS. So the earlier "warn only when agents are busy" was wrong for this
 * case: the blocker is terminal PRESENCE, and it fails deterministically, which
 * makes a button that offers it a button that always fails.
 */
describe('toolchainUpdateRisk — git on Windows with terminals open', () => {
    const win = { ...idle, platform: 'win32' as const };

    it('BLOCKS while any terminal is open, naming Git Bash as the reason', () => {
        const r = toolchainUpdateRisk('git', { ...win, openTerminals: 18 }, here);
        expect(r.risk).toBe('blocked');
        // The message has to say WHAT to do — the installer just aborts.
        expect(r.reason).toMatch(/terminal/i);
        expect(r.reason).toMatch(/close/i);
    });

    it('allows it once every terminal is closed', () => {
        expect(toolchainUpdateRisk('git', { ...win, openTerminals: 0 }, here).risk).toBe('safe');
    });

    it('does NOT block git off Windows, where Git Bash is not the shell', () => {
        const r = toolchainUpdateRisk(
            'git',
            { ...idle, platform: 'linux', openTerminals: 18 },
            here,
        );
        expect(r.risk).not.toBe('blocked');
    });

    it('still blocks an agent TUI mid-turn regardless of terminals', () => {
        expect(
            toolchainUpdateRisk(
                'claude-code',
                { ...win, busyAgents: [{ label: 'a', tool: 'claude-code' }], openTerminals: 0 },
                here,
            ).risk,
        ).toBe('blocked');
    });
});

/**
 * WHICH TOOL, AND INSTALL-IS-NOT-UPDATE (genie#448).
 *
 * The owner could not install the Genie TUI — a CLI that was **not on the
 * machine** — because two **Claude** agents were mid-turn. Two defects met:
 *
 *   1. The refusal asked `AGENT_CRITICAL.has(tool)` ("is this an agent CLI?")
 *      AND `busyAgents.length > 0` ("is ANY agent busy?") with nothing joining
 *      them, so a busy Claude agent blocked every other CLI in the catalog.
 *      With the hand-written two-entry set that was almost always right by
 *      accident; derived from the catalog (#437) it became almost always wrong.
 *   2. The whole justification is *"updating replaces the binary they are
 *      running"* — and an absent tool has no running binary to replace.
 *
 * The fix is NOT to shrink the set: a hand-written set would leave the newest
 * CLIs as the only ones overwritable mid-turn. The set is right; the predicate
 * that consumed it was wrong.
 */
describe('toolchainUpdateRisk — the busy agent must be running THIS tool (genie#448)', () => {
    const claudeBusy: ToolchainActivity = {
        ...idle,
        busyAgents: [
            { label: 'claude · tynn', tool: 'claude-code' },
            { label: 'claude · moic', tool: 'claude-code' },
        ],
    };

    it('does NOT block updating a CLI no busy agent is running', () => {
        for (const tool of ['codex', 'genie', 'gemini-cli', 'opencode'] as const) {
            const r = toolchainUpdateRisk(tool, claudeBusy, { installed: true });
            expect(r.risk, tool).toBe('safe');
        }
    });

    it('POSITIVE CONTROL: still blocks updating the CLI they ARE running', () => {
        // Without this the test above passes just as well against a guard that
        // has stopped guarding — which is strictly worse than the bug.
        const r = toolchainUpdateRisk('claude-code', claudeBusy, { installed: true });
        expect(r.risk).toBe('blocked');
        expect(r.affected).toEqual(['claude · tynn', 'claude · moic']);
        expect(r.reason).toContain('claude · tynn');
    });

    it('names the TOOL as well as the agent', () => {
        // "claude · tynn is mid-turn" on a Genie TUI row is a non-sequitur. The
        // sentence has to say what the conflict is WITH.
        const r = toolchainUpdateRisk('claude-code', claudeBusy, { installed: true });
        expect(r.reason).toContain('Claude Code');
    });

    it('blames only the agents on THAT tool when several are busy', () => {
        const mixed: ToolchainActivity = {
            ...idle,
            busyAgents: [
                { label: 'claude · tynn', tool: 'claude-code' },
                { label: 'codex · moic', tool: 'codex' },
            ],
        };
        const r = toolchainUpdateRisk('codex', mixed, { installed: true });
        expect(r.risk).toBe('blocked');
        expect(r.affected).toEqual(['codex · moic']);
        expect(r.reason).not.toContain('claude · tynn');
    });

    it('never blocks INSTALLING a tool that is absent, whatever is mid-turn', () => {
        // Nothing is being replaced, so no turn can be corrupted. This is the
        // report: the Genie TUI row said "Not installed" and refused anyway.
        for (const tool of ['genie', 'claude-code', 'node', 'git', 'docker'] as const) {
            const r = toolchainUpdateRisk(tool, claudeBusy, { installed: false });
            expect(r.risk, tool).toBe('safe');
        }
    });

    it('still blocks node on ANY busy agent — every agent CLI runs ON it', () => {
        const r = toolchainUpdateRisk('node', claudeBusy, { installed: true });
        expect(r.risk).toBe('blocked');
        expect(r.reason).toMatch(/node/i);
    });

    it('blocks node even for an agent whose provider was never recorded', () => {
        // `meta.agent` can be absent on an older spec. We cannot say WHICH CLI
        // it runs, but we know it runs on Node.
        const r = toolchainUpdateRisk(
            'node',
            { ...idle, busyAgents: [{ label: 'some agent' }] },
            { installed: true },
        );
        expect(r.risk).toBe('blocked');
    });

    it('does not blame an unknown-provider agent for a CLI it may not run', () => {
        // A refusal that cannot name the conflict is the false refusal #448 is
        // about. Node above is the honest blanket rule; this is not.
        const r = toolchainUpdateRisk(
            'claude-code',
            { ...idle, busyAgents: [{ label: 'some agent' }] },
            { installed: true },
        );
        expect(r.risk).toBe('safe');
    });
});

/**
 * The join that was being thrown away: a working terminal knows its provider
 * (`meta.agent`), and the catalog knows which tool a provider runs. `ipc.ts`
 * mapped straight to a LABEL and dropped the provider one line before the guard
 * needed it.
 */
describe('busyAgentOf', () => {
    it('resolves a provider to the catalog tool it runs', () => {
        expect(busyAgentOf('claude · tynn', 'claude')).toEqual({
            label: 'claude · tynn',
            tool: 'claude-code',
        });
        expect(busyAgentOf('c', 'codex').tool).toBe('codex');
        expect(busyAgentOf('g', 'genie').tool).toBe('genie');
    });

    it('carries no tool for a provider that names no fixed binary', () => {
        // A `custom` agent IS its command line; Genie cannot say which catalog
        // binary is executing, and must not guess one.
        expect(busyAgentOf('x', 'custom').tool).toBeUndefined();
    });

    it('carries no tool when the provider is missing or unknown', () => {
        expect(busyAgentOf('x', undefined).tool).toBeUndefined();
        expect(busyAgentOf('x', null).tool).toBeUndefined();
        expect(busyAgentOf('x', 'not-a-provider').tool).toBeUndefined();
    });
});
