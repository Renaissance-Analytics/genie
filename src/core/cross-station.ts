import type { AgentRecord } from './identity.js';
import { SYSTEM_WORKSPACE } from './inbox.js';
import { isOsAgent } from './os-agent.js';

/**
 * MAIL BETWEEN WORKSTATIONS — the pure half (P9, Tynn #341/#424; the owner, 2026-11-25: "the only thing we need … is
 * shareable agents, working remote access, and x-station agent inbox").
 *
 * - An ADDRESS naming another station is `name@workspace@station`. `name@workspace` still means this host
 *   (core/inbox.ts `parseAddress` keeps refusing a third part, so a station address never resolves locally).
 * - A remote agent is a PARTICIPANT in this host's inbox: `peer:<station id>:<name>@<workspace>`. The station is Tynn's
 *   workstation id, which is what a grant proves (`src_ws`); its name is only how it is shown.
 * - The ROSTER a station offers another: every awake workspace's agents whose scope is not `none`, each with the
 *   workspaces a remote sender may open a conversation from.
 * - A host takes mail only from its OWNER'S OWN workstations in this slice: the grant's owner, with control, naming the
 *   workstation it came from. Guests and share links come with P9.3/P9.4.
 * - ONE SWITCH (`CrossStationMode`) decides whether mail to a station that does not answer waits and is retried
 *   (`queue`), or goes only while the person is connected between the two and is refused otherwise (`connected`, the
 *   O5 ruling's reading). The default is `CROSS_STATION_MAIL`.
 */

/**
 * One of the owner's workstations as Tynn lists it. `online: false` = Tynn says it is not connected now (absent = unknown).
 * `mine`: Tynn says THIS account registered it as its owner; only such a station is ever dialled (the review of #2180).
 */
export interface StationRow { readonly id: string; readonly name: string; readonly online?: boolean | null; readonly mine?: boolean }
/**
 * `opensFrom`: the SHARED workspaces (core `sharedWorkspaceId`, a Tynn project) whose agents may open a conversation with
 * this one, or `all`. Never slugs: the same slug on two stations is not the same workspace.
 */
export interface RosterEntry { readonly name: string; readonly workspace: string; readonly opensFrom: 'all' | readonly string[] }

/**
 * A DEFINITE REFUSAL by the receiving host (the review of #2180, finding 1): the only answers that settle a message for
 * good. `no-address`: nobody by that address there; `scope`: its agent scope does not open to the sender. Said on the wire
 * as the result's `code`, with `unsupported` (an older host). Anything else (a host still booting, a disk error, a lock)
 * is not definite: the sender keeps the mail and tries again.
 */
export type DefiniteCode = 'no-address' | 'scope';
export class DefiniteRefusal extends Error {
    constructor(readonly code: DefiniteCode, message: string) {
        super(message);
    }
}

/** A workspace's shared identity across stations: its Tynn project, as `tynn:<project id>`; `null` = linked to none. */
export function sharedWorkspaceId(tynnProjectId: string | null): string | null {
    return tynnProjectId ? `tynn:${tynnProjectId}` : null;
}
export type CrossStationMode = 'queue' | 'connected';

/** THE ONE SWITCH's default. `connected` delivers only while the person is connected between the two stations. */
export const CROSS_STATION_MAIL: CrossStationMode = 'queue';

/** The wire's methods (core/remote-protocol.ts CONTROL_METHODS), and the capability that says a host speaks them. */
export const CROSS_STATION_METHODS = ['xstation.roster', 'xstation.deliver', 'xstation.read'] as const;
export type CrossStationMethod = (typeof CROSS_STATION_METHODS)[number];
export const CAP_CROSS_STATION = 'cross-station';

