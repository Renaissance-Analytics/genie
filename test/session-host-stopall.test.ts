import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { makeProcessTree, type ProcessInfo, type ProcessTree, type ProcessTreeIo } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * STOPPING EVERY AGENT, AND KNOWING WHEN IT IS DONE (genie#1201). Restart-to-install says "N of M agents still stopping"
 * and waits for them before the installer runs; a quit waits for them before Genie exits. With Genie's asynchronous
 * tree a stop's reap finishes after `stopAll` returns, so `stopAll` answers with a promise and reports each that ends,
 * and `drained` (what a quit waits on) waits for the stops still verifying too — not only for the providers' exits.
 */

let dir: string;
const records: AgentRecord[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-stopall-')); records.length = 0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const SELF = process.pid;

/** A process table whose async readings wait until released. */
function gatedTree() {
    let clock = 1_000;
    const rows = new Map<number, ProcessInfo>([[SELF, { pid: SELF, ppid: 1, started: 0, name: 'Genie.exe' }]]);
    const waiting: Array<() => void> = [];
    let open = false;
    const io: ProcessTreeIo = {
        snapshot: () => [...rows.values()],
        killOne: (pid) => { rows.delete(pid); },
        snapshotAsync: () => new Promise((resolve) => { const go = () => resolve([...rows.values()]); if (open) setTimeout(go, 0); else waiting.push(go); }),
        killOneAsync: async (pid) => { rows.delete(pid); },
    };
    return {
        tree: makeProcessTree(io),
        spawn: (pid: number, ppid: number, name: string) => { rows.set(pid, { pid, ppid, started: (clock += 10), name }); },
        drop: (pid: number) => { rows.delete(pid); },
        open: () => { open = true; for (const go of waiting.splice(0)) go(); },
    };
}

function hostOver(processTree: ProcessTree, spawnFor: (n: number) => { start: () => void; kill: () => void }): SessionHost {
    let n = 0;
    const driverFor: DriverFor = () => {
        const factory: SessionDriverFactory = () => { const d = spawnFor(n++); return { start: d.start, prompt: () => {}, kill: d.kill, cliSessionId: null }; };
        return factory;
    };
    return new SessionHost({ userData: dir, driverFor, processTree });
}

function startAgents(host: SessionHost, count: number): void {
    for (let i = 0; i < count; i += 1) {
        const r = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: `a${i}` });
        records.push(r);
        host.start(r, dir);
    }
}

describe('stopAll', () => {
    it('answers with a promise that settles once every stop is verified, counting down as each ends', async () => {
        const t = gatedTree();
        const host = hostOver(t.tree, (i) => ({ start: () => { t.spawn(940_000 + i * 10, SELF, 'cmd.exe'); }, kill: () => { t.drop(940_000 + i * 10); } }));
        startAgents(host, 3);
        const left: number[] = [];
        let done = false;
        const all = host.stopAll((n) => { left.push(n); });
        expect(all).toBeInstanceOf(Promise);
        void all.then(() => { done = true; });
        await new Promise((r) => setTimeout(r, 10));
        expect(done).toBe(false); // the readings have not come back: the stops are not verified yet
        t.open();
        await all;
        expect(left.at(-1)).toBe(0);
        expect(left).toEqual([...left].sort((a, b) => b - a));
        expect(host.count).toBe(0);
    });

    it('drained (what a quit waits on) waits for stops still verifying, not only for the providers’ exits', async () => {
        const t = gatedTree();
        const host = hostOver(t.tree, (i) => ({ start: () => { t.spawn(950_000 + i * 10, SELF, 'cmd.exe'); }, kill: () => { t.drop(950_000 + i * 10); } }));
        startAgents(host, 2);
        void host.stopAll();
        let drained = false;
        const done = host.drained(1).then(() => { drained = true; });
        await new Promise((r) => setTimeout(r, 20));
        expect(drained).toBe(false);
        t.open();
        // Await the drain itself, bounded: a fixed 20 ms after open was a timing guess that GitHub's Windows runner
        // missed (main CI 40292478624). A drain that never comes still fails, at the bound.
        await Promise.race([done, new Promise((r) => setTimeout(r, 5_000))]);
        expect(drained).toBe(true);
    });

    it('CONTROL — an injected synchronous tree: the same promise, already settled after the stops', async () => {
        const sync: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
        const host = hostOver(sync, () => ({ start: () => {}, kill: () => {} }));
        startAgents(host, 2);
        const left: number[] = [];
        await host.stopAll((n) => { left.push(n); });
        expect(left.at(-1)).toBe(0);
    });
});
