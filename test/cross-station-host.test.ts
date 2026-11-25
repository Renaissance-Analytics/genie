import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { framedForAgent, isAppSender } from '../src/core/app-inbox.js';
import { DefiniteRefusal, type CrossStationMode, type StationRow } from '../src/core/cross-station.js';
import { HUMAN } from '../src/core/inbox.js';
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
// `mine`: Tynn says the same account registered it (THE REVIEW OF #2180, finding 7: only such a station is dialled).
const ROWS: StationRow[] = [{ id: A, name: 'desk', mine: true }, { id: B, name: 'laptop', mine: true }];
let rows: StationRow[] = ROWS;

/*
 * `dials`: every link asked for, answered or not (each is a grant Tynn mints); `links`: those that opened. `booting`: the
 * host answers every call with a refusal that is not a definite one (what the wire says before its cross-station port is
 * there). `hang`: the link never opens. `shared`: each workspace's shared identity (its Tynn project), `slugs` its word.
 */
interface Side {
    id: string; host: CrossStationHost; inbox: InboxStore; atlas: AgentRecord; bolt: AgentRecord; extra: AgentRecord[]; online: boolean; person: Set<string>; links: number; dir: string;
    dials: number; booting: boolean; hang: boolean; shared: Map<string, string>; slugs: Map<string, string>;
}
let offsetMs = 0;
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
    const s: Side = {
        id, inbox, atlas, bolt, extra: [], online: true, person: new Set(), links: 0, dir, host: null as never,
        dials: 0, booting: false, hang: false, shared: new Map([[ws, 'tynn:proj_p8x']]), slugs: new Map([[ws, 'p8x'], ['ws_other', 'other']]),
    };
    s.host = new CrossStationHost({
        inbox,
        roster: () => [atlas, bolt, ...s.extra],
        slugs: () => s.slugs,
        sharedIdOf: (workspaceId) => s.shared.get(workspaceId) ?? null,
        asleep: () => new Set(),
        self: () => id,
        stations: async () => rows, // every workstation of the owner, this one too
        link: async (station): Promise<StationLink> => {
            s.dials += 1;
            if (s.hang) return new Promise<StationLink>(() => {});
            const there = other();
            if (station !== there.id || !there.online) throw new Error('that workstation is not online');
            s.links += 1;
            return {
                // As the wire says it (cross-station-wire.test.ts): only a DEFINITE refusal there is a StationRefused here.
                call: async (method, arg) => {
                    if (there.booting) throw new Error('laptop carries no agent mail between workstations');
                    return there.host.handle(method, arg, { station: id }).catch((e: unknown) => {
                        throw e instanceof DefiniteRefusal ? new StationRefused(e.message) : new Error(e instanceof Error ? e.message : String(e));
                    });
                },
                close: () => {},
            };
        },
        now: () => Date.now() + offsetMs,
        mode: () => mode,
        stationsTtlMs: 0,
        personConnected: (station) => s.person.has(station),
        log: () => {},
        schedule: (_ms, fn) => { timers.push(fn); return () => {}; },
    });
    s.host.start();
    return s;
}

beforeEach(async () => {
    mode = 'queue';
    rows = ROWS;
    offsetMs = 0;
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
        await runTimers(); // receipts go in a batch, a moment after the reads (THE REVIEW OF #2180, finding 2)
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

    it('a workstation Tynn says is not connected is not dialled for the list (an owner has many machines; each dial is a grant)', async () => {
        rows = [{ id: A, name: 'desk', mine: true }, { id: B, name: 'laptop', online: false, mine: true }];
        expect(await sides.A.host.peers(sides.A.atlas)).toEqual([]);
        expect(sides.A.links).toBe(0);
        rows = [{ id: A, name: 'desk', mine: true }, { id: B, name: 'laptop', online: true, mine: true }];
        expect(await sides.A.host.peers(sides.A.atlas)).toHaveLength(2); // positive control
    });

    it('an unreachable station lists nobody, and says so', async () => {
        sides.B.online = false;
        expect(await sides.A.host.peers(sides.A.atlas)).toEqual([]);
    });
});

