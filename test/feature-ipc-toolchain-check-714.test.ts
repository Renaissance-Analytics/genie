import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolStatus } from '../src/core/toolchain.js';
import { composeServices } from './helpers/compose-alone.js';
import { type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import type { FeatureAction } from '../src/renderer/features.js';

/**
 * Tynn #714 in main: `toolchain.checkUpdates` checks the rows ONE AT A TIME (never two probes at once), pushes each row's
 * state as it moves (waiting, then checking, then its answer), installs and updates NOTHING, and ends by stamping the
 * last-checked time. `toolchain.stopCheck` ends it after the tool in flight; rows not reached keep their last-known state.
 */
const pty: PtyPort = {
    open: (o) => ({ id: 'term_1', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

const tool = (name: string, installed: string | null, tone: ToolStatus['tone'], latest: string | null = null): ToolStatus => ({ tool: name, installed, latest, tone, source: null });
const known = (): ToolStatus[] => [tool('git', '2.56.0', 'unknown'), tool('composer', '2.10.2', 'unknown'), tool('npm', '11.1.0', 'unknown'), tool('rustc', null, 'not-installed')];

let dir: string;
let services: ComposedServices;
let order: string[];
let inFlight: number;
let maxInFlight: number;
let pushes: Array<Record<string, string>>;
let updates: string[];
let installs: string[];
let answers: Record<string, ToolStatus | Error>;
let gate: Record<string, Promise<void>>;

const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => known(),
        probeTool: async (name: string) => {
            order.push(name);
            inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                await gate[name];
                const a = answers[name];
                if (a instanceof Error) throw a;
                return a ?? tool(name, '1.0.0', 'up-to-date', '1.0.0');
            } finally { inFlight -= 1; }
        },
        checking: (run: { rows: Record<string, { state: string }> } | null) => { pushes.push(Object.fromEntries(Object.entries(run?.rows ?? {}).map(([k, v]) => [k, v.state]))); },
        update: async (name: string) => { updates.push(name); return { kind: 'repaired', from: '1', to: '2' }; },
        install: async (name: string) => { installs.push(name); return { kind: 'installed', version: '1' }; },
        now: () => 9_000,
        activity: async () => ({ sessions: [], processes: [], engines: [] }),
    },
} as unknown as FeaturePorts);

const scanned = (): FeatureState => ({ toolStatuses: known(), knowledgeQuery: '', toolchainCheckedAt: 1 });
const act = (action: FeatureAction, state: FeatureState = scanned()) => handleFeatureAction(services, action, state, ports());

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-714-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    order = []; inFlight = 0; maxInFlight = 0; pushes = []; updates = []; installs = []; answers = {}; gate = {};
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('#714 — the check, one tool at a time', () => {
    it('checks each installed tool in the list order, never two at once, and skips what is not installed', async () => {
        await act({ kind: 'toolchain.checkUpdates' } as FeatureAction);
        expect(order).toEqual(['git', 'composer', 'npm']);
        expect(maxInFlight).toBe(1);
    });

    it('pushes the states as they move: all waiting, then each row checking then its answer', async () => {
        answers['composer'] = tool('composer', '2.10.2', 'update-available', '2.11.0');
        await act({ kind: 'toolchain.checkUpdates' } as FeatureAction);
        expect(pushes[0]).toEqual({ git: 'waiting', composer: 'waiting', npm: 'waiting' });
        expect(pushes).toContainEqual({ git: 'checking', composer: 'waiting', npm: 'waiting' });
        expect(pushes).toContainEqual({ git: 'up-to-date', composer: 'checking', npm: 'waiting' });
        expect(pushes).toContainEqual({ git: 'up-to-date', composer: 'update-available', npm: 'checking' });
    });

    it('the answer carries the final states, the measured rows, and the last-checked time; the run is over', async () => {
        answers['composer'] = tool('composer', '2.10.2', 'update-available', '2.11.0');
        const snap = await act({ kind: 'toolchain.checkUpdates' } as FeatureAction);
        const tc = snap.toolchain as unknown as { checkedAt: number; tools: ToolStatus[]; checkRun: { running: boolean; rows: Record<string, { state: string }> } };
        expect(tc.checkRun.running).toBe(false);
        expect(Object.fromEntries(Object.entries(tc.checkRun.rows).map(([k, v]) => [k, v.state]))).toEqual({ git: 'up-to-date', composer: 'update-available', npm: 'up-to-date' });
        expect(tc.checkedAt).toBe(9_000);
        expect(tc.tools.find((x) => x.tool === 'composer')).toMatchObject({ tone: 'update-available', latest: '2.11.0' });
        expect(tc.tools.find((x) => x.tool === 'rustc')).toMatchObject({ tone: 'not-installed' });
    });

    it('it installs and updates NOTHING', async () => {
        answers['composer'] = tool('composer', '2.10.2', 'update-available', '2.11.0');
        await act({ kind: 'toolchain.checkUpdates' } as FeatureAction);
        expect(updates).toEqual([]);
        expect(installs).toEqual([]);
    });

    it('a tool that fails to answer is FAILED with the reason, and the rest are still checked', async () => {
        answers['git'] = new Error('git did not answer within 20 s');
        const snap = await act({ kind: 'toolchain.checkUpdates' } as FeatureAction);
        const rows = (snap.toolchain as unknown as { checkRun: { rows: Record<string, { state: string; reason?: string }> } }).checkRun.rows;
        expect(rows['git']).toEqual({ state: 'failed', reason: 'git did not answer within 20 s' });
        expect(rows['composer']!.state).toBe('up-to-date');
        expect(order).toEqual(['git', 'composer', 'npm']);
    });

    it('a tool whose newest version no source could name is FAILED with that said, never "up to date"', async () => {
        answers['npm'] = tool('npm', '11.1.0', 'unknown');
        const snap = await act({ kind: 'toolchain.checkUpdates' } as FeatureAction);
        const row = (snap.toolchain as unknown as { checkRun: { rows: Record<string, { state: string; reason?: string }> } }).checkRun.rows['npm']!;
        expect(row.state).toBe('failed');
        expect(row.reason).toMatch(/newest version/);
    });
});

describe('#714 — Stop', () => {
    it('stops after the tool in flight: the rest are not probed, the run is over, the last-checked time is NOT stamped', async () => {
        let release!: () => void;
        gate['composer'] = new Promise<void>((resolve) => { release = resolve; });
        const run = act({ kind: 'toolchain.checkUpdates' } as FeatureAction);
        await new Promise((r) => setTimeout(r, 20));
        expect(order).toEqual(['git', 'composer']);
        await act({ kind: 'toolchain.stopCheck' } as FeatureAction);
        release();
        const snap = await run;
        const tc = snap.toolchain as unknown as { checkedAt: number; checkRun: { running: boolean; rows: Record<string, { state: string }> } };
        expect(order).toEqual(['git', 'composer']);
        expect(tc.checkRun.running).toBe(false);
        expect(tc.checkRun.rows['npm']).toBeUndefined();
        expect(tc.checkRun.rows['git']!.state).toBe('up-to-date');
        expect(tc.checkedAt).toBe(1);
    });
});
