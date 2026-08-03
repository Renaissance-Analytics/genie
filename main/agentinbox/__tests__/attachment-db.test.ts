import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dbAgentInboxStore } from '../store';
import { initDatabase, getDb } from '../../db';
import type { AgentInboxAttachment, AgentInboxMessage } from '../types';

/**
 * Attachment METADATA in genie.db (the bytes live in the content-addressed blob
 * store — see attachment-store.test.ts). Exercised against a real sqlite so the
 * v35 schema, the hydration join and the wipe cascade are all proven together:
 * a message's attachments must come back on every read path the broker uses, and
 * must NOT outlive the message when the human wipes a conversation.
 */

let dir: string;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-attach-db-'));
    initDatabase(dir);
});

afterAll(() => {
    try {
        getDb().prepare("DELETE FROM whisper_messages WHERE id LIKE 'att-%'").run();
    } catch {
        /* best-effort */
    }
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

const file = (over: Partial<AgentInboxAttachment> = {}): AgentInboxAttachment => ({
    id: `f-${Math.random().toString(36).slice(2)}`,
    filename: 'notes.md',
    bytes: 12,
    mime: 'text/markdown',
    sha256: 'b'.repeat(64),
    ...over,
});

const msg = (over: Partial<AgentInboxMessage> & { id: string; seq: number }): AgentInboxMessage =>
    ({
        kind: 'dm',
        from: 'A',
        fromLabel: 'A',
        to: 'B',
        text: 't',
        ts: 1,
        ...over,
    }) as AgentInboxMessage;

describe('dbAgentInboxStore attachments (real sqlite)', () => {
    it('persists attachments with the message and hydrates them on loadRecent', () => {
        const att = file({ id: 'att-f1', filename: 'a.md' });
        dbAgentInboxStore.append(msg({ id: 'att-m1', seq: 9101, attachments: [att] }));

        const loaded = dbAgentInboxStore.loadRecent(50).find((m) => m.id === 'att-m1');
        expect(loaded?.attachments).toEqual([att]);
    });

    it('hydrates them on undeliveredFor, so a restart still delivers the file', () => {
        const att = file({ id: 'att-f2' });
        dbAgentInboxStore.append(msg({ id: 'att-m2', seq: 9102, attachments: [att] }));

        const pending = dbAgentInboxStore.undeliveredFor('B', [], 9101);
        expect(pending.find((m) => m.id === 'att-m2')?.attachments).toEqual([att]);
    });

    it('leaves a plain message without an attachments key', () => {
        dbAgentInboxStore.append(msg({ id: 'att-m3', seq: 9103 }));
        const loaded = dbAgentInboxStore.loadRecent(50).find((m) => m.id === 'att-m3');
        expect(loaded).not.toHaveProperty('attachments');
    });

    it('looks one up by id, with the message it belongs to', () => {
        const att = file({ id: 'att-f4', filename: 'spec.pdf', bytes: 99, mime: 'application/pdf' });
        dbAgentInboxStore.append(msg({ id: 'att-m4', seq: 9104, attachments: [att] }));

        expect(dbAgentInboxStore.getAttachment('att-f4')).toEqual({
            ...att,
            messageId: 'att-m4',
        });
        expect(dbAgentInboxStore.getAttachment('att-missing')).toBeNull();
        expect(dbAgentInboxStore.getMessage('att-m4')?.attachments).toEqual([att]);
        expect(dbAgentInboxStore.getMessage('att-missing')).toBeNull();
    });

    it('DEDUPLICATES the blob address — two messages may share one sha', () => {
        const sha = 'c'.repeat(64);
        dbAgentInboxStore.append(
            msg({ id: 'att-m5', seq: 9105, attachments: [file({ id: 'att-f5a', sha256: sha })] }),
        );
        dbAgentInboxStore.append(
            msg({ id: 'att-m6', seq: 9106, attachments: [file({ id: 'att-f5b', sha256: sha })] }),
        );

        expect(dbAgentInboxStore.getAttachment('att-f5a')?.sha256).toBe(sha);
        expect(dbAgentInboxStore.getAttachment('att-f5b')?.sha256).toBe(sha);
    });

    it('drops the attachment rows when the human WIPES the conversation', () => {
        dbAgentInboxStore.append(
            msg({
                id: 'att-m7',
                seq: 9107,
                kind: 'channel',
                channel: 'att-ws:general',
                to: undefined,
                attachments: [file({ id: 'att-f7' })],
            }),
        );
        expect(dbAgentInboxStore.getAttachment('att-f7')).not.toBeNull();

        dbAgentInboxStore.clearChannel('att-ws:general');
        expect(dbAgentInboxStore.getAttachment('att-f7')).toBeNull();

        dbAgentInboxStore.append(
            msg({ id: 'att-m8', seq: 9108, attachments: [file({ id: 'att-f8' })] }),
        );
        dbAgentInboxStore.deleteDmThread('A', 'B');
        expect(dbAgentInboxStore.getAttachment('att-f8')).toBeNull();
    });
});
