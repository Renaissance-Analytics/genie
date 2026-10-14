import { HUMAN, type Participant } from './inbox.js';
import { OS_AGENT_NAME, type AgentId } from './identity.js';
import type { InboxMessage, StoredAttachment } from '../main/inbox-store.js';

/*
 * GENIE 1's AGENTINBOX HISTORY — pure.
 *
 * The owner, 2026-10-14: "We had so much important information in there." v1 kept every message in
 * `genie.db` (`whisper_messages`, per-recipient read cursors in `whisper_cursors`, attachment metadata in
 * `agentinbox_attachments`, the bytes content-addressed under `<userData>/agentinbox-attachments/<sha[0..2]>/<sha>`).
 * Genie 2's inbox started empty. This decides what comes over and in what order; `main/v1-inbox.ts` reads
 * v1; `InboxStore.importFromV1` applies it once and records that it did, in `mail.json` itself.
 *
 * WHO — every v1 party is mapped to a Genie 2 participant or the message is NOTED, never guessed:
 * - `human` is the person (`HUMAN`).
 * - A v1 agent's inbox id is a uuid: `terminal_specs.meta.agent_id`, which v1 also wrote into
 *   `workspace_agents.id` for agents it unified. The reader resolves it to v1's (workspace, name); Genie 2's
 *   identity IS (workspace, name), and its workspace import kept v1's workspace ids, so the roster record with
 *   that pair is the same agent. An id v1 itself can no longer resolve (its terminal was deleted) or whose
 *   agent did not come over (its folder is gone, or it ran a tui Genie 2 does not run) is noted.
 * - `genie:workstation` was v1's built-in workstation operator — Genie 2's OS agent (`genie`) is its successor.
 * - `genie:system` (Genie's own announcements) and `genie:cron:<id>` / `genie:process:<id>` (machine notices)
 *   have no Genie 2 participant: a machine sender cannot be replied to and Genie 2 has none. Noted, by count.
 * - Channel broadcasts (`kind = 'channel'`) have no Genie 2 equivalent (its inbox is 1:1). Noted, by count.
 *
 * READ STATE — imported history arrives READ, except mail v1 says was unread AND that is recent:
 * - v1's only read fact is a per-recipient cursor (`acked_seq`); a message after it was never collected.
 * - Old uncollected mail is history, not work: delivering it as unread would hand an idle agent a reminder
 *   for every stale notice (the reminder book and the Deck count unread mail) — a flood at first boot.
 * - Uncollected mail from the last `V1_UNREAD_WINDOW_MS` (7 days before the import) is the hand-off v1 was in
 *   the middle of when the person upgraded, and is delivered as unread so it is not lost in the history.
 * - A participant who has already acknowledged mail in Genie 2 owns a cursor that must not move backwards
 *   over mail it read: its imported mail arrives read, noted (the cursor is one number per participant).
 *
 * ORDER — Genie 2's cursors are `seq`s. Imported history takes the seqs BELOW everything already in the store
 * (0, -1, -2, … — oldest lowest), so:
 * - no existing message is renumbered and no existing cursor changes meaning;
 * - a cursor of 0 (or any committed cursor) already sits past all of it, which is what "arrives read" means;
 * - the next `send` still numbers from the last message (`> 0`), and `receive({ cursor: -n })` rewinds into it.
 */

/** v1 delivers unread mail newer than this, measured back from the import; older is history (see above). */
export const V1_UNREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** v1's built-in workstation operator's inbox id. */
export const V1_WORKSTATION = 'genie:workstation';

/** A `whisper_messages` row, as v1 stores it. */
export interface V1InboxMessage {
    readonly id: string;
    readonly seq: number;
    readonly kind: string;
    readonly fromId: string;
    readonly toId: string | null;
    readonly text: string;
    /** Epoch milliseconds. */
    readonly ts: number;
}

/** An `agentinbox_attachments` row. */
export interface V1InboxAttachment {
    readonly id: string;
    readonly messageId: string;
    readonly filename: string;
    readonly bytes: number;
    readonly sha256: string;
}

/** A v1 inbox id that v1 itself resolves to a workspace agent. */
export interface V1InboxIdentity {
    readonly inboxId: string;
    readonly workspaceId: string;
    readonly name: string;
}

