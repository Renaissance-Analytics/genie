import { useCallback, useEffect, useRef, useState } from 'react';
import { IconRefresh, IconX } from './icons';
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
 * flyout chrome) with panes: the AGENT DIRECTORY (label / type / purpose /
 * status / workspace), the DIRECT-MESSAGE thread list (every DM pair with
 * messages — the human's OWN DMs AND agent↔agent threads), the CHANNEL list
 * (`slug:purpose`), and the message STREAM for the selection plus a composer that
 * posts as the human. Loads on open and stays live via `on.agentInboxPresence` /
 * `on.agentInboxMessage`. AgentInbox is local-only in v1, so it's guarded behind the
 * Genie bridge.
 */

/** The human panel's sender identity token (mirrors the broker's `AGENTINBOX_HUMAN`). */
const HUMAN = 'human';

type Selection =
    | { kind: 'channel'; key: string; title: string }
    | { kind: 'dm'; agentId: string; title: string }
    // An agent↔agent thread — the human watches it read-only.
    | { kind: 'dmPair'; a: string; b: string; title: string };

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
    // Track C — unACKed urgent DMs, keyed by messageId. Populated by
    // `on.agentInboxEscalation`; each is a "waiting on <agent>" oversight alert.
    const [escalations, setEscalations] = useState<Map<string, AgentInboxEscalationEvent>>(new Map());
    const streamEndRef = useRef<HTMLDivElement>(null);

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

    return (
        <div className={`docs-flyout-root${open ? ' open' : ''}`} aria-hidden={!open}>
            <div className="docs-scrim" onClick={onClose} />
            <aside
                className="docs-flyout agentinbox-flyout"
                role="dialog"
                aria-label="AgentInbox"
                aria-modal="false"
            >
                <div className="docs-head">
                    <span className="docs-title">AgentInbox</span>
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
                        {[...escalations.values()].map((e) => (
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
                            <div className="agentinbox-nav-head">Agents</div>
                            {agents.length === 0 ? (
                                <div className="agentinbox-empty">No agents online yet.</div>
                            ) : (
                                <ul className="agentinbox-list">
                                    {agents.map((a) => (
                                        <li key={a.agentId}>
                                            <button
                                                type="button"
                                                className={`agentinbox-agent${
                                                    sel?.kind === 'dm' &&
                                                    sel.agentId === a.agentId
                                                        ? ' on'
                                                        : ''
                                                }`}
                                                onClick={() =>
                                                    setSel({
                                                        kind: 'dm',
                                                        agentId: a.agentId,
                                                        title: a.label,
                                                    })
                                                }
                                                title={`DM ${a.label} · ${STATUS_LABEL[a.status]}`}
                                            >
                                                <span
                                                    className={`agentinbox-dot agentinbox-${a.status}`}
                                                />
                                                <span className="agentinbox-agent-main">
                                                    <span className="agentinbox-agent-label">
                                                        {a.label}
                                                    </span>
                                                    <span className="agentinbox-agent-sub">
                                                        {a.agentType} · {a.purpose} ·{' '}
                                                        {a.workspaceName}
                                                    </span>
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}

                            <div className="agentinbox-nav-head">Direct messages</div>
                            {threads.length === 0 ? (
                                <div className="agentinbox-empty">No direct messages yet.</div>
                            ) : (
                                <ul className="agentinbox-list">
                                    {threads.map((t) => {
                                        const active =
                                            (sel?.kind === 'dmPair' &&
                                                sel.a === t.a &&
                                                sel.b === t.b) ||
                                            (sel?.kind === 'dm' &&
                                                t.withHuman &&
                                                (t.a === sel.agentId || t.b === sel.agentId));
                                        return (
                                            <li key={t.key}>
                                                <button
                                                    type="button"
                                                    className={`agentinbox-dm${active ? ' on' : ''}`}
                                                    onClick={() => selectThread(t)}
                                                    title={`${t.aLabel} ↔ ${t.bLabel}`}
                                                >
                                                    <span className="agentinbox-dm-main">
                                                        <span className="agentinbox-dm-label">
                                                            {t.aLabel} ↔ {t.bLabel}
                                                        </span>
                                                        <span className="agentinbox-dm-sub">
                                                            {t.lastFromLabel}: {t.lastPreview}
                                                        </span>
                                                    </span>
                                                    <span className="agentinbox-dm-time">
                                                        {relTime(t.lastTs)}
                                                    </span>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}

                            <div className="agentinbox-nav-head">Channels</div>
                            {channels.length === 0 ? (
                                <div className="agentinbox-empty">No channels yet.</div>
                            ) : (
                                <ul className="agentinbox-list">
                                    {channels.map((c) => (
                                        <li key={c.key}>
                                            <button
                                                type="button"
                                                className={`agentinbox-channel${
                                                    sel?.kind === 'channel' &&
                                                    sel.key === c.key
                                                        ? ' on'
                                                        : ''
                                                }`}
                                                onClick={() =>
                                                    setSel({
                                                        kind: 'channel',
                                                        key: c.key,
                                                        title: `${c.slug}:${c.purpose}`,
                                                    })
                                                }
                                                title={`${c.slug}:${c.purpose} · ${c.workspaceName}`}
                                            >
                                                <span className="agentinbox-channel-name">
                                                    {c.slug}:{c.purpose}
                                                </span>
                                                <span className="agentinbox-channel-count">
                                                    {c.memberCount}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
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
                                        {sel.kind === 'channel'
                                            ? '#'
                                            : sel.kind === 'dm'
                                              ? '@'
                                              : ''}{' '}
                                        {sel.title}
                                        {loading && (
                                            <span className="iw-muted"> · loading…</span>
                                        )}
                                    </div>
                                    <div className="agentinbox-stream">
                                        {messages.length === 0 ? (
                                            <div className="agentinbox-empty">
                                                No messages yet.
                                            </div>
                                        ) : (
                                            messages.map((m) => (
                                                <div
                                                    key={m.id}
                                                    className={`agentinbox-msg${
                                                        m.from === 'human' ? ' is-human' : ''
                                                    }`}
                                                >
                                                    <div className="agentinbox-msg-meta">
                                                        <span className="agentinbox-msg-from">
                                                            {m.fromLabel}
                                                        </span>
                                                        <span className="agentinbox-msg-time">
                                                            {relTime(m.ts)}
                                                        </span>
                                                    </div>
                                                    <div className="agentinbox-msg-text">
                                                        {m.text}
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                        <div ref={streamEndRef} />
                                    </div>
                                    {sel.kind === 'dmPair' ? (
                                        <div className="agentinbox-readonly">
                                            Agent-to-agent thread — read-only.
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
                                                className="agentinbox-send"
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
