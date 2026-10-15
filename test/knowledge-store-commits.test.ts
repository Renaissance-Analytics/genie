import { existsSync, mkdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import { runtimeDir } from '../src/main/paths.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { composeTracker } from './support/compose-tracker.js';
import { walCommits } from './support/sqlite-wal.js';

/**
 * WHAT A NEW KNOWLEDGE STORE COSTS THE DISK (B13) — COUNTED, never timed.
 *
 * The flake: tests that open a SQLite database timed out in 1 full-suite run of 3 and never alone — v1-settings,
 * v1-schedules, compose-v1-knowledge, front-door-state's no-Caddy boot, all in the SAME run. v1-settings' test is
 * synchronous and does four tiny statements: for vitest to call it timed out, that body blocked for 5 s in one
 * stretch, and the only thing in it that can block that long is the disk sync of a commit. The one durable-write
 * primitive anywhere in the suite is SQLite; a sync waits behind everything else the machine is writing, which is why
 * it shows only under the full suite's parallel load. And the front-door-state test that failed is the one in its file
 * that generates NO RSA keys — the ones beside it that generate two per composition did not fail: CPU is not what
 * stalled.
 *
 * Every `composeServices` creates a fresh `knowledge.db`, and the schema went in as one commit PER STATEMENT — six WAL
 * commits, six syncs, on every composition in the suite (37 test files compose). Now it is one transaction: one sync.
 *
 * The gauge reads the WAL's commit frames (test/support/sqlite-wal.ts) while the store is open, and is shown able to
 * count more than one first — "1" from a gauge that can only say 1 would prove nothing.
 */

/** Commits in a database's log, or 0 when it has no log or an empty one (nothing was committed into it). */
const commitsIn = (dbFile: string): number => (existsSync(`${dbFile}-wal`) && statSync(`${dbFile}-wal`).size > 0 ? walCommits(dbFile).commits : 0);

/**
 * What switching a NEW database to WAL alone puts in the log — the floor every count below sits on. Measured, not
 * assumed: SQLite writes the switch into the main file, so this is expected to be 0, and if a build ever logs it the
 * counts below still compare like with like.
 */
function walSwitchFloor(): number {
    const file = join(dir, 'floor.db');
    const db = new DatabaseSync(file);
    try {
        db.exec('PRAGMA journal_mode = WAL');
        return commitsIn(file);
    } finally {
        db.close();
    }
}

let dir: string;
const composed = composeTracker();
const pty: PtyPort = {
    open: () => ({ id: 'term_1', pid: 501, shell: 'sh', scrollback: '' }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    scrollback: () => '',
    onData: () => () => {},
    onExit: () => () => {},
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-knowledge-commits-'));
});

afterEach(async () => {
    await composed.shutdownAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('the WAL commit gauge', () => {
    it('POSITIVE CONTROL: counts each autocommit of a WAL database as one commit — four statements, four commits', () => {
        const floor = walSwitchFloor();
        const file = join(dir, 'control.db');
        const db = new DatabaseSync(file);
        try {
            db.exec('PRAGMA journal_mode = WAL');
            db.exec('CREATE TABLE t (v TEXT)');
            for (const v of ['a', 'b', 'c']) db.prepare('INSERT INTO t (v) VALUES (?)').run(v);
            expect(walCommits(file).commits).toBe(floor + 4);
        } finally {
            db.close();
        }
    });
});

describe('a new knowledge store', () => {
    it('is created in ONE durable commit — not one per table and index', () => {
        const floor = walSwitchFloor();
        const store = KnowledgeStore.open(dir);
        try {
            expect(walCommits(join(runtimeDir(dir), 'knowledge.db')).commits).toBe(floor + 1);
        } finally {
            store.close();
        }
    });

    it('reopened, writes nothing at all: the schema is there, so no commit reaches the log', () => {
        KnowledgeStore.open(dir).close();
        const again = KnowledgeStore.open(dir);
        try {
            // The last close checkpointed and removed the log; a reopen that wrote would have started a new one with a commit.
            expect(commitsIn(join(runtimeDir(dir), 'knowledge.db'))).toBe(0);
        } finally {
            again.close();
        }
    });

    it('is created whole or not at all: a schema that fails part way leaves none of its tables behind, and the file is not held open', async () => {
        // A TABLE already named like one of the store's INDEXES: `CREATE INDEX IF NOT EXISTS nodes_created` refuses
        // ("there is already a table named nodes_created") after `nodes` and `nodes_slug` were created.
        const file = join(runtimeDir(dir), 'knowledge.db');
        mkdirSync(runtimeDir(dir), { recursive: true });
        const seed = new DatabaseSync(file);
        seed.exec('CREATE TABLE nodes_created (x)');
        seed.close();

        expect(() => KnowledgeStore.open(dir)).toThrow(/nodes_created/);

        const look = new DatabaseSync(file, { readOnly: true });
        try {
            const tables = (look.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all() as { name: string }[]).map((r) => r.name);
            expect(tables).toEqual(['nodes_created']);
        } finally {
            look.close();
        }
        // The failed open closed its handle: the folder can be removed at once, on Windows too (no EBUSY).
        await rm(dir, { recursive: true, force: true });
        expect(existsSync(dir)).toBe(false);
    });
});

describe('a composition of all of Genie', () => {
    it('costs the knowledge store ONE durable commit at boot', async () => {
        const floor = walSwitchFloor();
        const home = join(dir, 'genie-home');
        const services = await composed.compose({ userData: home, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
        expect(services.knowledge).toBeDefined();
        expect(walCommits(join(runtimeDir(home), 'knowledge.db')).commits).toBe(floor + 1);
    });
});
