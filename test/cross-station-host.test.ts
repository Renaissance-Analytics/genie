import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { CrossStationMode, StationRow } from '../src/core/cross-station.js';
import { CrossStationHost, StationRefused, type StationLink } from '../src/main/cross-station-host.js';
import { InboxStore } from '../src/main/inbox-store.js';

/*
 * TWO OF THE OWNER'S WORKSTATIONS, A AND B, EACH WITH ITS OWN HOST AND INBOX (P9, own stations first). A's agent mails
 * B's agent by `name@workspace@station`; B's host stores it, its agent reads it, and the receipt comes back to A. B's agent
 * answers the `from` it was given. While B cannot be reached, A keeps the mail and delivers it when B answers again. The
 * link here calls the other host's receiving side directly, with the station the grant proved; the wire is
 * cross-station-wire.test.ts.
 */

const A = '01m88dzykbnbx4kwj2ptpje92z';
const B = '01m88e0vzh4a36rj22h53hfcwr';
const ROWS: StationRow[] = [{ id: A, name: 'desk' }, { id: B, name: 'laptop' }];

interface Side { id: string; host: CrossStationHost; inbox: InboxStore; atlas: AgentRecord; bolt: AgentRecord; extra: AgentRecord[]; online: boolean; person: Set<string>; links: number; dir: string }
const sides: Record<'A' | 'B', Side> = {} as never;
let mode: CrossStationMode = 'queue';
const timers: Array<() => void> = [];
// Real files under the inbox: a settle is time, not ticks.
const settle = () => new Promise<void>((r) => setTimeout(r, 300));
const runTimers = async () => { for (const t of timers.splice(0)) t(); await settle(); };

async function side(id: string, other: () => Side): Promise<Side> {
    const dir = await mkdtemp(join(tmpdir(), `genie-xstation-${id.slice(-4)}-`));
    const inbox = await InboxStore.open(dir);
    const ws = 'ws_p8x';
    const atlas = agentRecord({ id: mintAgentId(), workspaceId: ws, provider: 'claude', name: 'atlas', accessScope: 'self' });
    const bolt = agentRecord({ id: mintAgentId(), workspaceId: ws, provider: 'claude', name: 'bolt', accessScope: 'self' });
    const s: Side = { id, inbox, atlas, bolt, extra: [], online: true, person: new Set(), links: 0, dir, host: null as never };
    s.host = new CrossStationHost({
        inbox,
        roster: () => [atlas, bolt, ...s.extra],
        slugs: () => new Map([[ws, 'p8x'], ['ws_other', 'other']]),
        asleep: () => new Set(),
        self: () => id,
        stations: async () => ROWS, // every workstation of the owner, this one too
        link: async (station): Promise<StationLink> => {
            const there = other();
            if (station !== there.id || !there.online) throw new Error('that workstation is not online');
            s.links += 1;
            return {
                call: (method, arg) => there.host.handle(method, arg, { station: id }).catch((e: unknown) => { throw new StationRefused(e instanceof Error ? e.message : String(e)); }),
                close: () => {},
            };
        },
        mode: () => mode,
        personConnected: (station) => s.person.has(station),
        log: () => {},
        schedule: (_ms, fn) => { timers.push(fn); return () => {}; },
    });
    s.host.start();
    return s;
}

beforeEach(async () => {
    mode = 'queue';
    timers.length = 0;
    sides.A = await side(A, () => sides.B);
    sides.B = await side(B, () => sides.A);
});
afterEach(async () => {
    for (const s of Object.values(sides)) { s.host.stop(); await rm(s.dir, { recursive: true, force: true }); }
});

const sendFromA = (to: string, text: string) => sides.A.host.send(sides.A.atlas, to, text);

