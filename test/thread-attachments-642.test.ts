import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatMessages } from '../src/core/chat-view.js';
import { agentRecord, mintAgentId, threadKeyFor, type AgentId } from '../src/core/identity.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import * as threadStore from '../src/core/thread-store.js';
import { threadLogFile, ThreadStore } from '../src/core/thread-store.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { sessionsDir } from '../src/main/paths.js';

/*
 * TYNN #642, THE HOST'S PART (the coordinator, 2026-11-12). The owner wants a sent message's image pill to show the image
 * on hover, as the composer's does — and a sent message kept only its attachments' NAMES: the image went to the provider
 * and nowhere else. Now genie-host keeps the images sent in a thread: per agent, in a folder beside the agent's ledger
 * (inside Genie's data dir, never anywhere a name or id could point), bounded by count and by bytes (the oldest go first),
 * and pruned with the thread. The message row names each kept image (`attachmentRefs`), and the window reads one, when a
 * pill asks, with `agents.attachment` — a read, through the same host the window's other agent reads go through.
 */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 64 }, (_, i) => i)]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
type Reply = { ok: true; mimeType: string; data: string; bytes: number } | { ok: false; reason: string };
type Ref = { id: string; name: string; mimeType: string; bytes: number };

let dir: string;
let hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-attachments-642-')); hosts = []; });
afterEach(async () => { await Promise.all(hosts.map((h) => h.settled())); await rm(dir, { recursive: true, force: true }); });
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function rig() {
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => ((o: { events: DriverEvents }) => {
        events = o.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    }) as unknown as SessionDriverFactory;
    const host = new SessionHost({ userData: dir, driverFor, processTree: tree });
    hosts.push(host);
    return { host, events: () => events };
}
const attachmentOf = (target: object) => {
    const fn = (target as { attachment?: (a: AgentId, id: string) => Promise<Reply> }).attachment;
    expect(fn, 'attachment').toBeTypeOf('function');
    return fn!.bind(target);
};
type Store = { writeAttachment(key: string, id: string, mimeType: string, data: string): Promise<void>; readAttachment(key: string, id: string): Promise<{ mimeType: string; data: string; bytes: number } | null> };
const storeOf = (s: ThreadStore) => s as unknown as Store;

async function sentWithAnImage(r: ReturnType<typeof rig>) {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
    r.host.start(record, dir);
    expect(r.host.promptWith(record.id, 'look at this', [
        { name: 'Pasted image 3.png', type: 'image/png', bytes: PNG },
        { name: 'notes.txt', type: 'text/plain', bytes: new TextEncoder().encode('just text') },
    ], 'you')).toEqual({ ok: true });
    await r.host.settled();
    const row = r.host.ledgerFor(record.id).map((t) => t.event).find((e) => e.kind === 'message' && e.speaker === 'you') as { attachments?: readonly string[]; attachmentRefs?: readonly Ref[] } | undefined;
    expect(row).toBeDefined();
    return { record, row: row! };
}

describe('the host keeps the images sent in a thread', () => {
    it('the message names each kept image (images only), and the host reads it back whole', async () => {
        const r = rig();
        const { record, row } = await sentWithAnImage(r);
        expect(row.attachments).toEqual(['Pasted image 3.png', 'notes.txt']);
        expect(row.attachmentRefs).toHaveLength(1);
        const ref = row.attachmentRefs![0]!;
        expect(ref).toMatchObject({ name: 'Pasted image 3.png', mimeType: 'image/png', bytes: PNG.byteLength });
        expect(await attachmentOf(r.host)(record.id, ref.id)).toEqual({ ok: true, mimeType: 'image/png', data: b64(PNG), bytes: PNG.byteLength });
    });

    it('kept inside Genie’s data dir, in the folder beside the agent’s ledger', async () => {
        const r = rig();
        const { record } = await sentWithAnImage(r);
        const log = threadLogFile(sessionsDir(dir), record.id);
        const folder = join(dirname(log), basename(log, '.jsonl'));
        const files = (await readdir(folder)).filter((f) => f.startsWith('att-'));
        expect(files).toHaveLength(1);
        const rel = relative(dir, join(folder, files[0]!));
        expect(rel.startsWith('..') || isAbsolute(rel)).toBe(false);
    });

    it('an id that is not one Genie made — a path, another folder — is refused, never read', async () => {
        const r = rig();
        const { record } = await sentWithAnImage(r);
        for (const id of ['../../etc/passwd', '..', '', 'att-x/../../y', 'A'.repeat(200)]) {
            const reply = await attachmentOf(r.host)(record.id, id);
            expect(reply.ok, id).toBe(false);
        }
    });

    it('CONTROL: an id never kept is a refusal with a reason, never an empty image', async () => {
        const r = rig();
        const { record } = await sentWithAnImage(r);
        const reply = await attachmentOf(r.host)(record.id, '0123456789abcdef0123456789abcdef');
        expect(reply.ok).toBe(false);
        expect((reply as { reason: string }).reason.length).toBeGreaterThan(0);
    });

    it('over the window’s link to the host: the same image', async () => {
        const r = rig();
        const server = new SessionEngineServer({ token: 'att-token', build: 't' });
        server.attach(r.host);
        const { record, row } = await sentWithAnImage(r);
        const [h, w] = memoryPair();
        server.accept(h);
        const client = new SessionEngineClient();
        expect(await client.connect(w, 'att-token')).toMatchObject({ ok: true });
        const reply = await vi.waitFor(() => attachmentOf(client)(record.id, row.attachmentRefs![0]!.id), { timeout: 5000 });
        expect(reply).toEqual({ ok: true, mimeType: 'image/png', data: b64(PNG), bytes: PNG.byteLength });
    });
});

