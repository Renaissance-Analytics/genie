import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContentRenderer, Switch } from '@particle-academy/react-fancy';
import { IconX } from './icons';
import {
    cardStateFromDraft,
    draftFromCardState,
    type CardState,
} from '../../lib/ask-state';
import {
    api,
    hasGenieBridge,
    type ForceAnswerSpec,
    type PendingQuestionSpec,
    type RemoteControlState,
    type WorkspaceQuestionGroupSpec,
} from '../../lib/genie';
import {
    answerGate,
    applyAnswerReport,
    submitAnswer,
    type AnswerGate,
} from '../../lib/answer-gate';
import {
    AVAILABILITY_DEFAULT,
    scopeValue,
    setScopeEntry,
    type FtqAvailability,
} from '../../lib/ftq-availability';
import { formatQuestionAge } from '../../lib/question-age';

/**
 * PendingQuestions top-bar inbox (Phase B). A right-side slide-in: an icon in the
 * title bar shows the pending count; opening it lists the WORKSPACES with pending
 * requests; selecting a workspace opens its questions in answer order (modal-queue
 * first, then DND-deferred). Answering routes to the blocked agent (or clears a
 * deferred one). Live via `on.questionsChanged` (no polling). The pure grouping is
 * main-side (`main/ask/inbox.ts`); this is thin glue over `api().questions`.
 */

const PRIORITY_COLOR: Record<string, string> = {
    urgent: 'var(--rose-500, #f43f5e)',
    high: 'var(--amber-500, #f59e0b)',
    normal: 'var(--agent)',
    low: 'var(--fg-3, #9aa0aa)',
};

// A NUL joins the two halves because neither can contain one, so no hostname
// and label pair can collide with another. It was written as a LITERAL NUL,
// which made git treat this whole file as binary: every diff of it rendered as
// "Bin 24434 -> 28018 bytes" and could not be reviewed. Same string, escaped.
const keyOf = (g: WorkspaceQuestionGroupSpec): string => `${g.remoteHost ?? ''}\u0000${g.workspaceLabel}`;

