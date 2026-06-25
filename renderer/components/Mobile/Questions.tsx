import { useEffect, useState } from 'react';
import { Action, Icon, Text } from '@particle-academy/react-fancy';
import type { ForceAnswerSpec } from '../../lib/genie';
import {
    answer as submitAnswer,
    listQuestions,
    MobileApiError,
    type MobileEvent,
    type PendingQuestion,
} from '../../lib/mobile-client';

/**
 * The phone's ForceTheQuestion view. Lists every pending request from
 * `GET /api/questions` and renders each EXACTLY like `pages/ask.tsx` — per
 * question: a header chip, the prompt, single/multi-select option chips, and an
 * always-available free-text note. Submitting posts `ForceAnswerSpec[]` to
 * `/api/questions/:id/answer`, which unblocks the agent AND advances/closes the
 * desktop modal (same `finish()` path `ask:answer` uses).
 *
 * `index 0` is the request currently shown on the desktop; we badge it so the
 * user knows the desktop is mirroring it. Lives via `question:changed` from the
 * shared event stream (refetch on any change — answered-elsewhere included).
 */
export default function Questions({
    initial,
    subscribe,
    onCountChange,
}: {
    initial: PendingQuestion[];
    subscribe: (cb: (e: MobileEvent) => void) => () => void;
    onCountChange: (count: number) => void;
}) {
    const [questions, setQuestions] = useState<PendingQuestion[]>(initial);

    useEffect(() => {
        setQuestions(initial);
    }, [initial]);

    // Keep the shell's badge in sync with what we're showing.
    useEffect(() => {
        onCountChange(questions.length);
    }, [questions.length, onCountChange]);

    const refetch = () =>
        listQuestions()
            .then(setQuestions)
            .catch(() => {});

    useEffect(() => {
        const off = subscribe((e: MobileEvent) => {
            if (e.type === 'question:changed') void refetch();
        });
        return off;
    }, [subscribe]);

    const dismiss = (id: string) =>
        setQuestions((prev) => prev.filter((q) => q.id !== id));

    if (questions.length === 0) {
        return (
            <div className="m-scroll m-questions-empty">
                <Icon name="check-circle" size="lg" className="text-emerald-500" />
                <Text size="sm" className="text-zinc-500">
                    No questions waiting.
                </Text>
            </div>
        );
    }

    return (
        <div className="m-scroll">
            {questions.map((q) => (
                <QuestionCard
                    key={q.id}
                    pending={q}
                    onResolved={() => dismiss(q.id)}
                />
            ))}
        </div>
    );
}

/**
 * One ForceTheQuestion request. Holds its own selection/note state and submit
 * lifecycle, exactly like the per-request state in `ask.tsx`. Requires at least
 * one selection OR a note per question before Submit enables.
 */
function QuestionCard({
    pending,
    onResolved,
}: {
    pending: PendingQuestion;
    onResolved: () => void;
}) {
    const [selected, setSelected] = useState<Record<number, string[]>>({});
    const [notes, setNotes] = useState<Record<number, string>>({});
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const toggle = (qi: number, label: string, multi: boolean) => {
        setSelected((prev) => {
            const cur = prev[qi] ?? [];
            if (multi) {
                const next = cur.includes(label)
                    ? cur.filter((l) => l !== label)
                    : [...cur, label];
                return { ...prev, [qi]: next };
            }
            // Single-select: re-tapping the chosen one clears it.
            return { ...prev, [qi]: cur[0] === label ? [] : [label] };
        });
    };

    const ready =
        pending.questions.length > 0 &&
        pending.questions.every(
            (_q, qi) =>
                (selected[qi]?.length ?? 0) > 0 || (notes[qi]?.trim() ?? '') !== '',
        );

    const submit = async () => {
        if (submitting || !ready) return;
        setSubmitting(true);
        setError(null);
        const answers: ForceAnswerSpec[] = pending.questions.map((q, qi) => ({
            header: q.header,
            question: q.question,
            selected: selected[qi] ?? [],
            note: (notes[qi] ?? '').trim(),
        }));
        try {
            // answered:false is a benign race (already answered on the desktop /
            // another phone) — either way the request is gone, so dismiss it.
            await submitAnswer(pending.id, answers);
            onResolved();
        } catch (e) {
            if (e instanceof MobileApiError && e.isLocked) {
                setError('Locked on desktop — answering is disabled.');
            } else {
                setError(e instanceof Error ? e.message : 'Failed to submit');
            }
            setSubmitting(false);
        }
    };

    return (
        <div className="m-card m-question">
            <div className="m-question-head">
                <Icon name="sparkles" size="xs" className="text-violet-500" />
                <Text size="sm" style={{ fontWeight: 600 }}>
                    {pending.workspaceLabel
                        ? `An agent in ${pending.workspaceLabel} needs your input`
                        : 'An agent needs your input'}
                </Text>
                {pending.index === 0 && (
                    <span className="m-badge-live" title="Shown on desktop now">
                        live
                    </span>
                )}
            </div>

            {pending.questions.map((q, qi) => (
                <div key={qi} className="m-q">
                    <div className="m-q-head">
                        <span className="m-chip">{q.header}</span>
                        {q.multiSelect && (
                            <Text size="xs" className="text-zinc-500">
                                choose any
                            </Text>
                        )}
                    </div>
                    <Text size="sm" style={{ fontWeight: 600 }}>
                        {q.question}
                    </Text>
                    <div className="m-options">
                        {q.options.map((o) => {
                            const on = (selected[qi] ?? []).includes(o.label);
                            return (
                                <button
                                    key={o.label}
                                    type="button"
                                    className={`m-opt${on ? ' on' : ''}`}
                                    onClick={() => toggle(qi, o.label, !!q.multiSelect)}
                                >
                                    <span className="m-opt-label">
                                        {on && <Icon name="check" size="xs" />} {o.label}
                                    </span>
                                    {o.description && (
                                        <span className="m-opt-desc">{o.description}</span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                    <textarea
                        className="input m-note"
                        value={notes[qi] ?? ''}
                        onChange={(e) =>
                            setNotes((prev) => ({ ...prev, [qi]: e.target.value }))
                        }
                        placeholder="Add a note (optional)…"
                        rows={2}
                    />
                </div>
            ))}

            {error && (
                <div className="m-pair-error">
                    <Icon name="alert-triangle" size="xs" />
                    <Text size="xs">{error}</Text>
                </div>
            )}

            <div className="m-question-foot">
                <Action
                    color="blue"
                    icon="check"
                    onClick={() => void submit()}
                    disabled={!ready || submitting}
                >
                    {submitting ? 'Sending…' : 'Submit'}
                </Action>
            </div>
        </div>
    );
}
