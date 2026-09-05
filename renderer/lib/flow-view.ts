/**
 * The sentences the Flow Manager prints.
 *
 * A manager for an automation system exists to answer one question — why did, or
 * did not, this happen — so its strings are the feature rather than decoration
 * on it. A row that shows `files:added` and a raw epoch has sent the user to the
 * database instead of answering.
 *
 * Kept out of the component for two reasons: the wording is then pinned by a
 * test that needs no DOM, and the list and the run-history drawer cannot drift
 * into describing the same run two different ways.
 *
 * ## Values are printed, not converted
 *
 * `5242880` renders as `5,242,880`, not `5 MB`. The event registry declares a
 * prop's TYPE and never its units, so a byte-aware formatter would be guessing
 * from the key name — and would eventually be wrong about a prop called
 * `sizeBytes` that holds something else. Precise beats clever here.
 */

import type { Color } from '@particle-academy/react-fancy';
import type { FlowRunOutcome, FlowSummaryClause, FlowSummaryTrigger } from './genie';

export interface OutcomeDescription {
    label: string;
    /** A Fancy `Badge` colour — the real union, so a typo is a type error
     *  rather than a badge that silently renders with no colour at all. */
    color: Color;
}

/**
 * Only `ran` is green.
 *
 * `blocked`, `refused` and `handoff` are not failures — they are the system
 * declining to act, often correctly — but none of them is a Flow that did its
 * job, and colouring them like one turns the column into decoration. The wording
 * keeps the same distinction: nothing here implies a body ran when it did not.
 */
const OUTCOMES: Record<FlowRunOutcome, OutcomeDescription> = {
    ran: { label: 'Ran', color: 'emerald' },
    failed: { label: 'Failed', color: 'rose' },
    blocked: { label: 'Held back', color: 'amber' },
    refused: { label: 'Refused', color: 'zinc' },
    handoff: { label: 'Needs you', color: 'blue' },
    error: { label: 'Misconfigured', color: 'orange' },
};

export function describeOutcome(outcome: FlowRunOutcome): OutcomeDescription {
    // An outcome added to the runtime and not yet to this table shows its own
    // name rather than blanking the row — an unfamiliar word beats an empty cell.
    return OUTCOMES[outcome] ?? { label: String(outcome), color: 'zinc' };
}

/** Everything except a clean run is worth the user's eye. */
export function runIsInteresting(outcome: FlowRunOutcome): boolean {
    return outcome !== 'ran';
}

const OPS: Record<string, string> = {
    eq: 'is',
    ne: 'is not',
    gt: 'is over',
    gte: 'is at least',
    lt: 'is under',
    lte: 'is at most',
    matches: 'matches',
    startsWith: 'starts with',
    endsWith: 'ends with',
    contains: 'contains',
    in: 'is one of',
    notIn: 'is not one of',
};

/** The negated reading of each operator, for a `none` clause. */
const NEGATED_OPS: Record<string, string> = {
    eq: 'is not',
    ne: 'is',
    gt: 'is not over',
    gte: 'is under',
    lt: 'is not under',
    lte: 'is over',
    matches: 'does not match',
    startsWith: 'does not start with',
    endsWith: 'does not end with',
    contains: 'does not contain',
    in: 'is not one of',
    notIn: 'is one of',
};

function quote(value: string | number | boolean): string {
    return typeof value === 'string' ? `“${value}”` : String(value);
}

function printValue(value: FlowSummaryClause['value']): string {
    if (Array.isArray(value)) return value.map(quote).join(', ');
    if (typeof value === 'number') return value.toLocaleString('en-US');
    return quote(value as string | boolean);
}

/**
 * One condition, in words.
 *
 * A `none` clause is NEGATED rather than prefixed, because the reference Flow
 * reads "over 5 MB, but not already in the folder we move it to" — printing that
 * second clause as though it were an `all` inverts what the Flow does, which is
 * the one mistake a description like this must never make.
 */
export function describeClause(clause: FlowSummaryClause): string {
    const negate = clause.group === 'none';
    const op =
        (negate ? NEGATED_OPS[clause.op] : OPS[clause.op]) ??
        (negate ? `does not ${clause.op}` : clause.op);
    const body = `${clause.propLabel} ${op} ${printValue(clause.value)}`;
    // "or" marks a clause as one alternative among several rather than another
    // requirement — `any` is a disjunction and reads wrong without it.
    return clause.group === 'any' ? `or ${body}` : body;
}

export function describeTrigger(trigger: FlowSummaryTrigger): string {
    if (trigger.kind === 'manual') return 'When you run it';
    if (!trigger.known) {
        // The Flow looks armed and cannot fire. Saying so where the trigger is
        // named is the difference between a manager and a list.
        return `${trigger.eventLabel} — nothing emits this any more`;
    }
    if (trigger.clauses.length === 0) return trigger.eventLabel;
    const n = trigger.clauses.length;
    return `${trigger.eventLabel}, with ${n} condition${n === 1 ? '' : 's'}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
    return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/**
 * When something happened, relative to now.
 *
 * A future timestamp reads as "just now" rather than a negative age: the run's
 * clock is the main process's and the renderer's is its own, and a few
 * milliseconds of skew must not produce "in -3 seconds".
 */
export function relativeTime(at: number, now: number = Date.now()): string {
    const ago = now - at;
    if (ago < MINUTE) return 'just now';
    if (ago < HOUR) return plural(Math.floor(ago / MINUTE), 'minute');
    if (ago < DAY) return plural(Math.floor(ago / HOUR), 'hour');
    if (ago < 2 * DAY) return 'yesterday';
    if (ago < 30 * DAY) return plural(Math.floor(ago / DAY), 'day');
    // Past the point where "63 days ago" tells anyone anything useful.
    return new Date(at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}
