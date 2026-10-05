import { Badge, Card, Heading, Progress, Text } from '@particle-academy/react-fancy';
import type { AgentSessionSpec, ListItemSpec, PendingQuestionSpec } from '../../lib/genie';
import { deckView, type RosterRow, type RosterState } from '../../lib/deck-view';
import { attentionItems } from '../../lib/attention-queue';
import { NeedsYou } from './NeedsYou';

/**
 * The DECK — a cross-workspace answer to "does anything need me".
 *
 * Read-only for now. Everything with a rule in it lives in `lib/deck-view.ts` and is
 * tested there; this file is the render, deliberately thin, so the decisions are not
 * trapped in JSX where only an E2E shard can reach them.
 *
 * ## What it refuses to draw
 *
 * **Nothing in the cost or context cell when the session cannot see one.** Not a
 * dash — a dash in a money column reads as "nothing spent", which is a claim about
 * money made on the strength of a missing field. The absence is carried as `null`
 * through `deck-view` and ends here as an empty cell.
 *
 * **No greyed-out "Conversation" for an Observed agent.** A disabled control is an
 * accusation; a different shape is a fact. An agent Genie can only watch gets a row
 * that is complete for what it is, plus one quiet label saying so — the same
 * discipline `provider-brand.ts` already applies to logos.
 *
 * The state cell's TYPOGRAPHY carries the epistemology: a Declared agent's state is
 * text because it is a stated fact; an Observed agent's is a measurement, and the
 * label says which.
 */

/** How each state reads, and how loudly. */
const STATE_LABEL: Record<RosterState, string> = {
    'awaiting-you': 'awaiting you',
    working: 'working',
    stalled: 'not moving',
    idle: 'idle',
};

const STATE_COLOR: Record<RosterState, 'amber' | 'green' | 'red' | 'slate'> = {
    // Amber, not red: a blocked agent is not broken, it is waiting — and the person
    // reading this is the thing it is waiting for.
    'awaiting-you': 'amber',
    working: 'green',
    // Red is right here. "Not moving" is the state the product could not see before,
    // and it is the one that silently wastes the most time.
    stalled: 'red',
    idle: 'slate',
};

function since(now: number, at: number): string {
    const ms = Math.max(0, now - at);
    const mins = Math.floor(ms / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function RosterLine({ row, now }: { row: RosterRow; now: number }): React.JSX.Element {
    return (
        <div className="deck-row" data-state={row.state} data-fidelity={row.fidelity}>
            <Badge color={STATE_COLOR[row.state]} size="sm" dot>
                {STATE_LABEL[row.state]}
            </Badge>
            <Text size="sm" className="deck-row-name">
                {row.name}
            </Text>
            <Text size="xs" className="deck-row-provider">
                {/* An unresolvable provider says so rather than showing a blank, because
                    the repair is the point of the row. */}
                {row.provider ?? 'provider unknown'}
                {row.fidelity === 'observed' ? ' · terminal only' : ''}
            </Text>
            <Text size="xs" className="deck-row-since">
                {since(now, row.since)}
            </Text>
            <div className="deck-row-ctx">
                {row.context && row.context.used !== null && row.context.max !== null ? (
                    <>
                        <Progress value={row.context.used} max={row.context.max} size="sm" />
                        <Text size="xs">
                            {Math.round(row.context.used / 1000)}k/{Math.round(row.context.max / 1000)}k
                        </Text>
                    </>
                ) : null}
            </div>
            <Text size="xs" className="deck-row-cost">
                {/* Empty, not a dash. See the module comment. */}
                {row.costUsd === null ? '' : `$${row.costUsd.toFixed(2)}`}
            </Text>
            {row.error ? (
                <Badge color="red" size="sm">
                    {row.error}
                </Badge>
            ) : null}
        </div>
    );
}

export interface DeckProps {
    sessions: readonly AgentSessionSpec[];
    /** Pending questions, already flattened across workspaces and hosts. */
    questions?: readonly PendingQuestionSpec[];
    /** UserList items across every workspace. */
    listItems?: readonly ListItemSpec[];
    now?: number;
    onAnswerOption?: (questionId: string, label: string) => void;
    onOpenQuestion?: (questionId: string) => void;
    onResolveListItem?: (todoId: string, action: 'done' | 'thrown_back' | 'refused') => void;
}

export function Deck({
    sessions,
    questions = [],
    listItems = [],
    now = Date.now(),
    onAnswerOption,
    onOpenQuestion,
    onResolveListItem,
}: DeckProps): React.JSX.Element {
    const view = deckView(sessions, now);
    const f = view.figures;

    // Resolve an agent NAME for a question from the sessions already on the board, so a
    // row can say "kai is blocked" rather than printing a terminal id. Null when nothing
    // names one — an internal approval gate has no asker, and attributing it to whichever
    // agent shares the workspace would blame one that is working fine.
    const nameForTerminal = (terminalId: string): string | null =>
        sessions.find((s) => s.specId === terminalId)?.session.name ?? null;

    const attention = attentionItems({ questions, listItems }, { agentNameFor: nameForTerminal });

    return (
        <div className="deck">
            <NeedsYou
                items={attention}
                questionsById={new Map(questions.map((q) => [q.id, q]))}
                now={now}
                onAnswerOption={onAnswerOption ?? (() => {})}
                onOpenQuestion={onOpenQuestion ?? (() => {})}
                onResolveListItem={onResolveListItem ?? (() => {})}
            />
            <Card className="deck-band">
                <div className="deck-band-head">
                    {/* `as`, not `level` — Heading has no `level` prop, and because it
                        spreads HTMLAttributes a `level` would have type-checked and
                        rendered nothing at all. Same shape as genie#320, where an
                        unsupported prop was swallowed and no header was drawn. The prop
                        was read off the real signature rather than assumed.

                        (The earlier version of this comment QUOTED that issue's offending
                        JSX, and `modal-header-composition.test.ts` flagged this file as an
                        offender — its comment stripper does not handle a JSX block comment.
                        The guard is right to be blunt; the citation is reworded instead.) */}
                    <Heading as="h3" size="sm">
                        Agents
                    </Heading>
                    <Text size="xs">
                        {f.live} live · {f.needingYou} waiting on you
                        {/* Suppressed entirely when nothing can report it — a board that
                            says "0k ctx · $0.00" while unable to see either is guessing. */}
                        {f.contextUsed !== null ? ` · ${Math.round(f.contextUsed / 1000)}k ctx` : ''}
                        {f.costUsd !== null ? ` · $${f.costUsd.toFixed(2)}` : ''}
                    </Text>
                </div>

                {view.roster.length === 0 ? (
                    <div className="deck-empty">
                        <Text size="sm">No agents registered yet.</Text>
                        {/* An empty state says what to do next — house rule §5. */}
                        <Text size="xs">Add one from a workspace to see it here.</Text>
                    </div>
                ) : (
                    view.roster.map((row) => <RosterLine key={row.agentId} row={row} now={now} />)
                )}
            </Card>
        </div>
    );
}
