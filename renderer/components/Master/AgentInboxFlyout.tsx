import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Action, Badge, Modal, Popover, Tabs, Text } from '@particle-academy/react-fancy';
import {
    IconCheckCheck,
    IconClock,
    IconDownload,
    IconLock,
    IconMore,
    IconPaperclip,
    IconRefresh,
    IconReply,
    IconSearch,
    IconSwap,
    IconTrash,
    IconX,
} from './icons';
import {
    api,
    currentConnKey,
    hasGenieBridge,
    type AgentInboxAgentInfo,
    type AgentInboxAttachment,
    type AgentInboxChannelInfo,
    type AgentInboxDmThreadInfo,
    type AgentInboxEscalationEvent,
    type AgentInboxMessage,
} from '../../lib/genie';
import {
    attachmentChipLabel,
    composerAttachmentSummary,
    suggestedSaveName,
} from '../../lib/agentinbox-attachments';
import {
    forgetSeen,
    headcountOf,
    makeCoalescer,
    markSeen,
    parseSeenState,
    partitionWipeTargets,
    rowKeyOfPairKey,
    seenStorageKey,
    toggleSelection,
    wipeToken,
    serializeSeenState,
    sortByActivityDesc,
    sortedPairKey,
    agentDisplayOf,
    avatarInitials,
    type AgentProviderId,
} from '../../lib/agentinbox-view';
import { terminalTypeForAgent } from '../../lib/terminal-types';

/**
 * AgentInbox human panel. Right-side slide-in (reuses the Docs / Task Manager
 * flyout chrome) laid out as a full-width header over a two-pane body: a LEFT
 * list pane (search + a `Channels | DMs` tab switcher + filter chips + waiting
 * summary) and a RIGHT thread pane (thread header, per-agent inbox status, the
 * message stream, and a fixed footer that is the composer on a writable thread
 * and a read-only bar on an observed agent↔agent thread). Loads on open and
 * stays live via `on.agentInboxPresence` / `on.agentInboxMessage` /
 * `on.agentInboxEscalation` / `on.agentInboxCleared`.
 *
 * genie #64 shaped the left pane: nearly every terminal in Genie is an agent and
 * the sidebar already lists them, so there is NO standing agent directory here —
 * just a headcount pill in the header that reveals the list on click. Both lists
 * are always sorted by LAST ACTIVITY, newest first.
 *
 * Read/unread here is the VIEWER's, persisted client-side (see
 * `renderer/lib/agentinbox-view.ts`). It is never the host's agent ACK cursor —
 * that drives the header's agent-lag badge, a different question entirely.
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

/** Which list the left pane is showing (genie #64 — tabbed, not stacked). */
type Tab = 'channels' | 'dms';

/**
 * A wipe awaiting confirmation. Wiping history is irreversible and reaches the
 * durable host store, so it always goes through a confirm step rather than
 * firing straight off a row hover.
 */
type PendingWipe =
    | { kind: 'channel'; key: string; label: string }
    | { kind: 'dm'; pairKey: string; label: string }
    // A multi-select mass delete (genie #66) — one host call for the whole set.
    | { kind: 'batch'; tokens: string[]; channels: number; threads: number };

/** A file staged on the composer, already read to base64 by the file input. */
interface StagedFile {
    filename: string;
    bytes: number;
    base64: string;
}

/**
 * Cap on what the panel will stage, mirroring the host's per-file ceiling. The
 * host is the authority (it refuses oversize on post), but catching it here
 * means the human learns BEFORE typing a message that the file won't go.
 */
const MAX_STAGED_BYTES = 25 * 1024 * 1024;

/** Read a picked File to base64 without a data-URL prefix. */
async function readFileAsBase64(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    let binary = '';
    const view = new Uint8Array(buf);
    // Chunked so a multi-megabyte file can't blow the argument limit on apply().
    for (let i = 0; i < view.length; i += 8192) {
        binary += String.fromCharCode(...view.subarray(i, i + 8192));
    }
    return btoa(binary);
}

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

