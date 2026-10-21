import type { LiveSession } from './roster.js';
import { editLineCounts, joinToolCalls, ledgerRow, type TimedEvent } from './stream-view.js';

/**
 * AN AGENT'S ACTIVITY FEED — what its lane on the workspace Dashboard draws (beta.33 item 10). No React, no Electron.
 *
 * The owner, 2026-10-20: *"this workspace dashboard is useless. Each agent should have a full lane that shows me a
 * heartbeat of activity. Not some stupid card that contains my msg … THINK BETTER."*
 *
 * Built by the HOST from the agent's real session rows — the ledger the Stream shows, with the times they arrived — and
 * pushed to the window when the session changes (main/activity-feeds.ts). The renderer only ever loads the on-screen
 * agent's ledger, so this is the one way a lane can be alive for every agent at once.
 *
 * ## Bounded
 *
 * A feed is the newest {@link FEED_ITEMS} things the agent did and {@link HEARTBEAT_MINUTES} minutes of beats — never
 * a second copy of the ledger. Building it reads the ledger from the END and stops as soon as it has what it needs.
 *
 * ## What is an item
 *
 * Edits (with their ± lines, from a real diff only), commands, other tool calls, replies, the prompts that started its
 * turns (yours or a peer's), turn ends (`finished` — a turn that ended with a reply, recorded by the session — and
 * `stopped`), approval decisions and warnings. Thoughts, usage reports, plan rewrites and markers are not items: the
 * plan has its own place on the lane, and the rest is noise at a glance. Every row still counts as a BEAT.
 */

export const FEED_ITEMS = 40;
export const HEARTBEAT_MINUTES = 30;
const MINUTE = 60_000;

export type FeedKind = 'edit' | 'command' | 'tool' | 'reply' | 'prompt' | 'finished' | 'stopped' | 'approval' | 'notice' | 'handoff';

export interface FeedItem {
    id: string;
    /** When it ARRIVED (the ledger's time); `null` = a row replayed from a thread that stored none. */
    at: number | null;
    kind: FeedKind;
    /** One line. */
    text: string;
    /** Who sent a prompt: `you`, or the peer's name. `null` on anything else. */
    by: string | null;
    /** An edit's line counts, from a real diff only; a zero side is `null`, never `+0`. */
    plus: number | null;
    minus: number | null;
    /** A call still running, or one that failed; `null` = done, or not reported. */
    status: 'running' | 'failed' | null;
}

/** Rows that arrived in one minute: `minute` is the epoch minute (`floor(at / 60000)`), so a feed slides with the clock. */
export interface FeedBeat {
    minute: number;
    n: number;
}

export interface FeedPlan {
    step: number;
    of: number;
    /** The step in progress; `null` when none is. */
    doing: string | null;
}

export interface ActivityFeed {
    agentId: string;
    /** It has a running session. `false` = stopped: what is drawn is its recorded history. */
    running: boolean;
    /** When its current state began (see {@link stateSince}); `null` = not known. */
    since: number | null;
    /** Its newest timed row; `null` = it has none. */
    lastAt: number | null;
    plan: FeedPlan | null;
    /** The last {@link HEARTBEAT_MINUTES} minutes that had activity, oldest first. */
    beats: readonly FeedBeat[];
    /** Newest first, at most {@link FEED_ITEMS}. */
    items: readonly FeedItem[];
}

/** Rows that say where a run or a window begins — Genie's markers, not something the agent did. */
const isMarker = (row: TimedEvent): boolean => row.event.kind === 'run' || row.event.kind === 'earlier';

const firstLine = (text: string): string => (text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '').slice(0, 200);

/** Diffs are an LCS each: computed once per edit's input, not once per push (the input object is kept through joins). */
const diffs = new WeakMap<object, ReturnType<typeof editLineCounts>>();
function diffOf(rawInput: unknown): ReturnType<typeof editLineCounts> {
    if (typeof rawInput !== 'object' || rawInput === null) return null;
    if (!diffs.has(rawInput)) diffs.set(rawInput, editLineCounts(rawInput));
    return diffs.get(rawInput) ?? null;
}

function commandOf(rawInput: unknown): string | null {
    if (typeof rawInput !== 'object' || rawInput === null) return null;
    const c = (rawInput as Record<string, unknown>)['command'];
    return typeof c === 'string' && c.trim() !== '' ? c.replace(/\s+/g, ' ').trim() : null;
}

function itemOf(row: TimedEvent): FeedItem | null {
    const e = row.event;
    const base = { id: row.id, at: row.at, by: null, plus: null, minus: null, status: null } as const;
    switch (e.kind) {
        case 'message': {
            const text = firstLine(e.text);
            if (text === '') return null;
            if (e.speaker === 'agent') return { ...base, kind: 'reply', text };
            return { ...base, kind: 'prompt', text, by: e.speaker === 'you' ? 'you' : e.peerName ?? 'peer' };
        }
        case 'tool': {
            const status = e.status === 'failed' ? 'failed' : e.status === 'pending' || e.status === 'in_progress' ? 'running' : null;
            if (e.toolKind === 'edit') {
                const diff = diffOf(e.rawInput);
                const line = ledgerRow(row, diff ? { diff } : {});
                return { ...base, kind: 'edit', text: line.main, plus: line.plus, minus: line.minus, status };
            }
            const command = e.toolKind === 'execute' ? commandOf(e.rawInput) : null;
            if (command !== null) return { ...base, kind: 'command', text: command, status };
            return { ...base, kind: e.toolKind === 'execute' ? 'command' : 'tool', text: ledgerRow(row).main, status };
        }
        case 'finished':
            return { ...base, kind: 'finished', text: `Turn ${e.n} finished` };
        case 'stopped':
            return { ...base, kind: 'stopped', text: e.by === null ? 'Stopped' : `Stopped by ${e.by}` };
        case 'approval':
            return { ...base, kind: 'approval', text: ledgerRow(row).main };
        case 'notice':
            return e.level === 'warning' || e.level === 'error' ? { ...base, kind: 'notice', text: firstLine(ledgerRow(row).main) } : null;
        default:
            return null;
    }
}

