import { useEffect, useState } from 'react';
import { Badge, Button, Card, Heading, Text, Textarea } from '@particle-academy/react-fancy';
import type { AttentionItem } from '../../lib/attention-queue';
import type { PendingQuestionSpec } from '../../lib/genie';
import { inlineAnswerable } from '../../lib/attention-actions';
import {
    answerIsComplete,
    answerableOnDeck,
    blankAnswerState,
    buildAnswer,
    type AnswerState,
} from '../../lib/question-answer';
import type { ForceAnswerSpec } from '../../lib/genie';

/**
 * NEEDS YOU — everything waiting on a human, ranked, resolvable without navigating.
 *
 * Being asked a question and being asked to *do* something are one human intention,
 * currently served by two surfaces with their own buttons and badges, reachable only by
 * noticing a glow and guessing which of twelve flyouts explains it.
 *
 * ## The rule this component is built around
 *
 * **A row only offers an inline answer when answering inline is the WHOLE answer.**
 *
 * A ForceTheQuestion can carry up to four sub-questions. Rendering the first one's
 * buttons would submit a partial answer and tell the agent the human had decided, so the
 * rest of the decision is lost and nothing says so. `inlineAnswerable` owns that decision
 * and is tested.
 *
 * ## ...and the row that cannot answer in one click now answers in FULL, here
 *
 * It used to offer "Open", which sent the person to `QuestionInboxFlyout` to do the same job
 * on another surface. Two ways to do one thing is the duplication P7 exists to remove — and
 * the plan's claim that the flyout is *"chrome only — all logic kept"* was measurably wrong:
 * it was the ONLY surface that could answer a multi-part, multi-select or free-text question,
 * so deleting it as written would have stranded all three.
 *
 * So those rows EXPAND into a form. `renderer/lib/question-answer.ts` owns every decision in
 * it — what is answerable, what counts as complete, and the refusal to send a partial — and
 * is tested without a DOM.
 *
 * One thing is still refused: a FORWARDED question (`remoteHost`) is answered on its own
 * host, because resolving the local copy would mark it done here while the real one waits
 * forever on the machine that asked. That keeps "Open".
 *
 * Expansion is a PROP, not internal state, so the expanded shape is assertable at all: the
 * renderer's test environment has no DOM and cannot click.
 */

export interface NeedsYouProps {
    items: readonly AttentionItem[];
    /** The pending questions, by id, so a row can render its actual options. */
    questionsById: ReadonlyMap<string, PendingQuestionSpec>;
    now?: number;
    onAnswerOption: (questionId: string, label: string) => void;
    onOpenQuestion: (questionId: string) => void;
    onResolveListItem: (todoId: string, action: 'done' | 'thrown_back' | 'refused') => void;
    /**
     * The row the KEYBOARD is on — `J`/`K` move it (`moveQueueFocus`).
     *
     * A cursor nobody can see is worse than no cursor, because the next keystroke acts on it.
     */
    focusedKey?: string | null;
    /** Which question's answer form is open. Controlled, so it is testable. */
    expandedQuestionId?: string | null;
    onExpandQuestion?: (questionId: string | null) => void;
    /** A COMPLETE answer, every part present. `buildAnswer` refuses to produce a partial. */
    onSubmitAnswer?: (questionId: string, answers: ForceAnswerSpec[]) => void;
}