/*
 * THE REVIEW OF #2180 (an independent review at 43e90be7): what must hold before merge. Each describe is one finding.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('finding 1, boot loss: only a DEFINITE answer settles a message', () => {
    it('B answers while it is still booting (no cross-station port yet): A keeps the mail, and delivers it once B is up', async () => {
        sides.B.booting = true;
        const r = await sendFromA('bolt@p8x@laptop', 'sent during B’s boot');
        expect(r).toMatchObject({ ok: true, delivered: false, queued: true });
        expect(sides.A.inbox.outboundFor(B)).toHaveLength(1);
        expect(sides.A.inbox.unread(sides.A.atlas.id)).toEqual([]); // nobody told atlas it was refused
        sides.B.booting = false;
        await runTimers();
        expect(sides.A.inbox.outboundFor(B)).toEqual([]);
        expect(sides.B.inbox.unread(sides.B.bolt.id).map((m) => m.text)).toEqual(['sent during B’s boot']);
    });

    it('the receiving host refuses definitely only for nobody by that address and for its scope, each with its code', async () => {
        const base = { id: 'msg_o1', from: { name: 'atlas', workspace: 'p8x', shared: 'tynn:proj_p8x' }, text: 'x', sentAt: new Date().toISOString() };
        const nobody = await sides.B.host.handle('xstation.deliver', { ...base, to: 'ghost@p8x' }, { station: A }).catch((e: unknown) => e);
        expect(nobody).toBeInstanceOf(DefiniteRefusal);
        expect((nobody as DefiniteRefusal).code).toBe('no-address');
        const scoped = await sides.B.host.handle('xstation.deliver', { ...base, id: 'msg_o2', from: { name: 'atlas', workspace: 'p8x', shared: null }, to: 'bolt@p8x' }, { station: A }).catch((e: unknown) => e);
        expect(scoped).toBeInstanceOf(DefiniteRefusal);
        expect((scoped as DefiniteRefusal).code).toBe('scope');
    });
});

describe('finding 2, retry storm: the backoff holds, offline stations are not dialled, reads do not each mint a grant', () => {
    it('while A backs off from B, five more sends dial nothing; the next retry takes all six in one link', async () => {
        sides.B.online = false;
        await sendFromA('bolt@p8x@laptop', 'm0');
        const dialled = sides.A.dials;
        expect(dialled).toBe(1);
        for (let i = 1; i <= 5; i += 1) expect(await sendFromA('bolt@p8x@laptop', `m${i}`)).toMatchObject({ ok: true, queued: true });
        expect(sides.A.dials).toBe(dialled);
        sides.B.online = true;
        await runTimers();
        expect(sides.A.dials).toBe(dialled + 1);
        expect(sides.B.inbox.unread(sides.B.bolt.id).map((m) => m.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    });

    it('a station Tynn says is offline is not dialled by a send; the mail waits, and goes once Tynn says it is back', async () => {
        rows = [{ id: A, name: 'desk', mine: true }, { id: B, name: 'laptop', online: false, mine: true }];
        expect(await sendFromA('bolt@p8x@laptop', 'later')).toMatchObject({ ok: true, queued: true });
        expect(sides.A.dials).toBe(0);
        rows = [{ id: A, name: 'desk', mine: true }, { id: B, name: 'laptop', online: true, mine: true }];
        await runTimers();
        expect(sides.B.inbox.unread(sides.B.bolt.id).map((m) => m.text)).toEqual(['later']);
    });

    it('five reads on B, one at a time, mint no grant each: the receipts go back together in one link', async () => {
        for (let i = 0; i < 5; i += 1) await sendFromA('bolt@p8x@laptop', `r${i}`);
        const before = sides.B.dials;
        for (let i = 0; i < 5; i += 1) await sides.B.inbox.receive({ participant: sides.B.bolt.id, limit: 1 });
        await settle();
        expect(sides.B.dials).toBe(before);
        await runTimers();
        expect(sides.B.dials).toBe(before + 1);
        expect(sides.A.inbox.receipts(sides.A.atlas.id).filter((x) => x.readAt !== null)).toHaveLength(5);
    });
});

describe('finding 3, bounds: the queue is capped per station and expires', () => {
    it('no more than the count a station may have waiting: the next send is refused in words, nothing more kept', async () => {
        sides.A.host.stop();
        sides.A.host = rebuilt(sides.A, { queueLimits: { count: 3, bytes: 1_000_000, maxAgeMs: 7 * 86_400_000 } });
        sides.B.online = false;
        for (let i = 0; i < 3; i += 1) expect(await sendFromA('bolt@p8x@laptop', `q${i}`)).toMatchObject({ ok: true, queued: true });
        expect(await sendFromA('bolt@p8x@laptop', 'one too many')).toMatchObject({ ok: false, reason: expect.stringMatching(/already wait for laptop/) });
        expect(sides.A.inbox.outboundFor(B)).toHaveLength(3);
    });

    it('no more than the bytes a station may have waiting', async () => {
        sides.A.host.stop();
        sides.A.host = rebuilt(sides.A, { queueLimits: { count: 100, bytes: 10, maxAgeMs: 7 * 86_400_000 } });
        sides.B.online = false;
        expect(await sendFromA('bolt@p8x@laptop', 'x'.repeat(8))).toMatchObject({ ok: true, queued: true });
        expect(await sendFromA('bolt@p8x@laptop', 'y'.repeat(8))).toMatchObject({ ok: false, reason: expect.stringMatching(/already wait for laptop/) });
    });

    it('mail still waiting after 7 days expires: it leaves the queue, the sending agent is told, and it is never delivered', async () => {
        sides.B.online = false;
        await sendFromA('bolt@p8x@laptop', 'stale');
        offsetMs = 7 * 86_400_000 + 1;
        await runTimers();
        expect(sides.A.inbox.outboundFor(B)).toEqual([]);
        expect(sides.A.inbox.all().find((m) => m.text === 'stale')?.outbound).toMatchObject({ state: 'refused', reason: expect.stringMatching(/7 days/) });
        expect(sides.A.inbox.unread(sides.A.atlas.id).map((m) => m.text).join(' ')).toMatch(/7 days/);
        sides.B.online = true;
        await runTimers();
        expect(sides.B.inbox.unread(sides.B.bolt.id)).toEqual([]);
    });
});

describe('finding 4, the refusal’s sender: Genie, read as data, never the person', () => {
    it('a refusal B wrote reaches atlas from an app sender, framed as an app’s message, not from the person', async () => {
        await sendFromA('ghost@p8x@laptop', 'anyone?');
        const told = sides.A.inbox.unread(sides.A.atlas.id);
        expect(told).toHaveLength(1);
        expect(told[0]!.from).not.toBe(HUMAN);
        expect(isAppSender(told[0]!.from)).toBe(true);
        expect(told[0]!.text).toMatch(/nobody at ghost@p8x/);
        expect(framedForAgent(told[0]!)).toMatchObject({ fromKind: 'app' });
    });
});

describe('finding 5, scope across stations: the same SHARED workspace (its Tynn project), never a matching slug', () => {
    it('A’s workspace is called p8x too but is linked to no Tynn project: B’s self-scoped bolt is not reachable from it', async () => {
        sides.A.shared = new Map();
        const r = await sendFromA('bolt@p8x@laptop', 'same slug, not the same workspace');
        expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/not reachable/) });
        expect(sides.B.inbox.unread(sides.B.bolt.id)).toEqual([]);
    });

    it('A’s workspace has another slug but the same Tynn project: it IS bolt’s workspace, and the mail is delivered', async () => {
        sides.A.slugs = new Map([['ws_p8x', 'renamed'], ['ws_other', 'other']]);
        expect(await sendFromA('bolt@p8x@laptop', 'same project')).toMatchObject({ ok: true, delivered: true });
        expect(sides.B.inbox.unread(sides.B.bolt.id).map((m) => m.text)).toEqual(['same project']);
    });

    it('an unlinked workspace on B matches nothing from another station', async () => {
        sides.B.shared = new Map();
        expect(await sendFromA('bolt@p8x@laptop', 'x')).toMatchObject({ ok: false });
        expect(sides.B.inbox.unread(sides.B.bolt.id)).toEqual([]);
    });
});

describe('finding 6, list: a short cache, not a dial per list', () => {
    it('two lists in a row dial B once', async () => {
        expect(await sides.A.host.peers(sides.A.atlas)).toHaveLength(2);
        expect(await sides.A.host.peers(sides.A.atlas)).toHaveLength(2);
        expect(sides.A.dials).toBe(1);
    });

    it('a station that did not answer is not dialled again by the next list either', async () => {
        sides.B.online = false;
        await sides.A.host.peers(sides.A.atlas);
        await sides.A.host.peers(sides.A.atlas);
        expect(sides.A.dials).toBe(1);
    });
});

describe('finding 7, the same account: A dials only a station Tynn says this account registered', () => {
    it('a station not registered by this account is not one of yours: nothing sent, nothing dialled, not listed', async () => {
        rows = [{ id: A, name: 'desk', mine: true }, { id: B, name: 'laptop', mine: false }];
        expect(await sendFromA('bolt@p8x@laptop', 'x')).toMatchObject({ ok: false, reason: expect.stringMatching(/not one of your workstations/) });
        expect(await sides.A.host.peers(sides.A.atlas)).toEqual([]);
        expect(sides.A.dials).toBe(0);
    });

    it('mail already queued for a station that is no longer this account’s is not dialled at the retry', async () => {
        sides.B.online = false;
        await sendFromA('bolt@p8x@laptop', 'x');
        const dialled = sides.A.dials;
        rows = [{ id: A, name: 'desk', mine: true }, { id: B, name: 'laptop', mine: false }];
        sides.B.online = true;
        await runTimers();
        expect(sides.A.dials).toBe(dialled);
        expect(sides.B.inbox.unread(sides.B.bolt.id)).toEqual([]);
    });
});

describe('nit: a send to a station that does not answer returns quickly, queued', () => {
    it('a link that never opens: the send says queued within its wait, and the mail is kept', async () => {
        sides.A.host.stop();
        sides.A.host = rebuilt(sides.A, { sendWaitMs: 50 });
        sides.A.hang = true;
        const r = await Promise.race([sendFromA('bolt@p8x@laptop', 'slow'), sleep(1_500).then(() => 'hung' as const)]);
        expect(r).not.toBe('hung');
        expect(r).toMatchObject({ ok: true, delivered: false, queued: true });
        expect(sides.A.inbox.outboundFor(B)).toHaveLength(1);
    });
});

/** The same side's host again, with these ports changed (the inbox, agents and link are the side's own). */
function rebuilt(s: Side, extra: Partial<ConstructorParameters<typeof CrossStationHost>[0]>): CrossStationHost {
    const other = (): Side => (s === sides.A ? sides.B : sides.A);
    const host = new CrossStationHost({
        inbox: s.inbox,
        roster: () => [s.atlas, s.bolt, ...s.extra],
        slugs: () => s.slugs,
        sharedIdOf: (workspaceId) => s.shared.get(workspaceId) ?? null,
        asleep: () => new Set(),
        self: () => s.id,
        stations: async () => rows,
        link: async (station): Promise<StationLink> => {
            s.dials += 1;
            if (s.hang) return new Promise<StationLink>(() => {});
            const there = other();
            if (station !== there.id || !there.online) throw new Error('that workstation is not online');
            s.links += 1;
            return {
                call: (method, arg) => there.host.handle(method, arg, { station: s.id }).catch((e: unknown) => {
                    throw e instanceof DefiniteRefusal ? new StationRefused(e.message) : new Error(e instanceof Error ? e.message : String(e));
                }),
                close: () => {},
            };
        },
        now: () => Date.now() + offsetMs,
        mode: () => mode,
        stationsTtlMs: 0,
        personConnected: (station) => s.person.has(station),
        log: () => {},
        schedule: (_ms, fn) => { timers.push(fn); return () => {}; },
        ...extra,
    });
    host.start();
    return host;
}
