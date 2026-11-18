import { CATALOG_SCHEMA_VERSION } from './catalog.js';
import { REMOTE_SCHEMA } from './remote-protocol.js';

/**
 * TWO-WAY PROTOCOL VERSIONING (Tynn #894). Pure. The owner's rulings of 2026-11-18:
 *
 * - Clients are dumb terminals; client and host update INDEPENDENTLY, so the wire works across versions both ways.
 * - Every TRACK (client, host, launcher, browser) numbers its own builds: `<schema>-<release>[.<hotfix>]`, the schema a
 *   date (`2026.11.18-1`; a hotfix is `-1.1` unless the schema changes). The SCHEMA is the protocol's version.
 * - The support window is FIXED: each side accepts a peer whose schema is no older than its own minus
 *   SUPPORT_WINDOW_DAYS. A security fix may raise that floor (SECURITY_FLOOR_SCHEMA), never lower it.
 * - The client detects a host to update and triggers its update; outside the window that is all the pair can do.
 * - Several people may be connected at once (conference mode): an offer and its negotiation are per connection.
 *
 * Each side says an OFFER (track, build, schema, the floor it accepts, capabilities): the client in `hello`, the host in
 * `welcome`. BOTH run `negotiate` over the two and reach the same answer without a third message.
 *
 * CAPABILITIES ARE THE ADF CATALOG'S VERSIONS (spec .ai/plans/specs/adf-sdk.md). A capability is `name@level`; a side
 * that says `x@3` speaks levels 1..3 of x and the pair uses the lower. The catalog's envelope is
 * `catalog@<CATALOG_SCHEMA_VERSION>`, and an element that crosses the wire is `<element id>@<its version's major>`. A
 * change within a level is additive; a change the other side cannot read raises the level, or comes with a new schema.
 */

export const TRACKS = ['client', 'host', 'launcher', 'browser'] as const;
export type Track = (typeof TRACKS)[number];

export interface ProtocolOffer {
    /** `null`: the peer did not say (an older Genie). */
    readonly track: Track | null;
    readonly build: string | null;
    readonly schema: string;
    /** The oldest schema this side accepts from the other: its window's floor. */
    readonly minSchema: string;
    readonly capabilities: readonly string[];
}

export interface Negotiated {
    /** The older of the two schemas: what the pair speaks. */
    readonly schema: string;
    /** Sorted, `name@level` at the lower of the two levels. */
    readonly capabilities: readonly string[];
}

export type Negotiation =
    | { readonly ok: true; readonly negotiated: Negotiated }
    /** `peerTooOld`: the other side is older than my window; otherwise my schema is older than its window. */
    | { readonly ok: false; readonly code: 'version'; readonly peerTooOld: boolean; readonly reason: string };

/** The fixed support window, in days of schema (the owner, 2026-11-18: FIXED). */
export const SUPPORT_WINDOW_DAYS = 30;
/**
 * THE SECURITY FLOOR: no schema older than this is accepted, whatever the window says. Raise it for a fix an older side
 * must not be allowed to bypass. The epoch accepts everything the window does.
 */
export const SECURITY_FLOOR_SCHEMA = '0000.01.01';

/** The wire as it was before Tynn #894 (protocol 1, beta.64 and older), said by a peer that says no schema. */
export const LEGACY_SCHEMA = '2026.11.01';
export const LEGACY_OFFER: ProtocolOffer = Object.freeze({ track: null, build: null, schema: LEGACY_SCHEMA, minSchema: SECURITY_FLOOR_SCHEMA, capabilities: Object.freeze([]) as readonly string[] });

/** An id'd `result` with `code: 'unsupported'` answers a call to a method this side does not know (never a bare refusal). */
export const CAP_UNSUPPORTED_RESULT = 'unsupported-result';
/** The ADF catalog's envelope (`catalog.ts` `CATALOG_SCHEMA_VERSION`). */
export const CAP_CATALOG = 'catalog';

export const MAX_CAPABILITIES = 256;
const MAX_CAPABILITY_LENGTH = 128;
const CAPABILITY = /^([a-z0-9][a-z0-9._-]*)@([1-9][0-9]{0,5})$/i;
const SCHEMA = /^(\d{4})\.(\d{2})\.(\d{2})$/;
const BUILD = /^(\d{4}\.\d{2}\.\d{2})-([1-9]\d{0,5})(?:\.(\d{1,6}))?$/;

