import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { V1_UNREAD_WINDOW_MS, planV1InboxImport, sequenceV1Mail, type V1Inbox } from '../src/core/v1-inbox.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { readV1Inbox } from '../src/main/v1-inbox.js';

/**
 * IMPORTING GENIE 1's AGENTINBOX. The planner and the sequencer are pure; the reader opens a database built here
 * with v1's REAL `CREATE TABLE` statements (copied from a v1 `genie.db`, foreign keys aside); the values are invented.
 */

const v1Tables = [
    "CREATE TABLE whisper_messages ( id TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('dm', 'channel')), from_id TEXT NOT NULL, from_label TEXT NOT NULL DEFAULT '', to_id TEXT, channel_key TEXT, text TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL, interrupt INTEGER NOT NULL DEFAULT 0 )",
    'CREATE TABLE whisper_cursors ( agent_id TEXT PRIMARY KEY, acked_seq INTEGER NOT NULL DEFAULT 0 )',
    "CREATE TABLE agentinbox_attachments ( id TEXT PRIMARY KEY, message_id TEXT NOT NULL, filename TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, mime TEXT NOT NULL DEFAULT '', sha256 TEXT NOT NULL, created_at INTEGER NOT NULL )",
    "CREATE TABLE workspace_agents ( id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, tui TEXT, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', avatar TEXT, boot_cwd TEXT, persona_path TEXT, role TEXT NOT NULL DEFAULT 'specialized' CHECK (role IN ('workspace','specialized','gapp')), parent_agent_id TEXT, terminal_spec_id TEXT, reachability TEXT NOT NULL DEFAULT 'workspace' CHECK (reachability IN ('workspace','workstation','hidden')), wake_on_dm INTEGER NOT NULL DEFAULT 1, ready_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, transport TEXT CHECK (transport IN ('claude-channel','codex-app-server')), transport_verified_at INTEGER, transport_error TEXT, native_transport TEXT, collision_group TEXT, budget_cost_usd_per_day REAL, budget_turns_per_day INTEGER, budget_action TEXT NOT NULL DEFAULT 'stop-and-ask' )",
    "CREATE TABLE terminal_specs ( id TEXT PRIMARY KEY, workspace_id TEXT, label TEXT NOT NULL, cwd TEXT NOT NULL, shell TEXT, args_json TEXT NOT NULL DEFAULT '[]', env_json TEXT NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_opened_at TEXT, type TEXT NOT NULL DEFAULT 'terminal', meta_json TEXT NOT NULL DEFAULT '{}', snapshot_at INTEGER, snapshot_bytes INTEGER, live_cwd TEXT, enabled INTEGER NOT NULL DEFAULT 1, host_session_id TEXT )",
];

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const NOW = Date.UTC(2026, 9, 14, 12);
const atlas = mintAgentId();
const scout = mintAgentId();
const ctx = { roster: [{ id: atlas, workspaceId: 'ws-a', name: 'atlas' }, { id: scout, workspaceId: 'ws-a', name: 'scout' }], osWorkspace: '__genie__', now: NOW };
const inbox = (over: Partial<V1Inbox> = {}): V1Inbox => ({
    messages: [],
    cursors: {},
    attachments: [],
    identities: [{ inboxId: 'u-atlas', workspaceId: 'ws-a', name: 'atlas' }, { inboxId: 'u-scout', workspaceId: 'ws-a', name: 'scout' }],
    blob: () => null,
    ...over,
});

