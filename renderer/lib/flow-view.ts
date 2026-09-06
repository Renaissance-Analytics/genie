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
 * ## What used to be here
 *
 * A twelve-operator table and its negations, for printing the filter language
 * the recipe system carried. There is no filter language now: a condition is a
 * `branch` node on the canvas, and "why did this not fire" is answered by node
 * STATUSES on the graph — `<FlowViewer statuses={…}>` — rather than by prose
 * reconstructing a predicate. A picture of the run beats a sentence about it.
 */

import type { Color } from '@particle-academy/react-fancy';
import type { FlowRunStatus, FlowTriggerView } from './genie';

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
const OUTCOMES: Record<FlowRunStatus, OutcomeDescription> = {
    ran: { label: 'Ran', color: 'emerald' },
    failed: { label: 'Failed', color: 'rose' },
    blocked: { label: 'Held back', color: 'amber' },
    refused: { label: 'Refused', color: 'zinc' },
    handoff: { label: 'Needs you', color: 'blue' },
    error: { label: 'Misconfigured', color: 'orange' },
    running: { label: 'Running', color: 'blue' },
    // Genie stopped on top of it. Deliberately NOT "Failed": the Flow did not
    // fail, and a user reading that would go hunting for a bug in an automation
    // that never had one.
    interrupted: { label: 'Interrupted', color: 'amber' },
};

export function describeOutcome(outcome: FlowRunStatus): OutcomeDescription {
    // An outcome added to the runtime and not yet to this table shows its own
    // name rather than blanking the row — an unfamiliar word beats an empty cell.
    return OUTCOMES[outcome] ?? { label: String(outcome), color: 'zinc' };
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

/**
 * Whose Flows the manager is showing, when that is not obvious.
 *
 * A remote window drives another machine and every other surface in it is about
 * the HOST. The Flow Manager is not: `api().flows.*` is not routed over the
 * remote bridge, so it reads THIS workstation's flows, and `broadcastLocal`
 * skips host-bound windows, so no run activity from either machine reaches it.
 *
 * A panel that looks identical to the local case while being about a different
 * computer is worse than an unsupported feature — the user is not warned,
 * because nothing looks wrong. So the panel names the machine, every time, and
 * the host it is NOT showing.
 *
 * Returns `null` for a local window: that is the case where the panel means what
 * it appears to mean, and a caveat there would be noise that trains people to
 * skip the one that matters.
 */
export function describeFlowSource(opts: {
    remote: boolean;
    hostName?: string;
}): string | null {
    if (!opts.remote) return null;
    // The host is named where it is known. Where it is not — the status
    // round-trip may not have landed yet — the sentence still says which machine
    // these Flows belong to rather than falling silent and looking local.
    const host = opts.hostName ? `“${opts.hostName}”` : 'the machine this window is driving';
    return `These are this workstation's Flows, not ${host}'s. Flows are not yet read over a remote connection.`;
}

/**
 * One trigger, in words.
 *
 * Reads a trigger NODE, because that is where triggers live now. A trigger Genie
 * recognises but cannot arm says so where it is named — the difference between a
 * manager and a list is answering "why did this not happen" in the place you are
 * already looking.
 */
export function describeTrigger(trigger: FlowTriggerView): string {
    if (trigger.kind === 'manual') return 'When you run it';
    if (trigger.kind === 'schedule') {
        return trigger.cron ? `On a schedule (${trigger.cron})` : 'On a schedule — none set';
    }
    if (trigger.kind === 'event') {
        if (!trigger.event) return 'When something happens — nothing chosen';
        // Said where the trigger is NAMED. The difference between a manager and
        // a list is answering "why did this not happen" in the place you are
        // already looking.
        return trigger.known === false
            ? `${trigger.event} — nothing emits this any more`
            : `When ${trigger.event}`;
    }
    return trigger.unsupported ?? 'Webhook';
}

/** Every trigger, joined — enough for a list row. */
export function describeTriggers(triggers: readonly FlowTriggerView[]): string {
    if (triggers.length === 0) return 'No trigger';
    return triggers.map(describeTrigger).join(' · ');
}
