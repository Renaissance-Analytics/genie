import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeDir } from '../src/main/paths.js';
import { ProcessBook, type ProcessBookDeps } from '../src/main/process-book.js';
import type { ProcessSpec, ProcessStatus } from '../src/main/process-supervisor.js';

/**
 * GENIE 1's BACKGROUND PROCESSES COME THROUGH THE UPGRADE (2026-10-14). Genie 1 kept the person's
 * background processes in `genie.db` (`terminal_specs` rows of type 'process', the run settings in
 * `meta_json`) and started them at launch. Genie 2 keeps them in `~/.genie/runtime/processes.json`
 * (process-book.ts) and had none of v1's: measured on a real upgrade, 54 v1 specs and 0 kept.
 *
 * Driven through `ProcessBook.open` — the boot's own door — with a v1 database built here from v1's
 * REAL `CREATE TABLE terminal_specs` (copied from a v1 `genie.db`); every value is invented.
 *
 * The contract:
 * - ONCE: the import is recorded in processes.json itself; a later boot imports nothing more, so a
 *   process removed, stopped or changed in Genie 2 stays as the person left it.
 * - A boot that cannot see v1 is PROVISIONAL: a later boot that can see it still imports.
 * - Nothing starts that v1 would not have started: wanted = enabled && autostart && !user_stopped;
 *   a hibernated workspace's process is held back by the restore, as for any kept process.
 * - Scheduled specs belong to Flows, not here: not imported, noted. Neither is a spec with no
 *   workspace, no command, a folder outside its workspace, or a workspace Genie 2 does not have —
 *   each is NOTED with why, never silently dropped.
 * - v1's database is opened read-only: its bytes are the same after the import.
 */

const TERMINAL_SPECS = `CREATE TABLE terminal_specs (
                        id            TEXT PRIMARY KEY,
                        workspace_id  TEXT,
                        label         TEXT NOT NULL,
                        cwd           TEXT NOT NULL,
                        shell         TEXT,
                        args_json     TEXT NOT NULL DEFAULT '[]',
                        env_json      TEXT NOT NULL DEFAULT '{}',
                        sort_order    INTEGER NOT NULL DEFAULT 0,
                        created_at    TEXT NOT NULL,
                        last_opened_at TEXT, type TEXT NOT NULL DEFAULT 'terminal', meta_json TEXT NOT NULL DEFAULT '{}', snapshot_at INTEGER, snapshot_bytes INTEGER, live_cwd TEXT, enabled INTEGER NOT NULL DEFAULT 1, host_session_id TEXT,
                        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
                    )`;
/** v1's `workspaces` (its leading columns as v1 created them, plus `hibernated_at`): `terminal_specs` references it, and node:sqlite enforces foreign keys. */
const WORKSPACES = `CREATE TABLE "workspaces" (
                    id                TEXT PRIMARY KEY,
                    tynn_project_id   TEXT NOT NULL,
                    tynn_project_name TEXT NOT NULL,
                    shape             TEXT NOT NULL CHECK (shape IN ('agi','simple')),
                    path              TEXT NOT NULL,
                    editor            TEXT,
                    editor_cmd        TEXT,
                    start_cmd         TEXT,
                    env_file          TEXT,
                    last_opened_at    TEXT,
                    created_by_genie  INTEGER NOT NULL DEFAULT 0
                , backend TEXT NOT NULL DEFAULT 'tynn', project_id   TEXT, project_name TEXT, sort_order INTEGER NOT NULL DEFAULT 0, hibernated_at INTEGER)`;

const WS ={ id: 'ws-example', path: '/w/example' };
const SLEEPY = { id: 'ws-sleepy', path: '/w/sleepy' };
const WINDOWS = { id: 'ws-win', path: 'C:\\w\\example-win' };

interface Row {
    id: string;
    workspace_id: string | null;
    label: string;
    cwd: string;
    meta: Record<string, unknown>;
    type?: string;
    shell?: string | null;
    enabled?: number;
}

