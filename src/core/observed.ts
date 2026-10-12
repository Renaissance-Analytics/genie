import type { AgentRow } from './dashboard-view.js';
import type { AgentRecord } from './identity.js';

/**
 * OBSERVED — what Genie can honestly say about a TUI it opened via Take Over and does not
 * manage.
 *
 * It sees BYTES, and when they came. That is the whole of it. §4.1: *"For an Observed agent
 * this cell holds activity bars instead — a measurement, not a claim."* The vocabulary is
 * `Active` / `Quiet`, never `Working` / `Idle`, because "working" is a claim about intent that
 * a stream of bytes cannot support. Every field a declared agent reports — plan, target,
 * deliveries, comms, context, cost — is `null` here: not zero, not a dash. Genie cannot see
 * them (§5).
 *
 * Pure. `take-over-host.ts` does the measuring; this is the arithmetic and the row.
 */

/** One burst of output: when, and how much. */
export interface Burst {
    at: number;
    bytes: number;
}

/** What the Take Over host knows about one agent's TUI. */
export interface TakeOverProbe {
    terminalId: string;
    startedAt: number;
    /** `null` until the TUI has printed anything. */
    lastOutputAt: number | null;
    bursts: readonly Burst[];
}

/** Twelve bars — the board's number — each a 5-second bucket of the last minute. */
export const ACTIVITY_BARS = 12;
export const BUCKET_MS = 5_000;
/** The row is 16px tall (`h-4`); the busiest bucket fills it. */
export const BAR_HEIGHT_PX = 16;
/** Silence this long is `Quiet`. */
export const QUIET_AFTER_MS = 30_000;

/**
 * Bytes per bucket over the last minute, newest LAST so the eye reads left-to-right as time,
 * scaled so the busiest bucket is the full row height. All zeros when nothing came out — a
 * measured nothing, drawn; twelve absent bars would say "not watching".
 */
export function activityBars(bursts: readonly Burst[], now: number): readonly number[] {
    const buckets = Array.from({ length: ACTIVITY_BARS }, () => 0);
    const windowStart = now - ACTIVITY_BARS * BUCKET_MS;

    for (const burst of bursts) {
        if (burst.at <= windowStart || burst.at > now) continue;
        // Bucket 0 is the oldest; the newest burst lands in the last bucket.
        const index = Math.min(ACTIVITY_BARS - 1, Math.floor((burst.at - windowStart - 1) / BUCKET_MS));
        buckets[index] = (buckets[index] ?? 0) + burst.bytes;
    }

    const peak = Math.max(...buckets);
    if (peak === 0) return buckets;
    return buckets.map((b) => Math.round((b / peak) * BAR_HEIGHT_PX));
}

/** `active` with output in the last 30 s; `quiet` otherwise, including never. */
export function observedState(lastOutputAt: number | null, now: number): 'active' | 'quiet' {
    if (lastOutputAt === null) return 'quiet';
    return now - lastOutputAt <= QUIET_AFTER_MS ? 'active' : 'quiet';
}

function durationOf(startedAt: number, now: number): string {
    const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}

/**
 * The Dashboard row for an agent with a live Take Over.
 *
 * `working` / `idle` are the row's STATES — the board's vocabulary maps them to
 * `Active` / `Quiet` for `observed` fidelity (`statusOf` in `dashboard-view.ts`), so the dot is
 * green while bytes flow and grey when they stop, with the words a measurement can carry.
 */
export function observedRowFor(record: AgentRecord, probe: TakeOverProbe, now: number): AgentRow {
    const state = observedState(probe.lastOutputAt, now) === 'active' ? 'working' : 'idle';
    return {
        // Byte-identical to the record's id — the one identity rule.
        id: record.id,
        name: record.name,
        provider: record.provider,
        workspaceId: record.workspaceId,
        fidelity: 'observed',
        state,
        duration: state === 'working' ? durationOf(probe.startedAt, now) : null,
        ask: null,
        reason: null,
        fixes: [],
        step: null,
        target: null,
        activity: activityBars(probe.bursts, now),
        delivery: null,
        collaborators: null,
        commsAgeSeconds: null,
        contextUsed: null,
        contextSize: null,
    };
}

/** `12.1 kB` / `40 B` — the board's own unit for a burst. */
export function formatBytes(bytes: number): string {
    return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`;
}

export interface ActivityRow {
    at: number;
    bytes: number;
    /** `output burst · 12.1 kB` — the board's `pty` row. */
    label: string;
}

/**
 * The Activity tab's ledger: one row per burst, NEWEST FIRST — what Genie measured, and nothing it did not. No
 * bursts is an empty ledger (a measured nothing), never a placeholder row.
 */
export function activityLedger(bursts: readonly Burst[]): readonly ActivityRow[] {
    return bursts
        .slice()
        .sort((a, b) => b.at - a.at)
        .map((b) => ({ at: b.at, bytes: b.bytes, label: `output burst · ${formatBytes(b.bytes)}` }));
}

/** `last output 40s ago` / `last output 2m ago` / `no output yet` — never a dash. */
export function lastOutputLabel(lastOutputAt: number | null, now: number): string {
    if (lastOutputAt === null) return 'no output yet';
    const s = Math.max(0, Math.floor((now - lastOutputAt) / 1000));
    if (s < 60) return `last output ${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `last output ${m}m ago`;
    return `last output ${Math.floor(m / 60)}h ago`;
}
