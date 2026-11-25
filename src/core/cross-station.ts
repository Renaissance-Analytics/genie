import type { AgentRecord } from './identity.js';

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

/** One of the owner's workstations as Tynn lists it. `online: false` = Tynn says it is not connected now (absent = unknown). */
export interface StationRow { readonly id: string; readonly name: string; readonly online?: boolean | null }
export interface RosterEntry { readonly name: string; readonly workspace: string; readonly opensFrom: 'all' | readonly string[] }
export type CrossStationMode = 'queue' | 'connected';

/** THE ONE SWITCH's default. `connected` delivers only while the person is connected between the two stations. */
export const CROSS_STATION_MAIL: CrossStationMode = 'queue';

/** The wire's methods (core/remote-protocol.ts CONTROL_METHODS), and the capability that says a host speaks them. */
export const CROSS_STATION_METHODS = ['xstation.roster', 'xstation.deliver', 'xstation.read'] as const;
export type CrossStationMethod = (typeof CROSS_STATION_METHODS)[number];
export const CAP_CROSS_STATION = 'cross-station';

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
 * The agents another station's agents may reach here. A `specific` scope names workspaces by THIS host's ids, which mean
 * nothing on another station, so it opens to its own workspace only; chosen agents are ids of this host's agents and do
 * not cross either. The OS agent's address workspace is `system`.
 */
export function rosterOf(records: readonly AgentRecord[], slugs: ReadonlyMap<string, string>, asleep: ReadonlySet<string>): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const r of records) {
        if (r.accessScope === 'none' || asleep.has(r.workspaceId)) continue;
        const workspace = slugs.get(r.workspaceId) ?? r.workspaceId;
        out.push({ name: r.name, workspace, opensFrom: r.accessScope === 'all' ? 'all' : [workspace] });
    }
    return out;
}

export function opensFrom(entry: RosterEntry, senderWorkspace: string): boolean {
    return entry.opensFrom === 'all' || entry.opensFrom.includes(senderWorkspace);
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
