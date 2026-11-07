import { memo, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { WorkspaceColorsContext, WorkspaceSwatch } from '../workspace-colors.js';
import { Badge, Button, ContentRenderer, Drawer, Icon, Input, Modal, Select, Textarea } from '@particle-academy/react-fancy';
import { genieClipboardWriter } from '../clipboard.js';
import { ago, filterCounts, filterThreads, HUMAN, pairKey, THREAD_FILTERS, type ThreadFilter, type ThreadSummary } from '../../core/inbox-threads.js';
import { highlightParts, inViewOrder, mergeWindow, ORDER_ICON, questionRef, scrollAfterInsert, searchSnippet, shortQuestionId, THREAD_BUFFER, type ThreadOrder } from '../../core/inbox-view.js';
import type { AskedRecord } from '../../main/attention-store.js';
import type { InboxMessage } from '../../main/inbox-store.js';
import type { InboxSearchResult, InboxSection, InboxThreadView } from '../features.js';
import { formatSize, type InboxCompose } from './FeatureSurfaces.js';
import { readAppSender, type AppSourceKind } from '../../core/app-inbox.js';

/** An app's icon by kind (genie#1345): a site, a background process, a script key. Icons over words. */
export const APP_KIND_ICON: Readonly<Record<AppSourceKind, string>> = { site: 'globe', process: 'cog', script: 'key-round' };
const APP_LEVEL_ICON: Readonly<Record<'info' | 'success' | 'failure', string>> = { info: 'info', success: 'circle-check', failure: 'circle-x' };
const APP_LEVEL_TONE: Readonly<Record<'info' | 'success' | 'failure', string>> = { info: 'text-[var(--fg-3)]', success: 'text-[var(--success)]', failure: 'text-[var(--danger)]' };

/** An app sender's mark: its kind's icon where an agent's workspace swatch would be. */
function AppMark({ id }: { id: string }) {
    const app = readAppSender(id);
    if (!app) return null;
    return (
        <span data-app-sender={app.kind} data-app-icon={APP_KIND_ICON[app.kind]} title={`An app (${app.kind}): read-only`} className="inline-flex shrink-0 items-center text-[var(--fg-3)]">
            <Icon name={APP_KIND_ICON[app.kind]} size="xs" />
        </span>
    );
}

/**
 * A message's Markdown, drawn once per text: React keeps it while the text is the same, so a thread update that adds or
 * patches one message re-renders that one card's Markdown, never every card's (the live-view rule, owner 2026-10-22).
 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
    return <ContentRenderer clipboardWriter={genieClipboardWriter} value={text} format="markdown" lineSpacing={1.5} className="text-[13px] text-[var(--fg-2)]" />;
});

/**
 * THE AGENTINBOX FLYOUT (beta.33 item 19; the owner: "the agentinbox should not be a page and it should be accessible
 * from the header system icons just like it was in genie 1").
 *
 * Genie 1's flyout, from its code (review-g1 `renderer/components/Master/AgentInboxFlyout.tsx`): it slides in from the
 * right below the title bar over a scrim; two panes — threads on the left (search, All / Unread / Stale, newest
 * activity first), the open thread on the right; a thread is a PAIR, the person's own with an agent (with a composer) or
 * two agents' (read-only, "You're observing", with a way to message one of them); attachments download; who is waiting
 * on mail. Its container is Fancy's `Drawer`, attached to the app's content row so the title bar — and its inbox icon —
 * stay reachable.
 *
 * What it does better than Genie 1, from the same code: search reads every message (Genie 1: names and a 140-character
 * preview); a thread pages back (`Load older`; Genie 1 stopped at 100); "waiting" is read from the mail itself, so it is
 * right after a reload (Genie 1's escalations lived in the open panel); `Mark all read` (Genie 1 had none); a new
 * conversation can be started with any agent from `New message` (Genie 1: only through its roster popover).
 *
 * Genie 2 has no urgent mail, so there are no escalations to raise: an agent's uncollected mail, and since when, is the
 * one fact Genie 1's escalation strip and lag badge were both about, and it is shown per thread.
 *
 * SORT, SEARCH, QUESTIONS (the owner, 2026-11-01: "msgs in the inbox should be sortable and searchable, sort newest on top
 * by default." and "for FTQ responses in the inbox, the id should be a link that expands to show the questions asked."):
 *  - the open thread shows NEWEST ON TOP by default; one icon Button flips it. Older mail pages in at the end of the list
 *    in that order. The thread on screen is a bounded buffer (`THREAD_BUFFER`) that each answer is merged into
 *    (core/inbox-view.ts); new mail at the top does not move a person who has scrolled down;
 *  - the thread's search runs HOST-side over its stored mail (`inbox.search`), so history not loaded is found; hits mark
 *    the match and a press jumps to the message in the thread;
 *  - an FTQ answer's question id is a link Button that opens, in place, the questions as they were asked: every option,
 *    the chosen ones marked, the notes (`inbox.question`, from the attention store's records).
 *
 * The list's own search (left) already reads names and every message's text host-side: each thread's summary carries
 * it (`haystack`, core/inbox-threads.ts), so it needs no second search box.
 */

/** How many messages a thread opens with; each `Load older` adds as many. */
export const THREAD_PAGE = 50;

/** The `inbox=` value (core/route.ts): `''` = the threads, a thread key, or a message id (`msg_…`). */
export function inboxTarget(value: string): { kind: 'list' } | { kind: 'thread'; key: string } | { kind: 'message'; id: string } {
    if (value === '') return { kind: 'list' };
    if (value.startsWith('msg_')) return { kind: 'message', id: value };
    return { kind: 'thread', key: value };
}

/** A thread search as the flyout holds it: running, answered, or failed (with why). */
export interface ThreadSearchState {
    readonly query: string;
    readonly status: 'searching' | 'done' | 'error';
    readonly hits: readonly InboxMessage[];
    readonly total: number;
    readonly error: string | null;
}

/** What the expand shows of a decided question: the record's fields the person reads. */
export type QuestionRecordView = Pick<AskedRecord, 'id' | 'agentName' | 'askedAt' | 'at' | 'outcome' | 'questions' | 'selections' | 'notes' | 'note'>;

/** One question id's expand: loading, read, no record kept, or failed. */
export type QuestionState =
    | { readonly status: 'loading' }
    | { readonly status: 'ok'; readonly record: QuestionRecordView }
    | { readonly status: 'gone' }
    | { readonly status: 'error'; readonly error: string };

export interface InboxFlyoutViewProps {
    threads: readonly ThreadSummary[];
    peers: InboxSection['peers'];
    /** The thread on screen, as loaded; `null` = none open (or still loading, with `loading`). */
    thread: InboxThreadView | null;
    /** The open thread's key while it loads or when it has no mail yet (a new conversation). */
    openKey: string | null;
    loading?: boolean | undefined;
    query: string;
    filter: ThreadFilter;
    now: number;
    /** Mail every agent has not collected. */
    uncollected: number;
    /** The person's unread mail. */
    unread: number;
    error?: string | null | undefined;
    sending?: boolean | undefined;
    draft: string;
    compose?: InboxCompose | undefined;
    onQuery: (q: string) => void;
    onFilter: (f: ThreadFilter) => void;
    onOpenThread: (key: string | null) => void;
    onLoadOlder: () => void;
    onDraft: (text: string) => void;
    onSend: () => void;
    onDownload: (attachmentId: string, name: string) => void;
    onMarkAllRead: () => void;
    onDelete: (key: string) => void;
    onClose: () => void;
    /** Agent id → its workspace's colour (genie#1300), drawn beside its name on a thread. Absent = none. */
    agentColors?: Readonly<Record<string, string>> | undefined;
    /** The open thread's order; absent = newest on top (the default). */
    order?: ThreadOrder | undefined;
    onOrder?: ((order: ThreadOrder) => void) | undefined;
    /** A `Load older` is on its way. */
    loadingOlder?: boolean | undefined;
    /** Back to the newest page (the buffer's newest end was trimmed, or the thread was opened at a search hit). */
    onBackToNewest?: (() => void) | undefined;
    /** The open thread's search as typed; non-empty = the results show instead of the thread. */
    threadQuery?: string | undefined;
    onThreadQuery?: ((query: string) => void) | undefined;
    search?: ThreadSearchState | null | undefined;
    onRetrySearch?: (() => void) | undefined;
    /** A search hit pressed: show it in its thread. */
    onJump?: ((hit: InboxMessage) => void) | undefined;
    /** Question id → its expand's state. */
    questions?: Readonly<Record<string, QuestionState>> | undefined;
    /** The question ids open. */
    expandedQuestions?: readonly string[] | undefined;
    onToggleQuestion?: ((questionId: string) => void) | undefined;
    onRetryQuestion?: ((questionId: string) => void) | undefined;
    /** The thread's scroller, for the container's scroll rule. */
    scrollRef?: Ref<HTMLDivElement> | undefined;
}

const FILTER_LABEL: Record<ThreadFilter, string> = { all: 'All', unread: 'Unread', waiting: 'Waiting', stale: 'Stale' };
const ORDER_LABEL: Record<ThreadOrder, string> = { newest: 'Newest first', oldest: 'Oldest first' };

/** The agent in a pair that is not the person (or the first agent of two agents). */
const otherOf = (a: string, b: string): string => (a === HUMAN ? b : a);

/** Text with the query's matches marked. */
function marked(text: string, query: string): ReactNode[] {
    return highlightParts(text, query).map((part, i) =>
        part.hit ? <mark key={i} data-search-hit="" className="rounded-sm bg-[var(--warning)]/30 px-0.5 text-[var(--fg-1)]">{part.text}</mark> : <span key={i}>{part.text}</span>,
    );
}

/** A decided question, as it was asked: every question, every option (chosen ones marked), the notes. */
function questionPanel(id: string, state: QuestionState | undefined, onRetry: ((id: string) => void) | undefined): ReactNode {
    return (
        <div data-question-panel={id} className="flex flex-col gap-3 rounded-md border border-[var(--border-1)] bg-[var(--bg-2)] px-3 py-2">
            {state === undefined || state.status === 'loading' ? (
                <div data-question-loading="" className="flex items-center gap-2 text-[12px] text-[var(--fg-3)]">
                    <Icon name="loader-circle" size="xs" className="animate-spin" />
                    <span>Loading the questions…</span>
                </div>
            ) : state.status === 'gone' ? (
                <div data-question-gone="" className="flex items-center gap-2 text-[12px] text-[var(--fg-3)]">
                    <Icon name="archive-x" size="xs" />
                    <span>The questions asked are no longer kept for this id; only the answer is.</span>
                </div>
            ) : state.status === 'error' ? (
                <div data-question-error="" role="alert" className="flex items-center gap-2 text-[12px] text-[var(--danger)]">
                    <Icon name="circle-x" size="xs" />
                    <span className="min-w-0 flex-1">{state.error}</span>
                    <Button type="button" size="xs" variant="ghost" icon="rotate-ccw" data-action="inbox-question-retry" onClick={() => onRetry?.(id)}>Retry</Button>
                </div>
            ) : (
                <>
                    {state.record.questions.map((q, i) => {
                        const chosen = state.record.selections[i] ?? [];
                        const note = (state.record.notes[i] ?? '').trim();
                        const multi = q.multiSelect === true;
                        return (
                            <div key={i} data-question-item={i} className="flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                    <Badge size="sm" variant="soft" color="violet">{q.header}</Badge>
                                    {multi ? <span title="More than one could be chosen" className="inline-flex text-[var(--fg-4)]"><Icon name="list-checks" size="xs" /></span> : null}
                                </div>
                                <Markdown text={q.question} />
                                <ul className="flex flex-col gap-0.5">
                                    {q.options.map((o) => {
                                        const on = chosen.includes(o.label);
                                        return (
                                            <li key={o.label} data-option={o.label} data-chosen={on ? 'true' : 'false'} className={`flex items-start gap-2 text-[12px] ${on ? 'font-medium text-[var(--fg-1)]' : 'text-[var(--fg-3)]'}`}>
                                                <span className={`mt-0.5 inline-flex ${on ? 'text-[var(--success)]' : 'text-[var(--fg-4)]'}`}>
                                                    <Icon name={on ? (multi ? 'square-check' : 'circle-check') : multi ? 'square' : 'circle'} size="xs" />
                                                </span>
                                                <span className="min-w-0">
                                                    <span>{o.label}</span>
                                                    {o.description ? <span className="font-normal text-[var(--fg-3)]">{` — ${o.description}`}</span> : null}
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ul>
                                {note ? (
                                    <div data-question-note="" className="flex items-start gap-1.5 text-[12px] text-[var(--fg-2)]">
                                        <span className="mt-0.5 inline-flex text-[var(--fg-4)]"><Icon name="sticky-note" size="xs" /></span>
                                        <span className="whitespace-pre-wrap break-words">{note}</span>
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                    {state.record.note.trim() ? (
                        <div data-question-note="overall" className="flex items-start gap-1.5 border-t border-[var(--border-1)] pt-2 text-[12px] text-[var(--fg-2)]">
                            <span className="mt-0.5 inline-flex text-[var(--fg-4)]"><Icon name="sticky-note" size="xs" /></span>
                            <span className="whitespace-pre-wrap break-words">{state.record.note.trim()}</span>
                        </div>
                    ) : null}
                    {state.record.outcome === 'dismissed' ? (
                        <div data-question-dismissed="" className="flex items-center gap-1.5 text-[12px] text-[var(--fg-3)]">
                            <Icon name="circle-slash" size="xs" />
                            <span>Dismissed: nothing chosen</span>
                        </div>
                    ) : null}
                </>
            )}
        </div>
    );
}

/** Hook-free: everything on screen comes in as props, so a test can render and press it. */
export function InboxFlyoutView(p: InboxFlyoutViewProps) {
    const agentColors = p.agentColors ?? {};
    const shown = filterThreads(p.threads, { filter: p.filter, query: p.query, now: p.now });
    const counts = filterCounts(p.threads, p.now);
    const summary = p.openKey ? p.threads.find((t) => t.key === p.openKey) ?? null : null;
    const [a, b] = p.openKey ? (p.openKey.split('|') as [string, string]) : ['', ''];
    const withHuman = p.openKey !== null && (a === HUMAN || b === HUMAN);
    const nameOf = (id: string): string => (id === HUMAN ? 'you' : summary ? (id === summary.a ? summary.aName : summary.bName) : p.peers.find((x) => x.agentId === id)?.name ?? id);
    const agentOfThread = p.openKey ? otherOf(a, b) : null;
    const reachable = p.peers.filter((x) => x.reachable && x.agentId);
    const order: ThreadOrder = p.order ?? 'newest';
    const threadQuery = p.threadQuery ?? '';
    const searching = threadQuery.trim() !== '';
    const expanded = new Set(p.expandedQuestions ?? []);
    const messages = p.thread ? inViewOrder(p.thread.messages, order) : [];

    const loadOlder = p.thread?.more ? (
        <Button type="button" size="xs" variant="ghost" icon={order === 'newest' ? 'chevrons-down' : 'chevrons-up'} data-action="inbox-load-older" loading={p.loadingOlder === true} disabled={p.loadingOlder === true} onClick={p.onLoadOlder} className="self-center">Load older</Button>
    ) : null;
    const backToNewest = p.thread?.newer ? (
        <Button type="button" size="xs" variant="ghost" icon={order === 'newest' ? 'arrow-up-to-line' : 'arrow-down-to-line'} data-action="inbox-back-to-newest" onClick={p.onBackToNewest} className="self-center">Newest</Button>
    ) : null;

    const card = (m: InboxMessage): ReactNode => {
        // An FTQ answer (or dismissal) the PERSON sent names its question: the id becomes the way to see what was asked.
        const ref = m.from === HUMAN && !m.app ? questionRef(m.text) : null;
        const open = ref !== null && expanded.has(ref.id);
        return (
            <div
                key={m.id}
                data-inbox-message={m.id}
                data-focus={p.thread?.focus === m.id ? 'true' : undefined}
                className={`flex flex-col gap-1 rounded-lg border px-3 py-2 ${p.thread?.focus === m.id ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border-1)]'}`}
            >
                <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--fg-3)]">
                    <span className="text-[var(--violet-400)]">{`${nameOf(m.from)} → ${nameOf(m.to)}`}</span>
                    <span>{ago(Date.parse(m.sentAt), p.now)}</span>
                    {m.to !== HUMAN && m.readAt === null ? <span data-message-waiting="" className="text-[var(--warning)]">not collected yet</span> : null}
                    {m.to !== HUMAN && m.readAt !== null ? <span className="text-[var(--fg-4)]">{`read ${ago(Date.parse(m.readAt), p.now)} ago`}</span> : null}
                </div>
                {m.app && readAppSender(m.from) ? (
                    /* AN APP'S MESSAGE (genie#1345): its subject and level, its link as a button, and its body as
                       PLAIN text — an app cannot draw links or markup in the person's flyout. */
                    <div data-app-message={m.app.source.kind} className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--fg-1)]">
                            <span data-app-level={m.app.level} className={`inline-flex ${APP_LEVEL_TONE[m.app.level]}`}><Icon name={APP_LEVEL_ICON[m.app.level]} size="xs" /></span>
                            <span className="min-w-0 truncate">{m.app.subject}</span>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-[13px] text-[var(--fg-2)]">{m.text}</p>
                        {m.app.link ? (
                            <Button data-app-link={m.app.link} href={m.app.link} target="_blank" rel="noreferrer" size="xs" variant="ghost" icon="external-link" className="w-fit border border-[var(--border-1)]">
                                {new URL(m.app.link).host}
                            </Button>
                        ) : null}
                    </div>
                ) : ref ? (
                    <>
                        <div className="flex items-center gap-1.5">
                            <Button
                                href={`#${ref.id}`}
                                size="xs"
                                variant="ghost"
                                icon="message-circle-question"
                                iconTrailing={open ? 'chevron-up' : 'chevron-down'}
                                data-question-ref={ref.id}
                                title={ref.id}
                                aria-expanded={open}
                                aria-label={`${open ? 'Hide' : 'Show'} the questions asked, ${ref.id}`}
                                onClick={(e: { preventDefault: () => void }) => { e.preventDefault(); p.onToggleQuestion?.(ref.id); }}
                                className="border border-[var(--border-1)] font-mono text-[var(--accent)]"
                            >
                                {shortQuestionId(ref.id)}
                            </Button>
                        </div>
                        {open ? questionPanel(ref.id, p.questions?.[ref.id], p.onRetryQuestion) : null}
                        {ref.rest.trim() ? <Markdown text={ref.rest} /> : null}
                    </>
                ) : (
                    <Markdown text={m.text} />
                )}
                {m.attachments.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                        {m.attachments.map((att) => (
                            <Button key={att.id} type="button" size="xs" variant="ghost" icon="paperclip" iconTrailing="download" data-inbox-attachment={att.id} title={`Download ${att.name}`} onClick={() => p.onDownload(att.id, att.name)}>
                                {`${att.name} · ${formatSize(att.size)}`}
                            </Button>
                        ))}
                    </div>
                ) : null}
            </div>
        );
    };

    const results = (): ReactNode => {
        const s = p.search;
        if (!s || s.status === 'searching') {
            return (
                <div data-inbox-searching="" className="flex items-center gap-2 text-[12px] text-[var(--fg-3)]">
                    <Icon name="loader-circle" size="xs" className="animate-spin" />
                    <span>Searching…</span>
                </div>
            );
        }
        if (s.status === 'error') {
            return (
                <div data-inbox-search-error="" role="alert" className="flex items-center gap-2 text-[12px] text-[var(--danger)]">
                    <Icon name="circle-x" size="xs" />
                    <span className="min-w-0 flex-1">{s.error ?? 'The search failed.'}</span>
                    <Button type="button" size="xs" variant="ghost" icon="rotate-ccw" data-action="inbox-search-retry" onClick={p.onRetrySearch}>Retry</Button>
                </div>
            );
        }
        if (s.total === 0) {
            return (
                <div data-inbox-no-matches="" className="flex items-center gap-2 text-[12px] text-[var(--fg-3)]">
                    <Icon name="search-x" size="xs" />
                    <span>No matches</span>
                </div>
            );
        }
        const hits = order === 'newest' ? s.hits : [...s.hits].reverse();
        return (
            <>
                <div data-inbox-search-count={s.total} className="font-mono text-[11px] text-[var(--fg-3)]">
                    {s.total > s.hits.length ? `${s.total} · newest ${s.hits.length}` : `${s.total}`}
                </div>
                {hits.map((m) => (
                    <Button
                        key={m.id}
                        type="button"
                        variant="ghost"
                        data-inbox-search-hit={m.id}
                        title="Show it in the thread"
                        onClick={() => p.onJump?.(m)}
                        className="w-full flex-col items-stretch justify-start rounded-lg border border-[var(--border-1)] px-3 py-2 text-left hover:bg-[var(--bg-2)]"
                        labelClassName="flex w-full flex-col gap-1 whitespace-normal"
                    >
                        <span className="flex items-center gap-2 font-mono text-[11px] text-[var(--fg-3)]">
                            <span className="text-[var(--violet-400)]">{marked(`${nameOf(m.from)} → ${nameOf(m.to)}`, s.query)}</span>
                            <span>{ago(Date.parse(m.sentAt), p.now)}</span>
                        </span>
                        <span className="break-words text-[13px] font-normal text-[var(--fg-2)]">{marked(searchSnippet(m.text, s.query, 90), s.query)}</span>
                    </Button>
                ))}
            </>
        );
    };

    return (
        <div data-inbox-flyout="" className="flex h-full min-h-0 flex-col">
            <Drawer.Header>
                <div className="flex items-center gap-3">
                    <Icon name="mail" size="sm" />
                    <span className="text-[14px] font-semibold">AgentInbox</span>
                    {p.unread > 0 ? <Badge data-inbox-unread={p.unread} color="amber" variant="soft" size="sm">{`${p.unread} unread`}</Badge> : null}
                    {p.uncollected > 0 ? <Badge data-inbox-uncollected={p.uncollected} color="violet" variant="soft" size="sm">{`${p.uncollected} waiting for agents`}</Badge> : null}
                    <span className="ml-auto" />
                    {p.unread > 0 ? <Button type="button" size="sm" variant="ghost" data-action="inbox-mark-all-read" onClick={p.onMarkAllRead}>Mark all read</Button> : null}
                </div>
            </Drawer.Header>
            <div className="flex min-h-0 flex-1">
                {/* THE THREADS: search, filters, newest activity first. */}
                <div data-inbox-threads="" className="flex w-[340px] min-w-[260px] shrink-0 flex-col border-r border-[var(--border-1)]">
                    <div className="flex flex-col gap-2 border-b border-[var(--border-1)] p-3">
                        <Input data-inbox-search="" value={p.query} placeholder="Search names and messages…" onValueChange={p.onQuery} aria-label="Search the AgentInbox" />
                        <div className="flex flex-wrap gap-1">
                            {THREAD_FILTERS.map((f) => (
                                <Button key={f} type="button" size="xs" variant={p.filter === f ? 'default' : 'ghost'} data-inbox-filter={f} aria-pressed={p.filter === f} onClick={() => p.onFilter(f)}>
                                    {`${FILTER_LABEL[f]} ${counts[f]}`}
                                </Button>
                            ))}
                        </div>
                        {reachable.length > 0 ? (
                            <Select
                                data-inbox-new=""
                                aria-label="New message to"
                                placeholder="New message to…"
                                list={reachable.map((x) => ({ value: x.agentId!, label: x.name }))}
                                value=""
                                onValueChange={(agentId) => { if (agentId) p.onOpenThread(pairKey(HUMAN, agentId)); }}
                            />
                        ) : null}
                    </div>
                    <ul className="min-h-0 flex-1 overflow-y-auto">
                        {shown.length === 0 ? (
                            <li data-inbox-empty="" className="px-4 py-6 text-[13px] text-[var(--fg-3)]">
                                {p.threads.length === 0 ? 'No mail yet. Agents and you write here; agent-to-agent threads show too.' : 'No thread matches.'}
                            </li>
                        ) : shown.map((t) => (
                            <li key={t.key}>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    data-inbox-thread={t.key}
                                    data-active={t.key === p.openKey ? 'true' : undefined}
                                    onClick={() => p.onOpenThread(t.key)}
                                    className={`w-full flex-col items-stretch justify-start rounded-none border-b border-[var(--border-1)] px-3 py-2 text-left font-normal hover:bg-[var(--bg-2)] ${t.key === p.openKey ? 'bg-[var(--bg-2)]' : ''}`}
                                    labelClassName="flex w-full flex-col gap-0.5 whitespace-normal"
                                >
                                    <span className="flex items-center gap-2 text-[13px]">
                                        {/* Each agent's workspace colour beside its name (genie#1300): whose thread this is. */}
                                        {(t.withHuman ? [t.a === HUMAN ? t.b : t.a] : [t.a, t.b]).map((id) => (readAppSender(id) ? <AppMark key={id} id={id} /> : <WorkspaceSwatch key={id} color={agentColors[id]} />))}
                                        <span className={t.unread > 0 ? 'font-semibold text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}>{t.withHuman ? (t.a === HUMAN ? t.bName : t.aName) : `${t.aName} ⇄ ${t.bName}`}</span>
                                        {t.withHuman || readAppSender(t.a) || readAppSender(t.b) ? null : <span data-thread-lock="" className="inline-flex"><Icon name="lock" size="xs" className="text-[var(--fg-4)]" /></span>}
                                        {t.attachments > 0 ? <Icon name="paperclip" size="xs" className="text-[var(--fg-4)]" /> : null}
                                        <span className="ml-auto font-mono text-[11px] text-[var(--fg-4)]">{Number.isNaN(t.lastAt) ? '' : ago(t.lastAt, p.now)}</span>
                                    </span>
                                    <span className="truncate text-[12px] text-[var(--fg-3)]">{`${t.lastFrom}: ${t.lastPreview}`}</span>
                                    <span className="flex items-center gap-2 font-mono text-[11px]">
                                        {t.unread > 0 ? <span data-thread-unread={t.unread} className="text-[var(--warning)]">{`${t.unread} unread`}</span> : null}
                                        {t.waiting ? <span data-thread-waiting={t.waiting.count} className="text-[var(--violet-400)]">{`waiting on ${t.waiting.agent} · ${ago(t.waiting.since, p.now)}`}</span> : null}
                                    </span>
                                </Button>
                            </li>
                        ))}
                    </ul>
                </div>

                {/* THE OPEN THREAD. */}
                <div data-inbox-thread-pane="" className="flex min-w-0 flex-1 flex-col">
                    {p.openKey === null ? (
                        <div className="m-auto max-w-[360px] text-center text-[13px] text-[var(--fg-3)]">Pick a thread, or start one with New message.</div>
                    ) : (
                        <>
                            <div className="flex items-center gap-2 border-b border-[var(--border-1)] px-4 py-2">
                                <span className="text-[13px] font-semibold">{withHuman ? nameOf(agentOfThread!) : `${nameOf(a)} ⇄ ${nameOf(b)}`}</span>
                                <span className="text-[12px] text-[var(--fg-3)]">{withHuman ? 'Your direct thread' : readAppSender(a) || readAppSender(b) ? 'An app’s messages · read-only' : 'Agent-to-agent thread · read-only'}</span>
                                {summary?.waiting ? <span className="font-mono text-[11px] text-[var(--violet-400)]">{`${summary.waiting.count} not collected by ${summary.waiting.agent} · ${ago(summary.waiting.since, p.now)}`}</span> : null}
                                <span className="ml-auto" />
                                <div className="w-[200px]">
                                    <Input
                                        data-inbox-thread-search=""
                                        type="search"
                                        size="sm"
                                        value={threadQuery}
                                        placeholder="Search…"
                                        aria-label="Search this thread"
                                        leading={<Icon name="search" size="xs" />}
                                        onValueChange={(v: string) => p.onThreadQuery?.(v)}
                                    />
                                </div>
                                <Button
                                    type="button"
                                    size="xs"
                                    variant="ghost"
                                    icon={ORDER_ICON[order]}
                                    data-action="inbox-sort"
                                    data-order={order}
                                    aria-label={ORDER_LABEL[order]}
                                    title={`${ORDER_LABEL[order]} · press for ${ORDER_LABEL[order === 'newest' ? 'oldest' : 'newest'].toLowerCase()}`}
                                    onClick={() => p.onOrder?.(order === 'newest' ? 'oldest' : 'newest')}
                                />
                                {summary ? <Button type="button" size="xs" variant="ghost" icon="trash-2" data-action="inbox-delete-thread" title="Delete thread" onClick={() => p.onDelete(summary.key)}>Delete thread</Button> : null}
                            </div>
                            <div ref={p.scrollRef} data-inbox-messages="" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 [overflow-anchor:none]">
                                {searching ? results() : (
                                    <>
                                        {order === 'newest' ? backToNewest : loadOlder}
                                        {p.loading && !p.thread ? <div className="text-[12px] text-[var(--fg-3)]">Loading…</div> : null}
                                        {p.thread && p.thread.messages.length === 0 ? <div className="text-[12px] text-[var(--fg-3)]">No messages yet.</div> : null}
                                        {messages.map(card)}
                                        {order === 'newest' ? loadOlder : backToNewest}
                                    </>
                                )}
                            </div>
                            {p.error ? <div data-inbox-error="" role="alert" className="border-t border-[var(--danger)] px-4 py-1.5 text-[12px] text-[var(--danger)]">{p.error}</div> : null}
                            {withHuman ? (
                                <div data-inbox-composer="" className="flex flex-col gap-2 border-t border-[var(--border-1)] p-3">
                                    {p.compose && p.compose.attachments.length > 0 ? (
                                        <div className="flex flex-wrap gap-1">
                                            {p.compose.attachments.map((path) => {
                                                const base = path.split(/[\\/]/).pop() ?? path;
                                                return <Button key={path} type="button" size="xs" variant="ghost" iconTrailing="x" data-attached={base} aria-label={`remove ${base}`} onClick={() => p.compose!.onRemove(path)}>{base}</Button>;
                                            })}
                                        </div>
                                    ) : null}
                                    <Textarea data-inbox-draft="" value={p.draft} autoResize minRows={2} maxRows={8} placeholder={`Message ${nameOf(agentOfThread!)} — it reads it with agentinbox receive`} onValueChange={p.onDraft} aria-label="Message" />
                                    <div className="flex items-center gap-2">
                                        {p.compose ? <Button type="button" size="sm" variant="ghost" icon="paperclip" data-action="attach-files" onClick={p.compose.onPick}>Attach…</Button> : null}
                                        <span className="ml-auto" />
                                        <Button type="button" size="sm" data-action="inbox-send" disabled={p.sending === true || p.draft.trim() === ''} onClick={p.onSend}>{p.sending ? 'Sending…' : 'Send'}</Button>
                                    </div>
                                </div>
                            ) : (
                                <div data-inbox-readonly="" className="flex items-center gap-2 border-t border-[var(--border-1)] px-4 py-2 text-[12px] text-[var(--fg-3)]">
                                    <Icon name="lock" size="xs" />
                                    <span>Agent-to-agent thread · read-only. You are observing.</span>
                                    <span className="ml-auto" />
                                    {[a, b].map((id) => (
                                        <Button key={id} type="button" size="xs" variant="ghost" data-action="inbox-message-agent" data-agent={id} onClick={() => p.onOpenThread(pairKey(HUMAN, id))}>{`Message ${nameOf(id)}`}</Button>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export interface InboxFlyoutProps {
    /** The route's `inbox=` value (`''`, a thread key, or a message id); `null` = closed. */
    value: string | null;
    inbox: InboxSection | null;
    compose?: InboxCompose | undefined;
    /** Ask main for a window of a thread (the `inbox.thread` action's answer). */
    loadThread: (req: { key?: string; messageId?: string; limit: number; beforeSeq?: number; fromSeq?: number }) => Promise<InboxThreadView | null>;
    /** Search one thread's stored mail host-side (the `inbox.search` action's answer). */
    searchThread: (key: string, query: string) => Promise<InboxSearchResult | null>;
    /** A decided question's record by its id (the `inbox.question` action's answer). */
    loadQuestion: (questionId: string) => Promise<{ id: string; record: AskedRecord | null } | null>;
    /** Send to an agent by its address; resolves when sent, rejects with the reason. */
    send: (to: string, text: string, attachments: readonly string[]) => Promise<void>;
    /** An attachment's bytes (the `inbox.attachment` action's answer). */
    attachment: (attachmentId: string) => Promise<{ name: string; base64: string } | null>;
    markAllRead: () => void;
    deleteThread: (key: string) => void;
    /** Move the flyout: another thread (`key`), back to the list (`''`), or closed (`null`). */
    onNavigate: (value: string | null) => void;
}

/** Save bytes as a download (Genie 1's attachment download: a Blob and `<a download>`, path-stripped name). */
function download(name: string, base64: string): void {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a');
    a.href = url;
    a.download = name.split(/[\\/]/).pop() ?? 'attachment';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** The thread on screen: the buffer (oldest first) and what lies beyond either end of it. */
interface ThreadWin {
    readonly key: string;
    readonly messages: readonly InboxMessage[];
    /** Older mail exists before the buffer. */
    readonly more: boolean;
    /** Newer mail exists after it: the newest end was trimmed, or the thread was opened at a search hit. */
    readonly newer: boolean;
    readonly focus: string | null;
}

/** How long typing rests before a thread search is asked. */
const SEARCH_REST_MS = 250;
/** A live refresh asks for everything from the buffer's oldest message on; the host caps it, the merge bounds it. */
const LIVE_LIMIT = THREAD_BUFFER * 4;

/** The flyout with its state: search, filter, the open thread (re-read when its summary moves — a push, never a poll). */
export function InboxFlyout({ value, inbox, compose, loadThread, searchThread, loadQuestion, send, attachment, markAllRead, deleteThread, onNavigate }: InboxFlyoutProps) {
    const colors = useContext(WorkspaceColorsContext);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<ThreadFilter>('all');
    const [win, setWin] = useState<ThreadWin | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const [order, setOrder] = useState<ThreadOrder>('newest');
    const [threadQuery, setThreadQuery] = useState('');
    const [search, setSearch] = useState<ThreadSearchState | null>(null);
    const [searchNonce, setSearchNonce] = useState(0);
    const [questions, setQuestions] = useState<Record<string, QuestionState>>({});
    const [expandedQuestions, setExpandedQuestions] = useState<readonly string[]>([]);
    /** The thread whose Delete is being confirmed (Genie 1 asked first, too). */
    const [confirming, setConfirming] = useState<string | null>(null);
    const scroller = useRef<HTMLDivElement | null>(null);
    /** Why the list is about to change and where the scroller was: the scroll rule's input (core/inbox-view.ts). */
    const pendingScroll = useRef<{ cause: 'live' | 'older' | 'reset' | 'jump'; prevTop: number; prevHeight: number } | null>(null);
    /** Bumped on every fresh load of a thread: an answer to an older load is dropped. */
    const epoch = useRef(0);
    /** The thread summary's stamp at the last load or refresh. */
    const seenStamp = useRef('');

    const target = value === null ? null : inboxTarget(value);
    const threads = inbox?.threads ?? [];
    // The open thread's key: the route's, or — opened on a message — the one main answered with.
    const openKey = target?.kind === 'thread' ? target.key : target?.kind === 'message' ? win?.key ?? null : null;
    const summary = openKey ? threads.find((t) => t.key === openKey) ?? null : null;
    // What makes the open thread worth reading again: new mail in it, or its read state moving (both arrive as a push).
    const stamp = summary ? `${summary.lastSeq}:${summary.unread}:${summary.waiting?.count ?? 0}:${summary.count}` : '';

    const remember = (cause: 'live' | 'older' | 'reset' | 'jump'): void => {
        const el = scroller.current;
        pendingScroll.current = { cause, prevTop: el?.scrollTop ?? 0, prevHeight: el?.scrollHeight ?? 0 };
    };

    /** A fresh load: the newest page (or, from a search hit, the page from it on). Anything still on its way is dropped. */
    const fresh = (req: { key?: string; messageId?: string; fromSeq?: number }, focus: string | null, cause: 'reset' | 'jump'): void => {
        const mine = ++epoch.current;
        seenStamp.current = stamp;
        setLoading(true);
        setNow(Date.now());
        void loadThread({ ...req, limit: THREAD_PAGE })
            .then((t) => {
                if (mine !== epoch.current) return;
                remember(cause);
                setWin(t ? { key: t.key, messages: t.messages, more: t.more, newer: t.newer === true, focus: focus ?? t.focus } : null);
                setError(null);
            })
            .catch((e: unknown) => { if (mine === epoch.current) { setWin(null); setError((e as Error).message); } })
            .finally(() => { if (mine === epoch.current) setLoading(false); });
    };

    // Opening a thread (or a message in one): a fresh load.
    useEffect(() => {
        if (target === null || target.kind === 'list') { epoch.current++; setWin(null); return; }
        fresh(target.kind === 'thread' ? { key: target.key } : { messageId: target.id }, null, 'reset');
    }, [value]);

    // A push moved the open thread: refresh what is on screen and take the new mail — merged, never rebuilt.
    useEffect(() => {
        if (!win || win.key !== openKey || stamp === '' || stamp === seenStamp.current) return;
        seenStamp.current = stamp;
        const first = win.messages[0];
        if (!first) { fresh({ key: win.key }, null, 'reset'); return; }
        const mine = epoch.current;
        // Following the newest end: take everything new (the oldest end gives way). Paged far back: patch the window only.
        const following = !win.newer;
        void loadThread({ key: win.key, fromSeq: first.seq, limit: following ? LIVE_LIMIT : win.messages.length })
            .then((t) => {
                if (!t || mine !== epoch.current) return;
                remember('live');
                setNow(Date.now());
                setWin((w) => {
                    if (!w || w.key !== t.key) return w;
                    const merged = mergeWindow(w.messages, t.messages, { from: first.seq, to: t.newer ? (t.messages.at(-1)?.seq ?? first.seq) : Infinity }, following ? 'oldest' : 'newest', THREAD_BUFFER);
                    return { ...w, messages: merged.messages, more: w.more || (following && merged.trimmed), newer: following ? t.newer === true : w.newer || t.newer === true };
                });
            })
            .catch((e: unknown) => { if (mine === epoch.current) setError((e as Error).message); });
    }, [stamp, win?.key, openKey]);

    // A different thread starts with an empty composer and no search.
    useEffect(() => { setDraft(''); setError(null); setThreadQuery(''); setSearch(null); }, [openKey]);

    // THE THREAD SEARCH: asked host-side once typing rests; progress shows at once.
    useEffect(() => {
        const q = threadQuery.trim();
        if (!openKey || q === '') { setSearch(null); return; }
        setSearch((s) => ({ query: threadQuery, status: 'searching', hits: s?.hits ?? [], total: s?.total ?? 0, error: null }));
        let live = true;
        const timer = setTimeout(() => {
            void searchThread(openKey, threadQuery)
                .then((r) => { if (live) { setNow(Date.now()); setSearch({ query: threadQuery, status: 'done', hits: r?.hits ?? [], total: r?.total ?? 0, error: null }); } })
                .catch((e: unknown) => { if (live) setSearch({ query: threadQuery, status: 'error', hits: [], total: 0, error: (e as Error).message }); });
        }, SEARCH_REST_MS);
        return () => { live = false; clearTimeout(timer); };
    }, [threadQuery, openKey, searchNonce]);

    // THE SCROLL RULE (core/inbox-view.ts): after the list changes, keep the reading position where rows went in above it.
    useLayoutEffect(() => {
        const el = scroller.current;
        const pending = pendingScroll.current;
        pendingScroll.current = null;
        if (!el || !pending) return;
        if (pending.cause === 'jump') {
            el.querySelector('[data-focus="true"]')?.scrollIntoView?.({ block: 'center' });
            return;
        }
        const top = scrollAfterInsert({ order, cause: pending.cause, prevTop: pending.prevTop, prevHeight: pending.prevHeight, newHeight: el.scrollHeight });
        if (top !== null) el.scrollTop = top;
    }, [win]);
    // A flipped order starts at the newest end.
    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const top = scrollAfterInsert({ order, cause: 'reset', prevTop: el.scrollTop, prevHeight: el.scrollHeight, newHeight: el.scrollHeight });
        if (top !== null) el.scrollTop = top;
    }, [order]);

    const onLoadOlder = (): void => {
        const w = win;
        const first = w?.messages[0];
        if (!w || !first || loadingOlder) return;
        const mine = epoch.current;
        setLoadingOlder(true);
        void loadThread({ key: w.key, beforeSeq: first.seq, limit: THREAD_PAGE })
            .then((t) => {
                if (!t || mine !== epoch.current) return;
                remember('older');
                setWin((cur) => {
                    if (!cur || cur.key !== t.key) return cur;
                    const covers = { from: t.more ? (t.messages[0]?.seq ?? first.seq) : -Infinity, to: first.seq - 1 };
                    const merged = mergeWindow(cur.messages, t.messages, covers, 'newest', THREAD_BUFFER);
                    return { ...cur, messages: merged.messages, more: t.more, newer: cur.newer || merged.trimmed };
                });
                setError(null);
            })
            .catch((e: unknown) => { if (mine === epoch.current) setError((e as Error).message); })
            .finally(() => setLoadingOlder(false));
    };

    const askQuestion = (id: string): void => {
        setQuestions((q) => ({ ...q, [id]: { status: 'loading' } }));
        void loadQuestion(id)
            .then((r) => setQuestions((q) => ({ ...q, [id]: r?.record ? { status: 'ok', record: r.record } : { status: 'gone' } })))
            .catch((e: unknown) => setQuestions((q) => ({ ...q, [id]: { status: 'error', error: (e as Error).message } })));
    };
    const onToggleQuestion = (id: string): void => {
        if (expandedQuestions.includes(id)) { setExpandedQuestions((x) => x.filter((y) => y !== id)); return; }
        setExpandedQuestions((x) => [...x, id]);
        const known = questions[id];
        if (!known || known.status === 'error') askQuestion(id);
    };

    const agentOf = (key: string): string | null => {
        const [x, y] = key.split('|');
        return x === HUMAN ? y ?? null : y === HUMAN ? x ?? null : null;
    };
    const onSend = (): void => {
        if (!openKey) return;
        const agentId = agentOf(openKey);
        const peer = inbox?.peers.find((x) => x.agentId === agentId);
        if (!peer) { setError('That agent is not on this workstation any more; it cannot be written to.'); return; }
        setSending(true);
        void send(peer.address, draft.trim(), compose?.attachments ?? [])
            .then(() => { setDraft(''); setError(null); compose?.onClear?.(); })
            .catch((e: unknown) => setError((e as Error).message))
            .finally(() => setSending(false));
    };
    const shownWin = openKey && win?.key === openKey ? win : null;
    /*
     * MOUNTED ONLY WHILE OPEN. Fancy's Drawer unmounts a closed panel on its exit animation's `animationend`, and Genie does
     * not load react-fancy's stylesheet (its keyframes): no animation runs, no `animationend` comes, and a closed flyout
     * stayed on screen — CI's real-window smoke caught it ("the AgentInbox flyout to close" timed out). Closing is now
     * an unmount; search, filter and order live here, above it, so they are kept for the next opening.
     */
    if (value === null) return null;
    return (
        <Drawer open onClose={() => onNavigate(null)} side="right" attach="container" className="w-[min(1040px,92%)] bg-[var(--surface)] text-[var(--fg-1)]" data-inbox-drawer="">
            <InboxFlyoutView
                agentColors={colors.agents}
                threads={threads}
                peers={inbox?.peers ?? []}
                thread={shownWin ? { key: shownWin.key, messages: shownWin.messages, more: shownWin.more, newer: shownWin.newer, limit: THREAD_PAGE, focus: shownWin.focus } : null}
                openKey={openKey}
                loading={loading}
                query={query}
                filter={filter}
                now={now}
                uncollected={inbox?.uncollected ?? 0}
                unread={inbox?.unread.length ?? 0}
                error={error}
                sending={sending}
                draft={draft}
                compose={compose}
                onQuery={setQuery}
                onFilter={setFilter}
                onOpenThread={(key) => onNavigate(key ?? '')}
                onLoadOlder={onLoadOlder}
                onDraft={setDraft}
                onSend={onSend}
                onDownload={(id, name) => { void attachment(id).then((a) => { if (a) download(a.name || name, a.base64); }).catch((e: unknown) => setError((e as Error).message)); }}
                onMarkAllRead={markAllRead}
                onDelete={setConfirming}
                onClose={() => onNavigate(null)}
                order={order}
                onOrder={setOrder}
                loadingOlder={loadingOlder}
                onBackToNewest={() => { if (openKey) fresh({ key: openKey }, null, 'reset'); }}
                threadQuery={threadQuery}
                onThreadQuery={setThreadQuery}
                search={search}
                onRetrySearch={() => setSearchNonce((n) => n + 1)}
                onJump={(hit) => { if (!openKey) return; setThreadQuery(''); fresh({ key: openKey, fromSeq: hit.seq }, hit.id, 'jump'); }}
                questions={questions}
                expandedQuestions={expandedQuestions}
                onToggleQuestion={onToggleQuestion}
                onRetryQuestion={askQuestion}
                scrollRef={scroller}
            />
            {confirming !== null ? (
                <Modal open onClose={() => setConfirming(null)} size="sm">
                    <Modal.Header>Delete this thread?</Modal.Header>
                    <Modal.Body>
                        <div data-inbox-confirm-delete={confirming} className="flex flex-col gap-3 text-sm">
                            <p>Its messages are removed from the AgentInbox — for you and for the agents in it. Mail an agent has not collected yet goes too.</p>
                            <div className="flex justify-end gap-2">
                                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
                                <Button type="button" size="sm" color="red" data-action="inbox-confirm-delete" onClick={() => { deleteThread(confirming); setConfirming(null); onNavigate(''); }}>Delete thread</Button>
                            </div>
                        </div>
                    </Modal.Body>
                </Modal>
            ) : null}
        </Drawer>
    );
}