/** A schema is a real calendar date written `YYYY.MM.DD` (zero-padded, so schemas order as strings). */
export function isSchema(text: unknown): text is string {
    if (typeof text !== 'string') return false;
    if (text === SECURITY_FLOOR_SCHEMA) return true; // the epoch: "no floor"
    const m = SCHEMA.exec(text);
    if (!m) return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    return y >= 2000 && date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function schemaMinusDays(schema: string, days: number): string {
    const m = SCHEMA.exec(schema);
    if (!m) throw new Error(`not a schema: ${schema}`);
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - days * 86_400_000);
    const pad = (n: number, w: number) => String(n).padStart(w, '0');
    return `${pad(date.getUTCFullYear(), 4)}.${pad(date.getUTCMonth() + 1, 2)}.${pad(date.getUTCDate(), 2)}`;
}

/** The fixed window's floor for `schema`: SUPPORT_WINDOW_DAYS back, or the security floor when that is newer. */
export function windowFloor(schema: string, securityFloor: string = SECURITY_FLOOR_SCHEMA): string {
    const window = schemaMinusDays(schema, SUPPORT_WINDOW_DAYS);
    return securityFloor > window ? securityFloor : window;
}

/** A track's build: `2026.11.18-1` → schema, release 1, hotfix 0; `-1.1` is hotfix 1. `null` for anything else. */
export function parseTrackBuild(build: string): { schema: string; release: number; hotfix: number } | null {
    const m = BUILD.exec(build.split('+')[0]!.trim());
    if (!m || !isSchema(m[1])) return null;
    return { schema: m[1]!, release: Number(m[2]), hotfix: m[3] === undefined ? 0 : Number(m[3]) };
}

/** Order of two track builds: schema, then release, then hotfix. A build that is not a track build sorts first. */
export function compareTrackBuilds(a: string, b: string): number {
    const x = parseTrackBuild(a);
    const y = parseTrackBuild(b);
    if (!x || !y) return x ? 1 : y ? -1 : 0;
    if (x.schema !== y.schema) return x.schema < y.schema ? -1 : 1;
    return x.release - y.release || x.hotfix - y.hotfix;
}

export function capability(name: string, level: number): string {
    return `${name}@${level}`;
}

export function parseCapability(text: string): { name: string; level: number } | null {
    if (text.length > MAX_CAPABILITY_LENGTH) return null;
    const m = CAPABILITY.exec(text);
    return m ? { name: m[1]!, level: Number(m[2]) } : null;
}

export function catalogCapability(): string {
    return capability(CAP_CATALOG, CATALOG_SCHEMA_VERSION);
}

/** An ADF element as a capability: its id at its version's major (a major of 0 is level 1; a level is never 0). */
export function elementCapability(element: { readonly id: string; readonly version: string }): string {
    const major = Number.parseInt(element.version, 10);
    return capability(element.id, Number.isInteger(major) && major > 0 ? major : 1);
}

/**
 * What a host's catalog offers a client: every element a client draws or links to (`side` client or both), at its
 * version's major. Host-only elements never cross the wire, so they are not offered. Sorted, deduplicated.
 */
export function catalogCapabilities(definitions: Iterable<{ readonly id: string; readonly version: string; readonly reach: { readonly side: string } }>): string[] {
    const out = new Set<string>();
    for (const d of definitions) if (d.reach.side !== 'host') out.add(elementCapability(d));
    return [...out].sort();
}

/**
 * An offer read from a `hello` or a `welcome`, defensively. No schema (or not a real date) is the legacy wire; a floor
 * missing, bad or newer than its own schema is not believed past the schema; a track that is not one of TRACKS is
 * unknown; capabilities that are not `name@level` are dropped, at most MAX_CAPABILITIES kept. Never throws.
 */
