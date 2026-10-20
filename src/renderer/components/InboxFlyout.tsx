import { useEffect, useRef, useState } from 'react';
import { Badge, Button, ContentRenderer, Drawer, Icon, Input, Modal, Select, Textarea } from '@particle-academy/react-fancy';
import { ago, filterCounts, filterThreads, HUMAN, pairKey, THREAD_FILTERS, type ThreadFilter, type ThreadSummary } from '../../core/inbox-threads.js';
import type { InboxSection, InboxThreadView } from '../features.js';
import { formatSize, type InboxCompose } from './FeatureSurfaces.js';

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
 */

/** How many messages a thread opens with; each `Load older` adds as many. */
export const THREAD_PAGE = 50;

/** The `inbox=` value (core/route.ts): `''` = the threads, a thread key, or a message id (`msg_…`). */
export function inboxTarget(value: string): { kind: 'list' } | { kind: 'thread'; key: string } | { kind: 'message'; id: string } {
    if (value === '') return { kind: 'list' };
    if (value.startsWith('msg_')) return { kind: 'message', id: value };
    return { kind: 'thread', key: value };
}

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
}

const FILTER_LABEL: Record<ThreadFilter, string> = { all: 'All', unread: 'Unread', waiting: 'Waiting', stale: 'Stale' };

/** The agent in a pair that is not the person (or the first agent of two agents). */
const otherOf = (a: string, b: string): string => (a === HUMAN ? b : a);

