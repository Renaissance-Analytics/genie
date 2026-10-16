import { describe, expect, it } from 'vitest';
import { PortAllocator } from '../src/core/port-allocator.js';

/**
 * THE LOOPBACK PORT ALLOCATOR — one for sites and engines. The one it replaces counted `++nextPort` from 4100
 * on every boot, so after a restart a site was handed the port an engine had recorded in services.json.
 * Here a port is handed out only when no instance records it, it has not been handed out already, and a
 * bind probe says it is free — and the same records give the same ports after a restart. The probe is a
 * fake that COUNTS what it was asked.
 */

function probe(busy: Iterable<number> = []) {
    const taken = new Set(busy);
    const asked: number[] = [];
    return { isFree: async (port: number) => { asked.push(port); return !taken.has(port); }, asked, taken };
}

async function allocator(records: number[], busy: Iterable<number> = [], poolSize = 4) {
    const p = probe(busy);
    const a = new PortAllocator({ first: 4101, reserved: () => records, isFree: p.isFree, poolSize });
    await a.prime();
    return { a, p };
}

const take = (a: PortAllocator, n: number) => Array.from({ length: n }, () => a.next());

describe('the ports it hands out', () => {
    it('positive control: nothing recorded, nothing in use — ascending from the first port', async () => {
        const { a } = await allocator([]);
        expect(take(a, 3)).toEqual([4101, 4102, 4103]);
    });

    it('skips every port a service instance RECORDS — the engines keep theirs, nothing else is put on them', async () => {
        const { a, p } = await allocator([4102, 4104]);
        expect(take(a, 3)).toEqual([4101, 4103, 4105]);
        // A recorded port is never even probed: it is not a candidate.
        expect(p.asked).not.toContain(4102);
        expect(p.asked).not.toContain(4104);
    });

    it('reads the records on EVERY allocation: a port recorded after it was probed free is not handed out', async () => {
        const records: number[] = [];
        const p = probe();
        const a = new PortAllocator({ first: 4101, reserved: () => records, isFree: p.isFree, poolSize: 4 });
        await a.prime();
        records.push(4101); // an engine was added on 4101 by another allocator path since the pool was filled
        expect(a.next()).toBe(4102);
    });

    it('skips a port something else on the machine holds (the bind probe says busy) — counted', async () => {
        const { a, p } = await allocator([], [4101, 4103]);
        expect(take(a, 2)).toEqual([4102, 4104]);
        expect(p.asked.filter((x) => x === 4101)).toHaveLength(1);
        expect(p.asked.filter((x) => x === 4103)).toHaveLength(1);
    });

    it('a probe that REJECTS counts as busy, never as free', async () => {
        const a = new PortAllocator({ first: 4101, reserved: () => [], isFree: async (port) => { if (port === 4101) throw new Error('EACCES'); return true; }, poolSize: 2 });
        await a.prime();
        expect(a.next()).toBe(4102);
    });

    it('never hands the same port out twice in one run, across pool top-ups', async () => {
        const { a } = await allocator([], [], 2);
        const got: number[] = [];
        for (let n = 0; n < 10; n++) {
            got.push(a.next());
            await a.settled();
        }
        expect(new Set(got).size).toBe(10);
        expect(got).toEqual([4101, 4102, 4103, 4104, 4105, 4106, 4107, 4108, 4109, 4110]);
    });

    it('a burst that empties the pool still never collides with a record, and SAYS the port was not probed', async () => {
        const lines: string[] = [];
        const a = new PortAllocator({ first: 4101, reserved: () => [4103], isFree: async () => true, poolSize: 1, log: (l) => lines.push(l) });
        await a.prime();
        const burst = take(a, 3);
        expect(burst).not.toContain(4103);
        expect(new Set(burst).size).toBe(3);
        expect(lines.length).toBeGreaterThanOrEqual(1);
        expect(lines[0]).toMatch(/handed out before it could be probed/);
    });

    it('past the last port it refuses, naming the range', async () => {
        const a = new PortAllocator({ first: 4101, last: 4102, reserved: () => [4102], isFree: async () => true, poolSize: 1 });
        await a.prime();
        expect(a.next()).toBe(4101);
        await a.settled();
        expect(() => a.next()).toThrow('no loopback port left between 4101 and 4102');
    });
});

describe('after a restart', () => {
    it('the same records on the same machine give the SAME ports, and none of them is a recorded port', async () => {
        const records = [4101, 4103];
        const first = await allocator(records, [4105]);
        const before = take(first.a, 4);
        // Restart: a fresh allocator over the same services.json and the same machine.
        const second = await allocator(records, [4105]);
        const after = take(second.a, 4);
        expect(after).toEqual(before);
        expect(before).toEqual([4102, 4104, 4106, 4107]);
        for (const r of records) expect(after).not.toContain(r);
    });

    it('the bug it replaces: boot 1 gives an engine 4102; on boot 2 the second site is NOT given 4102', async () => {
        const records: number[] = [];
        const boot1 = await allocator(records);
        expect(boot1.a.next()).toBe(4101); // a site
        records.push(boot1.a.next()); // an engine — recorded in services.json
        expect(records).toEqual([4102]);
        const boot2 = await allocator(records);
        const sites = take(boot2.a, 2);
        expect(sites).toEqual([4101, 4103]);
    });
});