describe('readV1Inbox', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'genie2-v1-inbox-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it("reads messages, cursors, attachment metadata, who each inbox id is (the row's own id, or its terminal's meta.agent_id), and the bytes from v1's store — without writing the database", () => {
        const file = join(dir, 'genie.db');
        const db = new DatabaseSync(file);
        for (const t of v1Tables) db.exec(t);
        db.prepare("INSERT INTO whisper_messages (id, seq, kind, from_id, from_label, to_id, text, ts, interrupt) VALUES (?, ?, 'dm', ?, 'label', ?, ?, ?, 1)").run('m1', 7, 'human', 'u-atlas', 'hello', 1_780_000_000_000);
        db.prepare("INSERT INTO whisper_messages (id, seq, kind, from_id, channel_key, text, ts) VALUES ('m2', 8, 'channel', 'u-atlas', 'ws:general', 'all', 1780000001000)").run();
        db.prepare("INSERT INTO whisper_cursors VALUES ('u-atlas', 7)").run();
        const bytes = Buffer.from('invented attachment');
        db.prepare("INSERT INTO agentinbox_attachments VALUES ('a1', 'm1', 'note.txt', ?, 'text/plain', ?, 1)").run(bytes.length, sha(bytes));
        // atlas: unified (its row id IS its inbox id). scout: AMS id, inbox id on its bound terminal's meta.
        db.prepare("INSERT INTO workspace_agents (id, workspace_id, tui, name, created_at, updated_at) VALUES ('u-atlas', 'ws-a', 'claude', 'atlas', 1, 1)").run();
        db.prepare("INSERT INTO workspace_agents (id, workspace_id, tui, name, terminal_spec_id, created_at, updated_at) VALUES ('agent:t2', 'ws-a', 'codex', 'scout', 't2', 2, 2)").run();
        db.prepare("INSERT INTO terminal_specs (id, workspace_id, label, cwd, created_at, meta_json) VALUES ('t2', 'ws-a', 'scout', '/w', 'x', ?)").run(JSON.stringify({ agent_id: 'u-scout', agent: 'codex' }));
        db.close();
        mkdirSync(join(dir, 'agentinbox-attachments', sha(bytes).slice(0, 2)), { recursive: true });
        writeFileSync(join(dir, 'agentinbox-attachments', sha(bytes).slice(0, 2), sha(bytes)), bytes);
        const before = sha(readFileSync(file));

        const v1 = readV1Inbox(file)!;
        expect(v1.messages).toEqual([
            { id: 'm1', seq: 7, kind: 'dm', fromId: 'human', toId: 'u-atlas', text: 'hello', ts: 1_780_000_000_000 },
            { id: 'm2', seq: 8, kind: 'channel', fromId: 'u-atlas', toId: null, text: 'all', ts: 1_780_000_001_000 },
        ]);
        expect(v1.cursors).toEqual({ 'u-atlas': 7 });
        expect(v1.attachments).toEqual([{ id: 'a1', messageId: 'm1', filename: 'note.txt', bytes: bytes.length, sha256: sha(bytes) }]);
        expect(v1.identities).toEqual(expect.arrayContaining([
            { inboxId: 'u-atlas', workspaceId: 'ws-a', name: 'atlas' },
            { inboxId: 'u-scout', workspaceId: 'ws-a', name: 'scout' },
        ]));
        expect(v1.blob(sha(bytes))!.equals(bytes)).toBe(true);
        expect(v1.blob(sha(Buffer.from('never stored')))).toBeNull();
        expect(sha(readFileSync(file))).toBe(before);
    });

    it('cannot-see is null: no file, or a database without the inbox table', () => {
        expect(readV1Inbox(join(dir, 'missing.db'))).toBeNull();
        const bare = join(dir, 'bare.db');
        const db = new DatabaseSync(bare);
        db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
        db.close();
        expect(readV1Inbox(bare)).toBeNull();
    });
});