export interface V1Inbox {
    readonly messages: readonly V1InboxMessage[];
    /** `whisper_cursors`: inbox id → seq of the last message acknowledged. */
    readonly cursors: Readonly<Record<string, number>>;
    readonly attachments: readonly V1InboxAttachment[];
    readonly identities: readonly V1InboxIdentity[];
    /** The bytes v1 kept for an attachment, or `null` when they are gone. */
    readonly blob: (sha256: string) => Buffer | null;
}

/** One message to import, mapped, before it has a Genie 2 seq. */
export interface PlannedV1Mail {
    readonly id: string;
    readonly from: Participant;
    readonly to: Participant;
    readonly text: string;
    readonly sentAt: string;
    readonly attachments: readonly StoredAttachment[];
    /** v1 never delivered it AND it is recent (see the rule above). */
    readonly unread: boolean;
}

export interface V1InboxPlan {
    /** Oldest first (v1's seq order). */
    readonly mail: readonly PlannedV1Mail[];
    /** Everything not imported, with why — counts, never message text. */
    readonly notes: readonly string[];
}

export interface V1InboxContext {
    /** Genie 2's agents now: id, workspace, name. */
    readonly roster: readonly { readonly id: AgentId; readonly workspaceId: string; readonly name: string }[];
    /** The OS agent's workspace in Genie 2's registry. */
    readonly osWorkspace: string;
    /** Epoch ms of the import. */
    readonly now: number;
}

/** The Genie 2 message id an imported v1 message gets: stable, so a second import can recognise it. */
export function v1MessageId(v1Id: string): string {
    return `msg_v1_${v1Id}`;
}

function machineKind(id: string): string | null {
    if (id === 'genie:system') return "Genie 1's own announcements (genie:system)";
    if (id.startsWith('genie:cron:')) return 'a scheduled job (genie:cron)';
    if (id.startsWith('genie:process:')) return 'a watched process (genie:process)';
    return null;
}

export function planV1InboxImport(v1: V1Inbox | null, ctx: V1InboxContext): V1InboxPlan | null {
    if (v1 === null) return null;
    const notes: string[] = [];
    const byPair = new Map(ctx.roster.map((r) => [`${r.workspaceId}\u0000${r.name}`, r.id] as const));
    const identity = new Map(v1.identities.map((i) => [i.inboxId, i] as const));
    const osAgent = byPair.get(`${ctx.osWorkspace}\u0000${OS_AGENT_NAME}`) ?? null;

    // Why each unmappable party is unmappable, and how many messages it took with it — one note per party.
    const unmapped = new Map<string, { why: string; count: number }>();
    const participant = (id: string): Participant | null => {
        if (id === HUMAN) return HUMAN;
        if (id === V1_WORKSTATION) {
            if (osAgent) return osAgent;
            unmapped.set(id, { why: "v1's workstation operator; Genie 2 has no OS agent registered yet", count: unmapped.get(id)?.count ?? 0 });
            return null;
        }
        const machine = machineKind(id);
        if (machine) {
            const key = id.startsWith('genie:cron:') ? 'genie:cron' : id.startsWith('genie:process:') ? 'genie:process' : id;
            unmapped.set(key, { why: `${machine}: a machine sender, which Genie 2 does not have`, count: unmapped.get(key)?.count ?? 0 });
            return null;
        }
        const who = identity.get(id);
        if (!who) {
            unmapped.set(id, { why: `v1 inbox id ${id}: Genie 1 itself no longer knows which agent this was (its terminal was removed)`, count: unmapped.get(id)?.count ?? 0 });
            return null;
        }
        const agent = byPair.get(`${who.workspaceId}\u0000${who.name}`);
        if (!agent) {
            unmapped.set(id, { why: `agent ${who.name} (workspace ${who.workspaceId}): not an agent in Genie 2 (not imported — its workspace folder is gone or it ran a tui Genie 2 does not run)`, count: unmapped.get(id)?.count ?? 0 });
            return null;
        }
        return agent;
    };
    const bump = (id: string) => {
        const key = id.startsWith('genie:cron:') ? 'genie:cron' : id.startsWith('genie:process:') ? 'genie:process' : id;
        const u = unmapped.get(key);
        if (u) u.count++;
    };

    const attachmentsOf = new Map<string, StoredAttachment[]>();
    for (const a of v1.attachments) {
        const list = attachmentsOf.get(a.messageId) ?? [];
        list.push({ id: `att_v1_${a.id}`, name: a.filename, size: a.bytes, sha256: a.sha256 });
        attachmentsOf.set(a.messageId, list);
    }

    const cutoff = ctx.now - V1_UNREAD_WINDOW_MS;
    let channel = 0;
    let malformed = 0;
    const mail: PlannedV1Mail[] = [];
    for (const m of [...v1.messages].sort((a, b) => a.seq - b.seq)) {
        if (typeof m.id !== 'string' || !m.id || !Number.isFinite(m.seq) || !Number.isFinite(m.ts)) { malformed++; continue; }
        if (m.kind === 'channel') { channel++; continue; }
        if (m.kind !== 'dm' || m.toId === null) { malformed++; continue; }
        const from = participant(m.fromId);
        const to = participant(m.toId);
        if (from === null || to === null) {
            // One message is counted once, against the party that stopped it (the sender first).
            bump(from === null ? m.fromId : m.toId);
            continue;
        }
        const acked = v1.cursors[m.toId] ?? 0;
        mail.push({
            id: v1MessageId(m.id),
            from,
            to,
            text: m.text,
            sentAt: new Date(m.ts).toISOString(),
            attachments: attachmentsOf.get(m.id) ?? [],
            unread: m.seq > acked && m.ts >= cutoff,
        });
    }
    if (channel) notes.push(`${channel} channel broadcasts not imported: Genie 2's inbox is 1:1 and has no channels`);
    if (malformed) notes.push(`${malformed} messages not imported: not a readable v1 direct message`);
    for (const { why, count } of unmapped.values()) if (count > 0) notes.push(`${count} messages not imported — ${why}`);
    return { mail, notes };
}