export function isCrossStationMethod(method: string): method is CrossStationMethod {
    return (CROSS_STATION_METHODS as readonly string[]).includes(method);
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const PEER = /^peer:([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)$/;

export function parseStationAddress(text: string): { name: string; workspace: string; station: string } | null {
    const parts = text.split('@');
    if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return null;
    return { name: parts[0]!, workspace: parts[1]!, station: parts[2]! };
}

/** A workstation's name as an address word: lower case, runs of anything else one dash. */
function slugOf(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** How a station is said in an address: its name when it is the person's only workstation called that, else its id. */
export function stationWord(id: string, stations: readonly StationRow[]): string {
    const row = stations.find((s) => s.id === id);
    if (!row) return id;
    const word = slugOf(row.name);
    if (word === '' || !SEGMENT.test(word)) return id;
    return stations.filter((s) => slugOf(s.name) === word).length === 1 ? word : id;
}

/** The station an address word names: by id, or by a name only one workstation has. Ambiguous is nobody. */
export function findStation(word: string, stations: readonly StationRow[]): StationRow | null {
    const byId = stations.find((s) => s.id === word);
    if (byId) return byId;
    const named = stations.filter((s) => slugOf(s.name) === word.toLowerCase());
    return named.length === 1 ? named[0]! : null;
}

export function peerParticipant(station: string, name: string, workspace: string): `peer:${string}` {
    return `peer:${station}:${name}@${workspace}`;
}

export function readPeer(participant: string): { station: string; name: string; workspace: string } | null {
    const m = PEER.exec(participant);
    return m ? { station: m[1]!, name: m[2]!, workspace: m[3]! } : null;
}

export function isPeer(participant: string): boolean {
    return readPeer(participant) !== null;
}

/** A remote participant as the person and agents read it: `name@workspace@station`. `null` for anyone else. */
export function peerLabel(participant: string, stations: readonly StationRow[]): string | null {
    const p = readPeer(participant);
    return p ? `${p.name}@${p.workspace}@${stationWord(p.station, stations)}` : null;
}

/**
 * The agents another station's agents may reach here. A `self` or `specific` scope opens to its own workspace only, and
 * across stations its own workspace is its SHARED identity (`sharedIdOf`, its Tynn project): the same workspace on another
 * station is the same workspace only when it is the same shared one, never because the slugs match, and a workspace linked
 * to nothing matches nothing (the coordinator's ruling on the review of #2180). Chosen agents are ids of this host's agents
 * and do not cross. The OS agent's address workspace is `system`.
 */
export function rosterOf(records: readonly AgentRecord[], slugs: ReadonlyMap<string, string>, asleep: ReadonlySet<string>, sharedIdOf: (workspaceId: string) => string | null): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const r of records) {
        if (r.accessScope === 'none' || asleep.has(r.workspaceId)) continue;
        // The OS agent's address workspace is `system` (core/inbox.ts agentAddress), never its internal id.
        const workspace = isOsAgent(r) ? SYSTEM_WORKSPACE : slugs.get(r.workspaceId) ?? r.workspaceId;
        const shared = r.accessScope === 'all' ? null : sharedIdOf(r.workspaceId);
        out.push({ name: r.name, workspace, opensFrom: r.accessScope === 'all' ? 'all' : shared ? [shared] : [] });
    }
    return out;
}

/** Whether a sender from that SHARED workspace (`null`: linked to none) may open a conversation with this entry. */
export function opensFrom(entry: RosterEntry, senderShared: string | null): boolean {
    return entry.opensFrom === 'all' || (senderShared !== null && entry.opensFrom.includes(senderShared));
}

/** Why a connection may not hand this host mail, or `null` when it may. */
export function deliveryAdmission(c: { readonly isOwner: boolean; readonly readonly: boolean; readonly station?: string | null | undefined }): string | null {
    if (!c.isOwner) return "this workstation takes agent mail only from its owner's own workstations";
    if (c.readonly) return 'a read-only connection cannot hand this workstation mail';
    if (!c.station) return 'this connection does not say which of your workstations it comes from, so no mail is taken from it';
    return null;
}

/**
 * What a send to another station does. `try-then-queue`: delivered now if it answers, else kept and retried until it
 * does. `try-once`: delivered now or refused, nothing kept. `refuse`: not tried at all.
 */
export function sendPlan(mode: CrossStationMode, state: { readonly personConnected: boolean }): 'try-then-queue' | 'try-once' | 'refuse' {
    if (mode === 'queue') return 'try-then-queue';
    return state.personConnected ? 'try-once' : 'refuse';
}

/** The `connected` switch's refusal (P9.5's sentence). */
export function notConnectedWords(address: string, station: string): string {
    return `${address} is on ${station}. Mail between workstations works only while you are connected between this workstation and ${station}. Nothing was sent.`;
}
