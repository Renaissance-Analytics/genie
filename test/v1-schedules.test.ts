import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeDir } from '../src/main/paths.js';
import { ProcessBook } from '../src/main/process-book.js';
import { inOneTransaction, openFixtureDb } from './support/sqlite-fixture.js';

/**
 * GENIE 1's SCHEDULED TASKS COME THROUGH THE UPGRADE (hosting ship line P4). Genie 1 kept a scheduled task as a
 * background process with a schedule (`terminal_specs` type 'process', `meta_json.schedule` + `schedule_kind`);
 * and Genie 2 keeps them the same way (genie#1204; the owner, 2026-10-26: "a scheduled command is a BG Process in a
 * workspace, just with a schedule"). Earlier betas imported them as flows; test/scheduled-tasks-move.test.ts moves those.
 *
 * Driven through `ProcessBook.open` — the boot's own call — with a v1 database built here from v1's REAL `CREATE TABLE`
 * statements (copied from a v1 `genie.db`); every value is invented.
 *
 * The contract:
 * - Every task comes over as a scheduled background process, PAUSED: the person enables what they want. One that was
 *   firing in Genie 1 is NOTED so, so the person knows what stopped.
 * - `command` runs in its folder; `agent-nudge` prompts the agent at its FULL Genie 2 address; the schedule has no
 *   timezone (local, as Genie 1's).
 * - ONCE: recorded in processes.json itself; a later boot imports nothing more, so what the person removed or changed
 *   stays as they left it. A boot that cannot see v1 is PROVISIONAL. An id already here is left alone.
 * - Not imported, each NOTED with why: no workspace, a workspace Genie 2 lacks, an unreadable schedule, no
 *   command, a folder outside the workspace, an agent v1 no longer knows or Genie 2 lacks, a v1 workflow task.
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
const WORKSPACE_AGENTS =
    "CREATE TABLE workspace_agents ( id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, tui TEXT, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', avatar TEXT, boot_cwd TEXT, persona_path TEXT, role TEXT NOT NULL DEFAULT 'specialized' CHECK (role IN ('workspace','specialized','gapp')), parent_agent_id TEXT, terminal_spec_id TEXT, reachability TEXT NOT NULL DEFAULT 'workspace' CHECK (reachability IN ('workspace','workstation','hidden')), wake_on_dm INTEGER NOT NULL DEFAULT 1, ready_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, transport TEXT CHECK (transport IN ('claude-channel','codex-app-server')), transport_verified_at INTEGER, transport_error TEXT, native_transport TEXT, collision_group TEXT, budget_cost_usd_per_day REAL, budget_turns_per_day INTEGER, budget_action TEXT NOT NULL DEFAULT 'stop-and-ask' )";

const WS = { id: 'ws-example', path: '/w/example' };

interface Row {
    id: string;
    workspace_id: string | null;
    label: string;
    cwd: string;
    meta: Record<string, unknown>;
    type?: string;
    enabled?: number;
}

const rows: Row[] = [
    { id: 's-report', workspace_id: WS.id, label: 'nightly report', cwd: `${WS.path}/repos/app`, meta: { command: 'npm run report', schedule: '0 3 * * *', schedule_kind: 'command' } },
    { id: 's-root', workspace_id: WS.id, label: 'prune', cwd: WS.path, enabled: 0, meta: { command: 'npm run prune', schedule: '*/15 * * * *' } },
    { id: 's-pending', workspace_id: WS.id, label: 'agent-made', cwd: WS.path, meta: { command: 'npm run sync', schedule: '0 * * * *', schedule_pending_approval: true } },
    { id: 's-nudge', workspace_id: WS.id, label: 'standup', cwd: WS.path, meta: { schedule: '0 9 * * 1-5', schedule_kind: 'agent-nudge', nudge_prompt: 'post the standup', nudge_agent_id: 'u-atlas' } },
    { id: 's-nudge-term', workspace_id: WS.id, label: 'scout sweep', cwd: WS.path, meta: { schedule: '30 * * * *', schedule_kind: 'agent-nudge', nudge_prompt: 'sweep the issues', nudge_target_terminal_id: 't-scout' } },
    { id: 's-nudge-gone', workspace_id: WS.id, label: 'orphan nudge', cwd: WS.path, meta: { schedule: '0 8 * * *', schedule_kind: 'agent-nudge', nudge_prompt: 'hello', nudge_agent_id: 'u-vanished' } },
    { id: 's-nudge-ghost', workspace_id: WS.id, label: 'ghost nudge', cwd: WS.path, meta: { schedule: '0 8 * * *', schedule_kind: 'agent-nudge', nudge_prompt: 'hello', nudge_agent_id: 'u-ghost' } },
    { id: 's-flow', workspace_id: WS.id, label: 'workflow', cwd: WS.path, meta: { schedule: '0 4 * * *', schedule_kind: 'flow', flow_id: 'f-1' } },
    { id: 's-bad-cron', workspace_id: WS.id, label: 'bad cron', cwd: WS.path, meta: { command: 'npm test', schedule: 'every day' } },
    { id: 's-outside', workspace_id: WS.id, label: 'outside', cwd: '/w/example-other', meta: { command: 'npm test', schedule: '0 1 * * *' } },
    { id: 's-nocmd', workspace_id: WS.id, label: 'empty', cwd: WS.path, meta: { schedule: '0 1 * * *' } },
    { id: 's-noworkspace', workspace_id: null, label: 'system', cwd: '/w', meta: { command: 'backup', schedule: '0 2 * * *' } },
    { id: 's-gone-ws', workspace_id: 'ws-not-in-genie2', label: 'elsewhere', cwd: '/w/gone', meta: { command: 'npm test', schedule: '0 2 * * *' } },
    // Not scheduled: the background-process import's business — neither imported nor noted here.
    { id: 'p-plain', workspace_id: WS.id, label: 'web', cwd: WS.path, meta: { command: 'npm run dev', autostart: true } },
    // scout's terminal, carrying its inbox id.
    { id: 't-scout', workspace_id: WS.id, label: 'scout', cwd: WS.path, type: 'terminal', meta: { agent_id: 'inbox-scout' } },
];