export default function QuestionInboxFlyout({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const [groups, setGroups] = useState<WorkspaceQuestionGroupSpec[]>([]);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    // DND availability for the WORKSTATION this window is bound to — a client-side,
    // workstation-scoped setting. `connKey === null` ⇒ the local machine (flips the
    // global `ftq_availability`); a remote window flips that host's entry in the
    // `ftq_availability_workstations` map. `stationLabel` names it for the UI.
    const [connKey, setConnKey] = useState<string | null>(null);
    const [stationLabel, setStationLabel] = useState<string | null>(null);
    const [availability, setAvailability] = useState<FtqAvailability>(AVAILABILITY_DEFAULT);
    // Opt-in: still HEAR a question land while in DND (chime, no popup / focus steal).
    const [dndSound, setDndSound] = useState(false);
    // WHO holds write control of the host this window drives (genie#468). A
    // view-only driver still SEES these questions — not interrupted is not the
    // same as not told — but the host 423s its answer POST, so the Answer control
    // must not look usable. Local windows never lock (main answers `locked:false`
    // when the calling window drives nothing).
    const [control, setControl] = useState<RemoteControlState>({ locked: false });

    const refresh = useCallback(() => {
        if (!hasGenieBridge()) return;
        api()
            .questions.list()
            .then((r) => setGroups(r.groups))
            .catch(() => {});
    }, []);

    // This window's workstation binding — read once on mount (it never changes for
    // a window's lifetime). Local window ⇒ connKey null; a host window ⇒ its connKey.
    useEffect(() => {
        if (!hasGenieBridge()) return;
        api()
            .remote.myBinding()
            .then((b) => {
                setConnKey(b.connKey ?? null);
                setStationLabel(
                    b.mode === 'remote' ? (b.host?.hostname ?? 'this host') : null,
                );
            })
            .catch(() => {});
    }, []);

    // Read on mount + live via `onControl`, exactly as the view-only banner does
    // (pages/master.tsx) — the baton moves precisely when a question is pending,
    // because the host owner grabs it to answer that question themselves.
    useEffect(() => {
        if (!hasGenieBridge()) return;
        let alive = true;
        api()
            .remote.controlState()
            .then((s) => {
                if (alive) setControl(s);
            })
            .catch(() => {});
        const off = api().remote.onControl((s) => setControl(s));
        return () => {
            alive = false;
            off();
        };
    }, []);

    const loadAvailability = useCallback(() => {
        if (!hasGenieBridge()) return;
        api()
            .settings.get()
            .then((s) => {
                const global = s.ftq_availability ?? AVAILABILITY_DEFAULT;
                // For a host window, the workstation's own value wins; unset inherits
                // the global default (mirrors the main-side resolver's precedence).
                const eff = connKey
                    ? (scopeValue(s.ftq_availability_workstations, connKey) ?? global)
                    : global;
                setAvailability(eff);
                setDndSound(s.ftq_dnd_sound === 'on');
            })
            .catch(() => {});
    }, [connKey]);

    const setDndSoundOn = useCallback((on: boolean) => {
        setDndSound(on); // optimistic
        api()
            .settings.set({ ftq_dnd_sound: on ? 'on' : 'off' })
            .catch(() => setDndSound(!on));
    }, []);

    useEffect(() => {
        if (open) {
            refresh();
            loadAvailability();
        }
    }, [open, refresh, loadAvailability]);
    useEffect(() => api().on.questionsChanged?.(refresh), [refresh]);
    // Reflect an availability change made elsewhere (the settings window) live.
    useEffect(
        () =>
            api().on.settingsChanged?.((keys) => {
                if (
                    keys.includes('ftq_availability') ||
                    keys.includes('ftq_availability_workstations')
                ) {
                    loadAvailability();
                }
            }),
        [loadAvailability],
    );

    const setDnd = useCallback(
        (on: boolean) => {
            const next: FtqAvailability = on ? 'dnd' : 'available';
            setAvailability(next); // optimistic
            const revert = () => setAvailability(on ? 'available' : 'dnd');
            if (connKey) {
                // Per-host: merge into the live map so one host's edit never clobbers
                // another's (re-read before writing).
                api()
                    .settings.get()
                    .then((s) =>
                        api().settings.set({
                            ftq_availability_workstations: setScopeEntry(
                                s.ftq_availability_workstations,
                                connKey,
                                next,
                            ),
                        }),
                    )
                    .catch(revert);
            } else {
                api().settings.set({ ftq_availability: next }).catch(revert);
            }
        },
        [connKey],
    );

    const gate = useMemo(() => answerGate(control), [control]);
    const total = useMemo(() => groups.reduce((n, g) => n + g.count, 0), [groups]);
    const selected = useMemo(
        () => groups.find((g) => keyOf(g) === selectedKey) ?? null,
        [groups, selectedKey],
    );

    if (!open) return null;

    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.35)',
                zIndex: 60,
                display: 'flex',
                justifyContent: 'flex-end',
            }}
        >
            <aside
                onClick={(e) => e.stopPropagation()}
                style={{
                    // #61: real ForceTheQuestion bodies are multi-paragraph markdown —
                    // 420px was cramped. Give them room while staying responsive.
                    width: 'min(620px, 96vw)',
                    height: '100%',
                    background: 'var(--bg-1, #16161a)',
                    borderLeft: '1px solid var(--bg-3, rgba(120,120,120,0.25))',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: '-8px 0 32px rgba(0,0,0,0.35)',
                }}
            >
                <header
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '12px 14px',
                        borderBottom: '1px solid var(--bg-3, rgba(120,120,120,0.2))',
                    }}
                >
                    <strong style={{ fontSize: 14, flex: 1 }}>
                        Questions{total > 0 ? ` · ${total}` : ''}
                    </strong>
                    <button
                        type="button"
                        className="gicon"
                        onClick={onClose}
                        aria-label="Close"
                        title="Close"
                    >
                        <IconX size={16} />
                    </button>
                </header>

                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 14px',
                        borderBottom: '1px solid var(--bg-3, rgba(120,120,120,0.2))',
                        background: availability === 'dnd'
                            ? 'color-mix(in srgb, var(--amber-500, #f59e0b) 12%, transparent)'
                            : 'transparent',
                    }}
                >
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                            Do Not Disturb
                            {stationLabel && (
                                <span style={{ color: 'var(--fg-3)', fontWeight: 400 }}>
                                    {' · '}
                                    {stationLabel}
                                </span>
                            )}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                            {availability === 'dnd'
                                ? `New questions${stationLabel ? ` from ${stationLabel}` : ''} wait here instead of popping up.`
                                : 'Questions pop up as always-on-top prompts.'}
                        </div>
                    </div>
                    <Switch
                        checked={availability === 'dnd'}
                        onCheckedChange={setDnd}
                        aria-label="Do Not Disturb — divert new questions to this inbox"
                    />
                </div>

                {availability === 'dnd' && (
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            padding: '8px 14px 8px 28px',
                            borderBottom: '1px solid var(--bg-3, rgba(120,120,120,0.2))',
                        }}
                    >
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 600 }}>Still play a chime</div>
                            <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                                Hear a question land — no popup, never steals focus (won&apos;t
                                interrupt a fullscreen game).
                            </div>
                        </div>
                        <Switch
                            checked={dndSound}
                            onCheckedChange={setDndSoundOn}
                            aria-label="Play a chime for new questions while in Do Not Disturb"
                        />
                    </div>
                )}

                <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
                    {groups.length === 0 ? (
                        <p style={{ color: 'var(--fg-3)', fontSize: 13, marginTop: 8 }}>
                            No pending questions. When an agent asks and you&apos;re in DND (or a
                            popup couldn&apos;t show), it lands here to answer at your leisure.
                        </p>
                    ) : !selected ? (
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                            {groups.map((g) => (
                                <li key={keyOf(g)}>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedKey(keyOf(g))}
                                        style={rowStyle}
                                    >
                                        <span
                                            aria-hidden
                                            style={{
                                                width: 8,
                                                height: 8,
                                                borderRadius: '50%',
                                                background: PRIORITY_COLOR[g.topPriority] ?? PRIORITY_COLOR.normal,
                                                flexShrink: 0,
                                            }}
                                        />
                                        <span
                                            style={{
                                                flex: 1,
                                                minWidth: 0,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                textAlign: 'left',
                                            }}
                                        >
                                            {g.workspaceLabel}
                                        </span>
                                        {g.remoteHost && (
                                            <span style={hostChipStyle} title={`on ${g.remoteHost}`}>
                                                ☁ {g.remoteHost}
                                            </span>
                                        )}
                                        <span style={countStyle}>{g.count}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div style={{ display: 'grid', gap: 12 }}>
                            <button
                                type="button"
                                onClick={() => setSelectedKey(null)}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'var(--agent)',
                                    cursor: 'pointer',
                                    fontSize: 12,
                                    textAlign: 'left',
                                    padding: 0,
                                }}
                            >
                                ← Workspaces
                            </button>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>
                                {selected.workspaceLabel}
                                {selected.remoteHost ? ` · ☁ ${selected.remoteHost}` : ''}
                            </div>
                            {selected.questions.map((pq) => (
                                <PendingCard
                                    key={pq.id}
                                    pending={pq}
                                    gate={gate}
                                    onAnswered={refresh}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </aside>
        </div>
    );
}

const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '9px 10px',
    borderRadius: 8,
    border: '1px solid var(--bg-3, rgba(120,120,120,0.2))',
    background: 'var(--bg-2, rgba(255,255,255,0.03))',
    color: 'var(--fg-1, #e8e8ea)',
    cursor: 'pointer',
    fontSize: 13,
};

const hostChipStyle: React.CSSProperties = {
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 999,
    background: 'color-mix(in srgb, var(--agent) 16%, transparent)',
    color: 'var(--agent)',
    whiteSpace: 'nowrap',
};

const countStyle: React.CSSProperties = {
    minWidth: 20,
    height: 20,
    padding: '0 6px',
    borderRadius: 999,
    background: 'var(--bg-3, rgba(120,120,120,0.25))',
    color: 'var(--fg-1, #e8e8ea)',
    fontSize: 11,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
};

/**
 * One pending request (its 1–4 questions) with an inline answer form.
 *
 * Exported for the render test (genie#468): the gate arrives as a PROP so the
 * card can be rendered in both control states without a bridge, and so the
 * flyout keeps the single subscription rather than one per card.
 */
export function PendingCard({
    pending,
    gate,
    onAnswered,
}: {
    pending: PendingQuestionSpec;
    gate: AnswerGate;
    onAnswered: () => void;
}) {
    const [state, setState] = useState<CardState>({});
    const [busy, setBusy] = useState(false);
    /** What the last submit did, when it was not simply accepted. Cleared on the
     *  next attempt — an action must never end in silence (genie#468). */
    const [notice, setNotice] = useState<string | null>(null);
    // This card UNMOUNTS when the flyout closes (`if (!open) return null`), so
    // until the draft lived in main, closing the panel to go check something
    // discarded every selection and every half-typed note. The draft is keyed by
    // question id and shared with the FTQ modal, so an answer begun in either
    // surface is finished in the other.
    const hydrated = useRef(false);
    useEffect(() => {
        let cancelled = false;
        void api()
            .ask.draftGet(pending.id)
            .then((stored) => {
                if (cancelled || !stored) return;
                setState(cardStateFromDraft(stored));
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) hydrated.current = true;
            });
        return () => {
            cancelled = true;
        };
    }, [pending.id]);

    useEffect(() => {
        // Only after hydration, or the empty initial state would overwrite the
        // stored draft before it had a chance to load.
        if (!hydrated.current) return;
        void api().ask.draftSet(pending.id, draftFromCardState(state)).catch(() => {});
    }, [pending.id, state]);

    // Read at render (the flyout re-reads on open + every `questions:changed`).
    // Null when the question carries no stamp — a host on an older build sends
    // none, and that degrades to showing nothing rather than a wrong time.
    const age = formatQuestionAge(pending.createdAt, Date.now());

    const toggle = (qi: number, label: string, multi: boolean): void => {
        setState((s) => {
            const cur = s[qi] ?? { selected: [], note: '' };
            const has = cur.selected.includes(label);
            const selected = multi
                ? has
                    ? cur.selected.filter((l) => l !== label)
                    : [...cur.selected, label]
                : [label];
            return { ...s, [qi]: { ...cur, selected } };
        });
    };
    const setNote = (qi: number, note: string): void =>
        setState((s) => ({ ...s, [qi]: { selected: s[qi]?.selected ?? [], note } }));

    const submit = async (): Promise<void> => {
        if (busy || !gate.canAnswer) return;
        setBusy(true);
        setNotice(null);
        const answers: ForceAnswerSpec[] = pending.questions.map((q, qi) => ({
            header: q.header,
            question: q.question,
            selected: state[qi]?.selected ?? [],
            note: state[qi]?.note ?? '',
        }));
        // EVERY outcome is rendered. This used to `await` and drop both the
        // rejection and the false, so a host that refused the answer looked
        // exactly like one that took it: the button un-busied, the question
        // stayed put, and the reviewer's next move was to press it again.
        const report = await submitAnswer(() => api().questions.answer(pending.id, answers));
        setBusy(false);
        applyAnswerReport(report, { notice: setNotice, refresh: onAnswered });
    };

    return (
        <div
            style={{
                border: '1px solid var(--bg-3, rgba(120,120,120,0.2))',
                borderRadius: 10,
                padding: 12,
                display: 'grid',
                gap: 10,
                background: 'var(--bg-2, rgba(255,255,255,0.02))',
            }}
        >
            {(pending.deferred || age) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {pending.deferred && (
                        <span
                            style={{
                                fontSize: 10,
                                padding: '1px 7px',
                                borderRadius: 999,
                                background:
                                    'color-mix(in srgb, var(--amber-500, #f59e0b) 18%, transparent)',
                                color: 'var(--amber-500, #f59e0b)',
                            }}
                        >
                            DND — answer at your leisure
                        </span>
                    )}
                    {/* How long the agent has been waiting. A question can sit here
                        for hours (DND, or the owner was away), so its AGE is what
                        says whether to answer it now — hover for the exact time. */}
                    {age && (
                        <span
                            style={{
                                marginLeft: 'auto',
                                fontSize: 10.5,
                                color: 'var(--fg-3, #9aa0aa)',
                                whiteSpace: 'nowrap',
                            }}
                            title={new Date(pending.createdAt as number).toLocaleString()}
                        >
                            came in {age}
                        </span>
                    )}
                </div>
            )}
            {pending.questions.map((q, qi) => (
                <div key={qi} style={{ display: 'grid', gap: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-2, #c8c8cc)' }}>
                        {q.header}
                    </div>
                    {/* #61: render the body as MARKDOWN (same as the FTQ modal
                        ask.tsx) so bold/code/lists format instead of showing raw ** */}
                    <ContentRenderer value={q.question} format="markdown" lineSpacing={1.55} />
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {q.options.map((o) => {
                            const on = (state[qi]?.selected ?? []).includes(o.label);
                            return (
                                <button
                                    key={o.label}
                                    type="button"
                                    onClick={() => toggle(qi, o.label, !!q.multiSelect)}
                                    title={o.description}
                                    style={{
                                        fontSize: 12,
                                        padding: '5px 10px',
                                        borderRadius: 7,
                                        cursor: 'pointer',
                                        border: `1px solid ${on ? 'var(--agent)' : 'var(--bg-3, rgba(120,120,120,0.3))'}`,
                                        background: on
                                            ? 'color-mix(in srgb, var(--agent) 22%, transparent)'
                                            : 'transparent',
                                        color: 'var(--fg-1, #e8e8ea)',
                                    }}
                                >
                                    {o.label}
                                </button>
                            );
                        })}
                    </div>
                    <textarea
                        value={state[qi]?.note ?? ''}
                        onChange={(e) => setNote(qi, e.target.value)}
                        placeholder="Add a note (optional)"
                        rows={2}
                        style={{
                            fontSize: 12,
                            padding: '6px 8px',
                            borderRadius: 7,
                            border: '1px solid var(--bg-3, rgba(120,120,120,0.3))',
                            background: 'var(--bg-1, #16161a)',
                            color: 'var(--fg-1, #e8e8ea)',
                            resize: 'vertical',
                            fontFamily: 'inherit',
                        }}
                    />
                </div>
            ))}
            {/* The REASON, not just a greyed button. A control you cannot use
                should not look usable, and one that looks broken with no
                explanation is the same silence in a different costume. */}
            {!gate.canAnswer && gate.reason && (
                <div
                    data-testid="question-answer-blocked"
                    style={{ fontSize: 11.5, color: 'var(--amber-500, #f59e0b)' }}
                >
                    {gate.reason}
                </div>
            )}
            {notice && (
                <div
                    data-testid="question-answer-notice"
                    style={{ fontSize: 11.5, color: 'var(--amber-500, #f59e0b)' }}
                >
                    {notice}
                </div>
            )}
            <button
                type="button"
                data-testid="question-answer"
                onClick={submit}
                disabled={busy || !gate.canAnswer}
                title={gate.reason ?? undefined}
                style={{
                    justifySelf: 'end',
                    fontSize: 13,
                    padding: '6px 16px',
                    borderRadius: 8,
                    border: 'none',
                    cursor: busy || !gate.canAnswer ? 'default' : 'pointer',
                    background: 'var(--agent)',
                    color: '#09090b',
                    opacity: busy || !gate.canAnswer ? 0.6 : 1,
                }}
            >
                {busy ? 'Sending…' : 'Answer'}
            </button>
        </div>
    );
}
