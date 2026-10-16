import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { planV1InboxImport, type V1Inbox, type V1InboxAttachment, type V1InboxContext, type V1InboxIdentity, type V1InboxMessage } from '../core/v1-inbox.js';
import type { InboxStore } from './inbox-store.js';
import { OS_WORKSPACE } from './registry.js';
import { V1_OPEN_OPTIONS } from './v1-settings.js';

/**
 * READING GENIE 1's AGENTINBOX — read-only, through `node:sqlite`, like the other v1 readers.
 *
 * - `whisper_messages` (id, seq, kind dm|channel, from_id, to_id, text, ts epoch ms) — v1 kept the old
 *   WhisperChat table names after the rename; `from_label`, `channel_key` and `interrupt` are not read.
 * - `whisper_cursors` (agent_id, acked_seq): one read cursor per recipient.
 * - `agentinbox_attachments` (id, message_id, filename, bytes, sha256): metadata only; v1 kept the BYTES on
 *   disk beside `genie.db`, content-addressed: `<userData>/agentinbox-attachments/<sha[0..2]>/<sha>`.
 * - Who an inbox id is: `workspace_agents` (id, workspace_id, name) — an agent v1 unified carries its inbox id
 *   as its row id — and, for the rest, its bound terminal's `terminal_specs.meta_json.agent_id`.
 *
 * Cannot-see is `null` (no file, not a database, no `whisper_messages`); the table with no rows is an empty inbox.
 */
export function readV1Inbox(dbFile: string): V1Inbox | null {
    if (!existsSync(dbFile)) return null;
    let db: DatabaseSync | null = null;
    try {
        db = new DatabaseSync(dbFile, V1_OPEN_OPTIONS);
        const has = (table: string) => db!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
        if (!has('whisper_messages')) return null;
        const text = (v: unknown) => (typeof v === 'string' ? v : '');
        const messages: V1InboxMessage[] = [];
        for (const row of db.prepare('SELECT id, seq, kind, from_id, to_id, text, ts FROM whisper_messages ORDER BY seq, rowid').all() as Record<string, unknown>[]) {
            messages.push({ id: text(row.id), seq: Number(row.seq), kind: text(row.kind), fromId: text(row.from_id), toId: typeof row.to_id === 'string' ? row.to_id : null, text: text(row.text), ts: Number(row.ts) });
        }
        const cursors: Record<string, number> = {};
        if (has('whisper_cursors')) {
            for (const row of db.prepare('SELECT agent_id, acked_seq FROM whisper_cursors').all() as Record<string, unknown>[]) {
                if (typeof row.agent_id === 'string' && Number.isFinite(Number(row.acked_seq))) cursors[row.agent_id] = Number(row.acked_seq);
            }
        }
        const attachments: V1InboxAttachment[] = [];
        if (has('agentinbox_attachments')) {
            for (const row of db.prepare('SELECT id, message_id, filename, bytes, sha256 FROM agentinbox_attachments ORDER BY created_at, rowid').all() as Record<string, unknown>[]) {
                if (typeof row.id !== 'string' || typeof row.message_id !== 'string' || typeof row.sha256 !== 'string') continue;
                attachments.push({ id: row.id, messageId: row.message_id, filename: text(row.filename), bytes: Number(row.bytes) || 0, sha256: row.sha256.toLowerCase() });
            }
        }
        const identities: V1InboxIdentity[] = [];
        if (has('workspace_agents')) {
            const specAgent = new Map<string, string>();
            if (has('terminal_specs')) {
                for (const row of db.prepare('SELECT id, meta_json FROM terminal_specs').all() as Record<string, unknown>[]) {
                    let meta: unknown = null;
                    try { meta = JSON.parse(text(row.meta_json) || '{}'); } catch { meta = null; }
                    const agentId = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).agent_id : undefined;
                    if (typeof row.id === 'string' && typeof agentId === 'string' && agentId) specAgent.set(row.id, agentId);
                }
            }
            const seen = new Set<string>();
            const add = (inboxId: string, workspaceId: string, name: string) => {
                if (seen.has(inboxId)) return;
                seen.add(inboxId);
                identities.push({ inboxId, workspaceId, name });
            };
            const rows = db.prepare('SELECT id, workspace_id, name, terminal_spec_id FROM workspace_agents ORDER BY created_at, rowid').all() as Record<string, unknown>[];
            // The row's own id first (v1's unification made it the inbox id), then the bound terminal's inbox id.
            for (const row of rows) if (typeof row.id === 'string' && typeof row.workspace_id === 'string' && typeof row.name === 'string') add(row.id, row.workspace_id, row.name);
            for (const row of rows) {
                if (typeof row.workspace_id !== 'string' || typeof row.name !== 'string' || typeof row.terminal_spec_id !== 'string') continue;
                const inboxId = specAgent.get(row.terminal_spec_id);
                if (inboxId) add(inboxId, row.workspace_id, row.name);
            }
        }
        const blobRoot = join(dirname(dbFile), 'agentinbox-attachments');
        const blob = (sha256: string): Buffer | null => {
            if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
            try { return readFileSync(join(blobRoot, sha256.slice(0, 2), sha256)); } catch { return null; }
        };
        return { messages, cursors, attachments, identities, blob };
    } catch {
        return null;
    } finally {
        try { db?.close(); } catch { /* already closed or never opened */ }
    }
}

/**
 * Run the import at boot: read v1 (only while the inbox has no record of an import that saw it), plan against
 * Genie 2's roster, apply. A failure is logged and NOT recorded, so the next boot tries again; the mail Genie 2
 * has is untouched either way. What was not imported is logged by count — never a message's text.
 */
export async function runV1InboxImport(inbox: InboxStore, read: () => V1Inbox | null, at: Omit<V1InboxContext, 'osWorkspace'>): Promise<void> {
    if (inbox.v1Import()?.sawV1) return;
    try {
        const v1 = read();
        const done = await inbox.importFromV1(planV1InboxImport(v1, { ...at, osWorkspace: OS_WORKSPACE }), v1?.blob ?? (() => null));
        const notes = inbox.v1Import()?.notes ?? [];
        if (!done.alreadyDone) console.log(`[genie] v1 inbox import: ${done.noV1 ? 'no v1 inbox seen' : `${done.imported} messages imported, ${done.kept} already here`}${notes.length ? `; noted: ${notes.join(' | ')}` : ''}`);
    } catch (error) {
        console.error(`[genie] v1 inbox import failed: ${(error as Error).message}`);
    }
}
