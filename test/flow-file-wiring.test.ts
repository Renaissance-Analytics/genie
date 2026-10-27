import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileAddedProps } from '../src/core/file-trigger.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { startFileSource, type RawWatchEvent } from '../src/main/flow-file-source.js';
import { fileMover } from '../src/main/flow-file-move.js';
import { FileTriggerWatches, nodeWatch } from '../src/main/flow-file-watch.js';
import { createFlowRunner } from '../src/main/flow-runner.js';
import { FlowScheduler } from '../src/main/flow-scheduler.js';
import { FlowStore } from '../src/main/flow-store.js';

/**
 * THE FILE TRIGGER, WIRED (genie#1204 item 5): an ARMED flow with a `genie/file_added` trigger runs when a matching
 * file lands — recorded as a `file` run naming the file — and nothing else does: a disarmed flow, a file that does not
 * match, a workspace no armed file flow names (it is not even watched). The move is real (`fileMover`): into the folder,
 * never overwriting, never outside the workspace, and its own arrival is not a new addition. The last test is the
 * owner's case end to end on a real folder: a 6 MB file is moved to .untracked; a small one stays.
 */

const user = { kind: 'user' } as const;
let dir: string;
let ws: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-file-wiring-'));
    ws = join(dir, 'ws');
    await mkdir(ws, { recursive: true });
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const doc = (trigger: Record<string, unknown>, step: Record<string, unknown> = { workspace: 'tynn', from: '{{in.path}}', to: '.untracked' }) => ({
    $schema: FLOW_SCHEMA_URL,
    version: 1,
    graph: {
        nodes: [
            { id: 't', kind: 'genie/file_added', position: { x: 0, y: 0 }, config: { workspace: 'tynn', ...trigger } },
            { id: 'm', kind: 'genie/file_move', position: { x: 240, y: 0 }, config: step },
        ],
        edges: [{ id: 't-m', source: 't', target: 'm' }],
    },
});
const fileIn = (relPath: string, sizeBytes: number): FileAddedProps => ({ workspaceId: 'tynn', path: join(ws, relPath), relPath, name: relPath.split('/').pop()!, extension: relPath.split('.').pop()!, sizeBytes });

describe('the scheduler starts the flows a file matches', () => {
    it('an armed matching flow runs, recorded as a file run naming the file; a disarmed one and a non-matching one do not', async () => {
        const store = await FlowStore.open(dir);
        const big = await store.create({ workspaceId: 'tynn', name: 'big files out', document: doc({ minSizeBytes: 5_000_000 }), by: user });
        const off = await store.create({ workspaceId: 'tynn', name: 'off', document: doc({}), by: user });
        const pngs = await store.create({ workspaceId: 'tynn', name: 'pngs', document: doc({ extensions: 'png' }), by: user });
        await store.arm(big.id, user);
        await store.arm(pngs.id, user);
        const ran: string[] = [];
        const scheduler = new FlowScheduler({ store, now: Date.now, schedule: () => () => {}, run: async (flow, trigger) => { ran.push(`${flow.name}:${trigger && 'file' in trigger ? trigger.file.relPath : '-'}`); } });

        scheduler.fileAdded(fileIn('uploads/big.bin', 6_000_000));
        await scheduler.settled();

        expect(ran).toEqual(['big files out:uploads/big.bin']);
        expect(store.get(big.id)!.runs.at(-1)).toMatchObject({ trigger: 'file', file: 'uploads/big.bin', outcome: 'ran' });
        expect(store.get(off.id)!.runs).toEqual([]);
        expect(store.get(pngs.id)!.runs).toEqual([]);
    });

    it('a flow names its file triggers (CONTROL: a scheduled flow has none)', async () => {
        const store = await FlowStore.open(dir);
        const f = await store.create({ workspaceId: 'tynn', name: 'f', document: doc({ folder: 'uploads' }), by: user });
        expect(store.fileTriggers(f.id)).toEqual([{ nodeId: 't', config: { workspace: 'tynn', folder: 'uploads' } }]);
        const s = await store.create({ workspaceId: 'tynn', name: 's', document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } }, { id: 'n', kind: 'genie/knowledge_add', position: { x: 240, y: 0 }, config: { workspace: 'tynn', title: 'x' } }], edges: [{ id: 'e', source: 't', target: 'n' }] } }, by: user });
        expect(store.fileTriggers(s.id)).toEqual([]);
    });
});

describe('only the workspaces an armed file flow names are watched', () => {
    it('arming starts one watcher per workspace; disarming the last flow there closes it', async () => {
        const store = await FlowStore.open(dir);
        const a = await store.create({ workspaceId: 'tynn', name: 'a', document: doc({}), by: user });
        const b = await store.create({ workspaceId: 'tynn', name: 'b', document: doc({ extensions: 'png' }), by: user });
        const opened: string[] = [];
        const closed: string[] = [];
        const watches = new FileTriggerWatches({
            store,
            workspacePath: (id) => (id === 'tynn' ? ws : null),
            watch: (path) => { opened.push(path); return () => closed.push(path); },
            onEvent: () => {},
        });
        expect(opened).toEqual([]);
        await store.arm(a.id, user);
        await store.arm(b.id, user);
        expect(opened).toEqual([ws]);
        await store.disarm(a.id, user);
        expect(closed).toEqual([]);
        await store.disarm(b.id, user);
        expect(closed).toEqual([ws]);
        watches.stop();
    });
});

