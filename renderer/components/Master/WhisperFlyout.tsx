import { useCallback, useEffect, useRef, useState } from 'react';
import { IconRefresh, IconX } from './icons';
import {
    api,
    hasGenieBridge,
    type WhisperAgentInfo,
    type WhisperChannelInfo,
    type WhisperDmThreadInfo,
    type WhisperEscalationEvent,
    type WhisperMessage,
} from '../../lib/genie';

/**
 * WhisperChat human panel. Right-side slide-in (reuses the Docs / Task Manager
 * flyout chrome) with panes: the AGENT DIRECTORY (label / type / purpose /
 * status / workspace), the DIRECT-MESSAGE thread list (every DM pair with
 * messages — the human's OWN DMs AND agent↔agent threads), the CHANNEL list
 * (`slug:purpose`), and the message STREAM for the selection plus a composer that
 * posts as the human. Loads on open and stays live via `on.whisperPresence` /
 * `on.whisperMessage`. WhisperChat is local-only in v1, so it's guarded behind the
 * Genie bridge.
 */

/** The human panel's sender identity token (mirrors the broker's `WHISPER_HUMAN`). */
const HUMAN = 'human';

type Selection =
    | { kind: 'channel'; key: string; title: string }
    | { kind: 'dm'; agentId: string; title: string }
    // An agent↔agent thread — the human watches it read-only.
    | { kind: 'dmPair'; a: string; b: string; title: string };

