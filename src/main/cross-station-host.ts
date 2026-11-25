import {
    DefiniteRefusal, findStation, notConnectedWords, opensFrom, parseStationAddress, peerParticipant, readPeer, rosterOf, sendPlan, stationWord,
    type CrossStationMethod, type CrossStationMode, type RosterEntry, type StationRow,
} from '../core/cross-station.js';
import { appSenderId, appSenderLabel, type AppMessageMeta, type AppSource } from '../core/app-inbox.js';
import { resolveAddress, SYSTEM_WORKSPACE, type Participant } from '../core/inbox.js';
import type { AgentRecord } from '../core/identity.js';
import type { InboxMessage, InboxStore, StationArrivalLimits } from './inbox-store.js';

/**
 * MAIL BETWEEN THE OWNER'S OWN WORKSTATIONS — the host half (P9, Tynn #424). Both ends live here:
 *
 * - SENDING: an agent's `agentinbox send` to `name@workspace@station` (or to the `peer:` from of mail it received) is
 *   kept in this host's inbox as mail to that remote participant, `outbound: queued`, and handed to the station over a
 *   short-lived link (cross-station-link.ts over the relay): opened for the batch, closed after it. A station that does
 *   not answer keeps it queued, retried on a backoff; a station that refuses it DEFINITELY (nobody by that address, its
 *   scope) settles it, and the sender is told in its own inbox, by Genie. Mail that has waited `maxAgeMs` (7 days)
 *   expires the same way. A station Tynn does not list as this account's own is never dialled.
 * - RECEIVING: `xstation.*` calls the receiving host's RemoteHost let through only from its owner's own workstations
 *   (core/cross-station.ts `deliveryAdmission`), with the station the GRANT proved. Mail is stored once per origin, for
 *   an agent in the roster the recipient's own scope opens to the sender's SHARED workspace, or that already wrote to it,
 *   and only while that agent is CAPABLE OF RECEIVING (not hibernated, not paused): "delivered" means it can take it.
 * - RECEIPTS: when a recipient here reads mail from another station, the read is owed back to that station (durably,
 *   `origin.receiptSent`), and sent a moment later, every read of the moment in one link.
 *
 * WHAT A LINK COSTS (the review of #2180, finding 2): each is a grant Tynn mints. So a station is dialled only when there
 * is work for it and it is not backing off, never while Tynn says it is offline, never once per local read, and a list
 * reads what each station answered a moment ago.
 *
 * ONE SWITCH (`mode`): `queue` keeps mail for a station that does not answer; `connected` sends only while the person is
 * connected between the two workstations and keeps nothing.
 */

/** A DEFINITE refusal by the other station, in its words (cross-station-link.ts): settled, never retried. */
export class StationRefused extends Error {}

export interface StationLink {
    call(method: CrossStationMethod, arg: unknown): Promise<unknown>;
    close(): void;
}

/** How much may wait for one station, and for how long (the review of #2180, finding 3). */
export interface QueueLimits { readonly count: number; readonly bytes: number; readonly maxAgeMs: number }

