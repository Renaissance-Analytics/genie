/**
 * FTS5, BEFORE GENIE-HOST BINDS ANYTHING (P10.1b). The knowledge store makes an FTS5 table (knowledge-store.ts), and
 * `node:sqlite` has FTS5 only from Node 22.16.0 (measured in CI: 22.13.1, 22.14.0 and 22.15.0 answer "no such module:
 * fts5"). A host on an older Node used to get as far as opening its stores and die there; now it refuses at boot, in
 * words naming the Node it found and the one it needs, before its endpoint is bound — no host.json, no listener.
 */

/** The first Node 22 whose `node:sqlite` has FTS5 (measured). */
export const FTS5_NODE_FLOOR = '22.16.0';

/** Why this host cannot start for want of FTS5, or null when it has it. */
export function fts5Refusal(_probe: () => void = () => {}, _nodeVersion: string = process.version): string | null {
    return null;
}
