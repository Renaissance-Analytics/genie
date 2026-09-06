import { useEffect, useMemo, useState } from 'react';
import { Action, ContentRenderer, Heading, Icon, Text } from '@particle-academy/react-fancy';
import { FileViewer } from '@particle-academy/fancy-code';
import { api, hasGenieBridge, type ForceQuestionSpec } from '../lib/genie';
import { extractFileRefs, type AskFileRef } from '../lib/ask-file-refs';
import {
    clearDraft,
    draftFor,
    draftToAnswers,
    isDraftReady,
    resolveActiveQuestionId,
    setDraftNote,
    toggleDraftOption,
    type AskDrafts,
} from '../lib/ask-state';

/**
 * ForceTheQuestion modal — a frameless, always-on-top window an agent raises via
 * the Genie MCP to ask the user one or more questions. Mirrors the AskUserQuestion
 * UX: each question offers single/multi-select options AND an always-available
 * free-text note.
 *
 * PendingQuestions v2: Genie is multi-agent, so several asks can be pending at once.
 * Main pushes the WHOLE queue (`ask:queue`, priority-ordered) + the head (`ask:show`,
 * sent only when the head actually CHANGES). The user can pick which pending request
 * to answer next — a higher-priority one sorts to the top, but nothing is answered
 * for the user; they choose. `ask:answer`/`ask:cancel` act on the SELECTED id.
 *
 * The user is answering while other agents keep changing the queue, so which request
 * is shown and the part-typed answer are both decided by pure helpers in
 * `lib/ask-state` (unit-tested; the renderer has no jsdom harness): a pin is the
 * user's until that request is gone, and a draft is keyed by request id so queue
 * churn can never wipe it (genie#156).
 */

type PendingItem = {
    id: string;
    workspaceLabel?: string;
    /** The asking workspace's local root — the file drawer resolves a path the
     *  question NAMES against it (Tynn #272). Absent ⇒ no drawer. */
    workspacePath?: string;
    questions: ForceQuestionSpec[];
    index: number;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    /** §8 attribution — the remote host this was forwarded from, or undefined (local). */
    remoteHost?: string;
};

/** What the file drawer is showing, for the file it was asked to open. */
type FileState =
    | { status: 'loading' }
    | { status: 'ready'; content: string; truncated: boolean }
    | { status: 'error'; message: string };

const PRIORITY_META: Record<
    NonNullable<PendingItem['priority']>,
    { label: string; color: string }
> = {
    urgent: { label: 'Urgent', color: 'var(--red-500)' },
    high: { label: 'High', color: 'var(--amber-500)' },
    normal: { label: '', color: '' },
    low: { label: 'Low', color: 'var(--zinc-500)' },
};

