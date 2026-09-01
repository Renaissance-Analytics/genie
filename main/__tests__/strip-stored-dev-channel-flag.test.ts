import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db';

/**
 * A stored command outranks a corrected default — again.
 *
 * #324 stopped Genie ADDING `--dangerously-load-development-channels`, which
 * prompts on every launch. But a terminal spec written before that has the flag
 * baked into `meta_json.agent_command`, and a revive replays the stored command
 * verbatim (`main/terminal/ipc.ts`):
 *
 *     launchCommand = typeof priorSpec?.meta?.agent_command === 'string'
 *         ? priorSpec.meta.agent_command
 *
 * so the command builder — and the strip inside it — never runs. Those agents
 * keep prompting forever while the code that would fix them sits unused.
 *
 * This is the same shape as the `genie-tui` retirement that needed v58: a value
 * persisted into a cache that outranks the registry. v58's remedy applies here
 * too — REMOVE the stored command so resolution falls through to the builder,
 * rather than trying to edit a string inside JSON.
 *
 * Only specs that actually carry the dead flag are touched. A command the owner
 * chose survives untouched, or the repair is worse than the bug.
 */

function db(): Database.Database {
    const d = new Database(':memory:');
    runMigrations(d);
    return d;
}

function spec(d: Database.Database, id: string, command: string | null): void {
    const meta = command === null
        ? JSON.stringify({ agent: 'claude' })
        : JSON.stringify({ agent: 'claude', agent_command: command });
    d.prepare(
        `INSERT INTO terminal_specs (id, workspace_id, label, cwd, type, meta_json, created_at)
         VALUES (?, NULL, ?, '.', 'terminal', ?, datetime('now'))`,
    ).run(id, id, meta);
}

function storedCommand(d: Database.Database, id: string): string | null {
    return (
        d
            .prepare<[string], { c: string | null }>(
                "SELECT json_extract(meta_json, '$.agent_command') AS c FROM terminal_specs WHERE id = ?",
            )
            .get(id)?.c ?? null
    );
}

const DEV_FLAG = '--dangerously-load-development-channels server:genie-agentinbox-channel';

describe('v59 strips the interactive channel flag from stored commands', () => {
    it('drops a stored command that carries the dead flag', () => {
        const d = new Database(':memory:');
        runMigrations(d);
        // Re-run against a spec inserted AFTER migration, then migrate again the
        // way a real upgrade would: insert, bump back, re-run.
        spec(d, 'stale', `claude --dangerously-skip-permissions ${DEV_FLAG}`);
        d.prepare('DELETE FROM schema_version WHERE version >= 59').run();
        runMigrations(d);

        expect(storedCommand(d, 'stale')).toBeNull();
    });

    it('leaves a command the owner actually chose alone', () => {
        // POSITIVE CONTROL: an indiscriminate wipe would pass the test above and
        // destroy every customised launch command on the machine.
        const d = new Database(':memory:');
        runMigrations(d);
        spec(d, 'mine', 'claude --model opus --my-own-flag');
        d.prepare('DELETE FROM schema_version WHERE version >= 59').run();
        runMigrations(d);

        expect(storedCommand(d, 'mine')).toBe('claude --model opus --my-own-flag');
    });

    it('is harmless on a spec that stores no command at all', () => {
        const d = new Database(':memory:');
        runMigrations(d);
        spec(d, 'none', null);
        d.prepare('DELETE FROM schema_version WHERE version >= 59').run();
        expect(() => runMigrations(d)).not.toThrow();
        expect(storedCommand(d, 'none')).toBeNull();
    });

    it('records itself, so it runs exactly once', () => {
        const d = db();
        const applied = d
            .prepare<[], { version: number }>('SELECT version FROM schema_version WHERE version = 59')
            .get();
        expect(applied?.version).toBe(59);
    });
});