const STATUS_LABEL: Record<WhisperAgentInfo['status'], string> = {
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

export default function WhisperFlyout({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const [agents, setAgents] = useState<WhisperAgentInfo[]>([]);
    const [channels, setChannels] = useState<WhisperChannelInfo[]>([]);
    const [threads, setThreads] = useState<WhisperDmThreadInfo[]>([]);
    const [sel, setSel] = useState<Selection | null>(null);
    const [messages, setMessages] = useState<WhisperMessage[]>([]);
    const [draft, setDraft] = useState('');
    const [loading, setLoading] = useState(false);
    const [posting, setPosting] = useState(false);
    // Track C — unACKed urgent DMs, keyed by messageId. Populated by
    // `on.whisperEscalation`; each is a "waiting on <agent>" oversight alert.
    const [escalations, setEscalations] = useState<Map<string, WhisperEscalationEvent>>(new Map());
    const streamEndRef = useRef<HTMLDivElement>(null);

    const loadDirectory = useCallback(async () => {
        if (!hasGenieBridge()) return;
        const [d, c, t] = await Promise.all([
            api().whisper.directory().catch(() => ({ agents: [] as WhisperAgentInfo[] })),
            api().whisper.channels().catch(() => ({ channels: [] as WhisperChannelInfo[] })),
            api().whisper.dmThreads().catch(() => ({ threads: [] as WhisperDmThreadInfo[] })),
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
                .whisper.history(
                    s.kind === 'channel'
                        ? { channelKey: s.key }
                        : s.kind === 'dmPair'
                          ? { dmPair: [s.a, s.b] }
                          : { agentId: s.agentId },
                )
                .catch(() => ({ messages: [] as WhisperMessage[] }));
            setMessages(res.messages);
        } finally {
            setLoading(false);
        }
    }, []);

    // Select a DM thread from the list: the human's OWN DM reuses the human↔agent
    // path (so the composer posts to that agent); an agent↔agent thread opens as a
    // read-only `dmPair` view.
    const selectThread = useCallback((t: WhisperDmThreadInfo) => {
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
        const offPresence = api().on.whisperPresence?.(() => void loadDirectory());
        const offMessage = api().on.whisperMessage?.((ev) => {
            void loadDirectory();
            setSel((cur) => {
                if (cur && eventMatches(cur, ev)) void loadHistory(cur);
                return cur;
            });
        });
        // Track C — raise / clear "waiting on <agent>" oversight alerts.
        const offEscalation = api().on.whisperEscalation?.((ev) => {
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
                .whisper.post(
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
                className="docs-flyout whisper-flyout"
                role="dialog"
                aria-label="WhisperChat"
                aria-modal="false"
            >
                <div className="docs-head">
                    <span className="docs-title">WhisperChat</span>
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
                        title="Close WhisperChat"
                        aria-label="Close WhisperChat"
                    >
                        <IconX />
                    </button>
                </div>

                {/* Track C — oversight: urgent DMs a peer hasn't picked up. */}
                {hasGenieBridge() && escalations.size > 0 && (
                    <div className="whisper-escalations">
                        {[...escalations.values()].map((e) => (
                            <div key={e.messageId} className="whisper-escalation" role="alert">
                                <span className="whisper-escalation-dot" />
                                <span className="whisper-escalation-text">
                                    Waiting on <b>{e.targetLabel ?? 'an agent'}</b> — {e.fromLabel ?? 'an'} urgent message is unread
                                    {e.sinceTs ? <span className="whisper-escalation-age"> · {relTime(e.sinceTs)}</span> : null}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                {!hasGenieBridge() ? (
                    <div className="whisper-body">
                        <div className="iw-muted" style={{ padding: 16 }}>
                            WhisperChat runs inside Genie.
                        </div>
                    </div>
                ) : (
                    <div className="whisper-body">
                        <div className="whisper-nav">
                            <div className="whisper-nav-head">Agents</div>
                            {agents.length === 0 ? (
                                <div className="whisper-empty">No agents online yet.</div>
                            ) : (
                                <ul className="whisper-list">
                                    {agents.map((a) => (
                                        <li key={a.agentId}>
                                            <button
                                                type="button"
                                                className={`whisper-agent${
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
                                                    className={`whisper-dot whisper-${a.status}`}
                                                />
                                                <span className="whisper-agent-main">
                                                    <span className="whisper-agent-label">
                                                        {a.label}
                                                    </span>
                                                    <span className="whisper-agent-sub">
                                                        {a.agentType} · {a.purpose} ·{' '}
                                                        {a.workspaceName}
                                                    </span>
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}

                            <div className="whisper-nav-head">Direct messages</div>
                            {threads.length === 0 ? (
                                <div className="whisper-empty">No direct messages yet.</div>
                            ) : (
                                <ul className="whisper-list">
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
                                                    className={`whisper-dm${active ? ' on' : ''}`}
                                                    onClick={() => selectThread(t)}
                                                    title={`${t.aLabel} ↔ ${t.bLabel}`}
                                                >
                                                    <span className="whisper-dm-main">
                                                        <span className="whisper-dm-label">
                                                            {t.aLabel} ↔ {t.bLabel}
                                                        </span>
                                                        <span className="whisper-dm-sub">
                                                            {t.lastFromLabel}: {t.lastPreview}
                                                        </span>
                                                    </span>
                                                    <span className="whisper-dm-time">
                                                        {relTime(t.lastTs)}
                                                    </span>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}

                            <div className="whisper-nav-head">Channels</div>
                            {channels.length === 0 ? (
                                <div className="whisper-empty">No channels yet.</div>
                            ) : (
                                <ul className="whisper-list">
                                    {channels.map((c) => (
                                        <li key={c.key}>
                                            <button
                                                type="button"
                                                className={`whisper-channel${
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
                                                <span className="whisper-channel-name">
                                                    {c.slug}:{c.purpose}
                                                </span>
                                                <span className="whisper-channel-count">
                                                    {c.memberCount}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        <div className="whisper-main">
                            {!sel ? (
                                <div className="whisper-empty whisper-placeholder">
                                    Pick an agent, a DM thread, or a channel to see the
                                    conversation.
                                </div>
                            ) : (
                                <>
                                    <div className="whisper-thread-head">
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
                                    <div className="whisper-stream">
                                        {messages.length === 0 ? (
                                            <div className="whisper-empty">
                                                No messages yet.
                                            </div>
                                        ) : (
                                            messages.map((m) => (
                                                <div
                                                    key={m.id}
                                                    className={`whisper-msg${
                                                        m.from === 'human' ? ' is-human' : ''
                                                    }`}
                                                >
                                                    <div className="whisper-msg-meta">
                                                        <span className="whisper-msg-from">
                                                            {m.fromLabel}
                                                        </span>
                                                        <span className="whisper-msg-time">
                                                            {relTime(m.ts)}
                                                        </span>
                                                    </div>
                                                    <div className="whisper-msg-text">
                                                        {m.text}
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                        <div ref={streamEndRef} />
                                    </div>
                                    {sel.kind === 'dmPair' ? (
                                        <div className="whisper-readonly">
                                            Agent-to-agent thread — read-only.
                                        </div>
                                    ) : (
                                        <div className="whisper-composer">
                                            <textarea
                                                className="input whisper-input"
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
                                                className="whisper-send"
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
