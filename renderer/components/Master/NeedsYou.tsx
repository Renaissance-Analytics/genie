import { Badge, Button, Card, Heading, Text } from '@particle-academy/react-fancy';
import type { AttentionItem } from '../../lib/attention-queue';
import type { PendingQuestionSpec } from '../../lib/genie';
import { inlineAnswerable } from '../../lib/attention-actions';

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
 * rest of the decision is lost and nothing says so. Those rows get "Open" instead — a
 * different affordance, not a disabled one, because a disabled control is an accusation
 * where a different shape is a fact. `inlineAnswerable` owns that decision and is tested.
 */

export interface NeedsYouProps {
    items: readonly AttentionItem[];
    /** The pending questions, by id, so a row can render its actual options. */
    questionsById: ReadonlyMap<string, PendingQuestionSpec>;
    now?: number;
    onAnswerOption: (questionId: string, label: string) => void;
    onOpenQuestion: (questionId: string) => void;
    onResolveListItem: (todoId: string, action: 'done' | 'thrown_back' | 'refused') => void;
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
}: NeedsYouProps): React.JSX.Element {
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
                        <div className="needs-row" key={item.key} data-kind={item.kind}>
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

                                {item.kind === 'question' && !canAnswerInline ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => onOpenQuestion(item.key.slice('question:'.length))}
                                    >
                                        Open
                                    </Button>
                                ) : null}

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
                        </div>
                    );
                })
            )}
        </Card>
    );
}