/**
 * Genie 1's database, built as a FIXTURE (test/support/sqlite-fixture.ts, B13): unsynced, in one transaction. It was
 * 23 synced autocommits per call — ~70 disk syncs, nine calls in this file — and under the full suite's parallel load
 * that alone timed tests here out. The reader opens it read-only either way; the rows are the same.
 */
function writeV1(file: string, specs: readonly Row[]): void {
    const db = openFixtureDb(file);
    try {
        inOneTransaction(db, () => {
            db.exec(WORKSPACES);
            db.exec(TERMINAL_SPECS);
            db.exec(WORKSPACE_AGENTS);
            const ws = db.prepare("INSERT INTO workspaces (id, tynn_project_id, tynn_project_name, shape, path) VALUES (?, ?, ?, 'agi', ?)");
            for (const id of new Set(specs.map((r) => r.workspace_id).filter((id): id is string => id !== null))) ws.run(id, `p-${id}`, id, `/w/${id}`);
            const ins = db.prepare('INSERT INTO terminal_specs (id, workspace_id, label, cwd, created_at, type, meta_json, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            for (const r of specs) ins.run(r.id, r.workspace_id, r.label, r.cwd, '2026-07-01T09:00:00.000Z', r.type ?? 'process', JSON.stringify(r.meta), r.enabled ?? 1);
            const agent = db.prepare('INSERT INTO workspace_agents (id, workspace_id, tui, name, terminal_spec_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)');
            agent.run('u-atlas', WS.id, 'claude', 'atlas', null);
            agent.run('agent:t-scout', WS.id, 'codex', 'scout', 't-scout');
            agent.run('u-ghost', WS.id, 'claude', 'ghost', null);
        });
    } finally {
        db.close();
    }
}

/** Genie 2's roster after its own v1 agent import: atlas and scout came over; ghost did not. */
const roster = [
    { id: 'agent_atlas', workspaceId: WS.id, provider: 'claude', name: 'atlas' },
    { id: 'agent_scout', workspaceId: WS.id, provider: 'codex', name: 'scout' },
];

let home: string;
let v1File: string;
const processesFile = () => join(runtimeDir(home), 'processes.json');
const onDisk = (): { processes?: Array<Record<string, unknown>>; v1ScheduleImport?: Record<string, unknown> } => (existsSync(processesFile()) ? JSON.parse(readFileSync(processesFile(), 'utf8')) : {});
const supervisor = { start: () => { throw new Error('the import starts nothing'); }, stop: () => true, forget: () => true, list: () => [] };
/** The book as the boot opens it: Genie 1's background processes AND scheduled tasks, imported once. */
const openBook = (database: string = v1File) => ProcessBook.open(home, { supervisor, envFor: () => ({}), asleep: () => false, v1: { database, workspaces: () => [WS], roster: () => roster } });
const scheduledOf = (book: ProcessBook) => new Map(book.kept().filter((p) => p.schedule !== undefined).map((p) => [p.id, p]));
const md5 = (f: string) => createHash('md5').update(readFileSync(f)).digest('hex');

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'genie2-v1-schedules-'));
    v1File = join(home, 'v1-genie.db');
});
afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