describe('mail between two of the owner’s workstations', () => {
    it('A’s atlas → bolt@p8x@laptop: delivered on B to B’s bolt (not A’s), from atlas@p8x@desk', async () => {
        const r = await sendFromA('bolt@p8x@laptop', 'hello from A');
        expect(r).toMatchObject({ ok: true, delivered: true, queued: false });
        const onB = sides.B.inbox.unread(sides.B.bolt.id);
        expect(onB.map((m) => m.text)).toEqual(['hello from A']);
        expect(onB[0]!.origin).toMatchObject({ station: A, stationName: 'desk' });
        expect(sides.A.inbox.unread(sides.A.bolt.id)).toEqual([]); // the local bolt got nothing
    });

    it('the station may be named by its Tynn id too', async () => {
        expect(await sendFromA(`bolt@p8x@${B}`, 'by id')).toMatchObject({ ok: true, delivered: true });
    });

    it('B’s bolt reads it: A’s atlas sees the receipt', async () => {
        const r = await sendFromA('bolt@p8x@laptop', 'read me');
        await sides.B.inbox.receive({ participant: sides.B.bolt.id });
        await settle();
        const receipt = sides.A.inbox.receipts(sides.A.atlas.id).find((x) => x.message.id === (r as { messageId: string }).messageId);
        expect(receipt?.readAt).toEqual(expect.any(String));
    });

    it('B’s bolt answers the `from` it was given, and A’s atlas has it', async () => {
        await sendFromA('bolt@p8x@laptop', 'question');
        const got = sides.B.inbox.unread(sides.B.bolt.id)[0]!;
        const reply = await sides.B.host.send(sides.B.bolt, got.from, 'answer');
        expect(reply).toMatchObject({ ok: true, delivered: true });
        expect(sides.A.inbox.unread(sides.A.atlas.id).map((m) => m.text)).toEqual(['answer']);
    });

    it('B down: A keeps the mail; B back: the next retry delivers it, once', async () => {
        sides.B.online = false;
        const r = await sendFromA('bolt@p8x@laptop', 'while you were away');
        expect(r).toMatchObject({ ok: true, delivered: false, queued: true });
        expect(sides.A.inbox.outboundFor(B)).toHaveLength(1);
        await runTimers(); // still down: still kept
        expect(sides.A.inbox.outboundFor(B)).toHaveLength(1);
        sides.B.online = true;
        await runTimers();
        expect(sides.A.inbox.outboundFor(B)).toEqual([]);
        expect(sides.B.inbox.unread(sides.B.bolt.id).map((m) => m.text)).toEqual(['while you were away']);
        await runTimers();
        expect(sides.B.inbox.unread(sides.B.bolt.id)).toHaveLength(1);
    });

    it('a receipt owed while A is down is sent when A answers again', async () => {
        const r = await sendFromA('bolt@p8x@laptop', 'read later');
        sides.A.online = false;
        await sides.B.inbox.receive({ participant: sides.B.bolt.id });
        await settle();
        expect(sides.B.inbox.receiptsOwed(A)).toHaveLength(1);
        sides.A.online = true;
        await runTimers();
        expect(sides.B.inbox.receiptsOwed(A)).toEqual([]);
        expect(sides.A.inbox.receipts(sides.A.atlas.id).find((x) => x.message.id === (r as { messageId: string }).messageId)?.readAt).toEqual(expect.any(String));
    });

    it('nobody there by that name: A’s atlas is told in its inbox, and nothing waits', async () => {
        const r = await sendFromA('ghost@p8x@laptop', 'anyone?');
        expect(r).toMatchObject({ ok: false });
        expect((r as { reason: string }).reason).toMatch(/nobody at ghost@p8x on laptop/);
        expect(sides.A.inbox.outboundFor(B)).toEqual([]);
    });

    it('a workstation that is not one of the owner’s is nobody, and nothing is sent', async () => {
        expect(await sendFromA('bolt@p8x@elsewhere', 'x')).toMatchObject({ ok: false, reason: expect.stringMatching(/elsewhere is not one of your workstations/) });
        expect(sides.A.links).toBe(0);
    });

    it('this workstation’s own word is a local address: not handled here', async () => {
        expect(await sendFromA('bolt@p8x@desk', 'local')).toBeNull();
    });

    it('the recipient’s own scope holds across stations: self opens only from its own workspace', async () => {
        const stranger = agentRecord({ id: mintAgentId(), workspaceId: 'ws_other', provider: 'claude', name: 'stranger', accessScope: 'all' });
        sides.A.extra.push(stranger);
        const r = await sides.A.host.send(stranger, 'bolt@p8x@laptop', 'let me in');
        expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/not reachable/) });
    });
});

describe('the ONE switch: only while the person is connected', () => {
    it('connected, nobody connected between the two: refused in words, nothing kept, nothing dialled', async () => {
        mode = 'connected';
        const r = await sendFromA('bolt@p8x@laptop', 'x');
        expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/works only while you are connected/) });
        expect(sides.A.inbox.outboundFor(B)).toEqual([]);
        expect(sides.A.links).toBe(0);
    });

    it('connected, the person is connected to laptop: delivered', async () => {
        mode = 'connected';
        sides.A.person.add(B);
        expect(await sendFromA('bolt@p8x@laptop', 'x')).toMatchObject({ ok: true, delivered: true });
    });

    it('connected, but laptop does not answer: refused, not queued', async () => {
        mode = 'connected';
        sides.A.person.add(B);
        sides.B.online = false;
        expect(await sendFromA('bolt@p8x@laptop', 'x')).toMatchObject({ ok: false });
        expect(sides.A.inbox.outboundFor(B)).toEqual([]);
    });
});

describe('agentinbox list shows the other stations’ agents, in full', () => {
    it('B’s agents as name@workspace@laptop, with whether atlas may open to each', async () => {
        const peers = await sides.A.host.peers(sides.A.atlas);
        expect(peers.map((p) => [p.address, p.reachable])).toEqual([['atlas@p8x@laptop', true], ['bolt@p8x@laptop', true]]);
    });

    it('an unreachable station lists nobody, and says so', async () => {
        sides.B.online = false;
        expect(await sides.A.host.peers(sides.A.atlas)).toEqual([]);
    });
});
