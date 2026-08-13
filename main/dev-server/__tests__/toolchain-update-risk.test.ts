import { describe, expect, it } from 'vitest';
import {
    toolchainUpdateRisk,
    type ToolchainActivity,
} from '../toolchain-update-risk';

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
