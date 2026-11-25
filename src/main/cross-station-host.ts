import {
    findStation, notConnectedWords, opensFrom, parseStationAddress, peerParticipant, readPeer, rosterOf, sendPlan, stationWord,
    type CrossStationMethod, type CrossStationMode, type RosterEntry, type StationRow,
} from '../core/cross-station.js';
import { HUMAN, resolveAddress, type Participant } from '../core/inbox.js';
import type { AgentRecord } from '../core/identity.js';
import type { InboxMessage, InboxStore } from './inbox-store.js';

/**
 * MAIL BETWEEN THE OWNER'S OWN WORKSTATIONS — the host half (P9, Tynn #424). Both ends live here:
 *
 * - SENDING: an agent's `agentinbox send` to `name@workspace@station` (or to the `peer:` from of mail it received) is
 *   kept in this host's inbox as mail to that remote participant, `outbound: queued`, and handed to the station over a
 *   short-lived link (cross-station-link.ts over the relay): opened for the batch, closed after it. A station that does
 *   not answer keeps it queued, retried on a backoff and whenever there is new work for it; a station that REFUSES it
 *   (nobody by that name, not reachable) settles it, and the sender is told in its own inbox.
 * - RECEIVING: `xstation.*` calls the receiving host's RemoteHost let through only from its owner's own workstations
 *   (core/cross-station.ts `deliveryAdmission`), with the station the GRANT proved. Mail is stored once per origin, for
 *   an agent in the roster the recipient's own scope opens to the sender's workspace, or that already wrote to it.
 * - RECEIPTS: when a recipient here reads mail from another station, the read is owed back to that station (durably,
 *   `origin.receiptSent`), and sent with the next batch to it.
 *
 * ONE SWITCH (`mode`): `queue` keeps mail for a station that does not answer; `connected` sends only while the person is
 * connected between the two workstations and keeps nothing.
 */

/** A refusal by the other station, in its words: settled, never retried. */
export class StationRefused extends Error {}

export interface StationLink {
    call(method: CrossStationMethod, arg: unknown): Promise<unknown>;
    close(): void;
}

export interface CrossStationPorts {
    readonly inbox: InboxStore;
    readonly roster: () => readonly AgentRecord[];
    readonly slugs: () => ReadonlyMap<string, string>;
    /** Workspaces that are hibernated: their agents are in no roster. */
    readonly asleep: () => ReadonlySet<string>;
    /** This workstation's Tynn id; `null` when it is not registered (then it neither sends nor is named). */
    readonly self: () => string | null;
    /** Every workstation of the owner, this one included, as Tynn lists them; `null` when Tynn cannot say. */
    readonly stations: () => Promise<readonly StationRow[] | null>;
    /** A link to that station; throws, in words, when it cannot be reached. */
    readonly link: (station: string) => Promise<StationLink>;
    readonly mode: () => CrossStationMode;
    /** Whether the person is connected between this workstation and that one (either way). */
    readonly personConnected: (station: string) => boolean;
    readonly log: (line: string) => void;
    readonly schedule?: (ms: number, fn: () => void) => () => void;
    /** The retry backoff, in ms; the last value repeats. */
    readonly retryMs?: readonly number[];
    /** How long Tynn's list of workstations is kept before it is asked again; default a minute. */
    readonly stationsTtlMs?: number;
}

export type CrossStationSend =
    | { readonly ok: true; readonly messageId: string; readonly delivered: boolean; readonly queued: boolean; readonly note?: string }
    | { readonly ok: false; readonly reason: string };

export interface RemotePeer {
    readonly address: string;
    readonly name: string;
    readonly workspace: string;
    readonly station: string;
    readonly reachable: boolean;
}

const RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
const STATIONS_TTL_MS = 60_000;
const MAX_TEXT = 256 * 1024;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

interface DeliverArg { id: string; from: { name: string; workspace: string }; to: string; text: string; sentAt: string }

export class CrossStationHost {
    readonly #p: CrossStationPorts;
    #stations: { rows: readonly StationRow[]; at: number } | null = null;
    readonly #rosters = new Map<string, RosterEntry[]>();
    readonly #busy = new Map<string, Promise<void>>();
    readonly #again = new Set<string>();
    readonly #tries = new Map<string, number>();
    readonly #timers = new Map<string, () => void>();
    #offRead: (() => void) | null = null;
    #stopped = false;

    constructor(ports: CrossStationPorts) {
        this.#p = ports;
    }

    /** Pick up what a restart left waiting, and owe receipts as mail from other stations is read. */
    start(): void {
        this.#stopped = false;
        this.#offRead = this.#p.inbox.onRead(() => {
            for (const station of this.#p.inbox.stationsOwedReceipts()) this.kick(station);
        });
        if (this.#p.mode() === 'queue') for (const station of this.#pendingStations()) this.kick(station);
    }