describe('planV1InboxImport', () => {
    it('cannot-see stays null', () => {
        expect(planV1InboxImport(null, ctx)).toBeNull();
    });

    it('unread = after the recipient\'s v1 cursor AND within the window; at the cursor is read, exactly at the window edge is recent', () => {
        const edge = NOW - V1_UNREAD_WINDOW_MS;
        const plan = planV1InboxImport(inbox({
            messages: [
                { id: 'at-cursor', seq: 5, kind: 'dm', fromId: 'u-scout', toId: 'u-atlas', text: 'x', ts: NOW },
                { id: 'just-old', seq: 6, kind: 'dm', fromId: 'u-scout', toId: 'u-atlas', text: 'x', ts: edge - 1 },
                { id: 'at-edge', seq: 7, kind: 'dm', fromId: 'u-scout', toId: 'u-atlas', text: 'x', ts: edge },
                { id: 'no-cursor', seq: 8, kind: 'dm', fromId: 'u-atlas', toId: 'u-scout', text: 'x', ts: NOW },
            ],
            cursors: { 'u-atlas': 5 },
        }), ctx)!;
        expect(plan.mail.map((m) => [m.id, m.unread])).toEqual([['msg_v1_at-cursor', false], ['msg_v1_just-old', false], ['msg_v1_at-edge', true], ['msg_v1_no-cursor', true]]);
    });

    it('orders by v1 seq whatever order the rows came in', () => {
        const plan = planV1InboxImport(inbox({
            messages: [
                { id: 'b', seq: 9, kind: 'dm', fromId: 'human', toId: 'u-atlas', text: 'second', ts: 2 },
                { id: 'a', seq: 3, kind: 'dm', fromId: 'human', toId: 'u-atlas', text: 'first', ts: 1 },
            ],
        }), ctx)!;
        expect(plan.mail.map((m) => m.text)).toEqual(['first', 'second']);
        expect(plan.mail[0]).toMatchObject({ from: HUMAN, to: atlas, sentAt: '1970-01-01T00:00:00.001Z' });
    });
});

describe('sequenceV1Mail', () => {
    const planned = (id: string, to: typeof atlas | typeof HUMAN, unread = false) => ({ id, from: scout, to, text: id, sentAt: '2026-10-01T00:00:00.000Z', attachments: [], unread });

    it('takes the seqs below the lowest already stored; an id already stored is kept as it is; a cursor is only ever ADDED', () => {
        const done = sequenceV1Mail({ mail: [planned('old', atlas), planned('here', atlas), planned('new', atlas, true), planned('h', HUMAN, true)], notes: [] }, {
            ids: new Set(['here']),
            cursors: { [HUMAN]: 4 },
            lowestSeq: 1,
        }, '2026-10-14T00:00:00.000Z');
        expect(done.messages.map((m) => [m.id, m.seq])).toEqual([['old', -2], ['new', -1], ['h', 0]]);
        expect(done.kept).toBe(1);
        expect(done.cursors).toEqual({ [atlas]: -2 });
        expect(done.messages.map((m) => m.readAt)).toEqual(['2026-10-14T00:00:00.000Z', null, '2026-10-14T00:00:00.000Z']);
        expect(done.notes.join('\n')).toMatch(/1 recent unread v1 messages? for human imported as read/);
    });

    it('into an empty store, the newest imported message is seq 0', () => {
        const done = sequenceV1Mail({ mail: [planned('a', atlas), planned('b', atlas)], notes: [] }, { ids: new Set(), cursors: {}, lowestSeq: null }, 'now');
        expect(done.messages.map((m) => m.seq)).toEqual([-1, 0]);
    });
});

describe('InboxStore.importFromV1', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'genie2-v1-inbox-store-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('bytes that do not match their hash are not stored: the attachment is left off and noted', async () => {
        const store = await InboxStore.open(dir);
        const real = Buffer.from('the real bytes');
        const plan = { mail: [{ id: 'msg_v1_x', from: scout, to: atlas, text: 't', sentAt: '2026-10-01T00:00:00.000Z', attachments: [{ id: 'att_v1_1', name: 'f.txt', size: 3, sha256: sha(real) }], unread: false }], notes: [] };
        expect(await store.importFromV1(plan, () => Buffer.from('tampered'))).toEqual({ imported: 1, kept: 0 });
        expect(store.involving(atlas)[0]!.attachments).toEqual([]);
        expect(store.v1Import()!.notes.join('\n')).toMatch(/1 attachments? left off/);
        // And it is the store's own record that makes it once: a second call does nothing.
        expect(await store.importFromV1(plan, () => real)).toEqual({ imported: 0, kept: 0, alreadyDone: true });
        // The record survives a restart.
        expect((await InboxStore.open(dir)).v1Import()).toMatchObject({ sawV1: true, imported: 1 });
    });
});
