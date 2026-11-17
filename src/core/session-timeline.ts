import { laneSummary, type Lane } from './lanes.js';
import { FACETS, LANES, activityRows, facetsOf, type Facet, type StreamFilter, type TimedEvent } from './stream-view.js';

/**
 * THE CHIPS ROW (the board's `Agent View`): the lane filter as the board draws it —
 * `All 412 · Thoughts 61 · Tools 288 · Edits 17` — with All on when nothing is filtered.
 *
 * The SESSION timeline strip that was modelled here went in beta.64; the agent pulse (`agent-pulse.ts`) replaced it.
 */

export interface Chip {
    id: 'all' | StreamFilter;
    label: string;
    /** A measured count — a zero is kept. */
    n: number;
    on: boolean;
}

const LABEL: Record<Lane, string> = { messages: 'Messages', thoughts: 'Thoughts', tools: 'Tools', edits: 'Edits' };
const FACET_LABEL: Record<Facet, string> = { usage: 'Usage', approvals: 'Approvals', errors: 'Errors' };

/**
 * `All 412 · Messages 14 · Thoughts 61 · Tools 288 · Edits 17 · Usage 9 · Errors 2`. The facet counts are measured
 * over the same rows (a zero is a fact: a turn with no failures has none). No Approvals chip — see `FACETS`.
 */
export function chipRow(rows: readonly TimedEvent[], selected: readonly StreamFilter[] | null): readonly Chip[] {
    // Over the ACTIVITY rows — what the Stream shows; replies live in the chat, so there is no Messages chip.
    const activity = activityRows(rows);
    const counts = laneSummary(activity).counts;
    const facetCounts: Record<Facet, number> = { usage: 0, approvals: 0, errors: 0 };
    for (const row of activity) for (const facet of facetsOf(row.event)) facetCounts[facet] += 1;
    return [
        { id: 'all', label: 'All', n: activity.length, on: selected === null },
        ...LANES.filter((lane) => lane !== 'messages').map((lane): Chip => ({ id: lane, label: LABEL[lane], n: counts[lane], on: selected !== null && selected.includes(lane) })),
        ...FACETS.map((facet): Chip => ({ id: facet, label: FACET_LABEL[facet], n: facetCounts[facet], on: selected !== null && selected.includes(facet) })),
    ];
}