export interface CrossStationPorts {
    readonly inbox: InboxStore;
    readonly roster: () => readonly AgentRecord[];
    readonly slugs: () => ReadonlyMap<string, string>;
    /**
     * A workspace's SHARED identity across stations (core/cross-station.ts `sharedWorkspaceId`: its Tynn project);
     * `null` when it is linked to none, and then it matches nothing on another station.
     */
    readonly sharedIdOf: (workspaceId: string) => string | null;
    /** Workspaces that are hibernated: their agents are in no roster. */
    readonly asleep: () => ReadonlySet<string>;
    /**
     * CAPABLE OF RECEIVING (the owner, 2026-11-25: "mail sent should get a message received response only when the agent
     * is capable of receiving messages"): why this agent here cannot take mail right now (its provider paused it), or
     * `null`. Such mail is not taken, so the sender keeps it queued and is never told it was received.
     */
    readonly cannotReceive?: (agentId: string) => string | null;
    /** Why an address here that resolves to nobody awake cannot be mailed (a hibernated workspace), in words; else `null`. */
    readonly recipientRefusal?: (address: string) => string | null;
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
    readonly now?: () => number;
    /** The retry backoff, in ms; the last value repeats. */
    readonly retryMs?: readonly number[];
    /** How long Tynn's list of workstations is kept before it is asked again; default a minute. */
    readonly stationsTtlMs?: number;
    /** How long what a station listed (or that it did not answer) is kept for `agentinbox list`; default 30 s. */
    readonly rosterTtlMs?: number;
    /** How long after a read its receipt goes, with every other read of that moment; default 3 s. */
    readonly receiptDelayMs?: number;
    /** How long a send waits for the station before it says "queued" (in `queue` mode); default 8 s. */
    readonly sendWaitMs?: number;
    readonly queueLimits?: QueueLimits;
    /** What one station may hand this host (inbox-store.ts STATION_ARRIVAL_LIMITS by default). */
    readonly arrivalLimits?: StationArrivalLimits;
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
const ROSTER_TTL_MS = 30_000;
const RECEIPT_DELAY_MS = 3_000;
const SEND_WAIT_MS = 8_000;
const DAY_MS = 86_400_000;
export const QUEUE_LIMITS: QueueLimits = { count: 500, bytes: 16 * 1024 * 1024, maxAgeMs: 7 * DAY_MS };
const MAX_TEXT = 256 * 1024;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

interface DeliverArg { id: string; from: { name: string; workspace: string; shared: string | null }; to: string; text: string; sentAt: string }

/** Genie itself, telling an agent what became of its mail to another workstation (core/app-inbox.ts kind `genie`). */
function genieSource(workspaceId: string): AppSource {
    return { kind: 'genie', id: 'cross-station', name: 'mail', workspaceId };
}

export class CrossStationHost {
    readonly #p: CrossStationPorts;
    #stations: { rows: readonly StationRow[]; at: number } | null = null;
    /** What each station last said it holds: a send refuses an address it does not have. */
    readonly #rosters = new Map<string, RosterEntry[]>();
    /** What `list` read of each station a moment ago: its roster, or `null` when it did not answer. */
    readonly #listed = new Map<string, { roster: RosterEntry[] | null; at: number }>();
    readonly #busy = new Map<string, Promise<void>>();
    readonly #again = new Set<string>();
    readonly #tries = new Map<string, number>();
    /** A station backing off: its next try. While one is set, nothing dials it sooner. */
    readonly #timers = new Map<string, () => void>();
    /** Receipts owed to a station, waiting a moment for the other reads of that moment. */
    readonly #receiptTimers = new Map<string, () => void>();
    #offRead: (() => void) | null = null;
    #stopped = false;

    constructor(ports: CrossStationPorts) {
        this.#p = ports;
    }

    #now(): number {
        return (this.#p.now ?? Date.now)();
    }

    #schedule(ms: number, fn: () => void): () => void {
        return (this.#p.schedule ?? ((wait, run) => { const t = setTimeout(run, wait); t.unref?.(); return () => clearTimeout(t); }))(ms, fn);
    }

    /** Pick up what a restart left waiting, and owe receipts as mail from other stations is read. */
    start(): void {
        this.#stopped = false;
        this.#offRead = this.#p.inbox.onRead(() => {
            for (const station of this.#p.inbox.stationsOwedReceipts()) this.#receiptSoon(station);
        });
        if (this.#p.mode() === 'queue') for (const station of this.#pendingStations()) this.kick(station);
    }

