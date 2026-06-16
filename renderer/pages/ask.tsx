import { useEffect, useState } from 'react';
import { Action, Heading, Icon, Text } from '@particle-academy/react-fancy';
import {
    api,
    hasGenieBridge,
    type ForceAnswerSpec,
    type ForceQuestionSpec,
} from '../lib/genie';

/**
 * ForceTheQuestion modal — a frameless, always-on-top window an agent raises via
 * the Genie MCP to ask the user one or more questions. Mirrors the AskUserQuestion
 * UX: each question offers single/multi-select options AND an always-available
 * free-text note, so a single call covers everything the agent needs.
 *
 * Main pushes the payload via `ask:show` (carrying the request id); we reply with
 * `ask:answer` (the per-question selections + notes) or `ask:cancel`.
 */
export default function AskPage() {
    const [bridgeReady, setBridgeReady] = useState(false);
    const [reqId, setReqId] = useState<string | null>(null);
    const [questions, setQuestions] = useState<ForceQuestionSpec[]>([]);
    // Per-question selected labels + free-text note, keyed by question index.
    const [selected, setSelected] = useState<Record<number, string[]>>({});
    const [notes, setNotes] = useState<Record<number, string>>({});
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (hasGenieBridge()) setBridgeReady(true);
    }, []);

    useEffect(() => {
        if (!bridgeReady) return;
        return api().ask.onShow(({ id, questions: qs }) => {
            setReqId(id);
            setQuestions(qs);
            setSelected({});
            setNotes({});
        });
    }, [bridgeReady]);

    const toggle = (qi: number, label: string, multi: boolean) => {
        setSelected((prev) => {
            const cur = prev[qi] ?? [];
            if (multi) {
                const next = cur.includes(label)
                    ? cur.filter((l) => l !== label)
                    : [...cur, label];
                return { ...prev, [qi]: next };
            }
            // Single-select: clicking the chosen one again clears it.
            return { ...prev, [qi]: cur[0] === label ? [] : [label] };
        });
    };

    const submit = async () => {
        if (!reqId || submitting) return;
        setSubmitting(true);
        const answers: ForceAnswerSpec[] = questions.map((q, qi) => ({
            header: q.header,
            question: q.question,
            selected: selected[qi] ?? [],
            note: (notes[qi] ?? '').trim(),
        }));
        try {
            await api().ask.answer(reqId, answers);
        } catch {
            /* window will close from main; nothing to recover here */
        }
    };

    const cancel = async () => {
        if (!reqId) return;
        await api().ask.cancel(reqId).catch(() => {});
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                void cancel();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reqId]);

    // Require at least one selection OR a note per question before submit.
    const ready =
        questions.length > 0 &&
        questions.every(
            (_q, qi) => (selected[qi]?.length ?? 0) > 0 || (notes[qi]?.trim() ?? '') !== '',
        );

    if (!bridgeReady || !reqId) {
        return (
            <div className="ask-frame ask-loading">
                <Text size="sm" className="text-zinc-500">
                    Waiting for the question…
                </Text>
            </div>
        );
    }

    return (
        <div className="ask-frame">
            <div className="ask-head">
                <Icon name="sparkles" size="sm" className="text-violet-500" />
                <Heading as="h1" size="sm" style={{ margin: 0 }}>
                    An agent needs your input
                </Heading>
                <div style={{ flex: 1 }} />
                <Action
                    variant="ghost"
                    size="xs"
                    icon="x"
                    onClick={cancel}
                    title="Dismiss (Esc)"
                />
            </div>

            <div className="ask-body">
                {questions.map((q, qi) => (
                    <div key={qi} className="ask-q">
                        <div className="ask-q-head">
                            <span className="ask-chip">{q.header}</span>
                            {q.multiSelect && (
                                <Text size="xs" className="text-zinc-500">
                                    choose any
                                </Text>
                            )}
                        </div>
                        <Text size="sm" style={{ fontWeight: 600 }}>
                            {q.question}
                        </Text>
                        <div className="ask-options">
                            {q.options.map((o) => {
                                const on = (selected[qi] ?? []).includes(o.label);
                                return (
                                    <button
                                        key={o.label}
                                        type="button"
                                        className={`ask-opt${on ? ' on' : ''}`}
                                        onClick={() => toggle(qi, o.label, !!q.multiSelect)}
                                    >
                                        <span className="ask-opt-label">
                                            {on && <Icon name="check" size="xs" />} {o.label}
                                        </span>
                                        {o.description && (
                                            <span className="ask-opt-desc">{o.description}</span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                        <textarea
                            className="input ask-note"
                            value={notes[qi] ?? ''}
                            onChange={(e) =>
                                setNotes((prev) => ({ ...prev, [qi]: e.target.value }))
                            }
                            placeholder="Add a note (optional)…"
                            rows={2}
                        />
                    </div>
                ))}
            </div>

            <div className="ask-foot">
                <span className="kbd">esc</span>
                <Text size="xs" className="text-zinc-500">
                    dismiss
                </Text>
                <div style={{ flex: 1 }} />
                <Action variant="ghost" size="sm" onClick={cancel}>
                    Cancel
                </Action>
                <Action
                    color="blue"
                    size="sm"
                    icon="check"
                    onClick={submit}
                    disabled={!ready || submitting}
                >
                    {submitting ? 'Sending…' : 'Submit'}
                </Action>
            </div>
        </div>
    );
}