const rows: Row[] = [
    { id: 'p-web', workspace_id: WS.id, label: 'web', cwd: WS.path, meta: { command: 'npm run dev', autostart: true, was_running: true } },
    { id: 'p-queue', workspace_id: WS.id, label: 'queue', cwd: `${WS.path}/repos/app`, meta: { command: 'php artisan queue:work', autostart: true, user_stopped: true, was_running: false } },
    { id: 'p-was', workspace_id: WS.id, label: 'watcher', cwd: WS.path, meta: { command: 'npm run watch', autostart: false, was_running: true } },
    { id: 'p-once', workspace_id: WS.id, label: 'migrate', cwd: WS.path, meta: { command: 'npm run migrate', autostart: true, restart_on_exit: false } },
    { id: 'p-nightly', workspace_id: WS.id, label: 'nightly', cwd: WS.path, meta: { command: 'npm run report', schedule: '0 3 * * *', schedule_kind: 'command' } },
    { id: 'p-nudge', workspace_id: WS.id, label: 'nudge', cwd: WS.path, meta: { schedule: '*/30 * * * *', schedule_kind: 'agent-nudge', nudge_prompt: 'check in', nudge_target_terminal_id: 't-1' } },
    { id: 'p-system', workspace_id: null, label: 'system service', cwd: '/w', meta: { command: 'serve', autostart: false, system: true } },
    { id: 'p-outside', workspace_id: WS.id, label: 'outside', cwd: '/w/example-other/app', meta: { command: 'npm start', autostart: true } },
    { id: 'p-nocmd', workspace_id: WS.id, label: 'empty', cwd: WS.path, meta: { autostart: true } },
    { id: 'p-off', workspace_id: WS.id, label: 'disabled', cwd: WS.path, enabled: 0, meta: { command: 'npm run off', autostart: true } },
    { id: 'p-shell', workspace_id: WS.id, label: 'bash job', cwd: WS.path, shell: '/bin/bash', meta: { command: 'make serve', autostart: true } },
    { id: 'p-gone', workspace_id: 'ws-not-in-genie2', label: 'orphan', cwd: '/w/gone', meta: { command: 'npm start', autostart: true } },
    { id: 'p-sleepy', workspace_id: SLEEPY.id, label: 'sleepy', cwd: SLEEPY.path, meta: { command: 'npm start', autostart: true } },
    { id: 'p-win', workspace_id: WINDOWS.id, label: 'win api', cwd: 'c:\\W\\Example-Win\\repos\\api', meta: { command: 'npm start', autostart: true } },
    { id: 'p-win-prefix', workspace_id: WINDOWS.id, label: 'win prefix', cwd: 'C:\\w\\example-win-2', meta: { command: 'npm start', autostart: true } },
    { id: 't-shell', workspace_id: WS.id, label: 'a terminal', cwd: WS.path, type: 'terminal', meta: { command: 'npm start', autostart: true } },
];

