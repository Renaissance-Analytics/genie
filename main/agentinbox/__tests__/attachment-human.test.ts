import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentInboxBroker } from '../broker';
import { blobPathFor } from '../attachments';
import { postAsHuman, readHumanAttachment } from '../human';
import type { AgentInboxJoinInput, AgentInboxMessage } from '../types';
import type { AgentInboxStore, StoredAttachment } from '../store';

/**
 * The HUMAN panel's attachment ops. The panel posts bytes INLINE (browser file
 * input) and downloads them back through Genie's own store, so neither direction
 * needs a filesystem capability — and both work identically on a remote window,
 * where the human's machine is not the host's.
 */

let blobs: string;
const dirs: string[] = [];

beforeEach(() => {
    blobs = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-att-human-'));
    dirs.push(blobs);
});

afterAll(() => {
    for (const d of dirs) {
        try {
            fs.rmSync(d, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
    }
});

function makeStore(): AgentInboxStore & { rows: AgentInboxMessage[] } {
    const rows: AgentInboxMessage[] = [];
    return {
        rows,
        append: (m) => void rows.push(m),
        maxSeq: () => rows.reduce((mx, m) => Math.max(mx, m.seq), 0),
        loadRecent: (limit) => rows.slice(-limit),
        getCursor: () => 0,
        setCursor: () => {},
        undeliveredFor: () => [],
        sentDmReceipts: () => [],
        clearChannel: () => 0,
        deleteDmThread: () => 0,
        getMessage: (id) => rows.find((m) => m.id === id) ?? null,
        getAttachment: (id) => {
            for (const m of rows) {
                const a = m.attachments?.find((x) => x.id === id);
                if (a) return { ...a, messageId: m.id } as StoredAttachment;
            }
            return null;
        },
    };
}

function agent(id: string): AgentInboxJoinInput {
    return {
        agentId: id,
        terminalId: `t-${id}`,
        workspaceId: 'w1',
        workspaceName: 'Workspace One',
        slug: 'ws-one',
        agentType: 'claude',
        label: `Agent ${id}`,
        purpose: 'general',
        scope: 'all',
        scopeWorkspaces: [],
        chatSessionId: null,
    };
}

function harness() {
    const store = makeStore();
    const broker = new AgentInboxBroker();
    broker.setStore(store);
    broker.join(agent('A'));
    return { store, broker, deps: { broker, storeRoot: () => blobs } };
}

describe('postAsHuman', () => {
    it('sends a message with inline attachments, storing the bytes', async () => {
        const { broker, store, deps } = harness();

        const res = await postAsHuman(
            {
                toAgentId: 'A',
                text: 'here is the spec',
                attachments: [
                    { filename: 'spec.md', base64: Buffer.from('# spec').toString('base64') },
                ],
            },
            deps,
        );

        expect(res).toEqual({ ok: true });
        expect(store.rows[0].attachments?.[0]).toMatchObject({
            filename: 'spec.md',
            bytes: 6,
            mime: 'text/markdown',
        });
        const { messages } = await broker.receive('A');
        expect(messages[0].attachments).toHaveLength(1);
    });

    it('is ALL-OR-NOTHING — a refused attachment sends NOTHING', async () => {
        const { store, deps } = harness();

        const res = await postAsHuman(
            {
                toAgentId: 'A',
                text: 'trust me',
                attachments: [{ filename: 'setup.exe', base64: Buffer.from('MZ').toString('base64') }],
            },
            deps,
        );

        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/Nothing was sent/);
        expect(res.error).toMatch(/executable/i);
        // The message must NOT have gone out with its files quietly dropped.
        expect(store.rows).toHaveLength(0);
    });

    it('still refuses an empty message and a message with no target', async () => {
        const { deps } = harness();
        expect((await postAsHuman({ toAgentId: 'A', text: '   ' }, deps)).ok).toBe(false);
        expect((await postAsHuman({ text: 'hi' }, deps)).ok).toBe(false);
    });

    it('posts a plain message exactly as before when nothing is attached', async () => {
        const { store, deps } = harness();
        expect(await postAsHuman({ toAgentId: 'A', text: 'plain' }, deps)).toEqual({ ok: true });
        expect(store.rows[0]).not.toHaveProperty('attachments');
    });
});

describe('readHumanAttachment', () => {
    it('hands back the bytes the human attached', async () => {
        const { store, deps } = harness();
        await postAsHuman(
            {
                toAgentId: 'A',
                text: 'file',
                attachments: [{ filename: 'a.txt', base64: Buffer.from('hello').toString('base64') }],
            },
            deps,
        );
        const id = store.rows[0].attachments![0].id;

        const r = await readHumanAttachment(id, deps);

        expect(r.ok).toBe(true);
        expect(r.filename).toBe('a.txt');
        expect(Buffer.from(r.base64!, 'base64').toString('utf8')).toBe('hello');
    });

    it('reports an unknown id plainly instead of throwing', async () => {
        const { deps } = harness();
        expect(await readHumanAttachment('nope', deps)).toMatchObject({ ok: false });
        expect(await readHumanAttachment('', deps)).toMatchObject({ ok: false });
    });

    it('redacts a raw fs read error — never leaks the path/stack to the (remote) caller', async () => {
        // The human panel's read is reachable over the mobile/remote API, so a raw
        // fs error here would expose a host path (CodeQL js/stack-trace-exposure,
        // genie#11). Store an attachment, then delete its blob so the byte read
        // throws ENOENT with a real path.
        const { store, deps } = harness();
        await postAsHuman(
            {
                toAgentId: 'A',
                text: 'file',
                attachments: [{ filename: 'a.txt', base64: Buffer.from('hi').toString('base64') }],
            },
            deps,
        );
        const att = store.rows[0].attachments![0];
        fs.rmSync(blobPathFor(blobs, att.sha256), { force: true });

        const r = await readHumanAttachment(att.id, deps);
        expect(r.ok).toBe(false);
        // A FIXED reason only — the raw fs error (path / ENOENT / stack) must never
        // reach the response.
        expect(r.error).toBe('That attachment could not be read.');
        expect(r.error).not.toMatch(/ENOENT|no such file|[\\/]/);
    });

    it('reads an attachment an AGENT sent — the human sees every conversation', async () => {
        const { broker, store, deps } = harness();
        broker.join(agent('B'));
        broker.send({
            fromAgentId: 'A',
            toAgentId: 'B',
            text: 'peer to peer',
            attachments: [
                { id: 'x1', filename: 'p.md', bytes: 2, mime: 'text/markdown', sha256: 'd'.repeat(64) },
            ],
        });
        expect(store.rows).toHaveLength(1);

        // The metadata resolves for the human even though the DM was A↔B; only
        // the BYTES are missing here (nothing was ever put in this test's store).
        const r = await readHumanAttachment('x1', deps);
        expect(r.ok).toBe(false);
        // A missing blob is a read failure → the redacted fixed reason (genie#11).
        expect(r.error).toBe('That attachment could not be read.');
    });
});