describe('the move (genie/file_move), on a real folder', () => {
    it('moves into the folder it creates, never overwrites, and tells the source the arrival is its own', async () => {
        await mkdir(join(ws, 'uploads'));
        await mkdir(join(ws, '.untracked'));
        await writeFile(join(ws, '.untracked', 'big.bin'), 'already here');
        await writeFile(join(ws, 'uploads', 'big.bin'), 'new');
        const expected: string[] = [];
        const move = fileMover({ workspacePath: () => ws, expectArrival: (p) => expected.push(p) });

        const r = await move('tynn', join(ws, 'uploads', 'big.bin'), '.untracked');

        expect(r).toEqual({ from: join(ws, 'uploads', 'big.bin'), to: join(ws, '.untracked', 'big (2).bin') });
        expect(existsSync(join(ws, 'uploads', 'big.bin'))).toBe(false);
        expect((await readdir(join(ws, '.untracked'))).sort()).toEqual(['big (2).bin', 'big.bin']);
        expect(expected).toEqual([join(ws, '.untracked', 'big (2).bin')]);
    });

    it('a file named RELATIVE to the workspace (a manual flow’s "File" setting) is moved from the workspace, not from Genie’s own folder', async () => {
        // Found by the Flows acceptance suite: the existence check and the rename used the setting as written, so a relative
        // name was looked for relative to Genie's process directory and the step failed "no longer there".
        await mkdir(join(ws, 'uploads'));
        await writeFile(join(ws, 'uploads', 'report.pdf'), 'x');
        const move = fileMover({ workspacePath: () => ws, expectArrival: () => {} });
        expect(await move('tynn', 'uploads/report.pdf', 'archive')).toEqual({ from: join(ws, 'uploads', 'report.pdf'), to: join(ws, 'archive', 'report.pdf') });
        expect(existsSync(join(ws, 'archive', 'report.pdf'))).toBe(true);
        expect(existsSync(join(ws, 'uploads', 'report.pdf'))).toBe(false);
    });

    it('refuses outside the workspace and an unknown workspace, moving nothing', async () => {
        await writeFile(join(dir, 'outside.bin'), 'x');
        const move = fileMover({ workspacePath: (id) => (id === 'tynn' ? ws : null), expectArrival: () => {} });
        await expect(move('tynn', join(dir, 'outside.bin'), '.untracked')).rejects.toThrow(/outside the workspace/);
        await expect(move('nope', join(ws, 'a.bin'), '.untracked')).rejects.toThrow(/not registered/);
        expect(existsSync(join(dir, 'outside.bin'))).toBe(true);
    });
});

describe('the owner\'s case, end to end on a real folder', () => {
    it('a file of 6 MB landing anywhere is moved to .untracked; a small file stays where it landed', async () => {
        const store = await FlowStore.open(dir);
        const flow = await store.create({ workspaceId: 'tynn', name: 'big files out of git', document: doc({ minSizeBytes: 5_000_000 }), by: user });
        let source: ReturnType<typeof startFileSource> | null = null;
        const run = createFlowRunner({
            asleep: () => false,
            ports: () => ({
                promptAgent: async () => '',
                runCommand: async () => ({ exitCode: 0, output: '' }),
                addKnowledge: async () => ({ id: 'kn' }),
                moveFile: fileMover({ workspacePath: () => ws, expectArrival: (p) => source?.expectArrival(p) }),
            }),
        });
        const scheduler = new FlowScheduler({ store, now: Date.now, schedule: () => () => {}, run });
        let deliver: ((e: RawWatchEvent) => void) | null = null;
        source = startFileSource({ subscribe: (l) => { deliver = l; return () => { deliver = null; }; }, statFile: nodeWatch.statFile, emit: (e) => scheduler.fileAdded(e), settleMs: 50 });
        const watches = new FileTriggerWatches({ store, workspacePath: () => ws, watch: nodeWatch.watch, onEvent: (e) => deliver?.(e) });
        await store.arm(flow.id, user);

        await mkdir(join(ws, 'docs', 'img'), { recursive: true });
        await writeFile(join(ws, 'docs', 'img', 'huge.bin'), Buffer.alloc(6_000_000));
        await writeFile(join(ws, 'docs', 'small.txt'), 'hello');

        await vi.waitFor(() => expect(existsSync(join(ws, '.untracked', 'huge.bin'))).toBe(true), { timeout: 10_000, interval: 50 });
        await scheduler.settled();
        expect(existsSync(join(ws, 'docs', 'img', 'huge.bin'))).toBe(false);
        expect(existsSync(join(ws, 'docs', 'small.txt'))).toBe(true);
        // The move's own arrival in .untracked did not start a second run.
        await new Promise((r) => setTimeout(r, 600));
        await scheduler.settled();
        expect(store.get(flow.id)!.runs.map((r) => [r.trigger, r.file, r.outcome])).toEqual([['file', 'docs/img/huge.bin', 'ran']]);
        watches.stop();
        source.stop();
    });
});