export interface V1InboxExisting {
    /** Message ids already in the store. */
    readonly ids: ReadonlySet<string>;
    /** Committed cursors already in the store. */
    readonly cursors: Readonly<Record<string, number>>;
    /** The lowest seq in the store, or `null` when it is empty. */
    readonly lowestSeq: number | null;
}

export interface SequencedV1Mail {
    /** Oldest first, every seq below `lowestSeq` (and ≤ 0). */
    readonly messages: readonly InboxMessage[];
    /** Cursors to SET — only for participants who have none yet. */
    readonly cursors: Readonly<Record<string, number>>;
    /** Planned messages whose id was already in the store, left exactly as they were. */
    readonly kept: number;
    readonly notes: readonly string[];
}

/**
 * Give the plan Genie 2 seqs below everything already stored, and the read state the rule above decides.
 * `readAt` is the import's own time: v1 recorded THAT a message was collected, never when.
 */
export function sequenceV1Mail(plan: V1InboxPlan, existing: V1InboxExisting, readAt: string): SequencedV1Mail {
    const fresh = plan.mail.filter((m) => !existing.ids.has(m.id));
    const kept = plan.mail.length - fresh.length;
    const top = Math.min(existing.lowestSeq === null ? 0 : existing.lowestSeq - 1, 0);
    const seqOf = (i: number) => top - (fresh.length - 1 - i);

    // Per recipient: the first message that stays unread. Only a participant with NO cursor in Genie 2 gets one.
    const firstUnread = new Map<string, number>();
    const keptRead = new Map<string, number>();
    fresh.forEach((m, i) => {
        if (!m.unread || firstUnread.has(m.to)) return;
        if (existing.cursors[m.to] !== undefined) { keptRead.set(m.to, (keptRead.get(m.to) ?? 0) + 1); return; }
        firstUnread.set(m.to, seqOf(i));
    });
    const cursors: Record<string, number> = {};
    for (const [to, seq] of firstUnread) cursors[to] = seq - 1;

    const messages: InboxMessage[] = fresh.map((m, i) => {
        const seq = seqOf(i);
        const cursor = cursors[m.to];
        const isUnread = cursor !== undefined && seq > cursor;
        return { seq, id: m.id, from: m.from, to: m.to, text: m.text, attachments: m.attachments, sentAt: m.sentAt, readAt: isUnread ? null : readAt };
    });
    const notes: string[] = [];
    for (const [to, n] of keptRead) notes.push(`${n} recent unread v1 messages for ${to} imported as read: it has already acknowledged mail in Genie 2, and a cursor never moves back over mail it read`);
    return { messages, cursors, kept, notes };
}
