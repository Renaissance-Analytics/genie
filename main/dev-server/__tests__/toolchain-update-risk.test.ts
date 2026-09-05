import { describe, expect, it } from 'vitest';
import {
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

describe('toolchainUpdateRisk', () => {
    it('is safe on a quiet machine, whatever the tool', () => {
        for (const tool of ['git', 'node', 'docker', 'claude-code', 'php'] as const) {
            expect(toolchainUpdateRisk(tool, idle).risk).toBe('safe');
        }
    });

    it('BLOCKS updating an agent TUI while an agent is mid-turn', () => {
        // Overwriting the binary a running agent is executing: on Windows the
        // write fails outright, and elsewhere it corrupts a live turn.
        const r = toolchainUpdateRisk('claude-code', { ...idle, busyAgents: ['Guardian', 'Tynn'] });
        expect(r.risk).toBe('blocked');
        expect(r.affected).toEqual(['Guardian', 'Tynn']);
        expect(r.reason).toMatch(/mid-turn|working/i);
        // It has to name them — "are you sure" teaches nothing.
        expect(r.reason).toContain('Guardian');
    });

    it('BLOCKS updating codex mid-turn too — same mechanism', () => {
        expect(toolchainUpdateRisk('codex', { ...idle, busyAgents: ['a'] }).risk).toBe('blocked');
    });

    /**
     * EVERY agent CLI, not the two that were written down.
     *
     * The refusal listed `claude-code` and `codex` by hand, which was complete
     * only while the toolchain knew of exactly those two. The moment Genie could
     * install more of them, a hand-written set becomes a hole with the worst
     * possible shape: the new CLIs would be the ONLY ones you could overwrite
     * while their agent was mid-turn. Derived from the catalog, adding a CLI
     * cannot open that hole.
     */
    it('BLOCKS updating ANY catalogued agent CLI mid-turn, not just the two hardcoded ones', () => {
        for (const tool of AGENT_CLI_IDS) {
            const r = toolchainUpdateRisk(tool, { ...idle, busyAgents: ['Guardian'] });
            expect(r.risk, tool).toBe('blocked');
            expect(r.reason, tool).toContain('Guardian');
        }
    });

    it('BLOCKS updating node while agents are working, since the TUIs run on it', () => {
        expect(toolchainUpdateRisk('node', { ...idle, busyAgents: ['a'] }).risk).toBe('blocked');
    });

    it('does NOT block an agent TUI update just because a terminal is open', () => {
        // An open shell is not a running turn. Blocking on mere presence would
        // make the button useless on a normal machine.
        expect(toolchainUpdateRisk('claude-code', { ...idle, openTerminals: 4 }).risk).not.toBe(
            'blocked',
        );
    });

    it('WARNS about docker naming the containers a restart would stop', () => {
        const r = toolchainUpdateRisk('docker', {
            ...idle,
            runningEngines: ['Postgres 16', 'Redis 7'],
        });
        expect(r.risk).toBe('warn');
        expect(r.affected).toEqual(['Postgres 16', 'Redis 7']);
        expect(r.reason).toMatch(/restart|stop/i);
        expect(r.reason).toContain('Postgres 16');
    });

    it('WARNS about php naming the sites running on it', () => {
        const r = toolchainUpdateRisk('php', { ...idle, runningSites: ['tynn', 'docs'] });
        expect(r.risk).toBe('warn');
        expect(r.affected).toEqual(['tynn', 'docs']);
        expect(r.reason).toContain('tynn');
    });

    it('WARNS about git while agents are working, without blocking it', () => {
        // A git update cannot corrupt a running agent's own binary; an in-flight
        // command is the exposure, and that is a warning, not a refusal.
        const r = toolchainUpdateRisk('git', { ...idle, busyAgents: ['Guardian'] });
        expect(r.risk).toBe('warn');
        expect(r.affected).toEqual(['Guardian']);
    });

    it('reports the WORST applicable risk when several things are live', () => {
        const r = toolchainUpdateRisk('node', {
            busyAgents: ['Guardian'],
            openTerminals: 3,
            runningSites: ['tynn'],
            runningEngines: ['Postgres 16'],
        });
        expect(r.risk).toBe('blocked');
    });

    it('never claims a risk it cannot name', () => {
        // A `warn` with an empty `affected` is just noise; if nothing relevant
        // is live the answer is `safe`.
        const r = toolchainUpdateRisk('docker', { ...idle, runningSites: ['tynn'] });
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
        const r = toolchainUpdateRisk('git', { ...win, openTerminals: 18 });
        expect(r.risk).toBe('blocked');
        // The message has to say WHAT to do — the installer just aborts.
        expect(r.reason).toMatch(/terminal/i);
        expect(r.reason).toMatch(/close/i);
    });

    it('allows it once every terminal is closed', () => {
        expect(toolchainUpdateRisk('git', { ...win, openTerminals: 0 }).risk).toBe('safe');
    });

    it('does NOT block git off Windows, where Git Bash is not the shell', () => {
        const r = toolchainUpdateRisk('git', { ...idle, platform: 'linux', openTerminals: 18 });
        expect(r.risk).not.toBe('blocked');
    });

    it('still blocks an agent TUI mid-turn regardless of terminals', () => {
        expect(
            toolchainUpdateRisk('claude-code', { ...win, busyAgents: ['a'], openTerminals: 0 }).risk,
        ).toBe('blocked');
    });
});
