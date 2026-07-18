import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    IconCheckCheck,
    IconClock,
    IconLock,
    IconMore,
    IconRefresh,
    IconReply,
    IconSearch,
    IconSwap,
    IconX,
} from './icons';
import {
    api,
    hasGenieBridge,
    type AgentInboxAgentInfo,
    type AgentInboxChannelInfo,
    type AgentInboxDmThreadInfo,
    type AgentInboxEscalationEvent,
    type AgentInboxMessage,
} from '../../lib/genie';

/**
 * AgentInbox human panel. Right-side slide-in (reuses the Docs / Task Manager
 * flyout chrome) laid out as a full-width header over a two-pane body: a LEFT
 * list pane (search + filter chips + waiting summary + the AGENT DIRECTORY,
 * WORKSPACE CHANNELS and DIRECT MESSAGES sections) and a RIGHT thread pane
 * (thread header, per-agent inbox status, the message stream, and a fixed
 * footer that is the composer on a writable thread and a read-only bar on an
 * observed agent↔agent thread). Loads on open and stays live via
 * `on.agentInboxPresence` / `on.agentInboxMessage` / `on.agentInboxEscalation`.
 * AgentInbox is local-only in v1, so it's guarded behind the Genie bridge.
 */

/** The human panel's sender identity token (mirrors the broker's `AGENTINBOX_HUMAN`). */
const HUMAN = 'human';

/** A thread with no traffic for this long reads as "stale" in the filter row. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Message bodies longer than this collapse behind a "Show more" link. */
const TRUNCATE_AT = 320;

type Selection =
    | { kind: 'channel'; key: string; title: string }
    | { kind: 'dm'; agentId: string; title: string }
    // An agent↔agent thread — the human watches it read-only.
    | { kind: 'dmPair'; a: string; b: string; title: string };

type Filter = 'all' | 'unread' | 'stale';

/** Last traffic seen on a row — drives its preview, relative time and unread. */
interface RowActivity {
    seq: number;
    ts: number;
    fromLabel: string;
    preview: string;
}

const STATUS_LABEL: Record<AgentInboxAgentInfo['status'], string> = {
    online: 'online',
    away: 'away',
    offline: 'offline',
};

