import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LOCAL_UPLOAD_TTL_MS } from '../src/core/local-content.js';
import type { BlobSource } from '../src/core/local-blobs.js';
import { AgentStoresService } from '../src/main/agent-stores-host.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { ChatDraftStore } from '../src/main/chat-draft-store.js';
import { hostLocalPorts } from '../src/main/host-local-ports.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import type { LocalDraftsStore } from '../src/main/local-drafts-api.js';
import { resourceDoor, resultValue } from './support/local-resource-door.js';

type SourceStore = ChatDraftStore & { openFile(ref: unknown, options?: { signal?: AbortSignal }): Promise<BlobSource | null> };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function rig(options: { size?: number } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'genie-7e-engine-files-'));
    const inbox = await InboxStore.open(home), attention = await AttentionStore.open(home, inbox), knowledge = KnowledgeStore.open(home), drafts = await ChatDraftStore.open(home);
    const stores = new AgentStoresService({ inbox, attention, knowledge, approvals: new ApprovalQueue(), drafts });
    const legacyRead = vi.spyOn(drafts, 'readFile');
    const opened: BlobSource[] = [], closed: BlobSource[] = [], control = { beforeOpen: async () => {} };
    const monitored = drafts as SourceStore, original = monitored.openFile?.bind(monitored);
    if (original) vi.spyOn(monitored, 'openFile').mockImplementation(async (...args) => {
        await control.beforeOpen(); const source = await original(...args);
        if (source) { const close = source.close.bind(source); source.close = vi.fn(async () => { await close(); if (!closed.includes(source)) closed.push(source); }); opened.push(source); }
        return source;
    });
    const bytes = new Uint8Array(options.size ?? 37).fill(0xa5), ref = await drafts.putFile(bytes), empty = await drafts.putFile(new Uint8Array());
    cleanups.push(async () => {
        await vi.waitFor(() => expect(closed.length).toBe(opened.length)); knowledge.close();
        await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    return { home, drafts, stores, bytes, ref, empty, opened, closed, control, legacyRead };
}
/*
 * The window's draft calls are genie-host's answers since Tynn #898 step 2d-4b2: main builds no host API, and its
 * engine-link draft adapter went with it. genie-host's actual port (host-local-ports.ts) over the same store is what a
 * window's door reads through; the parts of its sources the drafts never touch are refused if reached.
 */
function hostPort(f: Awaited<ReturnType<typeof rig>>): LocalDraftsStore {
    const unused = () => { throw new Error('not a draft source'); };
    const port = hostLocalPorts({
        workspaces: () => [], workspacePath: () => null, files: unused as never, plugins: { dump: unused as never },
        sendFromPerson: unused as never, drafts: f.drafts, terminals: () => null, trackCwd: () => false, terminalEnv: () => ({}),
        marketplace: () => null, gapps: () => null, onGappsChanged: () => () => {}, say: () => {},
    }).chatDrafts;
    // genie-host hands its own store to these ports (genie-host.ts), never a copy of the attachment routing policy.
    expect(readFileSync('src/main/host-local-ports.ts', 'utf8')).toMatch(/readFile: \(ref\) => sources\.drafts\.openFile\(ref\),/);
    return port as LocalDraftsStore;
}

/*
 * The engine server's engine.drafts.file* route is retired (Tynn #898 step 2e-2, #914): a window reads a draft's file
 * over the one protocol, through genie-host's port, which is what these rows hold.
 */
describe('7E host-owned bounded draft attachment reads', () => {
    it('genie-host’s port uses the bounded store source on the actual door and never the legacy whole-file read', async () => {
        const f = await rig({ size: 2 * 1024 * 1024 + 17 });
        const port = hostPort(f), door = await resourceDoor(cleanups, {}, { chatDrafts: port }), c = await door.client();
        const restored = await c.bridge.chatDrafts!.readFile(f.ref); expect(restored?.length).toBe(f.bytes.length); expect(hash(restored!)).toBe(hash(f.bytes));
        expect(f.legacyRead).not.toHaveBeenCalled(); expect(f.opened).toHaveLength(1); expect(f.closed).toHaveLength(1);
        expect(await c.bridge.chatDrafts!.readFile(randomUUID())).toBeNull();
    });
    it('an already-open store source belongs to its response even when blob.open never arrives', async () => {
        const f = await rig(), port = hostPort(f), door = await resourceDoor(cleanups, {}, { chatDrafts: port }), raw = await door.raw();
        const body = resultValue<{ draftsContent: { ref: string; blob: string } }>(await raw.call('chatDrafts.readFile', [f.ref])).draftsContent;
        expect(f.opened).toHaveLength(1); expect(f.closed).toHaveLength(0);
        expect(resultValue(await raw.call('content.release', [body.ref]))).toEqual({ released: true }); expect(f.closed).toHaveLength(1);
        expect(await raw.call('blob.open', ['draft-file', body.blob])).toMatchObject({ kind: 'result', ok: false });
    });
    it('response expiry releases a never-opened attachment source', async () => {
        let now = 1000; const f = await rig(), port = hostPort(f), door = await resourceDoor(cleanups, { now: () => now }, { chatDrafts: port }), raw = await door.raw();
        const body = resultValue<{ draftsContent: { ref: string; blob: string } }>(await raw.call('chatDrafts.readFile', [f.ref])).draftsContent;
        expect(f.opened).toHaveLength(1); now += LOCAL_UPLOAD_TTL_MS + 1;
        expect(await raw.call('blob.open', ['draft-file', body.blob])).toMatchObject({ kind: 'result', ok: false }); await vi.waitFor(() => expect(f.closed).toHaveLength(1));
    });
    it('a local window closing during the store’s open cannot strand the late source', async () => {
        const f = await rig(), port = hostPort(f), door = await resourceDoor(cleanups, {}, { chatDrafts: port }), c = await door.client();
        let unblock!: () => void, entered!: () => void; const wait = new Promise<void>(resolve => { unblock = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
        f.control.beforeOpen = async () => { entered(); await wait; };
        const reading = c.bridge.chatDrafts!.readFile(f.ref); await started; c.close(); await expect(reading).rejects.toThrow(/connection|closed/i); unblock();
        await vi.waitFor(() => { expect(f.opened).toHaveLength(1); expect(f.closed).toHaveLength(1); });
    });
});
