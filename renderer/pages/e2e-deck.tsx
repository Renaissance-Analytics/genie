import { useState } from 'react';
import { Deck } from '../components/Master/Deck';
import type { AgentSessionSpec, ListItemSpec, PendingQuestionSpec } from '../lib/genie';

/**
 * E2E harness for the DECK — Genie 2's landing surface. NOT product UI.
 *
 * ## Why this exists at all
 *
 * Every Genie 2 surface was unit-tested through `react-dom/server` and **had never
 * rendered in a real window**. 0 of 29 E2E specs touched the Deck, the Agent view or
 * Needs-You, and a green suite that does not execute the new code was used as evidence
 * that the work was finished. It was not evidence of anything.
 *
 * ## It mounts the REAL Deck
 *
 * Not rebuilt markup. The rule under test is a RELATIONSHIP — a row may only offer inline
 * answer buttons when answering inline is the WHOLE answer — and a harness that assembled
 * its own rows would keep passing after someone changed `Deck.tsx` to render the first
 * sub-question's buttons anyway. That is precisely the regression this guards.
 *
 * ## `.gwrap`
 *
 * Every colour token lives on `.gwrap` / `.genie-overlay-root`, not on `:root`
 * (master.css). Mounted outside that wrapper the bands render with unresolved tokens and a
 * visual assertion fails for a reason unrelated to the Deck — the genie#114 failure mode.
 *
 * Clicks are recorded on `window` so a spec can assert WHAT a row resolved to, not merely
 * that something was clickable.
 */

const NOW = 1_770_000_000_000;

/** One question that CAN be answered inline: a single part, with options. */
const single: PendingQuestionSpec = {
    id: 'q-single',
    index: 0,
    createdAt: NOW - 120_000,
    questions: [
        {
            header: 'Migrate or dual-write?',
            question: 'Which way for the pulse ring?',
            options: [{ label: 'Dual-write' }, { label: 'Migrate now' }],
        },
    ],
};

/**
 * One question that must NOT be answered inline: two parts.
 *
 * Answering the first would submit a PARTIAL answer and tell the agent the human had
 * decided everything. This is the row that must show "Open" and must not show `yes`/`no`.
 */
const multi: PendingQuestionSpec = {
    id: 'q-multi',
    index: 0,
    createdAt: NOW - 300_000,
    questions: [
        { header: 'A', question: 'first?', options: [{ label: 'yes' }] },
        { header: 'B', question: 'second?', options: [{ label: 'no' }] },
    ],
};

const sessions: readonly AgentSessionSpec[] = [];

/** A UserList item -- resolvable three ways, and NOT blocking: an agent carries on. */
const listItems: readonly ListItemSpec[] = [{ id: 'l1', text: 'Rotate the GH token', agentName: 'kai' }];

export default function E2EDeckPage() {
    const [log, setLog] = useState<string[]>([]);

    const record = (entry: string) => {
        setLog((l) => [...l, entry]);
        const w = window as unknown as { __DECK_CLICKS__?: string[] };
        w.__DECK_CLICKS__ = [...(w.__DECK_CLICKS__ ?? []), entry];
    };

    return (
        <div className="gwrap" style={{ height: '100vh', overflow: 'auto' }}>
            <Deck
                sessions={sessions}
                questions={[single, multi]}
                listItems={listItems}
                now={NOW}
                onAnswerOption={(id: string, label: string) => record(`answer:${id}:${label}`)}
                onOpenQuestion={(id: string) => record(`open:${id}`)}
                onResolveListItem={(id: string, action: string) => record(`resolve:${id}:${action}`)}
            />
            {/* A visible mirror of the click log, so a failure shows what DID happen. */}
            <div data-testid="deck-click-log" style={{ display: 'none' }}>
                {log.join('|')}
            </div>
        </div>
    );
}