function age(now: number, at: number | null): string {
    // Null means the host did not say — render nothing rather than a guessed age.
    if (at === null) return '';
    const mins = Math.floor(Math.max(0, now - at) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function NeedsYou({
    items,
    questionsById,
    now = Date.now(),
    onAnswerOption,
    onOpenQuestion,
    onResolveListItem,
    focusedKey = null,
    expandedQuestionId = null,
    onExpandQuestion,
    onSubmitAnswer,
}: NeedsYouProps): React.JSX.Element {
    const expanded = expandedQuestionId ? questionsById.get(expandedQuestionId) : undefined;
    /**
     * One slot per PART, so a multi-part question cannot answer only half.
     *
     * Reset when the expanded question changes, and keyed on its id rather than its position:
     * a question answered elsewhere while this one was open shifts every index, and a state
     * carried across would answer the question that took its place.
     */
    const [draft, setDraft] = useState<AnswerState[]>(() =>
        expanded ? blankAnswerState(expanded) : [],
    );
    useEffect(() => {
        setDraft(expanded ? blankAnswerState(expanded) : []);
    }, [expandedQuestionId, expanded]);

    const complete = !!expanded && answerIsComplete(expanded, draft);

    const toggle = (partIndex: number, label: string, multi: boolean): void => {
        setDraft((prev) =>
            prev.map((slot, i) => {
                if (i !== partIndex) return slot;
                const has = slot.selected.includes(label);
                if (!multi) return { ...slot, selected: has ? [] : [label] };
                return {
                    ...slot,
                    selected: has
                        ? slot.selected.filter((l) => l !== label)
                        : [...slot.selected, label],
                };
            }),
        );
    };

    const send = (): void => {
        if (!expanded) return;
        const answers = buildAnswer(expanded, draft);
        // Null means "do not send this" — a partial, a forwarded question, or a selection that
        // is not on offer. Every one of those is worse sent than withheld.
        if (!answers) return;
        onSubmitAnswer?.(expanded.id, answers);
        onExpandQuestion?.(null);
    };

    return (
        <Card className="deck-band">
            <div className="deck-band-head">
                <Heading as="h3" size="sm">
                    Needs you
                </Heading>
                <Text size="xs">{items.length === 0 ? 'nothing waiting' : `${items.length} waiting`}</Text>
            </div>

            {items.length === 0 ? (
                <div className="deck-empty">
                    <Text size="sm">Nothing is waiting on you.</Text>
                    {/* An empty state says what it means, not just that it is empty. */}
                    <Text size="xs">Questions, list items and blocked agents appear here.</Text>
                </div>
            ) : (
                items.map((item) => {
                    const question = item.kind === 'question' ? questionsById.get(item.key.slice('question:'.length)) : undefined;
                    const canAnswerInline = question ? inlineAnswerable(question) : false;
                    return (
                        <div
                            className="needs-row"
                            key={item.key}
                            data-kind={item.kind}
                            // Only the row that IS focused carries the attribute. A `false`
                            // written on every other row is three more things for a selector to
                            // get wrong, and the CSS only ever asks about the true case.
                            {...(focusedKey === item.key ? { 'data-focused': 'true' } : {})}
                        >
                            <div className="needs-row-head">
                                {item.blocking ? (
                                    <Badge color="amber" size="sm" dot>
                                        blocking
                                    </Badge>
                                ) : null}
                                <Text size="sm" className="needs-row-title">
                                    {item.title}
                                </Text>
                                <Text size="xs" className="needs-row-meta">
                                    {/* Only what is known. An absent agent or workspace renders
                                        nothing rather than a placeholder. */}
                                    {[item.agentName, item.workspaceLabel, age(now, item.createdAt)]
                                        .filter((p) => !!p)
                                        .join(' · ')}
                                    {item.deferralReason ? ` · ${item.deferralReason}` : ''}
                                    {item.remoteHost ? ` · from ${item.remoteHost}` : ''}
                                </Text>
                            </div>

                            <div className="needs-row-actions">
                                {item.kind === 'question' && canAnswerInline && question
                                    ? question.questions[0]!.options.map((o) => (
                                          <Button
                                              key={o.label}
                                              size="sm"
                                              variant="ghost"
                                              onClick={() => onAnswerOption(question.id, o.label)}
                                          >
                                              {o.label}
                                          </Button>
                                      ))
                                    : null}

                                {item.kind === 'question' && !canAnswerInline && question
                                    ? answerableOnDeck(question)
                                        ? (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() =>
                                                    onExpandQuestion?.(
                                                        expandedQuestionId === question.id ? null : question.id,
                                                    )
                                                }
                                            >
                                                {expandedQuestionId === question.id ? 'Close' : 'Answer'}
                                            </Button>
                                        )
                                        : (
                                            // FORWARDED. Answered on the host that asked, so the
                                            // only honest control here is one that takes you there.
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => onOpenQuestion(question.id)}
                                            >
                                                Open
                                            </Button>
                                        )
                                    : null}

                                {item.kind === 'list-item' ? (
                                    <>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => onResolveListItem(item.key.slice('list:'.length), 'done')}
                                        >
                                            Done
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() =>
                                                onResolveListItem(item.key.slice('list:'.length), 'thrown_back')
                                            }
                                        >
                                            {/* Named after the agent, because resolving NUDGES it and
                                                the person should know who hears about this. */}
                                            {item.agentName ? `Back to ${item.agentName}` : 'Throw back'}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => onResolveListItem(item.key.slice('list:'.length), 'refused')}
                                        >
                                            Won&apos;t do
                                        </Button>
                                    </>
                                ) : null}
                            </div>

                            {question && expandedQuestionId === question.id && expanded && answerableOnDeck(question) ? (
                                <div className="needs-answer-form" data-testid="needs-answer-form">
                                    {question.questions.map((part, i) => (
                                        <div className="needs-answer-part" key={`${question.id}-${i}`}>
                                            <Text size="xs">{part.header}</Text>
                                            <Text size="sm">{part.question}</Text>
                                            <div className="needs-answer-options">
                                                {part.options.map((o) => (
                                                    <Button
                                                        key={o.label}
                                                        size="sm"
                                                        // `default` is Fancy's filled variant — there is
                                                        // no `solid`. A selected option has to LOOK
                                                        // chosen: this form is the only place a
                                                        // multi-select answer can be composed, and a
                                                        // selection nobody can see is a wrong answer
                                                        // waiting to be sent.
                                                        variant={
                                                            draft[i]?.selected.includes(o.label)
                                                                ? 'default'
                                                                : 'ghost'
                                                        }
                                                        aria-pressed={
                                                            draft[i]?.selected.includes(o.label) ? true : false
                                                        }
                                                        onClick={() => toggle(i, o.label, !!part.multiSelect)}
                                                    >
                                                        {o.label}
                                                    </Button>
                                                ))}
                                            </div>
                                            {/* ALWAYS, options or not. The modal offers free text
                                                beside the choices, and an answer that declines every
                                                option and says why is a real answer — often the most
                                                useful one, and the only possible one when a part has
                                                no options at all. */}
                                            <Textarea
                                                className="needs-answer-note"
                                                data-testid="needs-answer-note"
                                                rows={2}
                                                value={draft[i]?.note ?? ''}
                                                onChange={(e: { target: { value: string } }) =>
                                                    setDraft((prev) =>
                                                        prev.map((slot, j) =>
                                                            j === i ? { ...slot, note: e.target.value } : slot,
                                                        ),
                                                    )
                                                }
                                            />
                                        </div>
                                    ))}
                                    <div className="needs-answer-actions">
                                        {/* Disabled is right HERE and wrong on the row: the row's
                                            shape says what a question is, while this button is a
                                            step in something already begun — "not yet" rather than
                                            "not for you". */}
                                        <Button size="sm" disabled={!complete} onClick={send}>
                                            Send
                                        </Button>
                                        <Button size="sm" variant="ghost" onClick={() => onExpandQuestion?.(null)}>
                                            Cancel
                                        </Button>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    );
                })
            )}
        </Card>
    );
}