    stop(): void {
        this.#stopped = true;
        this.#offRead?.();
        this.#offRead = null;
        for (const cancel of [...this.#timers.values(), ...this.#receiptTimers.values()]) cancel();
        this.#timers.clear();
        this.#receiptTimers.clear();
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
        // THE SAME ACCOUNT (the review of #2180, finding 7): only a workstation Tynn says this account registered is dialled.
        if (!station || station.mine !== true) return { ok: false, reason: `${parsed.station} is not one of your workstations; nothing was sent` };
        if (self === null) return { ok: false, reason: 'this workstation is not registered with Tynn, so it cannot send to your other workstations' };
        const word = stationWord(station.id, rows);
        const address = `${parsed.name}@${parsed.workspace}@${word}`;
        const myShared = this.#p.sharedIdOf(caller.workspaceId);
        const recipient = peerParticipant(station.id, parsed.name, parsed.workspace);
        // What that station said it holds, when known: refused here rather than queued for nobody.
        const known = this.#rosters.get(station.id);
        const entry = known?.find((e) => e.name.toLowerCase() === parsed.name.toLowerCase() && e.workspace === parsed.workspace);
        const answered = this.#p.inbox.hasWritten(recipient, caller.id);
        if (known && !entry && !answered) return { ok: false, reason: `nobody at ${parsed.name}@${parsed.workspace} on ${word}; use \`agentinbox list\` for the addresses that resolve` };
        if (entry && !opensFrom(entry, myShared) && !answered) return { ok: false, reason: `${address} is not reachable from ${caller.name}: its agent scope does not open to this workspace (permission, not liveness)` };

        const plan = sendPlan(this.#p.mode(), { personConnected: this.#p.personConnected(station.id) });
        if (plan === 'refuse') return { ok: false, reason: notConnectedWords(address, word) };
        // THE QUEUE'S BOUNDS (finding 3): so much, per station, and no more until it takes them.
        const limits = this.#p.queueLimits ?? QUEUE_LIMITS;
        const waiting = this.#p.inbox.outboundFor(station.id);
        const waitingBytes = waiting.reduce((n, m) => n + Buffer.byteLength(m.text), 0);
        if (waiting.length >= limits.count || waitingBytes + Buffer.byteLength(text) > limits.bytes) {
            return { ok: false, reason: `${waiting.length} message(s) already wait for ${word}, as many as Genie keeps for one workstation; nothing more is kept for it until it takes them. Nothing was sent.` };
        }
        const message = await this.#p.inbox.send({ from: caller.id, to: recipient, text, outbound: { station: station.id, stationName: station.name } });
        const queuedNote = (why: string) => `${word} cannot be reached now (${why}); Genie keeps the message and delivers it when ${word} is back`;
        if (plan === 'try-then-queue') {
            // Backing off, or offline as Tynn says (finding 2): kept for the next try, no link now.
            if (this.#timers.has(station.id) || station.online === false) {
                if (!this.#timers.has(station.id)) this.#retryLater(station.id);
                return { ok: true, messageId: message.id, delivered: false, queued: true, note: queuedNote(station.online === false ? 'Tynn says it is not connected' : 'it did not answer a moment ago') };
            }
        }
        const attempt = (async () => {
            await this.#flush(station.id);
            // A batch already running for that station took this one as "again": wait for that next pass too.
            if (this.#p.inbox.outboundFor(station.id).some((m) => m.id === message.id)) await this.#busy.get(station.id);
        })();
        // QUICK (the nit): in `queue` mode a send waits only so long for the station; the mail is kept either way.
        if (plan === 'try-then-queue') {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([attempt, new Promise<void>((r) => { timer = setTimeout(r, this.#p.sendWaitMs ?? SEND_WAIT_MS); timer.unref?.(); })]);
            clearTimeout(timer);
        } else {
            await attempt;
        }
        const now = this.#p.inbox.all().find((m) => m.id === message.id)?.outbound;
        if (now?.state === 'delivered') return { ok: true, messageId: message.id, delivered: true, queued: false };
        if (now?.state === 'refused') return { ok: false, reason: now.reason };
        if (plan === 'try-once') {
            await this.#p.inbox.settleOutbound(message.id, { state: 'refused', reason: `${word} did not answer` });
            return { ok: false, reason: `${word} did not answer: ${now?.reason ?? 'it could not be reached'}. Nothing was sent.` };
        }
        return { ok: true, messageId: message.id, delivered: false, queued: true, note: queuedNote(now?.reason ?? 'no answer yet') };
    }

    /** The other stations' agents, for `agentinbox list`: each station that answered a moment ago, in full addresses. */
    async peers(caller: AgentRecord): Promise<RemotePeer[]> {
        const self = this.#p.self();
        const rows = await this.#stationRows();
        if (rows === null || self === null) return [];
        const myShared = this.#p.sharedIdOf(caller.workspaceId);
        const out: RemotePeer[] = [];
        // Only this account's, and only what Tynn says is connected now: an owner can have many machines, and each dial costs a grant.
        const others = rows.filter((r) => r.id !== self && r.mine === true && r.online !== false);
        const ttl = this.#p.rosterTtlMs ?? ROSTER_TTL_MS;
        const rosters = await Promise.all(others.map(async (row) => {
            const cached = this.#listed.get(row.id);
            if (cached && this.#now() - cached.at < ttl) return { row, roster: cached.roster };
            let roster: RosterEntry[] | null = null;
            try {
                const link = await this.#p.link(row.id);
                try {
                    roster = rosterFrom(await link.call('xstation.roster', {}));
                    this.#rosters.set(row.id, roster);
                    this.#p.log(`cross-station: ${row.name} (${row.id}) lists ${roster.length} agent(s)`);
                } finally { link.close(); }
            } catch (error) {
                this.#p.log(`cross-station: ${row.name} gave no roster: ${error instanceof Error ? error.message : String(error)}`);
            }
            this.#listed.set(row.id, { roster, at: this.#now() });
            return { row, roster };
        }));
        for (const { row, roster } of rosters) {
            if (!roster) continue;
            const word = stationWord(row.id, rows);
            for (const e of roster) {
                const participant = peerParticipant(row.id, e.name, e.workspace);
                out.push({ address: `${e.name}@${e.workspace}@${word}`, name: e.name, workspace: e.workspace, station: word, reachable: opensFrom(e, myShared) || this.#p.inbox.hasWritten(participant, caller.id) });
            }
        }
        return out;
    }

    /** Try that station now (when nothing is trying it already). */
    kick(station: string): void {
        void this.#flush(station);
    }

    /** A receipt is owed to that station: sent a moment from now with the rest of that moment's reads, unless it backs off. */
    #receiptSoon(station: string): void {
        if (this.#stopped || this.#timers.has(station) || this.#receiptTimers.has(station)) return;
        this.#receiptTimers.set(station, this.#schedule(this.#p.receiptDelayMs ?? RECEIPT_DELAY_MS, () => { this.#receiptTimers.delete(station); this.kick(station); }));
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
        await this.#expire(station);
        const mail = this.#p.inbox.outboundFor(station);
        const owed = this.#p.inbox.receiptsOwed(station);
        if (mail.length === 0 && owed.length === 0) { this.#tries.delete(station); return; }
        const self = this.#p.self();
        // Never dialled: a station Tynn does not list as this account's, or says is offline (findings 2 and 7).
        const rows = await this.#stationRows();
        const row = rows?.find((r) => r.id === station) ?? null;
        if (row === null || row.mine !== true || row.online === false) {
            const why = rows === null ? 'Tynn could not say which workstations are yours' : row === null || row.mine !== true ? 'Tynn does not list it as one of your workstations now' : 'Tynn says it is not connected';
            this.#p.log(`cross-station: ${station} not dialled: ${why}; ${mail.length} message(s) and ${owed.length} receipt(s) wait`);
            this.#retryLater(station);
            return;
        }
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
                const arg: DeliverArg = {
                    id: m.id,
                    from: { name: sender.name, workspace: this.#p.slugs().get(sender.workspaceId) ?? sender.workspaceId, shared: this.#p.sharedIdOf(sender.workspaceId) },
                    to: `${to.name}@${to.workspace}`, text: m.text, sentAt: m.sentAt,
                };
                try {
                    await link.call('xstation.deliver', arg);
                    await this.#p.inbox.settleOutbound(m.id, { state: 'delivered' });
                } catch (error) {
                    // Only a DEFINITE refusal settles (finding 1); anything else ends this pass and the mail waits.
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

    /** Mail that has waited past `maxAgeMs` leaves the queue, and its sender is told (finding 3). */
    async #expire(station: string): Promise<void> {
        const limits = this.#p.queueLimits ?? QUEUE_LIMITS;
        const cutoff = this.#now() - limits.maxAgeMs;
        const stale = this.#p.inbox.outboundFor(station).filter((m) => Date.parse(m.sentAt) <= cutoff);
        if (stale.length === 0) return;
        const days = Math.round(limits.maxAgeMs / DAY_MS);
        const reason = `it waited ${days} days and that workstation never took it, so Genie stopped trying`;
        for (const m of stale) {
            await this.#p.inbox.settleOutbound(m.id, { state: 'refused', reason });
            await this.#tellSender(m, reason);
        }
        this.#p.log(`cross-station: ${stale.length} message(s) for ${station} expired after ${days} days`);
    }

    /**
     * What became of an agent's mail, said to it in its own inbox BY GENIE (finding 4): an app's message, which an agent
     * reads as data, never the person's. The reason may be words another host wrote.
     */
    async #tellSender(message: InboxMessage, reason: string): Promise<void> {
        const sender = this.#p.roster().find((r) => r.id === message.from);
        if (!sender) return;
        const rows = (await this.#stationRows()) ?? [];
        const to = readPeer(message.to);
        const address = to ? `${to.name}@${to.workspace}@${stationWord(to.station, rows)}` : 'another workstation';
        const source = genieSource(sender.workspaceId);
        const app: AppMessageMeta = { source, label: appSenderLabel(source, SYSTEM_WORKSPACE), subject: `not delivered to ${address}`, level: 'failure' };
        await this.#p.inbox.send({ from: appSenderId(source), to: message.from, text: `Your message to ${address} was not delivered: ${reason}`, app }).catch((error: unknown) => {
            this.#p.log(`cross-station: the sender could not be told: ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    #retryLater(station: string): void {
        if (this.#stopped || this.#p.mode() !== 'queue' || this.#timers.has(station)) return;
        const n = this.#tries.get(station) ?? 0;
        this.#tries.set(station, n + 1);
        const steps = this.#p.retryMs ?? RETRY_MS;
        const ms = steps[Math.min(n, steps.length - 1)]!;
        this.#timers.set(station, this.#schedule(ms, () => { this.#timers.delete(station); this.kick(station); }));
    }

    #pendingStations(): string[] {
        return [...new Set([...this.#p.inbox.outboundFor().map((m) => m.outbound!.station), ...this.#p.inbox.stationsOwedReceipts()])];
    }

    async #stationRows(): Promise<readonly StationRow[] | null> {
        if (this.#stations && this.#now() - this.#stations.at < (this.#p.stationsTtlMs ?? STATIONS_TTL_MS)) return this.#stations.rows;
        const rows = await this.#p.stations().catch(() => null);
        if (rows === null) return this.#stations?.rows ?? null;
        this.#stations = { rows, at: this.#now() };
        return rows;
    }

    // ---- receiving ----------------------------------------------------------------------------------------------------

    /** A call another of the owner's workstations made here; RemoteHost already admitted it and names its station. */
    async handle(method: string, arg: unknown, from: { readonly station: string }): Promise<unknown> {
        switch (method) {
            case 'xstation.roster':
                return { agents: rosterOf(this.#p.roster(), this.#p.slugs(), this.#p.asleep(), this.#p.sharedIdOf) };
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
        // DEFINITE (finding 1): the sender settles these; anything else thrown here it keeps and retries.
        if (target.kind !== 'one') {
            const why = this.#p.recipientRefusal?.(d.to) ?? null;
            throw new DefiniteRefusal('no-address', why ? `${d.to} on ${myWord}: ${why}` : `nobody at ${d.to} on ${myWord}`);
        }
        const record = records.find((r) => r.id === target.id)!;
        const entry = rosterOf([record], this.#p.slugs(), asleep, this.#p.sharedIdOf)[0];
        const answered = this.#p.inbox.hasWritten(record.id, sender);
        if (!answered && (!entry || !opensFrom(entry, d.from.shared))) throw new DefiniteRefusal('scope', `${d.to} on ${myWord} is not reachable from ${d.from.name}@${d.from.workspace}: its agent scope does not allow it (permission, not liveness)`);
        // Not capable of receiving now (the owner's rule): not taken, and NOT definite, so the sender keeps it and tries again.
        const cannot = this.#p.cannotReceive?.(record.id) ?? null;
        if (cannot) throw new Error(`${d.to} on ${myWord} cannot take mail right now: ${cannot}`);
        const stored = await this.#p.inbox.receiveFromStation({ station, stationName: fromRow?.name ?? station, id: d.id, from: sender, to: record.id as Participant, text: d.text, sentAt: d.sentAt }, this.#p.arrivalLimits);
        return { messageId: stored.message.id };
    }
}

function deliverArgOf(arg: unknown): DeliverArg {
    const a = (arg ?? {}) as Record<string, unknown>;
    const from = (a.from ?? {}) as Record<string, unknown>;
    const shared = from.shared === undefined || from.shared === null ? null : from.shared;
    const ok = typeof a.id === 'string' && a.id.length > 0 && a.id.length <= 100
        && typeof from.name === 'string' && SEGMENT.test(from.name) && typeof from.workspace === 'string' && SEGMENT.test(from.workspace)
        && (shared === null || (typeof shared === 'string' && shared.length > 0 && shared.length <= 200))
        && typeof a.to === 'string' && a.to.length <= 300 && typeof a.text === 'string' && a.text.length <= MAX_TEXT
        && typeof a.sentAt === 'string' && !Number.isNaN(Date.parse(a.sentAt));
    if (!ok) throw new Error('that is not a message this workstation takes');
    return { id: a.id as string, from: { name: from.name as string, workspace: from.workspace as string, shared: shared as string | null }, to: a.to as string, text: a.text as string, sentAt: a.sentAt as string };
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
