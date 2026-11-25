import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { CrossStationHost, StationRefused } from '../src/main/cross-station-host.js';
import { InboxStore } from '../src/main/inbox-store.js';

/*
 * THE HOST SAYS WHEN AN EXCHANGE GOES ON (the owner, 2026-11-25: "a visual display in the genie header during the
 * exchange"), and each message that crossed (for the sound and the flow trigger): a link it opened to send is an exchange
 * OUT for as long as it is open; mail another station handed it is an exchange IN.
 */

const A = '01m88dzykbnbx4kwj2ptpje92z';
const B = '01m88e0vzh4a36rj22h53hfcwr';
let dir: string;
let events: string[];
let crossed: Array<{ direction: string; station: string; agentId: string; address: string }>;
let host: CrossStationHost;
let other: CrossStationHost;
let atlasA: ReturnType<typeof agentRecord>;
let boltB: ReturnType<typeof agentRecord>;
let unreachable = false;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-xstation-exchanges-'));
    events = [];
    crossed = [];
    unreachable = false;
    const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'atlas', accessScope: 'all' });
    const bolt = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'bolt', accessScope: 'all' });
    atlasA = atlas;
    boltB = bolt;
    const rows = [{ id: A, name: 'desk' }, { id: B, name: 'laptop' }];
    const make = async (self: string, mine: typeof atlas, there: () => CrossStationHost, sub: string) => new CrossStationHost({
        inbox: await InboxStore.open(join(dir, sub)),
        roster: () => [mine], slugs: () => new Map([['ws', 'p8x']]), asleep: () => new Set(), self: () => self,
        stations: async () => rows,
        link: async () => { if (unreachable) throw new Error('not online'); return { call: (m, a) => there().handle(m, a, { station: self }).catch((e: unknown) => { throw new StationRefused(String((e as Error).message)); }), close: () => { events.push(`${sub}:link-closed`); } }; },
        mode: () => 'queue', personConnected: () => false, log: () => {},
        exchanges: {
            begin: (station, name, direction) => { events.push(`${sub}:begin ${direction} ${name}`); return () => events.push(`${sub}:end ${direction} ${name}`); },
            pulse: (station, name, direction) => { events.push(`${sub}:pulse ${direction} ${name}`); },
        },
        crossed: (c) => { crossed.push({ direction: c.direction, station: c.station, agentId: c.agentId, address: c.address }); },
    });
    host = await make(A, atlas, () => other, 'a');
    other = await make(B, bolt, () => host, 'b');
});
afterEach(async () => { host.stop(); other.stop(); await rm(dir, { recursive: true, force: true }); });

describe('exchanges and crossings', () => {
    it('sending: OUT while the link is open, ended before it closes; receiving: a pulse IN; each message crossed once per side', async () => {
        const r = await host.send(atlasA, 'bolt@p8x@laptop', 'hi');
        expect(r).toMatchObject({ ok: true, delivered: true });
        expect(events).toEqual(['a:begin out laptop', 'b:pulse in desk', 'a:end out laptop', 'a:link-closed']);
        expect(crossed).toEqual([
            { direction: 'in', station: A, agentId: boltB.id, address: 'atlas@p8x@desk' },
            { direction: 'out', station: B, agentId: atlasA.id, address: 'bolt@p8x@laptop' },
        ]);
    });

    it('a station that cannot be reached is no exchange and nothing crossed', async () => {
        unreachable = true;
        expect(await host.send(atlasA, 'bolt@p8x@laptop', 'later')).toMatchObject({ ok: true, queued: true });
        expect(events).toEqual([]);
        expect(crossed).toEqual([]);
    });
});
