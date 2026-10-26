import { describe, expect, it } from 'vitest';
import { makeProcessTree, systemProcessTree, type ProcessInfo, type ProcessTreeIo } from '../src/core/process-tree.js';

/**
 * A READING THAT DOES NOT HOLD THE WINDOW (genie#1201; the owner, 2026-10-26: "when I hit the 'restart genie to install..'
 * button … the whole Genie UI freezes, turns a pale white … and the mouse turns into the spinning circle"). The Windows
 * reading is a PowerShell `Get-CimInstance Win32_Process`, run with execFileSync — main's event loop held for the whole
 * PowerShell run, 1–6 times for every agent a quit stops, and a taskkill per pid on top. With many agents, seconds of
 * a window that answers nothing, and Windows paints it "not responding".
 *
 * So the tree reads and reaps ASYNCHRONOUSLY too (`read`, `reap`), with the same rules as the synchronous pair, and
 * readings asked for together are SHARED: a quit stopping fifteen agents takes a few readings, not forty-five. A
 * shared reading always STARTED after its caller asked — a verification never sees a table read before its kill.
 */

function table(): ProcessInfo[] {
    return [
        { pid: 100, ppid: 1, started: 0, name: 'Genie.exe' },
        { pid: 200, ppid: 100, started: 10, name: 'cmd.exe' },
        { pid: 300, ppid: 200, started: 20, name: 'claude.exe' },
    ];
}

/** An io whose async reading resolves when the test says, counting how many readings were taken and when each began. */
function asyncIo(rows: ProcessInfo[] = table()) {
    const began: number[] = [];
    const pending: Array<{ resolve: (r: ProcessInfo[]) => void; reject: (e: Error) => void }> = [];
    const killed: number[] = [];
    let asks = 0;
    let syncReads = 0;
    const io: ProcessTreeIo = {
        snapshot: () => { syncReads += 1; return [...rows]; },
        killOne: (pid) => { killed.push(pid); },
        snapshotAsync: () => new Promise<ProcessInfo[]>((resolve, reject) => { began.push(asks); pending.push({ resolve, reject }); }),
        killOneAsync: async (pid) => { killed.push(pid); },
    };
    return {
        io, killed, began,
        ask: () => { asks += 1; },
        /** Resolve the oldest reading in flight with the table as it is now. */
        finish: () => pending.shift()!.resolve([...rows]),
        fail: () => pending.shift()!.reject(new Error('WMI unavailable')),
        inFlight: () => pending.length,
        syncReads: () => syncReads,
    };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('read(): asynchronous, shared, and never older than the ask', () => {
    it('ten callers in one moment share ONE reading', async () => {
        const io = asyncIo();
        const tree = makeProcessTree(io.io);
        const reads = Array.from({ length: 10 }, () => tree.read!());
        await tick();
        expect(io.began).toHaveLength(1);
        io.finish();
        const all = await Promise.all(reads);
        expect(all.every((r) => r !== null && r.length === 3)).toBe(true);
        expect(io.syncReads()).toBe(0);
    });

    it('a caller asking WHILE a reading runs gets the NEXT one, which starts only after it — never the older table', async () => {
        const io = asyncIo();
        const tree = makeProcessTree(io.io);
        const first = tree.read!();
        await tick();
        expect(io.inFlight()).toBe(1);
        const later = tree.read!();
        const later2 = tree.read!();
        await tick();
        expect(io.inFlight()).toBe(1); // one PowerShell at a time
        io.finish();
        await first;
        await tick();
        expect(io.began).toHaveLength(2); // the second reading began after the first ended, for both late callers
        io.finish();
        expect(await later).not.toBeNull();
        expect(await later2).not.toBeNull();
    });

    it('a reading that fails is null for everyone who shared it — never an empty machine — and the next one runs', async () => {
        const io = asyncIo();
        const tree = makeProcessTree(io.io);
        const a = tree.read!();
        const b = tree.read!();
        await tick();
        io.fail();
        expect(await a).toBeNull();
        expect(await b).toBeNull();
        const c = tree.read!();
        await tick();
        io.finish();
        expect(await c).toHaveLength(3);
    });
});

describe('reap(): the same rules as killTree, asynchronously', () => {
    it('kills the same process only (pid, start time AND name); a recycled pid is left alone', async () => {
        const io = asyncIo();
        const tree = makeProcessTree(io.io);
        const now = table();
        const recycled: ProcessInfo = { pid: 300, ppid: 200, started: 999, name: 'claude.exe' };
        expect(await tree.reap!([now[2]!, now[1]!], now)).toEqual({ killed: 2, refused: false });
        expect(io.killed.sort()).toEqual([200, 300]);
        io.killed.length = 0;
        expect(await tree.reap!([recycled], now)).toEqual({ killed: 0, refused: false });
        expect(io.killed).toEqual([]);
    });

    it('refuses more than the plausible count for one session, and kills nothing', async () => {
        const io = asyncIo();
        const tree = makeProcessTree(io.io);
        const many = Array.from({ length: 40 }, (_, i): ProcessInfo => ({ pid: 1000 + i, ppid: 100, started: 50 + i, name: 'node.exe' }));
        const r = await tree.reap!(many, many);
        expect(r.refused).toBe(true);
        expect(io.killed).toEqual([]);
    });

    it('an empty list reads nothing and kills nothing', async () => {
        const io = asyncIo();
        const tree = makeProcessTree(io.io);
        expect(await tree.reap!([], [])).toEqual({ killed: 0, refused: false });
        expect(io.began).toHaveLength(0);
    });
});

describe('the real tree', () => {
    it('is asynchronous: Genie’s own tree has read and reap', () => {
        expect(typeof systemProcessTree.read).toBe('function');
        expect(typeof systemProcessTree.reap).toBe('function');
    });

    it('an io without async calls gives no async pair (an injected test tree keeps its synchronous stop)', () => {
        const tree = makeProcessTree({ snapshot: () => table(), killOne: () => {} });
        expect(tree.read).toBeUndefined();
        expect(tree.reap).toBeUndefined();
    });
});