export default function AskPage() {
    const [bridgeReady, setBridgeReady] = useState(false);
    // The full pending queue (priority-ordered) + the head, from main.
    const [pending, setPending] = useState<PendingItem[]>([]);
    const [head, setHead] = useState<PendingItem | null>(null);
    // The request the user explicitly picked from the queue strip. Theirs until
    // that request is gone — never cleared by queue churn (genie#156).
    const [pinnedId, setPinnedId] = useState<string | null>(null);
    // Part-typed answers, keyed by REQUEST id so nothing the queue does wipes them.
    const [drafts, setDrafts] = useState<AskDrafts>({});
    // The request whose submit is in flight (per id — the user can switch away).
    const [submittingId, setSubmittingId] = useState<string | null>(null);
    // The file being read beside the question, and what came back for it (#272).
    const [openFile, setOpenFile] = useState<AskFileRef | null>(null);
    const [fileState, setFileState] = useState<FileState>({ status: 'loading' });

    useEffect(() => {
        if (hasGenieBridge()) setBridgeReady(true);
    }, []);

    useEffect(() => {
        if (!bridgeReady) return;
        const offShow = api().ask.onShow(
            ({ id, questions: qs, workspaceLabel: ws, workspacePath: wp, queued }) => {
                setHead({ id, questions: qs, workspaceLabel: ws, workspacePath: wp, index: 0 });
                void queued; // count is derived from `pending` now
            },
        );
        const offQueue = api().ask.onQueue(({ pending: p }) => setPending(p as PendingItem[]));
        // Attached → tell main to deliver.
        void api().ask.ready().catch(() => {});
        return () => {
            offShow();
            offQueue();
        };
    }, [bridgeReady]);

    // The request being answered: the user's pin while it is still pending, else
    // the head (see resolveActiveQuestionId). Prefer the queue copy — authoritative
    // and it carries the priority/attribution — and fall back to the head payload.
    const active: PendingItem | null = useMemo(() => {
        const wantId = resolveActiveQuestionId({
            pinnedId,
            headId: head?.id ?? null,
            pendingIds: pending.map((p) => p.id),
        });
        if (!wantId) return null;
        return pending.find((p) => p.id === wantId) ?? (wantId === head?.id ? head : null);
    }, [pinnedId, head, pending]);

    const questions = active?.questions ?? [];
    const draft = active ? draftFor(drafts, active.id) : { selected: {}, notes: {} };
    const submitting = !!active && submittingId === active.id;

    // A part-typed answer belongs to the QUESTION, not to this window — and main
    // CLOSES this window whenever the queue drains, which took the answer with
    // it. Someone who ticked two options, started a note, and stepped away to
    // check something came back to a blank form. So the draft is mirrored into
    // main, which outlives the window and is shared with the in-app flyout.
    //
    // Hydrate only when nothing has been typed here yet: what is on screen is
    // newer than what was stored, and re-hydrating over it would undo the
    // keystroke that triggered the save.
    const activeId = active?.id ?? null;
    useEffect(() => {
        if (!activeId || drafts[activeId]) return;
        let cancelled = false;
        void api()
            .ask.draftGet(activeId)
            .then((stored) => {
                if (cancelled || !stored) return;
                setDrafts((prev) => (prev[activeId] ? prev : { ...prev, [activeId]: stored }));
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId]);

    const activeDraft = activeId ? drafts[activeId] : undefined;
    useEffect(() => {
        if (!activeId || !activeDraft) return;
        void api().ask.draftSet(activeId, activeDraft).catch(() => {});
    }, [activeId, activeDraft]);

    // --- The file drawer (Tynn #272) -------------------------------------
    // A question that names a file used to hand the reader a path and nothing
    // else. The paths it names become chips; opening one reads the file and
    // shows it BESIDE the question. Nothing here navigates — genie#196 turned
    // this window into a browser tab once and stranded the question behind it.

    /** The files each question names, keyed by question index. */
    const fileRefs = useMemo(
        () => questions.map((q) => extractFileRefs(q.question)),
        [questions],
    );
    const workspacePath = active?.workspacePath;
    // Files can only be opened when we know which workspace to resolve them in —
    // a forwarded question's paths are on the HOST, and reading a same-named
    // local file would show the reader the wrong file with no sign of it.
    const canOpenFiles = !!workspacePath;

    // Switching to a different request closes whatever file the last one opened:
    // it belongs to that question, not to this window.
    useEffect(() => {
        setOpenFile(null);
    }, [activeId]);

    useEffect(() => {
        if (!openFile || !workspacePath) return;
        let cancelled = false;
        setFileState({ status: 'loading' });
        void api()
            .files.read(workspacePath, openFile.path)
            .then((r) => {
                if (!cancelled) {
                    setFileState({ status: 'ready', content: r.content, truncated: r.truncated });
                }
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                const message = e instanceof Error ? e.message : String(e);
                setFileState({ status: 'error', message });
            });
        return () => {
            cancelled = true;
        };
    }, [openFile, workspacePath]);

    // The drawer sits beside the question, so the WINDOW has to grow for it —
    // main owns that (and keeping the widened window on screen).
    const drawerOpen = !!openFile;
    useEffect(() => {
        void api().ask.drawer(drawerOpen).catch(() => {});
    }, [drawerOpen]);

    const toggle = (qi: number, label: string, multi: boolean) => {
        if (!active) return;
        setDrafts((prev) => toggleDraftOption(prev, active.id, qi, label, multi));
    };

    const submit = async () => {
        if (!active || submitting) return;
        const id = active.id;
        setSubmittingId(id);
        try {
            await api().ask.answer(id, draftToAnswers(draft, questions));
            // Answered — the draft has served its purpose. (A failure keeps it, so
            // nothing the user typed is lost if the send didn't land.)
            setDrafts((prev) => clearDraft(prev, id));
        } catch {
            /* window will close / advance from main; nothing to recover here */
        } finally {
            setSubmittingId((cur) => (cur === id ? null : cur));
        }
    };

    // Cancel just the ACTIVE request (advances the queue); dismiss closes the window.
    const cancelActive = () => {
        if (!active) return;
        const id = active.id;
        void api().ask.cancel(id).catch(() => {});
        setDrafts((prev) => clearDraft(prev, id));
    };
    const dismiss = () => void api().ask.dismiss().catch(() => {});

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            // Escape closes the FILE first. Someone who opened a file to check it
            // and pressed Escape to put it away meant the file, not the question —
            // and dismissing the question cancels it for the agent waiting on it.
            if (drawerOpen) setOpenFile(null);
            else dismiss();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [drawerOpen]);

    const ready = isDraftReady(draft, questions.length);

    // §8 attribution — a forwarded question names its REMOTE host so it's never
    // mistaken for a local one; a local question keeps the workspace phrasing.
    const title = active?.remoteHost
        ? `An agent on ${active.remoteHost}${
              active.workspaceLabel ? ` · ${active.workspaceLabel}` : ''
          } needs your input`
        : active?.workspaceLabel
          ? `An agent in ${active.workspaceLabel} needs your input`
          : 'An agent needs your input';

    // The OTHER pending requests (everything but the one being answered).
    const others = pending.filter((p) => p.id !== active?.id);

    const header = (
        <div className="ask-head">
            <Icon name="sparkles" size="sm" className="text-violet-500" />
            <Heading as="h1" size="sm" style={{ margin: 0 }}>
                {title}
            </Heading>
            {others.length > 0 && (
                <span className="ask-queued" title={`${others.length} more waiting`}>
                    +{others.length} more queued
                </span>
            )}
            <div style={{ flex: 1 }} />
            <button
                type="button"
                className="ask-x"
                onClick={dismiss}
                title="Close (Esc)"
                aria-label="Close"
            >
                ✕
            </button>
        </div>
    );

    if (!bridgeReady || !active) {
        return (
            <div className="ask-shell">
                <div className="ask-frame">
                    {header}
                    <div className="ask-loading">
                        <Text size="sm" className="text-zinc-500">
                            Waiting for the question…
                        </Text>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={`ask-shell${drawerOpen ? ' with-file' : ''}`}>
            <div className="ask-frame">
                {header}

                {/* PendingQuestions v2 — the queue: pick which to answer next. Higher
                    priority sorts up, but the user chooses; nothing is auto-answered. */}
                {others.length > 0 && (
                    <div
                        style={{
                            display: 'flex',
                            gap: 6,
                            flexWrap: 'wrap',
                            padding: '8px 14px',
                            borderBottom: '1px solid var(--zinc-800, #27272a)',
                        }}
                    >
                        {pending.map((p) => {
                            const on = p.id === active.id;
                            const meta = p.priority ? PRIORITY_META[p.priority] : PRIORITY_META.normal;
                            return (
                                <button
                                    key={p.id}
                                    type="button"
                                    onClick={() => setPinnedId(p.id)}
                                    title={p.workspaceLabel ?? undefined}
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        padding: '3px 9px',
                                        borderRadius: 999,
                                        border: on
                                            ? '1px solid var(--violet-500, #8b5cf6)'
                                            : '1px solid var(--zinc-700, #3f3f46)',
                                        background: on ? 'var(--violet-500-a, rgba(139,92,246,.12))' : 'transparent',
                                        color: 'inherit',
                                        cursor: 'pointer',
                                        fontSize: 12,
                                    }}
                                >
                                    {meta.color && (
                                        <span
                                            aria-hidden
                                            style={{
                                                width: 7,
                                                height: 7,
                                                borderRadius: 999,
                                                background: meta.color,
                                            }}
                                        />
                                    )}
                                    <span>{p.questions[0]?.header ?? 'Question'}</span>
                                    {p.remoteHost ? (
                                        <span
                                            style={{
                                                opacity: 0.75,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                gap: 3,
                                            }}
                                            title={`Remote host: ${p.remoteHost}`}
                                        >
                                            <Icon name="cloud" size="xs" /> {p.remoteHost}
                                        </span>
                                    ) : p.workspaceLabel ? (
                                        <span style={{ opacity: 0.6 }}>· {p.workspaceLabel}</span>
                                    ) : null}
                                </button>
                            );
                        })}
                    </div>
                )}

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
                            <ContentRenderer
                                value={q.question}
                                format="markdown"
                                lineSpacing={1.55}
                                className="ask-q-content"
                            />
                            {canOpenFiles && (fileRefs[qi]?.length ?? 0) > 0 && (
                                <div className="ask-file-chips">
                                    {fileRefs[qi]!.map((ref) => (
                                        <button
                                            key={`${ref.path}:${ref.line ?? ''}${ref.section ?? ''}`}
                                            type="button"
                                            className={`ask-file-chip${
                                                openFile?.path === ref.path ? ' on' : ''
                                            }`}
                                            title={`Open ${ref.path}`}
                                            onClick={() =>
                                                setOpenFile((cur) =>
                                                    cur?.path === ref.path ? null : ref,
                                                )
                                            }
                                        >
                                            <Icon name="file-text" size="xs" />
                                            <span className="ask-file-chip-name">{ref.name}</span>
                                            {ref.section && (
                                                <span className="ask-file-chip-at">{ref.section}</span>
                                            )}
                                            {ref.line !== undefined && (
                                                <span className="ask-file-chip-at">:{ref.line}</span>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <div className="ask-options">
                                {q.options.map((o) => {
                                    const on = (draft.selected[qi] ?? []).includes(o.label);
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
                                value={draft.notes[qi] ?? ''}
                                onChange={(e) => {
                                    if (!active) return;
                                    const text = e.target.value;
                                    setDrafts((prev) => setDraftNote(prev, active.id, qi, text));
                                }}
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
                    <Action variant="ghost" size="sm" onClick={cancelActive}>
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

            {/* The file the question is about, BESIDE the question — never over it,
                and never by navigating this window (genie#196). The window itself
                widened to make room; see main/ask/drawer-bounds.ts. */}
            {openFile && (
                <aside className="ask-file-pane">
                    <div className="ask-file-head">
                        <Icon name="file-text" size="sm" className="text-zinc-500" />
                        <span className="ask-file-title">{openFile.name}</span>
                        {openFile.section && (
                            <span className="ask-file-chip-at">{openFile.section}</span>
                        )}
                        <span className="ask-file-path" title={openFile.path}>
                            {openFile.path}
                        </span>
                        <div style={{ flex: 1 }} />
                        <button
                            type="button"
                            className="ask-x"
                            onClick={() => setOpenFile(null)}
                            title="Close the file (Esc)"
                            aria-label="Close the file"
                        >
                            ✕
                        </button>
                    </div>
                    <div className="ask-file-view">
                        {fileState.status === 'loading' && (
                            <div className="ask-file-note">Opening {openFile.name}…</div>
                        )}
                        {fileState.status === 'error' && (
                            <div className="ask-file-note">
                                {openFile.path} could not be opened: {fileState.message}
                            </div>
                        )}
                        {fileState.status === 'ready' && (
                            <FileViewer
                                key={openFile.path}
                                filename={openFile.name}
                                value={fileState.content}
                                wordWrap
                            />
                        )}
                    </div>
                    {fileState.status === 'ready' && fileState.truncated && (
                        <div className="ask-file-note">
                            This file is too large to show in full — the rest is on disk.
                        </div>
                    )}
                </aside>
            )}
        </div>
    );
}