function writeV1(file: string, specs: readonly Row[]): void {
    const db = new DatabaseSync(file);
    db.exec(WORKSPACES);
    db.exec(TERMINAL_SPECS);
    const ws = db.prepare("INSERT INTO workspaces (id, tynn_project_id, tynn_project_name, shape, path) VALUES (?, ?, ?, 'agi', ?)");
    for (const id of new Set(specs.map((r) => r.workspace_id).filter((id): id is string => id !== null))) ws.run(id, `p-${id}`, id, `/w/${id}`);
    const ins = db.prepare('INSERT INTO terminal_specs (id, workspace_id, label, cwd, shell, created_at, type, meta_json, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of specs) ins.run(r.id, r.workspace_id, r.label, r.cwd, r.shell ?? null, '2026-07-01T09:00:00.000Z', r.type ?? 'process', JSON.stringify(r.meta), r.enabled ?? 1);
    db.close();
}

const started: ProcessSpec[] = [];
const supervisor: ProcessBookDeps['supervisor'] = {
    start: (spec: ProcessSpec) => { started.push(spec); return { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 1, exitCode: null, restarts: 0, since: 0 } satisfies ProcessStatus; },
    stop: () => true,
    forget: () => {},
    list: () => [],
} as never;

let home: string;
let v1File: string;
const bookFile = () => join(runtimeDir(home), 'processes.json');
const onDisk = (): { processes?: Array<Record<string, unknown>>; v1Import?: Record<string, unknown> } => (existsSync(bookFile()) ? JSON.parse(readFileSync(bookFile(), 'utf8')) : {});
const open = (database: string = v1File) =>
    ProcessBook.open(home, {
        supervisor,
        envFor: () => ({}),
        asleep: (id) => id === SLEEPY.id,
        now: () => Date.UTC(2026, 9, 14),
        v1: { database, workspaces: () => [WS, SLEEPY, WINDOWS] },
    } as ProcessBookDeps);
const md5 = (f: string) => createHash('md5').update(readFileSync(f)).digest('hex');

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'genie2-v1-processes-'));
    v1File = join(home, 'v1-genie.db');
    started.length = 0;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("Genie 1's background processes, imported once at boot", () => {
    it('maps each v1 process faithfully: v1 id kept, label as the name, command, folder, restart from restart_on_exit; wanted only when enabled, autostart and not stopped', async () => {
        writeV1(v1File, rows);
        const book = await open();
        const kept = new Map(book.kept().map((p) => [p.id, p]));
        expect([...kept.keys()].sort()).toEqual(['proc_v1_p-off', 'proc_v1_p-once', 'proc_v1_p-queue', 'proc_v1_p-shell', 'proc_v1_p-sleepy', 'proc_v1_p-was', 'proc_v1_p-web', 'proc_v1_p-win']);
        expect(kept.get('proc_v1_p-web')).toEqual({ id: 'proc_v1_p-web', workspaceId: WS.id, name: 'web', command: 'npm run dev', cwd: WS.path, restart: 'always', wanted: true, changedAt: Date.UTC(2026, 9, 14) });
        expect(kept.get('proc_v1_p-queue')).toMatchObject({ cwd: `${WS.path}/repos/app`, wanted: false });
        // v1 would have restored a was_running-only process; this import starts only what v1 was told to autostart.
        expect(kept.get('proc_v1_p-was')).toMatchObject({ wanted: false });
        expect(kept.get('proc_v1_p-once')).toMatchObject({ restart: 'never', wanted: true });
        expect(kept.get('proc_v1_p-off')).toMatchObject({ wanted: false });
        expect(kept.get('proc_v1_p-shell')).toMatchObject({ command: 'make serve', wanted: true });
        expect(kept.get('proc_v1_p-win')).toMatchObject({ workspaceId: WINDOWS.id, cwd: 'c:\\W\\Example-Win\\repos\\api', wanted: true });
    });

    it('notes everything it did not import or could not carry, with why — scheduled specs are for Flows, never processes', async () => {
        writeV1(v1File, rows);
        await open();
        const record = onDisk().v1Import!;
        expect(record).toMatchObject({ sawV1: true, imported: 8, wanted: 5, alreadyHere: 0 });
        const notes = record.notes as string[];
        expect(notes).toHaveLength(9);
        const about = (id: string) => notes.filter((n) => n.includes(id));
        expect(about('p-nightly')).toEqual([expect.stringMatching(/scheduled.*Flows/)]);
        expect(about('p-nudge')).toEqual([expect.stringMatching(/scheduled.*Flows/)]);
        expect(about('p-system')).toEqual([expect.stringMatching(/no workspace/)]);
        expect(about('p-outside')).toEqual([expect.stringMatching(/outside its workspace/)]);
        expect(about('p-win-prefix')).toEqual([expect.stringMatching(/outside its workspace/)]);
        expect(about('p-nocmd')).toEqual([expect.stringMatching(/no command/)]);
        expect(about('p-gone')).toEqual([expect.stringMatching(/workspace .*not in Genie 2/)]);
        expect(about('p-off')).toEqual([expect.stringMatching(/disabled in Genie 1.*stopped/)]);
        expect(about('p-shell')).toEqual([expect.stringMatching(/shell/)]);
        // A terminal is not a background process: not imported, not noted.
        expect(about('t-shell')).toEqual([]);
    });

    it("nothing starts that v1 would not have: the restore starts the wanted ones and holds back a hibernated workspace's", async () => {
        writeV1(v1File, rows);
        const book = await open();
        expect(started).toEqual([]); // the import itself starts nothing
        const restored = book.restore();
        expect(restored.started.sort()).toEqual(['proc_v1_p-once', 'proc_v1_p-shell', 'proc_v1_p-web', 'proc_v1_p-win']);
        expect(restored.heldBack).toEqual(['proc_v1_p-sleepy']);
        expect(started.map((s) => s.id).sort()).toEqual(['proc_v1_p-once', 'proc_v1_p-shell', 'proc_v1_p-web', 'proc_v1_p-win']);
    });

    it('once: what the person removed, stopped or added in Genie 2 is kept as they left it, and a later v1 row is not picked up', async () => {
        writeV1(v1File, rows);
        const first = await open();
        await first.remove('proc_v1_p-web');
        await first.stop('proc_v1_p-shell');
        await first.create({ workspaceId: WS.id, workspacePath: WS.path, name: 'mine', command: 'npm run mine', restart: 'never' });
        rmSync(v1File);
        writeV1(v1File, [...rows, { id: 'p-late', workspace_id: WS.id, label: 'late', cwd: WS.path, meta: { command: 'npm run late', autostart: true } }]);

        const second = await open();
        const ids = second.kept().map((p) => p.id);
        expect(ids).not.toContain('proc_v1_p-web');
        expect(ids).not.toContain('proc_v1_p-late');
        expect(second.kept().find((p) => p.id === 'proc_v1_p-shell')!.wanted).toBe(false);
        expect(second.kept().some((p) => p.name === 'mine')).toBe(true);
        // The record survives the person's own add/stop/remove (each rewrites the file).
        expect(onDisk().v1Import).toMatchObject({ sawV1: true, imported: 8 });
    });

    it('a boot that cannot see v1 is provisional: nothing kept, recorded as not seen; a later boot that can see it imports', async () => {
        const blind = await open(join(home, 'no-such.db'));
        expect(blind.kept()).toEqual([]);
        expect(onDisk().v1Import).toMatchObject({ sawV1: false });

        writeV1(v1File, rows);
        const seeing = await open();
        expect(seeing.kept()).toHaveLength(8);
        expect(onDisk().v1Import).toMatchObject({ sawV1: true, imported: 8 });
    });

    it('never overwrites: a kept process with the same id is left exactly as it is, and counted', async () => {
        writeV1(v1File, rows);
        const mine = { id: 'proc_v1_p-web', workspaceId: WS.id, name: 'web (mine)', command: 'npm run dev -- --port 4100', cwd: WS.path, restart: 'never', wanted: false, changedAt: 7 };
        mkdirSync(runtimeDir(home), { recursive: true });
        writeFileSync(bookFile(), JSON.stringify({ processes: [mine] }));
        const book = await open();
        expect(book.kept().find((p) => p.id === 'proc_v1_p-web')).toEqual(mine);
        expect(onDisk().v1Import).toMatchObject({ imported: 7, alreadyHere: 1 });
    });

    it("reads v1's database without changing a byte of it", async () => {
        writeV1(v1File, rows);
        const before = md5(v1File);
        await open();
        expect(md5(v1File)).toBe(before);
    });

    it('boot wires v1 into the book it opens, before the restore runs', () => {
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
        const openAt = main.indexOf('processBook = await ProcessBook.open(');
        const restoreAt = main.indexOf('processBook.restore()');
        expect(openAt).toBeGreaterThan(0);
        expect(restoreAt).toBeGreaterThan(openAt);
        expect(main.slice(openAt, restoreAt)).toMatch(/v1:\s*\{\s*database:\s*v1DatabaseFile\(\)/);
    });
});