describe('bounded per agent, pruned with the thread', () => {
    const id = (n: number) => n.toString(16).padStart(32, '0');
    it('past the count the oldest go first; the newest stay', async () => {
        const store = new ThreadStore(join(dir, 'sessions'), { attachmentMaxCount: 3 } as never);
        const key = threadKeyFor(mintAgentId());
        for (let n = 1; n <= 5; n += 1) await storeOf(store).writeAttachment(key, id(n), 'image/png', b64(PNG));
        expect(await storeOf(store).readAttachment(key, id(1))).toBeNull();
        expect(await storeOf(store).readAttachment(key, id(2))).toBeNull();
        for (const n of [3, 4, 5]) expect(await storeOf(store).readAttachment(key, id(n)), String(n)).not.toBeNull();
    });

    it('past the bytes the oldest go first', async () => {
        const store = new ThreadStore(join(dir, 'sessions'), { attachmentMaxBytes: PNG.byteLength * 2 } as never);
        const key = threadKeyFor(mintAgentId());
        for (let n = 1; n <= 3; n += 1) await storeOf(store).writeAttachment(key, id(n), 'image/png', b64(PNG));
        expect(await storeOf(store).readAttachment(key, id(1))).toBeNull();
        expect(await storeOf(store).readAttachment(key, id(3))).not.toBeNull();
    });

    it('one agent’s images never evict another’s', async () => {
        const store = new ThreadStore(join(dir, 'sessions'), { attachmentMaxCount: 1 } as never);
        const a = threadKeyFor(mintAgentId()), b = threadKeyFor(mintAgentId());
        await storeOf(store).writeAttachment(a, id(1), 'image/png', b64(PNG));
        await storeOf(store).writeAttachment(b, id(2), 'image/png', b64(PNG));
        expect(await storeOf(store).readAttachment(a, id(1))).not.toBeNull();
    });

    it('a thread cleared takes its images with it', async () => {
        const store = new ThreadStore(join(dir, 'sessions'));
        const key = threadKeyFor(mintAgentId());
        await storeOf(store).writeAttachment(key, id(1), 'image/png', b64(PNG));
        expect(await storeOf(store).readAttachment(key, id(1))).not.toBeNull();
        await store.clearLog(key);
        expect(await storeOf(store).readAttachment(key, id(1))).toBeNull();
    });

    it('the bounds are Genie’s own constants', () => {
        expect((threadStore as Record<string, unknown>)['ATTACHMENT_MAX_COUNT']).toBeTypeOf('number');
        expect((threadStore as Record<string, unknown>)['ATTACHMENT_MAX_BYTES']).toBeTypeOf('number');
    });
});

describe('the chat carries the kept images to its pills', () => {
    it('a sent message’s pills know which image each is, for the chat flyout and the agent view alike', () => {
        const refs: Ref[] = [{ id: '0'.repeat(32), name: 'Pasted image 3.png', mimeType: 'image/png', bytes: 72 }];
        const messages = chatMessages({
            agent: { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared', cwd: '/w' },
            session: { running: true, turnState: 'idle', failure: null },
            rows: [{ id: 'r1', at: 1, event: { kind: 'message', speaker: 'you', peerName: null, text: 'look', attachments: ['Pasted image 3.png'], attachmentRefs: refs } }],
        } as never);
        expect((messages[0] as unknown as { attachmentRefs?: Ref[] }).attachmentRefs).toEqual(refs);
    });
});
