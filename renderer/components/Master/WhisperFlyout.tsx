import { useCallback, useEffect, useRef, useState } from 'react';
import { IconRefresh, IconX } from './icons';
import {
    api,
    hasGenieBridge,
    type WhisperAgentInfo,
    type WhisperChannelInfo,
    type WhisperMessage,
} from '../../lib/genie';

/**
 * WhisperChat human panel. Right-side slide-in (reuses the Docs / Task Manager
 * flyout chrome) with three panes: the AGENT DIRECTORY (label / type / purpose /
 * status / workspace), the CHANNEL list (`slug:purpose`), and the message STREAM
 * for the selected channel or DM plus a composer that posts as the human. Loads on
 * open and stays live via `on.whisperPresence` / `on.whisperMessage`. WhisperChat
 * is local-only in v1, so it's guarded behind the Genie bridge.
 */

type Selection =
    | { kind: 'channel'; key: string; title: string }
    | { kind: 'dm'; agentId: string; title: string };

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
    return (
        ev.kind === 'dm' && (ev.from === sel.agentId || ev.toAgentId === sel.agentId)
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
    const [sel, setSel] = useState<Selection | null>(null);
    const [messages, setMessages] = useState<WhisperMessage[]>([]);
    const [draft, setDraft] = useState('');
    const [loading, setLoading] = useState(false);
    const [posting, setPosting] = useState(false);
    const streamEndRef = useRef<HTMLDivElement>(null);

    const loadDirectory = useCallback(async () => {
        if (!hasGenieBridge()) return;
        const [d, c] = await Promise.all([
            api().whisper.directory().catch(() => ({ agents: [] as WhisperAgentInfo[] })),
            api().whisper.channels().catch(() => ({ channels: [] as WhisperChannelInfo[] })),
        ]);
        setAgents(d.agents);
        setChannels(c.channels);
    }, []);

    const loadHistory = useCallback(async (s: Selection) => {
        if (!hasGenieBridge()) return;
        setLoading(true);
        try {
            const res = await api()
                .whisper.history(
                    s.kind === 'channel' ? { channelKey: s.key } : { agentId: s.agentId },
                )
                .catch(() => ({ messages: [] as WhisperMessage[] }));
            setMessages(res.messages);
        } finally {
            setLoading(false);
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
        return () => {
            offPresence?.();
            offMessage?.();
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
        if (!text || !sel || posting) return;
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
                                    Pick an agent or a channel to see the conversation.
                                </div>
                            ) : (
                                <>
                                    <div className="whisper-thread-head">
                                        {sel.kind === 'channel' ? '#' : '@'} {sel.title}
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
                                            placeholder={
                                                sel.kind === 'channel'
                                                    ? `Message ${sel.title} as you…`
                                                    : `Message ${sel.title} as you…`
                                            }
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
                                </>
                            )}
                        </div>
                    </div>
                )}
            </aside>
        </div>
    );
}
