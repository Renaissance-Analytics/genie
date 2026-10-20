import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { leftoverProviders } from '../src/core/leftover-providers.js';
import type { ProcessInfo } from '../src/core/process-tree.js';
import { leftoversToEnd, type LedgerRecord } from '../src/core/spawn-ledger.js';
import { SpawnLedger } from '../src/main/spawn-ledger.js';
import { processTable } from './support/process-table.js';

/**
 * THE SPAWN LEDGER AND THE BOOT SWEEP (hosting plan 1.5; lifecycle review F6/F7).
 *
 * The boot sweep used to know one thing: `claude --print … --resume <a thread an agent still has>`. It never caught the
 * orphan of a FRESH restart (the agent no longer has that thread), a first-run session (no `--resume` yet), a wedged
 * one, or any Codex agent — those were never reaped by anything. Now Genie writes down every process it starts — pid,
 * start time and image name — and at boot, BEFORE anything is started, ends the tree of every record from a previous
 * boot whose pid AND start time AND name all still match. It never touches a process it did not record.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'genie2-ledger-')); dirs.push(d); return d; };

const GONE_GENIE = 960_000; // the previous Genie: crashed, not in the table
const NOW_GENIE = process.pid;

function agentRecordOf(processes: ProcessInfo[], bootId = 'boot-previous', ownerId = 'agent_01'): LedgerRecord {
    return { kind: 'agent', ownerId, run: 1, bootId, processes, at: 0 };
}

describe('what the boot sweep ends', () => {
    it('a FRESH-restart orphan (its thread discarded): the --resume sweep misses it; the ledger ends its whole tree', () => {
        const t = processTable(NOW_GENIE);
        const cmd = t.spawn(961_001, GONE_GENIE, 'cmd.exe');
        const claude = t.spawn(961_002, cmd.pid, 'claude.exe');
        const mcp = t.spawn(961_003, claude.pid, 'node.exe');
        const table = t.tree.snapshot()!;

        // TODAY: the agent's thread was cleared by the fresh restart, so nothing matches.
        const rows = table.map((p) => ({ pid: p.pid, ppid: p.ppid, cmd: p.pid === claude.pid ? 'claude --print --output-format stream-json --resume 11111111-2222-3333-4444-555555555555' : p.name }));
        expect(leftoverProviders(rows, [{ name: 'atlas', threadId: null }], NOW_GENIE)).toEqual([]);

        const found = leftoversToEnd([agentRecordOf([cmd, claude])], table, 'boot-now');
        expect(found.flatMap((f) => f.processes.map((p) => p.pid)).sort()).toEqual([cmd.pid, claude.pid, mcp.pid].sort());
    });

    it('a Codex orphan: no --resume rule ever matched codex; the ledger ends it', () => {
        const t = processTable(NOW_GENIE);
        const cmd = t.spawn(962_001, GONE_GENIE, 'cmd.exe');
        const node = t.spawn(962_002, cmd.pid, 'node.exe');
        const codex = t.spawn(962_003, node.pid, 'codex.exe');
        const table = t.tree.snapshot()!;
        const rows = table.map((p) => ({ pid: p.pid, ppid: p.ppid, cmd: p.pid === codex.pid ? 'codex app-server --listen stdio://' : p.name }));
        expect(leftoverProviders(rows, [{ name: 'nova', threadId: '11111111-2222-3333-4444-555555555555' }], NOW_GENIE)).toEqual([]);

        const found = leftoversToEnd([agentRecordOf([cmd])], table, 'boot-now');
        expect(found.flatMap((f) => f.processes.map((p) => p.pid)).sort()).toEqual([cmd.pid, node.pid, codex.pid].sort());
    });

    it('PID REUSE: the same pid with a different start time is a stranger, and is not ended', () => {
        const t = processTable(NOW_GENIE);
        const stranger = t.spawn(963_001, 4, 'claude.exe', 99_999);
        const recorded: ProcessInfo = { ...stranger, started: 1_234 };
        expect(leftoversToEnd([agentRecordOf([recorded])], t.tree.snapshot()!, 'boot-now')).toEqual([]);
    });

    it('the same pid and start time under a different image name is not ended either', () => {
        const t = processTable(NOW_GENIE);
        const p = t.spawn(963_101, 4, 'notepad.exe');
        expect(leftoversToEnd([agentRecordOf([{ ...p, name: 'claude.exe' }])], t.tree.snapshot()!, 'boot-now')).toEqual([]);
    });

    it('POSITIVE CONTROL for the two above: the exact process IS ended', () => {
        const t = processTable(NOW_GENIE);
        const p = t.spawn(963_201, 4, 'claude.exe');
        expect(leftoversToEnd([agentRecordOf([p])], t.tree.snapshot()!, 'boot-now').flatMap((f) => f.processes.map((x) => x.pid))).toEqual([p.pid]);
    });

    it('this boot’s own records are never swept', () => {
        const t = processTable(NOW_GENIE);
        const p = t.spawn(963_301, NOW_GENIE, 'cmd.exe');
        expect(leftoversToEnd([agentRecordOf([p], 'boot-now')], t.tree.snapshot()!, 'boot-now')).toEqual([]);
    });
});

describe('SpawnLedger — the file, and the sweep that reads it', () => {
    it('records a spawn, forgets it at a verified end, and keeps what a stop left behind', async () => {
        const dir = tempDir();
        const file = join(dir, 'children.json');
        const ledger = SpawnLedger.open(file, 'boot-a');
        const t = processTable(NOW_GENIE);
        const a = t.spawn(964_001, NOW_GENIE, 'cmd.exe');
        const b = t.spawn(964_002, NOW_GENIE, 'cmd.exe');

        ledger.record({ kind: 'agent', ownerId: 'agent_a', run: 1, processes: [a] });
        ledger.record({ kind: 'agent', ownerId: 'agent_b', run: 2, processes: [b] });
        ledger.forget('agent', 'agent_a', 1);
        await ledger.flushed();

        const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { records: LedgerRecord[] };
        expect(onDisk.records.map((r) => r.ownerId)).toEqual(['agent_b']);
        expect(onDisk.records[0]).toMatchObject({ kind: 'agent', run: 2, bootId: 'boot-a', processes: [b] });
    });

    it('at the next boot: ends every matching tree from the previous boot, logs each, and drops the records', async () => {
        const dir = tempDir();
        const file = join(dir, 'children.json');
        const t = processTable(NOW_GENIE);
        const left = t.spawn(965_001, GONE_GENIE, 'cmd.exe');
        const child = t.spawn(965_002, left.pid, 'claude.exe');
        const dead: ProcessInfo = { pid: 965_099, ppid: GONE_GENIE, started: 5, name: 'cmd.exe' };
        writeFileSync(file, JSON.stringify({ records: [agentRecordOf([left]), agentRecordOf([dead], 'boot-previous', 'agent_02')] }));
        const lines: string[] = [];

        const ledger = SpawnLedger.open(file, 'boot-b');
        const ended = ledger.sweep(t.tree, (line) => lines.push(line));
        await ledger.flushed();

        expect(ended.map((p) => p.pid).sort()).toEqual([left.pid, child.pid].sort());
        expect(t.alive(left.pid) || t.alive(child.pid)).toBe(false);
        expect(lines.join('\n')).toMatch(/sweep .*agent_01.*965001/);
        expect((JSON.parse(readFileSync(file, 'utf8')) as { records: unknown[] }).records).toEqual([]);
    });

    it('a sweep that cannot read the machine ends nothing and KEEPS the records for the next boot', async () => {
        const dir = tempDir();
        const file = join(dir, 'children.json');
        const t = processTable(NOW_GENIE);
        const left = t.spawn(966_001, GONE_GENIE, 'cmd.exe');
        writeFileSync(file, JSON.stringify({ records: [agentRecordOf([left])] }));
        t.breakSnapshots();
        const lines: string[] = [];

        const ledger = SpawnLedger.open(file, 'boot-c');
        expect(ledger.sweep(t.tree, (line) => lines.push(line))).toEqual([]);
        await ledger.flushed();

        expect(t.alive(left.pid)).toBe(true);
        expect(lines.join('\n')).toMatch(/could not read/);
        expect((JSON.parse(readFileSync(file, 'utf8')) as { records: unknown[] }).records).toHaveLength(1);
    });

    it('an unreadable or missing ledger is an empty one — a boot never fails on it', () => {
        const dir = tempDir();
        expect(SpawnLedger.open(join(dir, 'none.json'), 'boot-d').size).toBe(0);
        const bad = join(dir, 'bad.json');
        writeFileSync(bad, '{not json');
        expect(SpawnLedger.open(bad, 'boot-d').size).toBe(0);
        expect(existsSync(bad)).toBe(true);
    });
});