export function offerOf(frame: { readonly track?: unknown; readonly build?: unknown; readonly schema?: unknown; readonly minSchema?: unknown; readonly capabilities?: unknown }): ProtocolOffer {
    const track = typeof frame.track === 'string' && (TRACKS as readonly string[]).includes(frame.track) ? frame.track as Track : null;
    const build = typeof frame.build === 'string' && frame.build.trim() !== '' ? frame.build : null;
    if (!isSchema(frame.schema) || frame.schema === SECURITY_FLOOR_SCHEMA) return { ...LEGACY_OFFER, track, build };
    const schema = frame.schema;
    const minSchema = isSchema(frame.minSchema) ? (frame.minSchema > schema ? schema : frame.minSchema) : SECURITY_FLOOR_SCHEMA;
    const capabilities: string[] = [];
    if (Array.isArray(frame.capabilities)) {
        for (const c of frame.capabilities) {
            if (capabilities.length >= MAX_CAPABILITIES) break;
            if (typeof c === 'string' && parseCapability(c)) capabilities.push(c);
        }
    }
    return { track, build, schema, minSchema, capabilities };
}

function levels(offer: ProtocolOffer): Map<string, number> {
    const map = new Map<string, number>();
    for (const c of offer.capabilities) {
        const p = parseCapability(c);
        if (p) map.set(p.name, Math.max(map.get(p.name) ?? 0, p.level));
    }
    return map;
}

/** Inside both windows → the older schema and the shared capabilities; otherwise why, naming both schemas. Symmetric. */
export function negotiate(mine: ProtocolOffer, theirs: ProtocolOffer): Negotiation {
    if (theirs.schema < mine.minSchema) {
        return { ok: false, code: 'version', peerTooOld: true, reason: `the other side speaks schema ${theirs.schema}, older than this side's support window (from ${mine.minSchema}). Update it.` };
    }
    if (mine.schema < theirs.minSchema) {
        return { ok: false, code: 'version', peerTooOld: false, reason: `this side speaks schema ${mine.schema}, older than the other side's support window (from ${theirs.minSchema}). Update this side.` };
    }
    const a = levels(mine);
    const b = levels(theirs);
    const both: string[] = [];
    for (const [name, level] of a) {
        const other = b.get(name);
        if (other !== undefined) both.push(capability(name, Math.min(level, other)));
    }
    both.sort();
    return { ok: true, negotiated: { schema: mine.schema < theirs.schema ? mine.schema : theirs.schema, capabilities: both } };
}

/** Did the pair agree on `name` at `level` or above? */
export function supports(negotiated: Negotiated | null | undefined, name: string, level = 1): boolean {
    if (!negotiated) return false;
    for (const c of negotiated.capabilities) {
        const p = parseCapability(c);
        if (p && p.name === name && p.level >= level) return true;
    }
    return false;
}

/** What a client knows of its host's version (on the welcome, and whenever it asks again). */
export interface HostUpdateView {
    /** The host's schema is older than this client's: the client offers its update. */
    readonly needed: boolean;
    /** Inside both windows: everything works meanwhile. `false`: only `host.version` and `host.update` do. */
    readonly compatible: boolean;
    readonly hostSchema: string;
    readonly hostBuild: string | null;
    readonly hostMinSchema: string;
    readonly windowDays: number;
}

export function hostUpdate(client: ProtocolOffer, host: ProtocolOffer): HostUpdateView {
    const compatible = negotiate(client, host).ok;
    return { needed: host.schema < client.schema, compatible, hostSchema: host.schema, hostBuild: host.build, hostMinSchema: host.minSchema, windowDays: SUPPORT_WINDOW_DAYS };
}

/** What a host answers to `host.update` (the launcher wires it in a later step; until then the port is a stub). */
export interface HostUpdateAnswer {
    readonly started: boolean;
    readonly reason: string;
    /** The answer came from the stub: nothing was asked of a launcher. */
    readonly stub?: true;
}

/** The capabilities this build speaks on the remote wire, whichever side it is. */
export function remoteCapabilities(): string[] {
    return [capability(CAP_UNSUPPORTED_RESULT, 1), catalogCapability()];
}

/** This build's offer on `track`: the wire's schema, the fixed window's floor, its capabilities and any a caller adds. */
export function remoteOffer(track: Track, build: string | null = null, extra: readonly string[] = []): ProtocolOffer {
    const caps = [...remoteCapabilities()];
    for (const c of extra) if (parseCapability(c) && !caps.includes(c)) caps.push(c);
    return { track, build, schema: REMOTE_SCHEMA, minSchema: windowFloor(REMOTE_SCHEMA), capabilities: caps.slice(0, MAX_CAPABILITIES) };
}