    stop(): void {
        this.#stopped = true;
        this.#offRead?.();
        this.#offRead = null;
        for (const cancel of this.#timers.values()) cancel();
        this.#timers.clear();
    }

    // ---- sending ------------------------------------------------------------------------------------------------------

    /**
     * `agentinbox send` to another station. `null`: `to` is not a station address, or names this workstation (a local
     * address, the caller resolves it as `name@workspace`).
     */
    async send(caller: AgentRecord, to: string, text: string): Promise<CrossStationSend | null> {
        const peer = readPeer(to);
        const parsed = peer ? { name: peer.name, workspace: peer.workspace, station: peer.station } : parseStationAddress(to);
        if (!parsed) return null;
        const self = this.#p.self();
        const rows = await this.#stationRows();
        if (rows === null) return { ok: false, reason: 'Tynn could not say which workstations are yours right now, so nothing was sent' };
        const station = findStation(parsed.station, rows);
        if (station && station.id === self) return null;
        if (!station) return { ok: false, reason: `${parsed.station} is not one of your workstations; nothing was sent` };
        if (self === null) return { ok: false, reason: 'this workstation is not registered with Tynn, so it cannot send to your other workstations' };
        const word = stationWord(station.id, rows);
        const address = `${parsed.name}@${parsed.workspace}@${word}`;
        const myWorkspace = this.#p.slugs().get(caller.workspaceId) ?? caller.workspaceId;
        const recipient = peerParticipant(station.id, parsed.name, parsed.workspace);
        // What that station said it holds, when known: refused here rather than queued for nobody.
        const known = this.#rosters.get(station.id);
        const entry = known?.find((e) => e.name.toLowerCase() === parsed.name.toLowerCase() && e.workspace === parsed.workspace);
        const answered = this.#p.inbox.hasWritten(recipient, caller.id);
        if (known && !entry && !answered) return { ok: false, reason: `nobody at ${parsed.name}@${parsed.workspace} on ${word}; use \`agentinbox list\` for the addresses that resolve` };
        if (entry && !opensFrom(entry, myWorkspace) && !answered) return { ok: false, reason: `${address} is not reachable from ${caller.name}: its agent scope does not open to ${myWorkspace} (permission, not liveness)` };

        const plan = sendPlan(this.#p.mode(), { personConnected: this.#p.personConnected(station.id) });
        if (plan === 'refuse') return { ok: false, reason: notConnectedWords(address, word) };
        const message = await this.#p.inbox.send({ from: caller.id, to: recipient, text, outbound: { station: station.id } });
        await this.#flush(station.id);
        // A batch already running for that station took this one as "again": wait for that next pass too.
        if (this.#p.inbox.outboundFor(station.id).some((m) => m.id === message.id)) await this.#busy.get(station.id);
        const now =this.#p.inbox.all().find((m) => m.id === message.id)?.outbound;
        if (now?.state === 'delivered') return { ok: true, messageId: message.id, delivered: true, queued: false };
        if (now?.state === 'refused') return { ok: false, reason: now.reason };
        if (plan === 'try-once') {
            await this.#p.inbox.settleOutbound(message.id, { state: 'refused', reason: `${word} did not answer` });
            return { ok: false, reason: `${word} did not answer: ${now?.reason ?? 'it could not be reached'}. Nothing was sent.` };
        }
        return { ok: true, messageId: message.id, delivered: false, queued: true, note: `${word} cannot be reached now (${now?.reason ?? 'no answer'}); Genie keeps the message and delivers it when ${word} is back` };
    }

    /** The other stations' agents, for `agentinbox list`: each station that answers now, in full addresses. */
    async peers(caller: AgentRecord): Promise<RemotePeer[]> {
        const self = this.#p.self();
        const rows = await this.#stationRows();
        if (rows === null || self === null) return [];
        const myWorkspace = this.#p.slugs().get(caller.workspaceId) ?? caller.workspaceId;
        const out: RemotePeer[] = [];
        // Only what Tynn says is connected now: an owner can have many machines, and each dial costs a grant.
        const others = rows.filter((r) => r.id !== self && r.online !== false);
        const rosters = await Promise.all(others.map(async (row) => {
            try {
                const link = await this.#p.link(row.id);
                try {
                    const answer = await link.call('xstation.roster', {});
                    const roster = rosterFrom(answer);
                    this.#rosters.set(row.id, roster);
                    this.#p.log(`cross-station: ${row.name} (${row.id}) lists ${roster.length} agent(s)`);
                    return { row, roster };
                } finally { link.close(); }
            } catch (error) {
                this.#p.log(`cross-station: ${row.name} gave no roster: ${error instanceof Error ? error.message : String(error)}`);
                return { row, roster: null };
            }
        }));
        for (const { row, roster } of rosters) {
            if (!roster) continue;
            const word = stationWord(row.id, rows);
            for (const e of roster) {
                const participant = peerParticipant(row.id, e.name, e.workspace);
                out.push({ address: `${e.name}@${e.workspace}@${word}`, name: e.name, workspace: e.workspace, station: word, reachable: opensFrom(e, myWorkspace) || this.#p.inbox.hasWritten(participant, caller.id) });
            }
        }
        return out;
    }

    /** Try that station now (when nothing is trying it already). */
    kick(station: string): void {
        void this.#flush(station);
    }

    async #flush(station: string): Promise<void> {
        const running = this.#busy.get(station);
        if (running) { this.#again.add(station); return running; }
        const run = this.#deliver(station).finally(() => {
            this.#busy.delete(station);
            if (this.#again.delete(station)) void this.#flush(station);
        });
        this.#busy.set(station, run);
        return run;
    }

    async #deliver(station: string): Promise<void> {
        if (this.#stopped) return;
        const mail = this.#p.inbox.outboundFor(station);
        const owed = this.#p.inbox.receiptsOwed(station);
        if (mail.length === 0 && owed.length === 0) { this.#tries.delete(station); return; }
        const self = this.#p.self();
        let link: StationLink;
        try {
            link = await this.#p.link(station);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            for (const m of mail) await this.#p.inbox.outboundTried(m.id, reason);
            this.#p.log(`cross-station: ${station} could not be reached: ${reason}; ${mail.length} message(s) and ${owed.length} receipt(s) wait`);
            this.#retryLater(station);
            return;
        }
        try {
            for (const m of mail) {
                const sender = this.#p.roster().find((r) => r.id === m.from);
                const to = readPeer(m.to);
                if (!sender || !to || self === null) { await this.#p.inbox.settleOutbound(m.id, { state: 'refused', reason: 'its sender is no longer in Genie' }); continue; }
                const arg: DeliverArg = { id: m.id, from: { name: sender.name, workspace: this.#p.slugs().get(sender.workspaceId) ?? sender.workspaceId }, to: `${to.name}@${to.workspace}`, text: m.text, sentAt: m.sentAt };
                try {
                    await link.call('xstation.deliver', arg);
                    await this.#p.inbox.settleOutbound(m.id, { state: 'delivered' });
                } catch (error) {
                    if (!(error instanceof StationRefused)) throw error;
                    await this.#p.inbox.settleOutbound(m.id, { state: 'refused', reason: error.message });
                    await this.#tellSender(m, error.message);
                }
            }
            if (owed.length > 0) {
                await link.call('xstation.read', { reads: owed });
                await this.#p.inbox.markReceiptsSent(station, owed.map((o) => o.id));
            }
            this.#tries.delete(station);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            for (const m of this.#p.inbox.outboundFor(station)) await this.#p.inbox.outboundTried(m.id, reason);
            this.#p.log(`cross-station: the link to ${station} failed: ${reason}`);
            this.#retryLater(station);
        } finally {
            link.close();
        }
    }

    /** A refusal from the other station, said to the agent that wrote, in its own inbox. */
    async #tellSender(message: InboxMessage, reason: string): Promise<void> {
        const rows = (await this.#stationRows()) ?? [];
        const to = readPeer(message.to);
        const address = to ? `${to.name}@${to.workspace}@${stationWord(to.station, rows)}` : 'another workstation';
        await this.#p.inbox.send({ from: HUMAN, to: message.from, text: `Genie: your message to ${address} was not delivered: ${reason}` }).catch(() => {});
    }

    #retryLater(station: string): void {
        if (this.#stopped || this.#p.mode() !== 'queue' || this.#timers.has(station)) return;
        const n = this.#tries.get(station) ?? 0;
        this.#tries.set(station, n + 1);
        const steps = this.#p.retryMs ?? RETRY_MS;
        const ms = steps[Math.min(n, steps.length - 1)]!;
        const schedule = this.#p.schedule ?? ((wait, fn) => { const t = setTimeout(fn, wait); t.unref?.(); return () => clearTimeout(t); });
        this.#timers.set(station, schedule(ms, () => { this.#timers.delete(station); this.kick(station); }));
    }

    #pendingStations(): string[] {
        return [...new Set([...this.#p.inbox.outboundFor().map((m) => m.outbound!.station), ...this.#p.inbox.stationsOwedReceipts()])];
    }

    async #stationRows(): Promise<readonly StationRow[] | null> {
        if (this.#stations && Date.now() - this.#stations.at < (this.#p.stationsTtlMs ?? STATIONS_TTL_MS)) return this.#stations.rows;
        const rows = await this.#p.stations().catch(() => null);
        if (rows === null) return this.#stations?.rows ?? null;
        this.#stations = { rows, at: Date.now() };
        return rows;
    }

    // ---- receiving ----------------------------------------------------------------------------------------------------

    /** A call another of the owner's workstations made here; RemoteHost already admitted it and names its station. */
    async handle(method: string, arg: unknown, from: { readonly station: string }): Promise<unknown> {
        switch (method) {
            case 'xstation.roster':
                return { agents: rosterOf(this.#p.roster(), this.#p.slugs(), this.#p.asleep()) };
            case 'xstation.deliver':
                return this.#receive(deliverArgOf(arg), from.station);
            case 'xstation.read': {
                const reads = readsOf(arg);
                let changed = 0;
                for (const r of reads) changed += await this.#p.inbox.peerRead(from.station, [r.id], r.readAt);
                return { changed };
            }
            default:
                throw new Error(`no ${method} here`);
        }
    }

    async #receive(d: DeliverArg, station: string): Promise<{ messageId: string }> {
        const rows = (await this.#stationRows()) ?? [];
        const here = this.#p.self();
        const myWord = here ? stationWord(here, rows) : 'this workstation';
        const fromRow = rows.find((r) => r.id === station);
        const sender = peerParticipant(station, d.from.name, d.from.workspace);
        const asleep = this.#p.asleep();
        const records = this.#p.roster();
        const target = resolveAddress(d.to, records.filter((r) => !asleep.has(r.workspaceId)), this.#p.slugs());
        if (target.kind !== 'one') throw new Error(`nobody at ${d.to} on ${myWord}`);
        const record = records.find((r) => r.id === target.id)!;
        const entry = rosterOf([record], this.#p.slugs(), asleep)[0];
        const answered = this.#p.inbox.hasWritten(record.id, sender);
        if (!answered && (!entry || !opensFrom(entry, d.from.workspace))) throw new Error(`${d.to} on ${myWord} is not reachable from ${d.from.name}@${d.from.workspace}: its agent scope does not allow it (permission, not liveness)`);
        const stored = await this.#p.inbox.receiveFromStation({ station, stationName: fromRow?.name ?? station, id: d.id, from: sender, to: record.id as Participant, text: d.text, sentAt: d.sentAt });
        return { messageId: stored.message.id };
    }
}

function deliverArgOf(arg: unknown): DeliverArg {
    const a = (arg ?? {}) as Record<string, unknown>;
    const from = (a.from ?? {}) as Record<string, unknown>;
    const ok = typeof a.id === 'string' && a.id.length > 0 && a.id.length <= 100
        && typeof from.name === 'string' && SEGMENT.test(from.name) && typeof from.workspace === 'string' && SEGMENT.test(from.workspace)
        && typeof a.to === 'string' && a.to.length <= 300 && typeof a.text === 'string' && a.text.length <= MAX_TEXT
        && typeof a.sentAt === 'string' && !Number.isNaN(Date.parse(a.sentAt));
    if (!ok) throw new Error('that is not a message this workstation takes');
    return { id: a.id as string, from: { name: from.name as string, workspace: from.workspace as string }, to: a.to as string, text: a.text as string, sentAt: a.sentAt as string };
}

function readsOf(arg: unknown): Array<{ id: string; readAt: string }> {
    const reads = (arg as { reads?: unknown } | null)?.reads;
    if (!Array.isArray(reads) || reads.length > 1_000) throw new Error('that is not a list of reads');
    return reads.filter((r): r is { id: string; readAt: string } => typeof (r as { id?: unknown })?.id === 'string' && typeof (r as { readAt?: unknown }).readAt === 'string' && !Number.isNaN(Date.parse((r as { readAt: string }).readAt)));
}

function rosterFrom(answer: unknown): RosterEntry[] {
    const agents = (answer as { agents?: unknown } | null)?.agents;
    if (!Array.isArray(agents)) return [];
    return agents.flatMap((e): RosterEntry[] => {
        const r = e as Record<string, unknown>;
        if (typeof r.name !== 'string' || !SEGMENT.test(r.name) || typeof r.workspace !== 'string' || !SEGMENT.test(r.workspace)) return [];
        const opens = r.opensFrom === 'all' ? 'all' as const : Array.isArray(r.opensFrom) ? r.opensFrom.filter((w): w is string => typeof w === 'string') : [];
        return [{ name: r.name, workspace: r.workspace, opensFrom: opens }];
    });
}