/** The broker DM pair key for a DM selection — what `deleteThread` takes. */
function pairKeyOf(s: Selection): string {
    if (s.kind === 'dm') return sortedPairKey(HUMAN, s.agentId);
    if (s.kind === 'dmPair') return sortedPairKey(s.a, s.b);
    return '';
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

/**
 * The PROVIDER LOGO to draw for a participant, or null for the human and for an
 * agent that has left the directory (Tynn #254).
 */
function providerOf(
    agentId: string,
    byId: Map<string, AgentInboxAgentInfo>,
): AgentProviderId | null {
    if (agentId === HUMAN) return null;
    return agentDisplayOf(byId.get(agentId)).provider;
}

/** The avatar fallback for a participant with no logo — the human, or a
 *  departed agent. An agent Genie runs gets its provider's logo instead. */
function shortCode(agentId: string, byId: Map<string, AgentInboxAgentInfo>): string {
    if (agentId === HUMAN) return 'yo';
    const a = byId.get(agentId);
    return avatarInitials(a?.purpose || a?.label || agentId);
}

/** An agent's NAME as a person reads it — never `claude · tynn`, never a ref. */
function nameOf(agentId: string, byId: Map<string, AgentInboxAgentInfo>, fallback: string): string {
    if (agentId === HUMAN) return 'You';
    return agentDisplayOf(byId.get(agentId), fallback).name;
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

/**
 * A small rounded-square agent avatar: the PROVIDER'S LOGO when the participant
 * is an agent Genie runs, and initials otherwise (Tynn #254).
 *
 * The logo is what makes two agents of the same name distinguishable — `cl` and
 * `cx` beside two identical `tynn`s is not something anyone reads at a glance,
 * and it was worse than that: only codex had a code of its own, so a claude
 * agent got the first two letters of its own name and matched nothing.
 */
function Avatar({
    code,
    tone,
    provider,
}: {
    code: string;
    tone: string;
    provider?: AgentProviderId | null;
}) {
    const Logo = provider ? terminalTypeForAgent(provider).icon : null;
    return (
        <span className={`agentinbox-av agentinbox-tone-${tone}`}>
            {Logo ? <Logo size={14} /> : code}
        </span>
    );
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
            <Avatar code={shortCode(a, byId)} tone={toneOf(a, byId)} provider={providerOf(a, byId)} />
            <Avatar code={shortCode(b, byId)} tone={toneOf(b, byId)} provider={providerOf(b, byId)} />
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
    const [tab, setTab] = useState<Tab>('channels');
    const [rosterOpen, setRosterOpen] = useState(false);
    // genie #66 — multi-select. Tokens are typed (`channel:` / `dm:`) so ONE set
    // spans both tabs: the owner can tick channels and DMs and wipe them together.
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [pendingWipe, setPendingWipe] = useState<PendingWipe | null>(null);
    const [wiping, setWiping] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    // Channels carry no timestamp in the directory payload, so their preview and
    // relative time are built from the live message events the panel observes
    // (and back-filled from history the first time one is opened).
    const [chanActivity, setChanActivity] = useState<Map<string, RowActivity>>(new Map());
    // Highest seq the human has actually looked at, per row — drives "unread".
    // CLIENT-SIDE and PERSISTED (genie #64): this is the viewer's own state, not
    // the host's agent ACK cursor, so it lives in localStorage bucketed by
    // `currentConnKey()` — the local window and each host window keep their own,
    // and it survives a reload of this infrequently-visited panel.
    const [seenSeq, setSeenSeq] = useState<Map<string, number>>(() => {
        if (typeof window === 'undefined') return new Map();
        try {
            return parseSeenState(window.localStorage.getItem(seenStorageKey(currentConnKey())));
        } catch {
            // Storage can be unavailable (disabled/quota); read state is a nicety,
            // never a blocker for showing the inbox.
            return new Map();
        }
    });

    // Persist the viewer's read state on every change.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        try {
            window.localStorage.setItem(
                seenStorageKey(currentConnKey()),
                serializeSeenState(seenSeq),
            );
        } catch {
            /* storage unavailable — the panel still works, it just re-reads next boot */
        }
    }, [seenSeq]);
    // Track C — unACKed urgent DMs, keyed by messageId. Populated by
    // `on.agentInboxEscalation`; each is a "waiting on <agent>" oversight alert.
    const [escalations, setEscalations] = useState<Map<string, AgentInboxEscalationEvent>>(new Map());
    const streamEndRef = useRef<HTMLDivElement>(null);
    // Files staged on the composer, already read into base64 by the browser's own
    // file input. The BYTES ride the post rather than a host path, so a remote
    // human attaches from THEIR machine and the panel needs no fs access.
    const [staged, setStaged] = useState<StagedFile[]>([]);
    const [attachError, setAttachError] = useState<string | null>(null);
    // Attachment id currently downloading — the chip shows it is working, since
    // the bytes come over the bridge on a host window.
    const [downloading, setDownloading] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

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
                // `markSeen` is monotonic, so paging back through old history
                // can never un-read the row.
                setSeenSeq((prev) => markSeen(prev, rowKeyOfSelection(s), last.seq));
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
        // genie #64 — a conversation was WIPED (here, in another window, or on the
        // host). Drop every cached trace of it: the row's activity, the viewer's
        // read mark (else a future thread reusing the key would open pre-read),
        // and the open stream if it was the one wiped.
        //
        // genie #66 — a MASS delete fires one of these per target (deliberately,
        // so the per-key invalidation below stays exact). Only the directory
        // REFETCH is coalesced, or an N-target batch would cost 3N round trips.
        const reload = makeCoalescer(() => void loadDirectory());
        const offCleared = api().on.agentInboxCleared?.((ev) => {
            const rowKey = ev.scope === 'channel' ? `c:${ev.key}` : null;
            if (ev.scope === 'channel') {
                setChanActivity((prev) => {
                    if (!prev.has(ev.key)) return prev;
                    const next = new Map(prev);
                    next.delete(ev.key);
                    return next;
                });
            }
            setSeenSeq((prev) => forgetSeen(prev, rowKey ?? rowKeyOfPairKey(ev.key)));
            // A wiped row can't stay ticked — its token would outlive the row.
            setSelected((prev) => {
                const token = wipeToken(
                    ev.scope === 'channel' ? 'channel' : 'dm',
                    ev.key,
                );
                if (!prev.has(token)) return prev;
                const next = new Set(prev);
                next.delete(token);
                return next;
            });
            reload.schedule();
            setSel((cur) => {
                if (!cur) return cur;
                const hit =
                    ev.scope === 'channel'
                        ? cur.kind === 'channel' && cur.key === ev.key
                        : rowKeyOfSelection(cur) === rowKeyOfPairKey(ev.key);
                if (!hit) return cur;
                setMessages([]);
                return null;
            });
        });
        return () => {
            offPresence?.();
            offMessage?.();
            offEscalation?.();
            offCleared?.();
            reload.cancel();
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
        // Staged files belong to the thread they were staged in — switching
        // conversations must not carry them into someone else's message.
        setStaged([]);
        setAttachError(null);
        void loadHistory(sel);
    }, [open, sel, loadHistory]);

    // Close on Escape.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            // A confirm modal or the roster popover OWNS Escape while it is up —
            // Fancy dismisses it, and the flyout must not close out from under it
            // (which would look like one keypress closing two layers).
            if (pendingWipe || rosterOpen) return;
            e.preventDefault();
            onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose, pendingWipe, rosterOpen]);

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
            const attachments = staged.map((f) => ({ filename: f.filename, base64: f.base64 }));
            const target =
                sel.kind === 'channel' ? { channelKey: sel.key } : { toAgentId: sel.agentId };
            const res = await api()
                .agentInbox.post({ ...target, text, ...(attachments.length ? { attachments } : {}) })
                .catch(() => ({ ok: false, error: 'Could not reach the host.' }));
            if (res.ok) {
                setDraft('');
                setStaged([]);
                setAttachError(null);
                await loadHistory(sel);
            } else {
                // The post is all-or-nothing on the host, so the draft and the
                // staged files are deliberately KEPT — the human fixes the
                // problem and sends the same message rather than retyping it.
                setAttachError(res.error ?? 'The message could not be sent.');
            }
        } finally {
            setPosting(false);
        }
    };

    /** Stage the files the human just picked (the browser reads them locally). */
    const onPickFiles = async (list: FileList | null) => {
        if (!list || list.length === 0) return;
        const next: StagedFile[] = [];
        for (const file of Array.from(list)) {
            if (file.size > MAX_STAGED_BYTES) {
                setAttachError(`"${file.name}" is too large to attach.`);
                continue;
            }
            if (file.size === 0) {
                setAttachError(`"${file.name}" is empty.`);
                continue;
            }
            try {
                next.push({
                    filename: file.name,
                    bytes: file.size,
                    base64: await readFileAsBase64(file),
                });
            } catch {
                setAttachError(`"${file.name}" could not be read.`);
            }
        }
        if (next.length > 0) {
            setAttachError(null);
            setStaged((prev) => [...prev, ...next]);
        }
    };

    /**
     * Download an attachment. The BYTES come from the host's store and are saved
     * on THIS machine — so on a remote window the human gets the file locally,
     * which is where they wanted it, and no host path is ever involved.
     */
    const download = async (att: AgentInboxAttachment) => {
        if (downloading) return;
        setDownloading(att.id);
        try {
            const res = await api()
                .agentInbox.attachmentBytes(att.id)
                .catch(() => ({ ok: false, error: 'Could not reach the host.' }) as
                    Awaited<ReturnType<ReturnType<typeof api>['agentInbox']['attachmentBytes']>>);
            if (!res.ok || !res.base64) {
                setAttachError(res.error ?? 'That attachment could not be downloaded.');
                return;
            }
            const bin = atob(res.base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const url = URL.createObjectURL(
                new Blob([bytes], { type: res.mime || 'application/octet-stream' }),
            );
            const a = document.createElement('a');
            a.href = url;
            a.download = suggestedSaveName(res.filename ?? att.filename);
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } finally {
            setDownloading(null);
        }
    };

    /**
     * Run a confirmed wipe. Both ops are HOST ops (the durable log lives in the
     * host's genie.db), so the panel does NOT optimistically prune its own
     * state — it waits for the host's `agentinbox:cleared` push, which drives the
     * identical refresh in every open window (and over the bridge on a remote
     * one). A failed call leaves the conversation exactly as it was.
     */
    const confirmWipe = async () => {
        if (!pendingWipe || wiping) return;
        setWiping(true);
        try {
            if (pendingWipe.kind === 'channel') {
                await api().agentInbox.clearChannel(pendingWipe.key);
            } else if (pendingWipe.kind === 'dm') {
                await api().agentInbox.deleteThread(pendingWipe.pairKey);
            } else {
                // ONE host call for the whole selection — the broker batches over
                // the same per-target ops, so a partial failure can't leave half
                // the set in a different state than a one-at-a-time loop would.
                await api().agentInbox.wipeMany(partitionWipeTargets(pendingWipe.tokens));
                setSelected(new Set());
                setSelectMode(false);
            }
            await loadDirectory();
        } finally {
            setWiping(false);
            setPendingWipe(null);
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

    // genie #64 — ALWAYS sorted by last activity, newest first, both lists. A
    // channel with no traffic yet carries no activity and sinks to the bottom.
    const shownChannels = sortByActivityDesc(channelRows.filter(passesFilter), (r) => r.act);
    const shownThreads = sortByActivityDesc(threadRows.filter(passesFilter), (r) => r.act);

    const allRows = [...channelRows, ...threadRows];
    const counts: Record<Filter, number> = {
        all: allRows.length,
        unread: allRows.filter((r) => r.unread).length,
        stale: allRows.filter((r) => isStale(r.act)).length,
    };

    // genie #66 — the tokens for whatever the ACTIVE tab currently shows, which is
    // what "Select all" operates on (selecting rows a filter is hiding would be a
    // nasty surprise). The selection itself spans both tabs.
    const visibleTokens =
        tab === 'channels'
            ? shownChannels.map((r) => wipeToken('channel', r.c.key))
            : shownThreads.map((r) => wipeToken('dm', r.t.key));
    const allVisibleSelected =
        visibleTokens.length > 0 && visibleTokens.every((t) => selected.has(t));

    const toggleAllVisible = () => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (allVisibleSelected) for (const t of visibleTokens) next.delete(t);
            else for (const t of visibleTokens) next.add(t);
            return next;
        });
    };

    const exitSelectMode = () => {
        setSelectMode(false);
        setSelected(new Set());
    };

    /** Open the confirm for the current multi-selection. */
    const requestBatchWipe = () => {
        const { channelKeys, pairKeys } = partitionWipeTargets([...selected]);
        if (channelKeys.length + pairKeys.length === 0) return;
        setPendingWipe({
            kind: 'batch',
            tokens: [...selected],
            channels: channelKeys.length,
            threads: pairKeys.length,
        });
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

    // genie #64 — the headcount PILL replaced the standing agent list: nearly
    // every terminal in Genie is an agent and the sidebar already lists them, so
    // the panel shows `active/total` and reveals the roster only on click.
    const headcount = headcountOf(agents);

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
        if (last) setSeenSeq((prev) => markSeen(prev, rowKeyOfSelection(sel), last.seq));
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
                        <Popover
                            placement="bottom"
                            offset={6}
                            open={rosterOpen}
                            onOpenChange={setRosterOpen}
                        >
                            <Popover.Trigger>
                                <button
                                    type="button"
                                    className="agentinbox-live agentinbox-headcount"
                                    aria-expanded={rosterOpen}
                                    title={`${headcount.active} of ${headcount.total} agents active — click for the roster`}
                                >
                                    <span className="agentinbox-live-dot" />
                                    {headcount.active}/{headcount.total} agents
                                </button>
                            </Popover.Trigger>
                            <Popover.Content
                                className="agentinbox-roster"
                                role="menu"
                                aria-label="Agent roster"
                            >
                                {agents.length === 0 ? (
                                    <Text size="xs" className="text-zinc-500">
                                        No agents registered yet.
                                    </Text>
                                ) : (
                                    <ul className="agentinbox-roster-list">
                                        {agents.map((a) => (
                                            <li key={a.agentId}>
                                                <button
                                                    type="button"
                                                    role="menuitem"
                                                    className="agentinbox-roster-row"
                                                    onClick={() => {
                                                        setSel({
                                                            kind: 'dm',
                                                            agentId: a.agentId,
                                                            title: a.label,
                                                        });
                                                        // The DM we just opened lives in the DMs
                                                        // list — land the user where it is.
                                                        setTab('dms');
                                                        setRosterOpen(false);
                                                    }}
                                                    title={`DM ${nameOf(a.agentId, byId, a.label)} · ${STATUS_LABEL[a.status]}`}
                                                >
                                                    <span className="agentinbox-row-av">
                                                        <Avatar
                                                            code={shortCode(a.agentId, byId)}
                                                            tone={toneOf(a.agentId, byId)}
                                                            provider={providerOf(a.agentId, byId)}
                                                        />
                                                        <span
                                                            className={`agentinbox-dot agentinbox-${a.status}`}
                                                        />
                                                    </span>
                                                    <span className="agentinbox-roster-main">
                                                        {/* The NAME alone — the provider is the
                                                            logo beside it, and the chat-id is
                                                            addressing that belongs nowhere a
                                                            person reads (Tynn #254). */}
                                                        <span className="agentinbox-row-name">
                                                            {nameOf(a.agentId, byId, a.label)}
                                                        </span>
                                                        <span className="agentinbox-row-preview">
                                                            {a.workspaceName} ·{' '}
                                                            {STATUS_LABEL[a.status]}
                                                        </span>
                                                    </span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </Popover.Content>
                        </Popover>
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

                            {/* genie #64 — Channels | DMs, tabbed rather than two
                                stacked sections, so the pane shows ONE list at a time. */}
                            <Tabs
                                variant="pills"
                                activeTab={tab}
                                onTabChange={(t) => setTab(t as Tab)}
                                className="agentinbox-tabs"
                            >
                                <Tabs.List className="agentinbox-tabs-list">
                                    <Tabs.Tab value="channels">
                                        Channels
                                        <span className="agentinbox-chip-count">
                                            {shownChannels.length}
                                        </span>
                                    </Tabs.Tab>
                                    <Tabs.Tab value="dms">
                                        DMs
                                        <span className="agentinbox-chip-count">
                                            {shownThreads.length}
                                        </span>
                                    </Tabs.Tab>
                                </Tabs.List>
                            </Tabs>

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
                                <span className="grow" />
                                {/* genie #66 — enter multi-select to wipe in bulk. */}
                                <button
                                    type="button"
                                    className={`agentinbox-chip${selectMode ? ' on' : ''}`}
                                    onClick={() =>
                                        selectMode ? exitSelectMode() : setSelectMode(true)
                                    }
                                    aria-pressed={selectMode}
                                    title={
                                        selectMode
                                            ? 'Leave selection mode'
                                            : 'Select several conversations to delete at once'
                                    }
                                >
                                    {selectMode ? 'Done' : 'Select'}
                                </button>
                            </div>

                            {selectMode && (
                                <div className="agentinbox-selectbar" role="group" aria-label="Bulk actions">
                                    <label className="agentinbox-selectall">
                                        <input
                                            type="checkbox"
                                            checked={allVisibleSelected}
                                            onChange={toggleAllVisible}
                                            disabled={visibleTokens.length === 0}
                                            aria-label={`Select all ${tab === 'channels' ? 'channels' : 'DMs'} shown`}
                                        />
                                        All shown
                                    </label>
                                    <span className="agentinbox-selectcount">
                                        {selected.size} selected
                                    </span>
                                    <span className="grow" />
                                    <button
                                        type="button"
                                        className="agentinbox-danger"
                                        onClick={requestBatchWipe}
                                        disabled={selected.size === 0}
                                        title="Delete every selected conversation"
                                    >
                                        <IconTrash size={12} />
                                        Delete selected
                                    </button>
                                </div>
                            )}

                            {waitingThreadCount > 0 && (
                                <div className="agentinbox-waiting-line">
                                    <IconClock size={12} />
                                    {waitingThreadCount} thread
                                    {waitingThreadCount === 1 ? '' : 's'} waiting on an agent
                                    {oldestWaiting ? ` · oldest ${relTime(oldestWaiting)}` : ''}
                                </div>
                            )}

                            {/* Only the ACTIVE tab's list renders — the panes are
                                alternatives, not two sections of one scroll. */}
                            <div className="agentinbox-scroll">
                                {tab === 'channels' ? (
                                    shownChannels.length === 0 ? (
                                        <div className="agentinbox-empty">No channels yet.</div>
                                    ) : (
                                        <ul className="agentinbox-list">
                                            {shownChannels.map(({ c, act, unread }) => {
                                                const token = wipeToken('channel', c.key);
                                                const ticked = selected.has(token);
                                                return (
                                                <li
                                                    key={c.key}
                                                    className={`agentinbox-li${selectMode ? ' picking' : ''}`}
                                                >
                                                    {selectMode && (
                                                        <input
                                                            type="checkbox"
                                                            className="agentinbox-row-check"
                                                            checked={ticked}
                                                            onChange={() =>
                                                                setSelected((p) =>
                                                                    toggleSelection(p, token),
                                                                )
                                                            }
                                                            aria-label={`Select #${c.purpose} in ${c.workspaceName}`}
                                                        />
                                                    )}
                                                    <button
                                                        type="button"
                                                        className={`agentinbox-row${
                                                            !selectMode &&
                                                            sel?.kind === 'channel' &&
                                                            sel.key === c.key
                                                                ? ' on'
                                                                : ''
                                                        }${unread ? ' alert' : ''}${ticked ? ' picked' : ''}`}
                                                        onClick={() =>
                                                            // In selection mode the row IS the
                                                            // checkbox target — a bigger hit area
                                                            // than the box alone.
                                                            selectMode
                                                                ? setSelected((p) =>
                                                                      toggleSelection(p, token),
                                                                  )
                                                                : setSel({
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
                                                    {/* Sibling, not a child: a button inside a
                                                        button is invalid and unclickable. The
                                                        single-row action hides in selection mode —
                                                        "Delete selected" is the action there. */}
                                                    {!selectMode && (
                                                        <button
                                                            type="button"
                                                            className="agentinbox-row-action"
                                                            onClick={() =>
                                                                setPendingWipe({
                                                                    kind: 'channel',
                                                                    key: c.key,
                                                                    label: `#${c.purpose} · ${c.workspaceName}`,
                                                                })
                                                            }
                                                            title={`Clear #${c.purpose} history`}
                                                            aria-label={`Clear #${c.purpose} history`}
                                                        >
                                                            <IconTrash size={12} />
                                                        </button>
                                                    )}
                                                </li>
                                                );
                                            })}
                                        </ul>
                                    )
                                ) : shownThreads.length === 0 ? (
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
                                            const token = wipeToken('dm', t.key);
                                            const ticked = selected.has(token);
                                            return (
                                                <li
                                                    key={t.key}
                                                    className={`agentinbox-li${selectMode ? ' picking' : ''}`}
                                                >
                                                    {selectMode && (
                                                        <input
                                                            type="checkbox"
                                                            className="agentinbox-row-check"
                                                            checked={ticked}
                                                            onChange={() =>
                                                                setSelected((p) =>
                                                                    toggleSelection(p, token),
                                                                )
                                                            }
                                                            aria-label={`Select the DM thread ${t.aLabel} ↔ ${t.bLabel}`}
                                                        />
                                                    )}
                                                    <button
                                                        type="button"
                                                        className={`agentinbox-row${
                                                            !selectMode && active ? ' on' : ''
                                                        }${unread ? ' alert' : ''}${ticked ? ' picked' : ''}`}
                                                        onClick={() =>
                                                            selectMode
                                                                ? setSelected((p) =>
                                                                      toggleSelection(p, token),
                                                                  )
                                                                : selectThread(t)
                                                        }
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
                                                    {!selectMode && (
                                                        <button
                                                            type="button"
                                                            className="agentinbox-row-action"
                                                            onClick={() =>
                                                                setPendingWipe({
                                                                    kind: 'dm',
                                                                    pairKey: t.key,
                                                                    label: `${t.aLabel} ↔ ${t.bLabel}`,
                                                                })
                                                            }
                                                            title="Delete this DM thread"
                                                            aria-label={`Delete the DM thread ${t.aLabel} ↔ ${t.bLabel}`}
                                                        >
                                                            <IconTrash size={12} />
                                                        </button>
                                                    )}
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
                                                    {/* genie #64 — wipe from the thread you're
                                                        reading, not only from its list row. */}
                                                    <button
                                                        type="button"
                                                        role="menuitem"
                                                        className="agentinbox-menu-danger"
                                                        onClick={() => {
                                                            setMenuOpen(false);
                                                            setPendingWipe(
                                                                sel.kind === 'channel'
                                                                    ? {
                                                                          kind: 'channel',
                                                                          key: sel.key,
                                                                          label: sel.title,
                                                                      }
                                                                    : {
                                                                          kind: 'dm',
                                                                          pairKey: pairKeyOf(sel),
                                                                          label: sel.title,
                                                                      },
                                                            );
                                                        }}
                                                    >
                                                        {sel.kind === 'channel'
                                                            ? 'Clear history'
                                                            : 'Delete thread'}
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
                                                                provider={providerOf(p, byId)}
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
                                                                provider={providerOf(m.from, byId)}
                                                            />
                                                            <span
                                                                className={`agentinbox-msg-from agentinbox-name-${tone}`}
                                                            >
                                                                {nameOf(m.from, byId, m.fromLabel)}
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
                                                        {(m.attachments?.length ?? 0) > 0 && (
                                                            <div className="agentinbox-attachments">
                                                                {m.attachments!.map((att) => (
                                                                    <button
                                                                        key={att.id}
                                                                        type="button"
                                                                        className="agentinbox-attachment"
                                                                        onClick={() => void download(att)}
                                                                        disabled={downloading === att.id}
                                                                        title={`Download ${att.filename}`}
                                                                    >
                                                                        <Badge
                                                                            variant="soft"
                                                                            size="sm"
                                                                            color="slate"
                                                                        >
                                                                            <IconPaperclip size={11} />
                                                                            {attachmentChipLabel(att)}
                                                                            {downloading === att.id ? (
                                                                                <IconClock size={11} />
                                                                            ) : (
                                                                                <IconDownload size={11} />
                                                                            )}
                                                                        </Badge>
                                                                    </button>
                                                                ))}
                                                            </div>
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

                                    {/* Attachment trouble is reported ABOVE the footer, so a
                                        failed DOWNLOAD is still visible on a read-only
                                        agent↔agent thread — where there is no composer to
                                        carry the notice. */}
                                    {attachError && (
                                        <div className="agentinbox-staged">
                                            <Text size="xs" className="agentinbox-staged-err">
                                                {attachError}
                                            </Text>
                                        </div>
                                    )}

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
                                        <div className="agentinbox-composer-wrap">
                                            {staged.length > 0 && (
                                                <div className="agentinbox-staged">
                                                    {staged.map((f, i) => (
                                                        <Badge
                                                            key={`${f.filename}-${i}`}
                                                            variant="soft"
                                                            size="sm"
                                                            color="slate"
                                                        >
                                                            <IconPaperclip size={11} />
                                                            {attachmentChipLabel(f)}
                                                            <button
                                                                type="button"
                                                                className="agentinbox-staged-x"
                                                                title={`Remove ${f.filename}`}
                                                                onClick={() =>
                                                                    setStaged((prev) =>
                                                                        prev.filter((_, j) => j !== i),
                                                                    )
                                                                }
                                                            >
                                                                <IconX size={10} />
                                                            </button>
                                                        </Badge>
                                                    ))}
                                                    <Text size="xs" className="agentinbox-staged-sum">
                                                        {composerAttachmentSummary(staged)}
                                                    </Text>
                                                </div>
                                            )}
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
                                                {/* The browser's own picker: the bytes are read HERE,
                                                    so a remote window attaches from the human's machine
                                                    and the panel needs no filesystem access. */}
                                                <input
                                                    ref={fileInputRef}
                                                    type="file"
                                                    multiple
                                                    className="agentinbox-file-input"
                                                    onChange={(e) => {
                                                        void onPickFiles(e.target.files);
                                                        e.target.value = '';
                                                    }}
                                                />
                                                <Action
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => fileInputRef.current?.click()}
                                                    disabled={posting}
                                                    title="Attach files"
                                                    aria-label="Attach files"
                                                >
                                                    <IconPaperclip size={14} />
                                                </Action>
                                                <button
                                                    type="button"
                                                    className="agentinbox-primary"
                                                    onClick={() => void post()}
                                                    disabled={!draft.trim() || posting}
                                                >
                                                    {posting ? 'Sending…' : 'Send'}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                )}
            </aside>

            {/* genie #64 — wiping history is irreversible and reaches the host's
                durable store, so it always goes through this confirm. */}
            {pendingWipe && (
                <Modal open size="sm" onClose={() => !wiping && setPendingWipe(null)}>
                    <Modal.Header>
                        {pendingWipe.kind === 'channel'
                            ? 'Clear channel history?'
                            : pendingWipe.kind === 'dm'
                              ? 'Delete this DM thread?'
                              : `Delete ${pendingWipe.channels + pendingWipe.threads} conversations?`}
                    </Modal.Header>
                    <Modal.Body>
                        <Text size="sm" style={{ display: 'block' }}>
                            {pendingWipe.kind === 'channel' ? (
                                <>
                                    Every message in <b>{pendingWipe.label}</b> is permanently
                                    deleted. The channel and its members stay — only the history
                                    goes.
                                </>
                            ) : pendingWipe.kind === 'dm' ? (
                                <>
                                    The whole conversation <b>{pendingWipe.label}</b> is permanently
                                    deleted.
                                </>
                            ) : (
                                <>
                                    Permanently deleting{' '}
                                    {pendingWipe.channels > 0 && (
                                        <b>
                                            {pendingWipe.channels} channel
                                            {pendingWipe.channels === 1 ? '' : 's'}
                                        </b>
                                    )}
                                    {pendingWipe.channels > 0 && pendingWipe.threads > 0 && ' and '}
                                    {pendingWipe.threads > 0 && (
                                        <b>
                                            {pendingWipe.threads} DM thread
                                            {pendingWipe.threads === 1 ? '' : 's'}
                                        </b>
                                    )}
                                    . Channels keep their members — only the history goes.
                                </>
                            )}
                        </Text>
                        <Text
                            size="xs"
                            className="text-zinc-500"
                            style={{ display: 'block', marginTop: 8, lineHeight: 1.5 }}
                        >
                            This cannot be undone. Messages an agent hasn&rsquo;t picked up yet stay
                            in its inbox — clearing your view never drops an agent&rsquo;s mail.
                        </Text>
                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'flex-end',
                                gap: 8,
                                marginTop: 14,
                            }}
                        >
                            <Action
                                variant="ghost"
                                onClick={() => setPendingWipe(null)}
                                disabled={wiping}
                            >
                                Cancel
                            </Action>
                            <Action color="red" onClick={() => void confirmWipe()} disabled={wiping}>
                                {wiping
                                    ? 'Deleting…'
                                    : pendingWipe.kind === 'channel'
                                      ? 'Clear history'
                                      : pendingWipe.kind === 'dm'
                                        ? 'Delete thread'
                                        : `Delete ${pendingWipe.channels + pendingWipe.threads}`}
                            </Action>
                        </div>
                    </Modal.Body>
                </Modal>
            )}
        </div>
    );
}