/** Hook-free: everything on screen comes in as props, so a test can render and press it. */
export function InboxFlyoutView(p: InboxFlyoutViewProps) {
    const shown = filterThreads(p.threads, { filter: p.filter, query: p.query, now: p.now });
    const counts = filterCounts(p.threads, p.now);
    const summary = p.openKey ? p.threads.find((t) => t.key === p.openKey) ?? null : null;
    const [a, b] = p.openKey ? (p.openKey.split('|') as [string, string]) : ['', ''];
    const withHuman = p.openKey !== null && (a === HUMAN || b === HUMAN);
    const nameOf = (id: string): string => (id === HUMAN ? 'you' : summary ? (id === summary.a ? summary.aName : summary.bName) : p.peers.find((x) => x.agentId === id)?.name ?? id);
    const agentOfThread = p.openKey ? otherOf(a, b) : null;
    const reachable = p.peers.filter((x) => x.reachable && x.agentId);
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
                                <button
                                    type="button"
                                    data-inbox-thread={t.key}
                                    data-active={t.key === p.openKey ? 'true' : undefined}
                                    onClick={() => p.onOpenThread(t.key)}
                                    className={`flex w-full flex-col gap-0.5 border-b border-[var(--border-1)] px-3 py-2 text-left hover:bg-[var(--bg-2)] ${t.key === p.openKey ? 'bg-[var(--bg-2)]' : ''}`}
                                >
                                    <span className="flex items-center gap-2 text-[13px]">
                                        <span className={t.unread > 0 ? 'font-semibold text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}>{t.withHuman ? (t.a === HUMAN ? t.bName : t.aName) : `${t.aName} ⇄ ${t.bName}`}</span>
                                        {t.withHuman ? null : <Icon name="lock" size="xs" className="text-[var(--fg-4)]" />}
                                        {t.attachments > 0 ? <Icon name="paperclip" size="xs" className="text-[var(--fg-4)]" /> : null}
                                        <span className="ml-auto font-mono text-[11px] text-[var(--fg-4)]">{Number.isNaN(t.lastAt) ? '' : ago(t.lastAt, p.now)}</span>
                                    </span>
                                    <span className="truncate text-[12px] text-[var(--fg-3)]">{`${t.lastFrom}: ${t.lastPreview}`}</span>
                                    <span className="flex items-center gap-2 font-mono text-[11px]">
                                        {t.unread > 0 ? <span data-thread-unread={t.unread} className="text-[var(--warning)]">{`${t.unread} unread`}</span> : null}
                                        {t.waiting ? <span data-thread-waiting={t.waiting.count} className="text-[var(--violet-400)]">{`waiting on ${t.waiting.agent} · ${ago(t.waiting.since, p.now)}`}</span> : null}
                                    </span>
                                </button>
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
                                <span className="text-[12px] text-[var(--fg-3)]">{withHuman ? 'Your direct thread' : 'Agent-to-agent thread · read-only'}</span>
                                {summary?.waiting ? <span className="font-mono text-[11px] text-[var(--violet-400)]">{`${summary.waiting.count} not collected by ${summary.waiting.agent} · ${ago(summary.waiting.since, p.now)}`}</span> : null}
                                <span className="ml-auto" />
                                {summary ? <Button type="button" size="xs" variant="ghost" icon="trash-2" data-action="inbox-delete-thread" onClick={() => p.onDelete(summary.key)}>Delete thread</Button> : null}
                            </div>
                            <div data-inbox-messages="" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
                                {p.thread?.more ? <Button type="button" size="xs" variant="ghost" data-action="inbox-load-older" onClick={p.onLoadOlder} className="self-center">Load older</Button> : null}
                                {p.loading && !p.thread ? <div className="text-[12px] text-[var(--fg-3)]">Loading…</div> : null}
                                {p.thread && p.thread.messages.length === 0 ? <div className="text-[12px] text-[var(--fg-3)]">No messages yet.</div> : null}
                                {p.thread?.messages.map((m) => (
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
                                        <ContentRenderer value={m.text} format="markdown" lineSpacing={1.5} className="text-[13px] text-[var(--fg-2)]" />
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
                                ))}
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
    /** Ask main for a thread (the `inbox.thread` action's answer). */
    loadThread: (req: { key?: string; messageId?: string; limit: number }) => Promise<InboxThreadView | null>;
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

/** The flyout with its state: search, filter, the open thread (re-read when its summary moves — a push, never a poll). */
export function InboxFlyout({ value, inbox, compose, loadThread, send, attachment, markAllRead, deleteThread, onNavigate }: InboxFlyoutProps) {
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<ThreadFilter>('all');
    const [thread, setThread] = useState<InboxThreadView | null>(null);
    const [limit, setLimit] = useState(THREAD_PAGE);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    /** The thread whose Delete is being confirmed (Genie 1 asked first, too). */
    const [confirming, setConfirming] = useState<string | null>(null);
    const target = value === null ? null : inboxTarget(value);
    const threads = inbox?.threads ?? [];
    // The open thread's key: the route's, or — opened on a message — the one main answered with.
    const openKey = target?.kind === 'thread' ? target.key : target?.kind === 'message' ? thread?.key ?? null : null;
    const summary = openKey ? threads.find((t) => t.key === openKey) ?? null : null;
    // What makes the open thread worth reading again: new mail in it, or its read state moving (both arrive as a push).
    const stamp = summary ? `${summary.lastSeq}:${summary.unread}:${summary.waiting?.count ?? 0}:${summary.count}` : '';
    const asked = useRef('');
    useEffect(() => {
        if (target === null || target.kind === 'list') { setThread(null); return; }
        const req = target.kind === 'thread' ? { key: target.key, limit } : { messageId: target.id, limit };
        const ask = `${value}:${limit}:${stamp}`;
        if (asked.current === ask) return;
        asked.current = ask;
        setLoading(true);
        setNow(Date.now());
        void loadThread(req)
            .then((t) => { setThread(t); setError(null); })
            .catch((e: unknown) => { setThread(null); setError((e as Error).message); })
            .finally(() => setLoading(false));
    }, [value, limit, stamp]);
    // A different thread starts at one page and an empty composer.
    useEffect(() => { setLimit(THREAD_PAGE); setDraft(''); setError(null); }, [openKey]);

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
    return (
        <Drawer open={value !== null} onClose={() => onNavigate(null)} side="right" attach="container" className="w-[min(1040px,92%)] bg-[var(--surface)] text-[var(--fg-1)]" data-inbox-drawer="">
            <InboxFlyoutView
                threads={threads}
                peers={inbox?.peers ?? []}
                thread={openKey && thread?.key === openKey ? thread : null}
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
                onLoadOlder={() => setLimit((n) => n + THREAD_PAGE)}
                onDraft={setDraft}
                onSend={onSend}
                onDownload={(id, name) => { void attachment(id).then((a) => { if (a) download(a.name || name, a.base64); }).catch((e: unknown) => setError((e as Error).message)); }}
                onMarkAllRead={markAllRead}
                onDelete={setConfirming}
                onClose={() => onNavigate(null)}
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
