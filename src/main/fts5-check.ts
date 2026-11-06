import { DatabaseSync } from 'node:sqlite';

/**
 * FTS5, BEFORE GENIE-HOST BINDS ANYTHING (P10.1b). The knowledge store makes an FTS5 table (knowledge-store.ts), and
 * `node:sqlite` has FTS5 only from Node 22.16.0 (measured in CI: 22.13.1, 22.14.0 and 22.15.0 answer "no such module:
 * fts5"). A host on an older Node used to get as far as opening its stores and die there; now it refuses at boot, in
 * words naming the Node it found and the one it needs, before its endpoint is bound — no host.json, no listener.
 */

/** The first Node 22 whose `node:sqlite` has FTS5 (measured). */
export const FTS5_NODE_FLOOR = '22.16.0';

/** Makes an FTS5 table in a database in memory; throws when this runtime's SQLite has no FTS5. */
function realProbe(): void {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('CREATE VIRTUAL TABLE genie_fts5_probe USING fts5(a)');
    } finally {
        db.close();
    }
}

/** Why this host cannot start for want of FTS5, or null when it has it. */
export function fts5Refusal(probe: () => void = realProbe, nodeVersion: string = process.version): string | null {
    try {
        probe();
        return null;
    } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        return `genie-host cannot start: this Node (${nodeVersion}) has no FTS5 in node:sqlite (${why}), and Genie's knowledge store needs it. Run genie-host on Node ${FTS5_NODE_FLOOR} or later.`;
    }
}