/** The latest plan the agent reported, or `null`. A plan Genie could not read is `null` — never a fabricated `0/0`. */
export function planFrom(rows: readonly TimedEvent[]): FeedPlan | null {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const event = rows[i]!.event;
        if (event.kind !== 'plan') continue;
        const steps = event.entries.flatMap((entry) => {
            if (typeof entry !== 'object' || entry === null) return [];
            const r = entry as Record<string, unknown>;
            return typeof r['content'] === 'string' && typeof r['status'] === 'string' ? [{ content: r['content'], status: r['status'] }] : [];
        });
        if (steps.length === 0) return null;
        const doing = steps.find((s) => s.status === 'in_progress');
        return { step: steps.filter((s) => s.status === 'completed').length, of: steps.length, doing: doing?.content ?? null };
    }
    return null;
}

/**
 * When the agent's CURRENT state began — what "Working 14m" on its lane counts from:
 *
 *  - waiting on you: when the question was parked;
 *  - broken: when the failure was recorded;
 *  - working: when its turn began (the latest turn marker) — not when the session started, which is what the roster's
 *    duration counts, and a session can be hours old on a turn a minute old;
 *  - idle: when its last turn ended (`finished` / `stopped`), else when the session started;
 *  - stopped (no session): its last activity.
 */
function stateSince(rows: readonly TimedEvent[], session: LiveSession | null, lastAt: number | null): number | null {
    if (session === null || !session.running) return lastAt;
    if (session.pendingApproval !== null) return session.parkedAt ?? null;
    if (session.failure !== null) return session.failure.at ?? null;
    const working = session.turnState === 'working';
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i]!;
        if (r.at === null) continue;
        if (working && r.event.kind === 'turn') return r.at;
        if (!working && (r.event.kind === 'finished' || r.event.kind === 'stopped')) return r.at;
    }
    return session.startedAt;
}

export function activityFeed(input: { agentId: string; rows: readonly TimedEvent[]; session: LiveSession | null; now: number }): ActivityFeed {
    const { rows, now } = input;
    const cutoff = Math.floor(now / MINUTE) - (HEARTBEAT_MINUTES - 1);

    // From the END: the beats of the last 30 minutes, and enough rows for the newest items — a tool call's updates are
    // several rows, so the slice keeps going until it holds FEED_ITEMS item rows of distinct calls, and a margin, so the
    // oldest call in it still has the frame that named it.
    const counts = new Map<number, number>();
    let lastAt: number | null = null;
    let start = rows.length;
    const seenCalls = new Set<string>();
    let itemRows = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i]!;
        const minute = r.at === null ? null : Math.floor(r.at / MINUTE);
        if (lastAt === null && r.at !== null && !isMarker(r)) lastAt = r.at;
        const inWindow = minute !== null && minute >= cutoff;
        if (inWindow && !isMarker(r)) counts.set(minute, (counts.get(minute) ?? 0) + 1);
        if (itemRows < FEED_ITEMS + 8) {
            start = i;
            const e = r.event;
            if (e.kind === 'tool' && e.toolCallId !== '') {
                if (!seenCalls.has(e.toolCallId)) { seenCalls.add(e.toolCallId); itemRows += 1; }
            } else if (itemOf(r) !== null) itemRows += 1;
        } else if (minute !== null && minute < cutoff) break;
    }

    const items: FeedItem[] = [];
    const joined = joinToolCalls(rows.slice(start));
    for (let i = joined.length - 1; i >= 0 && items.length < FEED_ITEMS; i -= 1) {
        const item = itemOf(joined[i]!);
        if (item) items.push(item);
    }

    return {
        agentId: input.agentId,
        running: input.session?.running === true,
        since: stateSince(rows, input.session, lastAt),
        lastAt,
        plan: planFrom(rows),
        beats: [...counts].sort((a, b) => a[0] - b[0]).map(([minute, n]) => ({ minute, n })),
        items,
    };
}

/** The heartbeat strip: {@link HEARTBEAT_MINUTES} bars, oldest first, read against the window's own clock. */
export function heartbeat(beats: readonly FeedBeat[], now: number): number[] {
    const last = Math.floor(now / MINUTE);
    const bars = new Array<number>(HEARTBEAT_MINUTES).fill(0);
    for (const b of beats) {
        const i = HEARTBEAT_MINUTES - 1 - (last - b.minute);
        if (i >= 0 && i < HEARTBEAT_MINUTES) bars[i] = (bars[i] ?? 0) + b.n;
    }
    return bars;
}