function relTime(ts: number): string {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.round(h / 24)}d`;
}

/**
 * Stable row identity, shared by the list rows and the selection so "mark this
 * row seen while it's open" lines up. A human↔agent thread and the directory
 * entry for that same agent are deliberately the SAME row — both open the
 * human's DM with them.
 */
function rowKeyOfSelection(s: Selection): string {
    if (s.kind === 'channel') return `c:${s.key}`;
    if (s.kind === 'dm') return `d:${s.agentId}`;
    return `p:${[s.a, s.b].sort().join('|')}`;
}

function rowKeyOfThread(t: AgentInboxDmThreadInfo): string {
    if (t.withHuman) return `d:${t.a === HUMAN ? t.b : t.a}`;
    return `p:${[t.a, t.b].sort().join('|')}`;
}

/**
 * Palette bucket for a participant. The design colours claude purple and codex
 * cyan; anything else (a custom TUI, a departed agent) stays neutral, and the
 * human borrows the indigo agent accent.
 */
function toneOf(agentId: string, byId: Map<string, AgentInboxAgentInfo>): string {
    if (agentId === HUMAN) return 'human';
    const type = byId.get(agentId)?.agentType;
    if (type === 'claude') return 'claude';
    if (type === 'codex') return 'codex';
    return 'neutral';
}

/** Two-letter avatar / pill code — "claude" → "cl", "codex" → "cx". */
function shortCode(agentId: string, byId: Map<string, AgentInboxAgentInfo>): string {
    if (agentId === HUMAN) return 'yo';
    const a = byId.get(agentId);
    if (a?.agentType === 'codex') return 'cx';
    const src = a?.label || a?.agentType || agentId;
    return src.replace(/[^a-z0-9]/gi, '').slice(0, 2).toLowerCase() || '??';
}

/** The `·workspace` suffix beside an agent name, when the directory knows it. */
function workspaceOf(agentId: string, byId: Map<string, AgentInboxAgentInfo>): string {
    const a = byId.get(agentId);
    return a?.slug || a?.workspaceName || '';
}

const BRANCH_RE = /\b(?:feat|fix|chore|docs|refactor|test|perf)\/[\w.\-/]+/g;
const PATH_RE = /\b[\w.-]+\/[\w.\-/]+\.\w+\b/g;
const HASH_RE = /\b[0-9a-f]{7,40}\b/g;

/**
 * Chips under a message body. Only objectively-detectable tokens are tagged —
 * a branch ref, a file path, a commit-ish hash — plus an "awaiting ack" chip
 * when this very message is the one an escalation is waiting on.
 */
function tagsOf(text: string, escalated: boolean): { tone: string; label: string }[] {
    const out: { tone: string; label: string }[] = [];
    const seen = new Set<string>();
    const take = (tone: string, label: string) => {
        if (seen.has(label) || out.length >= 6) return;
        seen.add(label);
        out.push({ tone, label });
    };
    if (escalated) take('amber', 'awaiting ack');
    for (const m of text.match(BRANCH_RE) ?? []) take('branch', m);
    for (const m of text.match(PATH_RE) ?? []) take('ref', m);
    // Require a digit so plain hex-looking words ("defaced") aren't read as SHAs.
    for (const m of text.match(HASH_RE) ?? []) if (/\d/.test(m)) take('ref', m);
    return out;
}

/** Oldest `sinceTs` across a set of escalations, when any carries one. */
function oldestSince(list: AgentInboxEscalationEvent[]): number | undefined {
    return list.reduce(
        (acc, e) => (e.sinceTs && (!acc || e.sinceTs < acc) ? e.sinceTs : acc),
        undefined as number | undefined,
    );
}

/** Does a live message event belong to the currently-open thread? */
function eventMatches(
    sel: Selection,
    ev: { kind: 'dm' | 'channel'; channelKey?: string; toAgentId?: string; from: string },
): boolean {
    if (sel.kind === 'channel') return ev.kind === 'channel' && ev.channelKey === sel.key;
    if (sel.kind === 'dm') {
        return ev.kind === 'dm' && (ev.from === sel.agentId || ev.toAgentId === sel.agentId);
    }
    // dmPair: the event's two endpoints must be exactly this agent↔agent pair.
    return (
        ev.kind === 'dm' &&
        ((ev.from === sel.a && ev.toAgentId === sel.b) ||
            (ev.from === sel.b && ev.toAgentId === sel.a))
    );
}

/** A small rounded-square agent avatar. */
function Avatar({ code, tone }: { code: string; tone: string }) {
    return <span className={`agentinbox-av agentinbox-tone-${tone}`}>{code}</span>;
}

/** The overlapping pair of avatars a DM row / thread header leads with. */
function PairAvatar({
    a,
    b,
    byId,
}: {
    a: string;
    b: string;
    byId: Map<string, AgentInboxAgentInfo>;
}) {
    return (
        <span className="agentinbox-av-pair">
            <Avatar code={shortCode(a, byId)} tone={toneOf(a, byId)} />
            <Avatar code={shortCode(b, byId)} tone={toneOf(b, byId)} />
        </span>
    );
}

/** Waiting (amber, with the blocked agent + age) or the muted read marker. */
function RowStatus({
    waiting,
    byId,
}: {
    waiting: AgentInboxEscalationEvent[];
    byId: Map<string, AgentInboxAgentInfo>;
}) {
    if (waiting.length === 0) {
        return (
            <span className="agentinbox-read">
                <IconCheckCheck size={12} />
                read
            </span>
        );
    }
    const oldest = oldestSince(waiting);
    return (
        <span className="agentinbox-waiting">
            <IconClock size={11} />
            {shortCode(waiting[0].targetAgentId, byId)}
            {oldest ? ` · ${relTime(oldest)}` : ''}
        </span>
    );
}

export default function AgentInboxFlyout({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const [agents, setAgents] = useState<AgentInboxAgentInfo[]>([]);
    const [channels, setChannels] = useState<AgentInboxChannelInfo[]>([]);
    const [threads, setThreads] = useState<AgentInboxDmThreadInfo[]>([]);
    const [sel, setSel] = useState<Selection | null>(null);
    const [messages, setMessages] = useState<AgentInboxMessage[]>([]);
    const [draft, setDraft] = useState('');
    const [loading, setLoading] = useState(false);
    const [posting, setPosting] = useState(false);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('all');
    const [menuOpen, setMenuOpen] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    // Channels carry no timestamp in the directory payload, so their preview and
    // relative time are built from the live message events the panel observes
    // (and back-filled from history the first time one is opened).
    const [chanActivity, setChanActivity] = useState<Map<string, RowActivity>>(new Map());
    // Highest seq the human has actually looked at, per row — drives "unread".
    const [seenSeq, setSeenSeq] = useState<Map<string, number>>(new Map());
    // Track C — unACKed urgent DMs, keyed by messageId. Populated by
    // `on.agentInboxEscalation`; each is a "waiting on <agent>" oversight alert.
    const [escalations, setEscalations] = useState<Map<string, AgentInboxEscalationEvent>>(new Map());
    const streamEndRef = useRef<HTMLDivElement>(null);

    const byId = useMemo(() => new Map(agents.map((a) => [a.agentId, a])), [agents]);

    const loadDirectory = useCallback(async () => {
        if (!hasGenieBridge()) return;
        const [d, c, t] = await Promise.all([
            api().agentInbox.directory().catch(() => ({ agents: [] as AgentInboxAgentInfo[] })),
            api().agentInbox.channels().catch(() => ({ channels: [] as AgentInboxChannelInfo[] })),
            api().agentInbox.dmThreads().catch(() => ({ threads: [] as AgentInboxDmThreadInfo[] })),
        ]);
        setAgents(d.agents);
        setChannels(c.channels);
        setThreads(t.threads);
    }, []);

    const loadHistory = useCallback(async (s: Selection) => {
        if (!hasGenieBridge()) return;
        setLoading(true);
        try {
            const res = await api()
                .agentInbox.history(
                    s.kind === 'channel'
                        ? { channelKey: s.key }
                        : s.kind === 'dmPair'
                          ? { dmPair: [s.a, s.b] }
                          : { agentId: s.agentId },
                )
                .catch(() => ({ messages: [] as AgentInboxMessage[] }));
            setMessages(res.messages);
            const last = res.messages[res.messages.length - 1];
            if (last) {
                // Reading a thread marks it seen, and gives a channel row the
                // preview / timestamp the directory payload doesn't carry.
                setSeenSeq((prev) => new Map(prev).set(rowKeyOfSelection(s), last.seq));
                if (s.kind === 'channel') {
                    setChanActivity((prev) =>
                        new Map(prev).set(s.key, {
                            seq: last.seq,
                            ts: last.ts,
                            fromLabel: last.fromLabel,
                            preview: last.text,
                        }),
                    );
                }
            }
        } finally {
            setLoading(false);
        }
    }, []);

    // Select a DM thread from the list: the human's OWN DM reuses the human↔agent
    // path (so the composer posts to that agent); an agent↔agent thread opens as a
    // read-only `dmPair` view.
    const selectThread = useCallback((t: AgentInboxDmThreadInfo) => {
        if (t.withHuman) {
            const agentId = t.a === HUMAN ? t.b : t.a;
            const title = t.a === HUMAN ? t.bLabel : t.aLabel;
            setSel({ kind: 'dm', agentId, title });
        } else {
            setSel({ kind: 'dmPair', a: t.a, b: t.b, title: `${t.aLabel} ↔ ${t.bLabel}` });
        }
    }, []);

    // Load the directory + channels on open.
    useEffect(() => {
        if (!open) return;
        void loadDirectory();
    }, [open, loadDirectory]);

    // Keep the directory + open thread live while the panel is open.
    useEffect(() => {
        if (!open) return;
        const offPresence = api().on.agentInboxPresence?.(() => void loadDirectory());
        const offMessage = api().on.agentInboxMessage?.((ev) => {
            void loadDirectory();
            if (ev.kind === 'channel' && ev.channelKey) {
                const key = ev.channelKey;
                setChanActivity((prev) =>
                    new Map(prev).set(key, {
                        seq: ev.seq,
                        ts: ev.ts,
                        fromLabel: ev.fromLabel,
                        preview: ev.preview,
                    }),
                );
            }
            setSel((cur) => {
                if (cur && eventMatches(cur, ev)) void loadHistory(cur);
                return cur;
            });
        });
        // Track C — raise / clear "waiting on <agent>" oversight alerts.
        const offEscalation = api().on.agentInboxEscalation?.((ev) => {
            setEscalations((prev) => {
                const next = new Map(prev);
                if (ev.resolved) next.delete(ev.messageId);
                else next.set(ev.messageId, ev);
                return next;
            });
        });
        return () => {
            offPresence?.();
            offMessage?.();
            offEscalation?.();
        };
    }, [open, loadDirectory, loadHistory]);

    // (Re)load the stream when the selection changes.
    useEffect(() => {
        if (!open || !sel) {
            setMessages([]);
            return;
        }
        setMenuOpen(false);
        setExpanded(new Set());
        void loadHistory(sel);
    }, [open, sel, loadHistory]);

    // Close on Escape.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    // Auto-scroll the stream to the newest message.
    useEffect(() => {
        streamEndRef.current?.scrollIntoView({ block: 'end' });
    }, [messages]);

    const post = async () => {
        const text = draft.trim();
        // Agent↔agent threads are read-only for the human (no 3-party DM model).
        if (!text || !sel || sel.kind === 'dmPair' || posting) return;
        setPosting(true);
        try {
            const res = await api()
                .agentInbox.post(
                    sel.kind === 'channel'
                        ? { channelKey: sel.key, text }
                        : { toAgentId: sel.agentId, text },
                )
                .catch(() => ({ ok: false }) as { ok: boolean });
            if (res.ok) {
                setDraft('');
                await loadHistory(sel);
            }
        } finally {
            setPosting(false);
        }
    };

    /** Live escalations blocking any of the given participants. */
    const waitingOn = useCallback(
        (...ids: string[]) => [...escalations.values()].filter((e) => ids.includes(e.targetAgentId)),
        [escalations],
    );

    const isUnread = useCallback(
        (rowKey: string, act: RowActivity | undefined) =>
            !!act && act.seq > (seenSeq.get(rowKey) ?? -1),
        [seenSeq],
    );

    const isStale = (act: RowActivity | undefined) =>
        !!act && Date.now() - act.ts > STALE_AFTER_MS;

    const q = query.trim().toLowerCase();
    const matches = (...fields: (string | undefined)[]) =>
        !q || fields.some((f) => (f ?? '').toLowerCase().includes(q));

    const visibleAgents = agents.filter((a) =>
        matches(a.label, a.agentType, a.purpose, a.workspaceName, a.slug),
    );

    const channelRows = channels
        .filter((c) => matches(c.slug, c.purpose, c.workspaceName))
        .map((c) => {
            const rowKey = `c:${c.key}`;
            const act = chanActivity.get(c.key);
            return { c, rowKey, act, waiting: [] as AgentInboxEscalationEvent[], unread: isUnread(rowKey, act) };
        });

    const threadRows = threads
        .filter((t) => matches(t.aLabel, t.bLabel, t.lastPreview, t.lastFromLabel))
        .map((t) => {
            const rowKey = rowKeyOfThread(t);
            const act: RowActivity = {
                seq: t.lastSeq,
                ts: t.lastTs,
                fromLabel: t.lastFromLabel,
                preview: t.lastPreview,
            };
            const waiting = waitingOn(t.a, t.b);
            return { t, rowKey, act, waiting, unread: isUnread(rowKey, act) || waiting.length > 0 };
        });

    const passesFilter = (row: { unread: boolean; act?: RowActivity }) => {
        if (filter === 'unread') return row.unread;
        if (filter === 'stale') return isStale(row.act);
        return true;
    };

    const shownChannels = channelRows.filter(passesFilter);
    const shownThreads = threadRows.filter(passesFilter);
    // The directory has no traffic of its own, so it only lists under "All".
    const shownAgents = filter === 'all' ? visibleAgents : [];

    const allRows = [...channelRows, ...threadRows];
    const counts: Record<Filter, number> = {
        all: allRows.length,
        unread: allRows.filter((r) => r.unread).length,
        stale: allRows.filter((r) => isStale(r.act)).length,
    };

    const escalationList = [...escalations.values()];
    const waitingThreadCount = threadRows.filter((r) => r.waiting.length > 0).length;
    const oldestWaiting = oldestSince(escalationList);

    /** The two participants of the open thread, for the header + status pills. */
    const participants: [string, string] | null =
        sel?.kind === 'dmPair'
            ? [sel.a, sel.b]
            : sel?.kind === 'dm'
              ? [HUMAN, sel.agentId]
              : null;

    const onlineCount = agents.filter((a) => a.status === 'online').length;

    /**
     * "Interrupt thread" — the human can't join an agent↔agent thread (there's
     * no 3-party DM model), so this opens their OWN DM with one of the two
     * participants, where the composer is live.
     */
    const interrupt = () => {
        if (sel?.kind !== 'dmPair') return;
        const target = sel.a === HUMAN ? sel.b : sel.a;
        setSel({ kind: 'dm', agentId: target, title: byId.get(target)?.label ?? target });
    };

    const markThreadRead = () => {
        if (!sel) return;
        const last = messages[messages.length - 1];
        if (last) setSeenSeq((prev) => new Map(prev).set(rowKeyOfSelection(sel), last.seq));
        setMenuOpen(false);
    };

    /** A participant's name + muted `·workspace` suffix in the thread header. */
    const headerName = (id: string) => (
        <>
            <span className={`agentinbox-name-${toneOf(id, byId)}`}>
                {id === HUMAN ? 'You' : (byId.get(id)?.label ?? id)}
            </span>
            {workspaceOf(id, byId) && (
                <span className="agentinbox-thread-ws">·{workspaceOf(id, byId)}</span>
            )}
        </>
    );

    return (
        <div className={`docs-flyout-root${open ? ' open' : ''}`} aria-hidden={!open}>
            <div className="docs-scrim" onClick={onClose} />
            <aside
                className="docs-flyout agentinbox-flyout"
                role="dialog"
                aria-label="AgentInbox"
                aria-modal="false"
            >
                <div className="docs-head agentinbox-head">
                    <span className="agentinbox-brand" aria-hidden="true">
                        A
                    </span>
                    <span className="docs-title">AgentInbox</span>
                    {hasGenieBridge() && (
                        <span className="agentinbox-live" title="AgentInbox broker connected">
                            <span className="agentinbox-live-dot" />
                            live · {onlineCount} online
                        </span>
                    )}
                    <span className="grow" />
                    <button
                        type="button"
                        className="gicon"
                        onClick={() => void loadDirectory()}
                        title="Refresh"
                        aria-label="Refresh agents & channels"
                    >
                        <IconRefresh />
                    </button>
                    <button
                        type="button"
                        className="gicon"
                        onClick={onClose}
                        title="Close AgentInbox"
                        aria-label="Close AgentInbox"
                    >
                        <IconX />
                    </button>
                </div>

                {/* Track C — oversight: urgent DMs a peer hasn't picked up. */}
                {hasGenieBridge() && escalations.size > 0 && (
                    <div className="agentinbox-escalations">
                        {escalationList.map((e) => (
                            <div key={e.messageId} className="agentinbox-escalation" role="alert">
                                <span className="agentinbox-escalation-dot" />
                                <span className="agentinbox-escalation-text">
                                    Waiting on <b>{e.targetLabel ?? 'an agent'}</b> — {e.fromLabel ?? 'an'} urgent message is unread
                                    {e.sinceTs ? <span className="agentinbox-escalation-age"> · {relTime(e.sinceTs)}</span> : null}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                {!hasGenieBridge() ? (
                    <div className="agentinbox-body">
                        <div className="iw-muted" style={{ padding: 16 }}>
                            AgentInbox runs inside Genie.
                        </div>
                    </div>
                ) : (
                    <div className="agentinbox-body">
                        <div className="agentinbox-nav">
                            <div className="agentinbox-search">
                                <IconSearch size={13} />
                                <input
                                    className="agentinbox-search-input"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    placeholder="Search agents, workspaces, channels…"
                                    aria-label="Search AgentInbox"
                                />
                            </div>

                            <div className="agentinbox-chips" role="group" aria-label="Filter threads">
                                {(['all', 'unread', 'stale'] as Filter[]).map((f) => (
                                    <button
                                        key={f}
                                        type="button"
                                        className={`agentinbox-chip${filter === f ? ' on' : ''}`}
                                        onClick={() => setFilter(f)}
                                        aria-pressed={filter === f}
                                    >
                                        {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : 'Stale'}
                                        <span className="agentinbox-chip-count">{counts[f]}</span>
                                    </button>
                                ))}
                            </div>

                            {waitingThreadCount > 0 && (
                                <div className="agentinbox-waiting-line">
                                    <IconClock size={12} />
                                    {waitingThreadCount} thread
                                    {waitingThreadCount === 1 ? '' : 's'} waiting on an agent
                                    {oldestWaiting ? ` · oldest ${relTime(oldestWaiting)}` : ''}
                                </div>
                            )}

                            <div className="agentinbox-scroll">
                                {filter === 'all' && (
                                    <>
                                        <div className="agentinbox-sec">
                                            <span className="agentinbox-sec-label">Agents</span>
                                            <span className="agentinbox-sec-count">
                                                {shownAgents.length}
                                            </span>
                                            <span className="agentinbox-sec-rule" />
                                        </div>
                                        {shownAgents.length === 0 ? (
                                            <div className="agentinbox-empty">
                                                No agents online yet.
                                            </div>
                                        ) : (
                                            <ul className="agentinbox-list">
                                                {shownAgents.map((a) => {
                                                    const waiting = waitingOn(a.agentId);
                                                    return (
                                                        <li key={a.agentId}>
                                                            <button
                                                                type="button"
                                                                className={`agentinbox-row${
                                                                    sel?.kind === 'dm' &&
                                                                    sel.agentId === a.agentId
                                                                        ? ' on'
                                                                        : ''
                                                                }${waiting.length > 0 ? ' alert' : ''}`}
                                                                onClick={() =>
                                                                    setSel({
                                                                        kind: 'dm',
                                                                        agentId: a.agentId,
                                                                        title: a.label,
                                                                    })
                                                                }
                                                                title={`DM ${a.label} · ${STATUS_LABEL[a.status]}`}
                                                            >
                                                                <span className="agentinbox-row-av">
                                                                    <Avatar
                                                                        code={shortCode(a.agentId, byId)}
                                                                        tone={toneOf(a.agentId, byId)}
                                                                    />
                                                                    <span
                                                                        className={`agentinbox-dot agentinbox-${a.status}`}
                                                                    />
                                                                </span>
                                                                <span className="agentinbox-row-main">
                                                                    <span className="agentinbox-row-top">
                                                                        <span className="agentinbox-row-name">
                                                                            {a.label}
                                                                        </span>
                                                                        <span className="agentinbox-ws">
                                                                            {a.workspaceName}
                                                                        </span>
                                                                        <span className="agentinbox-row-time">
                                                                            {STATUS_LABEL[a.status]}
                                                                        </span>
                                                                    </span>
                                                                    <span className="agentinbox-row-bot">
                                                                        <span className="agentinbox-row-preview">
                                                                            {a.agentType} · {a.purpose}
                                                                        </span>
                                                                        <RowStatus
                                                                            waiting={waiting}
                                                                            byId={byId}
                                                                        />
                                                                    </span>
                                                                </span>
                                                            </button>
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        )}
                                    </>
                                )}

                                <div className="agentinbox-sec">
                                    <span className="agentinbox-sec-label">Workspace channels</span>
                                    <span className="agentinbox-sec-count">
                                        {shownChannels.length}
                                    </span>
                                    <span className="agentinbox-sec-rule" />
                                </div>
                                {shownChannels.length === 0 ? (
                                    <div className="agentinbox-empty">No channels yet.</div>
                                ) : (
                                    <ul className="agentinbox-list">
                                        {shownChannels.map(({ c, act, unread }) => (
                                            <li key={c.key}>
                                                <button
                                                    type="button"
                                                    className={`agentinbox-row${
                                                        sel?.kind === 'channel' && sel.key === c.key
                                                            ? ' on'
                                                            : ''
                                                    }${unread ? ' alert' : ''}`}
                                                    onClick={() =>
                                                        setSel({
                                                            kind: 'channel',
                                                            key: c.key,
                                                            title: `${c.slug}:${c.purpose}`,
                                                        })
                                                    }
                                                    title={`${c.slug}:${c.purpose} · ${c.workspaceName}`}
                                                >
                                                    <span className="agentinbox-row-av">
                                                        <span className="agentinbox-av agentinbox-tone-hash">
                                                            #
                                                        </span>
                                                    </span>
                                                    <span className="agentinbox-row-main">
                                                        <span className="agentinbox-row-top">
                                                            <span className="agentinbox-row-name">
                                                                #{c.purpose}
                                                            </span>
                                                            <span className="agentinbox-ws">
                                                                {c.workspaceName}
                                                            </span>
                                                            <span className="agentinbox-row-time">
                                                                {act ? relTime(act.ts) : ''}
                                                            </span>
                                                        </span>
                                                        <span className="agentinbox-row-bot">
                                                            <span className="agentinbox-row-preview">
                                                                {act
                                                                    ? `${act.fromLabel}: ${act.preview}`
                                                                    : `${c.memberCount} member${c.memberCount === 1 ? '' : 's'}`}
                                                            </span>
                                                            <RowStatus waiting={[]} byId={byId} />
                                                        </span>
                                                    </span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                <div className="agentinbox-sec">
                                    <span className="agentinbox-sec-label">Direct messages</span>
                                    <span className="agentinbox-sec-count">
                                        {shownThreads.length}
                                    </span>
                                    <span className="agentinbox-sec-rule" />
                                </div>
                                {shownThreads.length === 0 ? (
                                    <div className="agentinbox-empty">No direct messages yet.</div>
                                ) : (
                                    <ul className="agentinbox-list">
                                        {shownThreads.map(({ t, act, waiting, unread }) => {
                                            const active =
                                                (sel?.kind === 'dmPair' &&
                                                    sel.a === t.a &&
                                                    sel.b === t.b) ||
                                                (sel?.kind === 'dm' &&
                                                    t.withHuman &&
                                                    (t.a === sel.agentId || t.b === sel.agentId));
                                            const wsA = workspaceOf(t.a, byId);
                                            const wsB = workspaceOf(t.b, byId);
                                            return (
                                                <li key={t.key}>
                                                    <button
                                                        type="button"
                                                        className={`agentinbox-row${
                                                            active ? ' on' : ''
                                                        }${unread ? ' alert' : ''}`}
                                                        onClick={() => selectThread(t)}
                                                        title={`${t.aLabel} ↔ ${t.bLabel}`}
                                                    >
                                                        <span className="agentinbox-row-av">
                                                            <PairAvatar a={t.a} b={t.b} byId={byId} />
                                                        </span>
                                                        <span className="agentinbox-row-main">
                                                            <span className="agentinbox-row-top">
                                                                <span className="agentinbox-row-name">
                                                                    <span
                                                                        className={`agentinbox-name-${toneOf(t.a, byId)}`}
                                                                    >
                                                                        {t.aLabel}
                                                                    </span>
                                                                    <IconSwap size={11} />
                                                                    <span
                                                                        className={`agentinbox-name-${toneOf(t.b, byId)}`}
                                                                    >
                                                                        {t.bLabel}
                                                                    </span>
                                                                </span>
                                                                <span className="agentinbox-row-time">
                                                                    {relTime(t.lastTs)}
                                                                </span>
                                                            </span>
                                                            <span className="agentinbox-row-bot">
                                                                <span className="agentinbox-row-preview">
                                                                    {wsA && wsB
                                                                        ? `${wsA} ↔ ${wsB} · `
                                                                        : ''}
                                                                    {act.fromLabel}: {act.preview}
                                                                </span>
                                                                <RowStatus
                                                                    waiting={waiting}
                                                                    byId={byId}
                                                                />
                                                            </span>
                                                        </span>
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </div>
                        </div>

                        <div className="agentinbox-main">
                            {!sel ? (
                                <div className="agentinbox-empty agentinbox-placeholder">
                                    Pick an agent, a DM thread, or a channel to see the
                                    conversation.
                                </div>
                            ) : (
                                <>
                                    <div className="agentinbox-thread-head">
                                        {participants ? (
                                            <PairAvatar
                                                a={participants[0]}
                                                b={participants[1]}
                                                byId={byId}
                                            />
                                        ) : (
                                            <span className="agentinbox-av agentinbox-tone-hash">
                                                #
                                            </span>
                                        )}
                                        <span className="agentinbox-thread-main">
                                            <span className="agentinbox-thread-title">
                                                {participants ? (
                                                    <>
                                                        {headerName(participants[0])}
                                                        <IconSwap size={12} />
                                                        {headerName(participants[1])}
                                                    </>
                                                ) : (
                                                    sel.title
                                                )}
                                            </span>
                                            <span className="agentinbox-thread-sub">
                                                {sel.kind === 'dmPair'
                                                    ? 'Cross-workspace direct thread · read-only'
                                                    : sel.kind === 'dm'
                                                      ? 'Direct thread'
                                                      : 'Workspace channel'}
                                                {loading ? ' · loading…' : ''}
                                            </span>
                                        </span>
                                        <span className="grow" />
                                        <span className="agentinbox-menu-wrap">
                                            <button
                                                type="button"
                                                className="gicon"
                                                onClick={() => setMenuOpen((o) => !o)}
                                                title="Thread actions"
                                                aria-label="Thread actions"
                                                aria-expanded={menuOpen}
                                            >
                                                <IconMore />
                                            </button>
                                            {menuOpen && (
                                                <div className="agentinbox-menu" role="menu">
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        onClick={() => {
                                                            void loadHistory(sel);
                                                            setMenuOpen(false);
                                                        }}
                                                    >
                                                        Reload thread
                                                    </button>
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        onClick={markThreadRead}
                                                    >
                                                        Mark as read
                                                    </button>
                                                </div>
                                            )}
                                        </span>
                                    </div>

                                    {participants && (
                                        <div className="agentinbox-inbox-status">
                                            <span className="agentinbox-inbox-label">
                                                Inbox status
                                            </span>
                                            {participants
                                                .filter((p) => p !== HUMAN)
                                                .map((p) => {
                                                    const w = waitingOn(p);
                                                    const oldest = oldestSince(w);
                                                    return (
                                                        <span
                                                            key={p}
                                                            className={`agentinbox-status-pill${w.length > 0 ? ' warn' : ''}`}
                                                        >
                                                            <Avatar
                                                                code={shortCode(p, byId)}
                                                                tone={toneOf(p, byId)}
                                                            />
                                                            {w.length > 0
                                                                ? `${w.length} unread${oldest ? ` · ${relTime(oldest)}` : ''}`
                                                                : 'caught up'}
                                                        </span>
                                                    );
                                                })}
                                        </div>
                                    )}

                                    <div className="agentinbox-stream">
                                        {messages.length === 0 ? (
                                            <div className="agentinbox-empty">No messages yet.</div>
                                        ) : (
                                            messages.map((m) => {
                                                const tone = toneOf(m.from, byId);
                                                const escalated = escalationList.some(
                                                    (e) => e.messageId === m.id,
                                                );
                                                const tags = tagsOf(m.text, escalated);
                                                const long = m.text.length > TRUNCATE_AT;
                                                const show = expanded.has(m.id) || !long;
                                                const ws = workspaceOf(m.from, byId);
                                                return (
                                                    <div
                                                        key={m.id}
                                                        className={`agentinbox-msg agentinbox-bar-${tone}${
                                                            m.from === 'human' ? ' is-human' : ''
                                                        }`}
                                                    >
                                                        <div className="agentinbox-msg-meta">
                                                            <Avatar
                                                                code={shortCode(m.from, byId)}
                                                                tone={tone}
                                                            />
                                                            <span
                                                                className={`agentinbox-msg-from agentinbox-name-${tone}`}
                                                            >
                                                                {m.fromLabel}
                                                            </span>
                                                            {ws && (
                                                                <span className="agentinbox-msg-ws">
                                                                    ·{ws}
                                                                </span>
                                                            )}
                                                            <span className="grow" />
                                                            <span className="agentinbox-msg-time">
                                                                {relTime(m.ts)}
                                                            </span>
                                                        </div>
                                                        <div className="agentinbox-msg-text">
                                                            {show
                                                                ? m.text
                                                                : `${m.text.slice(0, TRUNCATE_AT)}…`}
                                                        </div>
                                                        {long && !show && (
                                                            <button
                                                                type="button"
                                                                className="agentinbox-more"
                                                                onClick={() =>
                                                                    setExpanded((prev) =>
                                                                        new Set(prev).add(m.id),
                                                                    )
                                                                }
                                                            >
                                                                Show more
                                                            </button>
                                                        )}
                                                        {tags.length > 0 && (
                                                            <div className="agentinbox-tags">
                                                                {tags.map((t) => (
                                                                    <span
                                                                        key={t.label}
                                                                        className={`agentinbox-tag agentinbox-tag-${t.tone}`}
                                                                    >
                                                                        <span className="agentinbox-tag-dot" />
                                                                        {t.label}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })
                                        )}
                                        <div ref={streamEndRef} />
                                    </div>

                                    {sel.kind === 'dmPair' ? (
                                        <div className="agentinbox-foot">
                                            <span className="agentinbox-readonly">
                                                <IconLock size={12} />
                                                Agent-to-agent thread · read-only. You&rsquo;re
                                                observing.
                                            </span>
                                            <span className="grow" />
                                            <button
                                                type="button"
                                                className="agentinbox-primary"
                                                onClick={interrupt}
                                                title="Open your own DM with one of these agents"
                                            >
                                                <IconReply size={13} />
                                                Interrupt thread
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="agentinbox-composer">
                                            <textarea
                                                className="input agentinbox-input"
                                                value={draft}
                                                onChange={(e) => setDraft(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' && !e.shiftKey) {
                                                        e.preventDefault();
                                                        void post();
                                                    }
                                                }}
                                                placeholder={`Message ${sel.title} as you…`}
                                                rows={2}
                                            />
                                            <button
                                                type="button"
                                                className="agentinbox-primary"
                                                onClick={() => void post()}
                                                disabled={!draft.trim() || posting}
                                            >
                                                {posting ? 'Sending…' : 'Send'}
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                )}
            </aside>
        </div>
    );
}
