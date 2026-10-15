import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { AgentRecord } from '../src/core/identity.js';
import { composeServices } from '../src/main/compose.js';
import { FlowStore } from '../src/main/flow-store.js';
import { runtimeDir } from '../src/main/paths.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { runV1ScheduleImport } from '../src/main/v1-schedules.js';

/**
 * GENIE 1's SCHEDULED TASKS COME THROUGH THE UPGRADE (hosting ship line P4). Genie 1 kept a scheduled task as a
 * background process with a schedule (`terminal_specs` type 'process', `meta_json.schedule` + `schedule_kind`);
 * the process import (core/v1-processes.ts) leaves them to Flows, and until now Flows imported nothing.
 *
 * Driven through `runV1ScheduleImport` — the boot's own call — and once through `composeServices`, with a v1
 * database built here from v1's REAL `CREATE TABLE` statements (copied from a v1 `genie.db`); every value is
 * invented.
 *
 * The contract:
 * - Every task comes over as a flow, DISARMED: the person arms what they want. One that was firing in Genie 1
 *   is NOTED so, so the person knows what stopped.
 * - `command` → schedule → genie/terminal_run, the folder relative to the workspace; `agent-nudge` → schedule →
 *   genie/agent_prompt to the agent's FULL Genie 2 address; the schedule has no timezone (local, as Genie 1's).
 * - ONCE: recorded in flows.json itself; a later boot imports nothing more, so what the person removed or changed
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

function writeV1(file: string, specs: readonly Row[]): void {
    const db = new DatabaseSync(file);
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
    db.close();
}

/** Genie 2's roster after its own v1 agent import: atlas and scout came over; ghost did not. */
const roster = [
    { id: 'agent_atlas', workspaceId: WS.id, provider: 'claude', name: 'atlas' },
    { id: 'agent_scout', workspaceId: WS.id, provider: 'codex', name: 'scout' },
];

