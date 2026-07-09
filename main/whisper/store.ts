import { getDb } from '../db';
import type { WhisperMessage } from './types';

/**
 * Durable persistence port for the WhisperChat broker.
 *
 * The broker keeps its live working set (inboxes, channel/DM logs, membership,
 * long-poll waiters) in memory for speed. This store is the durability
 * backstop: every message is appended here, per-agent ACK cursors are
 * persisted, and on boot the broker rehydrates its logs + undelivered inboxes
 * from here — so a queued whisper survives an app restart, the human panel
 * keeps its history, and unACKed-urgent escalation (Track C) has a durable
 * position to check. The default is a NO-OP so the broker stays pure (tests
 * and any in-memory-only mode work with zero wiring); {@link dbWhisperStore}
 * is installed at boot in the main process.
 */
export interface WhisperStore {
    /** Persist a delivered message. */
    append(msg: WhisperMessage): void;
    /** The highest persisted seq — the broker resumes its global counter here so
     *  cursors stay valid across restarts. */
    maxSeq(): number;
    /** Recent messages (oldest→newest), capped, for rehydrating the logs. */
    loadRecent(limit: number): WhisperMessage[];
    /** The agent's persisted ACK cursor (0 if never received). */
    getCursor(agentId: string): number;
    /** Advance the agent's ACK cursor (monotonic — never moves backwards). */
    setCursor(agentId: string, seq: number): void;
    /** Undelivered messages targeting an agent — a DM to it, or a channel it is a
     *  member of — with seq > cursor, excluding the agent's own sends. Used to
     *  rebuild an inbox on boot so nothing queued is lost. */
    undeliveredFor(agentId: string, channelKeys: string[], cursor: number): WhisperMessage[];
}

/** No-op store — the broker's default (pure / in-memory-only; used by tests). */
export const noopWhisperStore: WhisperStore = {
    append() {},
    maxSeq() {
        return 0;
    },
    loadRecent() {
        return [];
    },
    getCursor() {
        return 0;
    },
    setCursor() {},
    undeliveredFor() {
        return [];
    },
};

interface Row {
    id: string;
    seq: number;
    kind: 'dm' | 'channel';
    from_id: string;
    from_label: string;
    to_id: string | null;
    channel_key: string | null;
    text: string;
    ts: number;
    interrupt: number;
}

function toMsg(r: Row): WhisperMessage {
    return {
        seq: r.seq,
        id: r.id,
        from: r.from_id,
        fromLabel: r.from_label,
        kind: r.kind,
        text: r.text,
        ts: r.ts,
        ...(r.kind === 'channel' ? { channel: r.channel_key ?? undefined } : {}),
        ...(r.kind === 'dm' ? { to: r.to_id ?? undefined } : {}),
        ...(r.interrupt ? { interrupt: true } : {}),
    };
}

/** The genie.db-backed store — installed at boot (main process). */
export const dbWhisperStore: WhisperStore = {
    append(msg) {
        getDb()
            .prepare(
                `INSERT OR REPLACE INTO whisper_messages
                 (id, seq, kind, from_id, from_label, to_id, channel_key, text, ts, interrupt)
                 VALUES (@id, @seq, @kind, @from_id, @from_label, @to_id, @channel_key, @text, @ts, @interrupt)`,
            )
            .run({
                id: msg.id,
                seq: msg.seq,
                kind: msg.kind,
                from_id: msg.from,
                from_label: msg.fromLabel,
                to_id: msg.kind === 'dm' ? (msg.to ?? null) : null,
                channel_key: msg.kind === 'channel' ? (msg.channel ?? null) : null,
                text: msg.text,
                ts: msg.ts,
                interrupt: msg.interrupt ? 1 : 0,
            });
    },
    maxSeq() {
        return (
            getDb()
                .prepare<[], { mx: number | null }>('SELECT MAX(seq) AS mx FROM whisper_messages')
                .get()?.mx ?? 0
        );
    },
    loadRecent(limit) {
        const rows = getDb()
            .prepare<[number], Row>('SELECT * FROM whisper_messages ORDER BY seq DESC LIMIT ?')
            .all(limit);
        return rows.reverse().map(toMsg);
    },
    getCursor(agentId) {
        return (
            getDb()
                .prepare<[string], { acked_seq: number }>(
                    'SELECT acked_seq FROM whisper_cursors WHERE agent_id = ?',
                )
                .get(agentId)?.acked_seq ?? 0
        );
    },
    setCursor(agentId, seq) {
        getDb()
            .prepare(
                `INSERT INTO whisper_cursors (agent_id, acked_seq) VALUES (?, ?)
                 ON CONFLICT(agent_id) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq)`,
            )
            .run(agentId, seq);
    },
    undeliveredFor(agentId, channelKeys, cursor) {
        const placeholders = channelKeys.map(() => '?').join(',');
        const channelClause = channelKeys.length
            ? ` OR (kind = 'channel' AND channel_key IN (${placeholders}))`
            : '';
        const rows = getDb()
            .prepare<unknown[], Row>(
                `SELECT * FROM whisper_messages
                 WHERE seq > ? AND from_id != ?
                   AND ((kind = 'dm' AND to_id = ?)${channelClause})
                 ORDER BY seq ASC`,
            )
            .all(cursor, agentId, agentId, ...channelKeys);
        return rows.map(toMsg);
    },
};