describe("Genie 1's scheduled tasks, imported once as PAUSED scheduled background processes", () => {
    it('maps each task faithfully: a command runs in its folder, a nudge prompts the agent at its full address — every one paused, local time', async () => {
        writeV1(v1File, rows);
        const byId = scheduledOf(await openBook());
        expect([...byId.keys()].sort()).toEqual(['proc_v1_s-nudge', 'proc_v1_s-nudge-term', 'proc_v1_s-pending', 'proc_v1_s-report', 'proc_v1_s-root']);
        for (const p of byId.values()) {
            expect(p.wanted).toBe(false);
            expect(p.workspaceId).toBe(WS.id);
        }
        expect(byId.get('proc_v1_s-report')).toMatchObject({ name: 'nightly report', command: 'npm run report', cwd: join(WS.path, 'repos/app'), schedule: { cron: '0 3 * * *', kind: 'command' } });
        expect(byId.get('proc_v1_s-root')).toMatchObject({ command: 'npm run prune', cwd: WS.path });
        expect(byId.get('proc_v1_s-nudge')!.schedule).toMatchObject({ kind: 'agent-nudge', agent: 'ws-example:claude:atlas', prompt: 'post the standup' });
        // The terminal's agent, found through the terminal the nudge named.
        expect(byId.get('proc_v1_s-nudge-term')!.schedule).toMatchObject({ kind: 'agent-nudge', agent: 'ws-example:codex:scout', prompt: 'sweep the issues' });
    });

    it('records what it did in processes.json and NOTES, with why, what was firing (now paused) and everything not imported', async () => {
        writeV1(v1File, rows);
        await openBook();
        const record = onDisk().v1ScheduleImport!;
        expect(record).toMatchObject({ sawV1: true, imported: 5, alreadyHere: 0 });
        const notes = record.notes as string[];
        const about = (id: string) => notes.filter((n) => n.includes(`task ${id} `));
        // Firing in Genie 1 (enabled, approved) → said so; disabled or awaiting approval → nothing to say.
        for (const id of ['s-report', 's-nudge', 's-nudge-term']) expect(about(id)).toEqual([expect.stringMatching(/was firing on its schedule in Genie 1; it comes over PAUSED/)]);
        expect(about('s-root')).toEqual([]);
        expect(about('s-pending')).toEqual([]);
        expect(about('s-nudge-gone')).toEqual([expect.stringMatching(/Genie 1 no longer knows which agent/)]);
        expect(about('s-nudge-ghost')).toEqual([expect.stringMatching(/its agent ghost .* is not in Genie 2; not imported/)]);
        expect(about('s-flow')).toEqual([expect.stringMatching(/ran a Genie 1 workflow \(f-1\)/)]);
        expect(about('s-bad-cron')).toEqual([expect.stringMatching(/"every day" is not a cron expression/)]);
        expect(about('s-outside')).toEqual([expect.stringMatching(/outside its workspace/)]);
        expect(about('s-nocmd')).toEqual([expect.stringMatching(/no command/)]);
        expect(about('s-noworkspace')).toEqual([expect.stringMatching(/no workspace/)]);
        expect(about('s-gone-ws')).toEqual([expect.stringMatching(/ws-not-in-genie2 is not in Genie 2/)]);
        expect(about('p-plain')).toEqual([]);
        expect(about('t-scout')).toEqual([]);
        expect(notes).toHaveLength(3 + 8);
    });

    it('the person enables what they want: Enable schedule arms an imported task', async () => {
        writeV1(v1File, rows);
        const book = await openBook();
        await book.enableSchedule('proc_v1_s-report');
        expect(scheduledOf(book).get('proc_v1_s-report')!.wanted).toBe(true);
    });

    it('once: what the person removed or changed stays as they left it, and a later v1 row is not picked up', async () => {
        writeV1(v1File, rows);
        const first = await openBook();
        await first.remove('proc_v1_s-root');
        await first.enableSchedule('proc_v1_s-report');
        rmSync(v1File);
        writeV1(v1File, [...rows, { id: 's-late', workspace_id: WS.id, label: 'late', cwd: WS.path, meta: { command: 'npm run late', schedule: '0 5 * * *' } }]);
        const second = await openBook();
        const ids = [...scheduledOf(second).keys()];
        expect(ids).not.toContain('proc_v1_s-root');
        expect(ids).not.toContain('proc_v1_s-late');
        expect(scheduledOf(second).get('proc_v1_s-report')!.wanted).toBe(true);
        expect(onDisk().v1ScheduleImport).toMatchObject({ sawV1: true, imported: 5 });
    });

    it('a boot that cannot see v1 is provisional: nothing imported, recorded as not seen; a later boot that can see it imports', async () => {
        const blind = await openBook(join(home, 'no-such.db'));
        expect(scheduledOf(blind).size).toBe(0);
        expect(onDisk().v1ScheduleImport).toMatchObject({ sawV1: false });
        writeV1(v1File, rows);
        const seeing = await openBook();
        expect(scheduledOf(seeing).size).toBe(5);
        expect(onDisk().v1ScheduleImport).toMatchObject({ sawV1: true, imported: 5 });
    });

    it('never overwrites: a process already kept under the same id is left exactly as it is, and counted', async () => {
        writeV1(v1File, rows);
        const mine = await ProcessBook.open(home, { supervisor, envFor: () => ({}), asleep: () => false });
        await mine.adoptScheduled([{ id: 'proc_v1_s-report', workspaceId: WS.id, name: 'mine', command: 'npm run mine', cwd: WS.path, wanted: true, schedule: { cron: '0 4 * * *', kind: 'command' } }]);
        const book = await openBook();
        expect(scheduledOf(book).get('proc_v1_s-report')).toMatchObject({ name: 'mine', schedule: { cron: '0 4 * * *' } });
        expect(onDisk().v1ScheduleImport).toMatchObject({ imported: 4, alreadyHere: 1 });
    });

    it("reads v1's database without changing a byte of it", async () => {
        writeV1(v1File, rows);
        const before = md5(v1File);
        await openBook();
        expect(md5(v1File)).toBe(before);
    });
});