let home: string;
let v1File: string;
const flowsFile = () => join(runtimeDir(home), 'flows.json');
const onDisk = (): { flows?: Array<Record<string, unknown>>; v1Import?: Record<string, unknown> } => (existsSync(flowsFile()) ? JSON.parse(readFileSync(flowsFile(), 'utf8')) : {});
const importInto = async (store: FlowStore, database: string = v1File) => runV1ScheduleImport(store, { database, workspaces: [WS], roster });
const md5 = (f: string) => createHash('md5').update(readFileSync(f)).digest('hex');

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'genie2-v1-schedules-'));
    v1File = join(home, 'v1-genie.db');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("Genie 1's scheduled tasks, imported once as DISARMED flows", () => {
    it('maps each task faithfully: a command into genie/terminal_run in its folder, a nudge into genie/agent_prompt to the full address — every one disarmed, local time', async () => {
        writeV1(v1File, rows);
        const store = await FlowStore.open(home);
        await importInto(store);
        const byId = new Map(store.list().map((f) => [f.id, f]));
        expect([...byId.keys()].sort()).toEqual(['flow_v1_s-nudge', 'flow_v1_s-nudge-term', 'flow_v1_s-pending', 'flow_v1_s-report', 'flow_v1_s-root']);
        for (const f of byId.values()) {
            expect(f.armed).toBe(false);
            expect(f.workspaceId).toBe(WS.id);
            expect(f.importedFrom).toEqual({ v1SpecId: f.id.replace('flow_v1_', '') });
        }
        expect(byId.get('flow_v1_s-report')).toMatchObject({
            name: 'nightly report',
            // The canonical shape: the steps under graph, where the engine reads (and validated) them.
            document: {
                $schema: FLOW_SCHEMA_URL,
                version: 1,
                graph: {
                    nodes: [
                        { id: 't', kind: 'schedule_trigger', config: { cron: '0 3 * * *' } },
                        { id: 's', kind: 'genie/terminal_run', config: { workspace: WS.id, command: 'npm run report', cwd: 'repos/app' } },
                    ],
                    edges: [{ id: 'e1', source: 't', target: 's' }],
                },
            },
        });
        // No timezone: evaluated in this machine's local time, as Genie 1 did.
        expect(store.schedules('flow_v1_s-report')).toEqual([{ nodeId: 't', cron: '0 3 * * *', timezone: undefined }]);
        // At the workspace root there is no folder.
        expect(((byId.get('flow_v1_s-root')!.document.graph as { nodes: unknown }).nodes as Array<{ config: Record<string, unknown> }>)[1]!.config).toEqual({ workspace: WS.id, command: 'npm run prune' });
        expect(((byId.get('flow_v1_s-nudge')!.document.graph as { nodes: unknown }).nodes as Array<{ kind: string; config: Record<string, unknown> }>)[1]).toMatchObject({ kind: 'genie/agent_prompt', config: { agent: 'ws-example:claude:atlas', prompt: 'post the standup' } });
        // The terminal's agent, found through the terminal the nudge named.
        expect(((byId.get('flow_v1_s-nudge-term')!.document.graph as { nodes: unknown }).nodes as Array<{ config: Record<string, unknown> }>)[1]!.config).toEqual({ agent: 'ws-example:codex:scout', prompt: 'sweep the issues' });
        // No refusals: every imported schedule is one Genie can evaluate.
        expect(store.list().flatMap((f) => f.refusals)).toEqual([]);
    });

    it('records what it did in flows.json and NOTES, with why, what was firing (now disarmed) and everything not imported', async () => {
        writeV1(v1File, rows);
        await importInto(await FlowStore.open(home));
        const record = onDisk().v1Import!;
        expect(record).toMatchObject({ sawV1: true, imported: 5, alreadyHere: 0 });
        const notes = record.notes as string[];
        const about = (id: string) => notes.filter((n) => n.includes(`task ${id} `));
        // Firing in Genie 1 (enabled, approved) → said so; disabled or awaiting approval → nothing to say.
        for (const id of ['s-report', 's-nudge', 's-nudge-term']) expect(about(id)).toEqual([expect.stringMatching(/was firing on its schedule in Genie 1; it comes over DISARMED/)]);
        expect(about('s-root')).toEqual([]);
        expect(about('s-pending')).toEqual([]);
        expect(about('s-nudge-gone')).toEqual([expect.stringMatching(/Genie 1 no longer knows which agent/)]);
        expect(about('s-nudge-ghost')).toEqual([expect.stringMatching(/its agent ghost .* is not in Genie 2; not imported/)]);
        expect(about('s-flow')).toEqual([expect.stringMatching(/Genie 1 workflow \(f-1\).*not imported/)]);
        expect(about('s-bad-cron')).toEqual([expect.stringMatching(/"every day" is not a cron expression/)]);
        expect(about('s-outside')).toEqual([expect.stringMatching(/outside its workspace/)]);
        expect(about('s-nocmd')).toEqual([expect.stringMatching(/no command/)]);
        expect(about('s-noworkspace')).toEqual([expect.stringMatching(/no workspace/)]);
        expect(about('s-gone-ws')).toEqual([expect.stringMatching(/ws-not-in-genie2 is not in Genie 2/)]);
        // A plain background process and a terminal are not scheduled tasks: not imported, not noted.
        expect(about('p-plain')).toEqual([]);
        expect(about('t-scout')).toEqual([]);
        expect(notes).toHaveLength(3 + 8);
    });

    it('the person arms what they want: an imported flow arms for the user and then has a due', async () => {
        writeV1(v1File, rows);
        const store = await FlowStore.open(home);
        await importInto(store);
        expect(await store.arm('flow_v1_s-report', { kind: 'user' })).toMatchObject({ ok: true });
        expect(store.get('flow_v1_s-report')!.armed).toBe(true);
    });

    it('once: what the person removed or changed stays as they left it, and a later v1 row is not picked up', async () => {
        writeV1(v1File, rows);
        const first = await FlowStore.open(home);
        await importInto(first);
        await first.remove('flow_v1_s-root');
        await first.update('flow_v1_s-report', { name: 'nightly report (mine)' }, { kind: 'user' });
        rmSync(v1File);
        writeV1(v1File, [...rows, { id: 's-late', workspace_id: WS.id, label: 'late', cwd: WS.path, meta: { command: 'npm run late', schedule: '0 5 * * *' } }]);

        const second = await FlowStore.open(home);
        await importInto(second);
        const ids = second.list().map((f) => f.id);
        expect(ids).not.toContain('flow_v1_s-root');
        expect(ids).not.toContain('flow_v1_s-late');
        expect(second.get('flow_v1_s-report')!.name).toBe('nightly report (mine)');
        expect(onDisk().v1Import).toMatchObject({ sawV1: true, imported: 5 });
    });

    it('a boot that cannot see v1 is provisional: nothing imported, recorded as not seen; a later boot that can see it imports', async () => {
        const blind = await FlowStore.open(home);
        await importInto(blind, join(home, 'no-such.db'));
        expect(blind.list()).toEqual([]);
        expect(onDisk().v1Import).toMatchObject({ sawV1: false });

        writeV1(v1File, rows);
        const seeing = await FlowStore.open(home);
        await importInto(seeing);
        expect(seeing.list()).toHaveLength(5);
        expect(onDisk().v1Import).toMatchObject({ sawV1: true, imported: 5 });
    });

    it('never overwrites: a flow already here under the same id is left exactly as it is, and counted', async () => {
        writeV1(v1File, rows);
        const store = await FlowStore.open(home);
        // The person's own flow, as if written by an earlier build under the v1 id.
        await store.importFromV1({ flows: [{ id: 'flow_v1_s-report', v1SpecId: 's-report', workspaceId: WS.id, name: 'mine', document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [], edges: [] } } }], notes: [] });
        const raw = JSON.parse(readFileSync(flowsFile(), 'utf8')) as { flows: unknown[] };
        // Forget the record (a file from before it existed) but keep the flow.
        const { writeFileSync } = await import('node:fs');
        writeFileSync(flowsFile(), JSON.stringify({ flows: raw.flows }));
        const reopened = await FlowStore.open(home);
        await importInto(reopened);
        expect(reopened.get('flow_v1_s-report')!.name).toBe('mine');
        expect(onDisk().v1Import).toMatchObject({ imported: 4, alreadyHere: 1 });
    });

    it('a task whose document the engine refuses is NOTED with the engine’s words and left behind; the others still come over (counted)', async () => {
        const store = await FlowStore.open(home);
        const graph = (step: Record<string, unknown>) => ({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } }, { id: 's', position: { x: 240, y: 0 }, ...step }], edges: [{ id: 'e1', source: 't', target: 's' }] } });
        const done = await store.importFromV1({
            flows: [
                { id: 'flow_v1_s-hollow', v1SpecId: 's-hollow', workspaceId: WS.id, name: 'hollow', document: graph({ kind: 'genie/terminal_run', config: { workspace: WS.id } }) },
                { id: 'flow_v1_s-whole', v1SpecId: 's-whole', workspaceId: WS.id, name: 'whole', document: graph({ kind: 'genie/terminal_run', config: { workspace: WS.id, command: 'npm run report' } }) },
            ],
            notes: [],
        });
        expect(store.list().map((f) => f.id)).toEqual(['flow_v1_s-whole']);
        expect(done.record).toMatchObject({ sawV1: true, imported: 1, alreadyHere: 0 });
        expect(done.record.notes).toEqual(['"hollow" (v1 task s-hollow): the flow document was refused by the engine: node s: command: Command is required; not imported']);
    });

    it("reads v1's database without changing a byte of it", async () => {
        writeV1(v1File, rows);
        const before = md5(v1File);
        await importInto(await FlowStore.open(home));
        expect(md5(v1File)).toBe(before);
    });
});

describe('boot — the composition root imports them before the scheduler plans, and arms none', () => {
    const pty: PtyPort = {
        open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
        write: () => true,
        resize: () => true,
        kill: () => true,
        scrollback: () => '',
        onData: () => () => {},
        onExit: () => () => {},
    };

    it('composeServices with Genie 1’s database: the flows are there, disarmed, and nothing is due', async () => {
        writeV1(v1File, rows);
        const records = roster.map((r) => ({ ...r, instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null })) as unknown as AgentRecord[];
        const services = await composeServices({ userData: home, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => records, workspaces: () => [WS], v1Schedules: { database: v1File } });
        try {
            expect(services.flows.list().map((f) => [f.id, f.armed]).sort()).toEqual([
                ['flow_v1_s-nudge', false],
                ['flow_v1_s-nudge-term', false],
                ['flow_v1_s-pending', false],
                ['flow_v1_s-report', false],
                ['flow_v1_s-root', false],
            ]);
            expect(services.flowScheduler.nextDue()).toBeNull();
        } finally {
            await services.shutdown();
        }
    });
});
