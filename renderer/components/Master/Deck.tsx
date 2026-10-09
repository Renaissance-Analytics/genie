import type {
    AgentSessionSpec,
    ForceAnswerSpec,
    ListItemSpec,
    PendingQuestionSpec,
} from '../../lib/genie';
import { attentionItems } from '../../lib/attention-queue';
import { stationSignals, type StationFacts } from '../../lib/station-signals';
import { NeedsYou } from './NeedsYou';

/**
 * The DECK — "does anything need me?"
 *
 * ## It gave up its Agents band
 *
 * The spec board (`Genie v2 Spec Board.dc.html`) divides the two surfaces by the question
 * each answers: *"The Deck answers 'does anything need me?' It keeps Needs-you and the
 * signal strip, and gives up its Agents band. The Dashboard answers 'what is being
 * produced, and by whom?'"* — and *"Waiting rows on the Dashboard link to the Deck item and
 * are answered there. The Deck resolves; the Dashboard shows."*
 *
 * beta.1 shipped the Deck with that band still attached, AND made it the default. Both
 * surfaces then listed every agent, and the Deck's copy was the inert one: its rows were
 * bare `<div>`s with no handler, so the screen Genie opened on showed 24 agents and could
 * open none of them. The owner: *"I am fucking stuck on this damn screen. Nothing is
 * clicklable."*
 *
 * So the band is gone rather than fixed. Making those rows clickable would have left two
 * boards claiming the same subject, and the duplication was the design error — the
 * unreachability was only what made it visible.
 *
 * What remains is what the board says remains: the signal strip and Needs-you, which is
 * the one place an item is RESOLVED rather than reported.
 */

export interface DeckProps {
    /**
     * Still required, and not for a roster: `NeedsYou` prints an agent's NAME where a
     * question's `terminalId` is all the queue carries, and this is what resolves one.
     */
    sessions: readonly AgentSessionSpec[];
    /** Pending questions, already flattened across workspaces and hosts. */
    questions?: readonly PendingQuestionSpec[];
    /** UserList items across every workspace. */
    listItems?: readonly ListItemSpec[];
    now?: number;
    onAnswerOption?: (questionId: string, label: string) => void;
    onOpenQuestion?: (questionId: string) => void;
    /**
     * The WORKSTATION'S ambient facts — what the title-bar icons used to say at a glance.
     *
     * Owner decision, asked directly: *"move the signals to the Deck, then delete the icons."* P7's
     * "0 features lost" held for features and not for signals: an icon animated for a running Flow
     * and badged unread agent mail, and a ⌘K row cannot.
     *
     * Absent means the window cannot see the workstation — a remote one — and then nothing is
     * rendered rather than a claim that all is well.
     */
    signals?: StationFacts;
    /** Clicking a signal goes where the icon went. A badge you cannot act on is worse. */
    onSignal?: (featureId: string) => void;
    /** The row the keyboard is on — `J`/`K` move it. */
    focusedKey?: string | null;
    /** Which question's full-answer form is open — see `NeedsYou`. */
    expandedQuestionId?: string | null;
    onExpandQuestion?: (questionId: string | null) => void;
    onSubmitAnswer?: (questionId: string, answers: ForceAnswerSpec[]) => void;
    onResolveListItem?: (todoId: string, action: 'done' | 'thrown_back' | 'refused') => void;
}

export function Deck({
    sessions,
    questions = [],
    signals,
    onSignal,
    focusedKey = null,
    expandedQuestionId = null,
    onExpandQuestion,
    onSubmitAnswer,
    listItems = [],
    now = Date.now(),
    onAnswerOption,
    onOpenQuestion,
    onResolveListItem,
}: DeckProps): React.JSX.Element {
    // Resolve an agent NAME for a question from the sessions already on the board, so a
    // row can say "kai is blocked" rather than printing a terminal id. Null when nothing
    // names one — an internal approval gate has no asker, and attributing it to whichever
    // agent shares the workspace would blame one that is working fine.
    const nameForTerminal = (terminalId: string): string | null =>
        sessions.find((s) => s.specId === terminalId)?.session.name ?? null;

    const attention = attentionItems({ questions, listItems }, { agentNameFor: nameForTerminal });
    // SILENT unless something is true. `stationSignals` owns which and in what order.
    const strip = signals ? stationSignals(signals) : [];

    return (
        <div className="deck">
            {strip.length > 0 ? (
                <div className="deck-signals" data-testid="deck-signals">
                    {strip.map((signal) => (
                        <button
                            key={signal.id}
                            type="button"
                            className="deck-signal"
                            data-tone={signal.tone}
                            data-feature={signal.featureId}
                            onClick={() => onSignal?.(signal.featureId)}
                        >
                            {signal.label}
                        </button>
                    ))}
                </div>
            ) : null}

            <NeedsYou
                items={attention}
                questionsById={new Map(questions.map((q) => [q.id, q]))}
                now={now}
                onAnswerOption={onAnswerOption ?? (() => {})}
                onOpenQuestion={onOpenQuestion ?? (() => {})}
                focusedKey={focusedKey}
                expandedQuestionId={expandedQuestionId}
                {...(onExpandQuestion ? { onExpandQuestion } : {})}
                {...(onSubmitAnswer ? { onSubmitAnswer } : {})}
                onResolveListItem={onResolveListItem ?? (() => {})}
            />
        </div>
    );
}
