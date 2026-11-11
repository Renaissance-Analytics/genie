import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ENGINE_METHODS, type EngineMethod } from '../src/core/engine-protocol.js';
import { LOCAL_UPLOAD_TTL_MS } from '../src/core/local-content.js';
import type { BlobSource } from '../src/core/local-blobs.js';
import { memoryPair } from '../src/core/line-transport.js';
import { REMOTE_METHODS } from '../src/core/remote-protocol.js';
import { AgentStoresService } from '../src/main/agent-stores-host.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { ChatDraftStore } from '../src/main/chat-draft-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import type { LocalDraftsStore } from '../src/main/local-drafts-api.js';
import { resourceDoor, resultValue } from './support/local-resource-door.js';

const methods = ['engine.drafts.fileOpen', 'engine.drafts.fileRead', 'engine.drafts.fileClose'] as const;
type FileInfo = { handle: string; size: number; sha256: string };
type SourceStore = ChatDraftStore & { openFile(ref: unknown, options?: { signal?: AbortSignal }): Promise<BlobSource | null> };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function rig(options: { idleMs?: number; size?: number } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'genie-7e-engine-files-'));
    const inbox = await InboxStore.open(home), attention = await AttentionStore.open(home, inbox), knowledge = KnowledgeStore.open(home), drafts = await ChatDraftStore.open(home);
    const stores = new AgentStoresService({ inbox, attention, knowledge, approvals: new ApprovalQueue(), drafts }, { draftFileIdleMs: options.idleMs } as never);
    const legacyRead = vi.spyOn(drafts, 'readFile');
    const opened: BlobSource[] = [], closed: BlobSource[] = [], control = { beforeOpen: async () => {} };
    const monitored = drafts as SourceStore, original = monitored.openFile?.bind(monitored);
    if (original) vi.spyOn(monitored, 'openFile').mockImplementation(async (...args) => {
        await control.beforeOpen(); const source = await original(...args);
        if (source) { const close = source.close.bind(source); source.close = vi.fn(async () => { await close(); if (!closed.includes(source)) closed.push(source); }); opened.push(source); }
        return source;
    });
    const bytes = new Uint8Array(options.size ?? 37).fill(0xa5), ref = await drafts.putFile(bytes), empty = await drafts.putFile(new Uint8Array());
    const server = new SessionEngineServer({ token: 'synthetic-7e-bounded-read', build: 'fixture', stores });
    const host = new SessionHost({ userData: home, driverFor: () => null, processTree: { snapshot: () => [], killTree: pids => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() }); server.attach(host);
    const clients: SessionEngineClient[] = [], frames: string[] = [];
    cleanups.push(async () => {
        for (const c of clients) c.disconnect(); await tick();
        await vi.waitFor(() => expect(closed.length).toBe(opened.length)); knowledge.close();
        await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    const connect = async () => {
        const [h, w] = memoryPair(); server.accept(h);
        const client = new SessionEngineClient({ env: () => ({}) }); clients.push(client);
        expect(await client.connect({ ...w, send: text => { frames.push(text); w.send(text); }, onMessage: listener => w.onMessage(text => { frames.push(text); listener(text); }) }, 'synthetic-7e-bounded-read')).toMatchObject({ ok: true });
        return client;
    };
    const call = (client: SessionEngineClient, method: typeof methods[number], args: unknown[]) => {
        // Missing registration is the immediate tests-first failure, never a pending unknown engine call.
        expect(ENGINE_METHODS).toContain(method); return client.call(method as EngineMethod, args);
    };
    const open = async (client: SessionEngineClient, file = ref): Promise<FileInfo | null> => {
        const result = await call(client, 'engine.drafts.fileOpen', [file]); expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.reason); return result.value as FileInfo | null;
    };
    return { home, drafts, stores, bytes, ref, empty, opened, closed, control, legacyRead, frames, connect, call, open };
}
async function mainPort(f: Awaited<ReturnType<typeof rig>>, engine: SessionEngineClient): Promise<LocalDraftsStore> {
    const path: string = '../src/main/engine-draft-files-client.js'; const { engineDraftsPort } = await import(path);
    // Execute main's actual adapter; no second copy of the attachment routing policy.
    const main = readFileSync('src/main/main.ts', 'utf8'), expression = main.match(/chatDrafts:\s*([^\r\n]+),\r?\n\s*files:/)?.[1]; expect(expression).toBeTruthy();
    return new Function('engineDraftsPort', 'drafts', 'agentEngineLink', `return (${expression});`)(engineDraftsPort, engine.stores().drafts, { client: engine }) as LocalDraftsStore;
}

describe('7E host-owned bounded draft attachment reads', () => {
    it.each(methods)('%s is internal engine-only, never a door method', method => { expect(ENGINE_METHODS).toContain(method); expect(REMOTE_METHODS).not.toContain(method); });
    it('a just-put file opens by its minted ref before any draft is saved; missing stays null and empty stays zero bytes', async () => {
        const f = await rig(), c = await f.connect(), info = await f.open(c);
        expect(info).toMatchObject({ handle: expect.any(String), size: f.bytes.length, sha256: hash(f.bytes) });
        expect(await f.open(c, randomUUID())).toBeNull(); const empty = await f.open(c, f.empty); expect(empty).toMatchObject({ size: 0, sha256: hash(new Uint8Array()) });
        expect(f.legacyRead).not.toHaveBeenCalled();
    });
    it.each(['../outside', 'C:\\outside\\secret', 'file:///outside', null])('refuses a non-store reference %s without losing the engine connection', async ref => {
        const f = await rig(), c = await f.connect();
        expect(await f.call(c, 'engine.drafts.fileOpen', [ref])).toMatchObject({ ok: false, reason: expect.stringMatching(/ref|UUID|draft/i) });
        expect(await c.call('engine.ping', [])).toMatchObject({ ok: true }); expect(f.legacyRead).not.toHaveBeenCalled();
    });
    it('reads exact bounded ranges, enforces the512KiB boundary and rejects unknown/released handles', async () => {
        // WHERE ITS TIME GOES (Tynn #692): on omarchy-test it took 1.8 to 5.8 s in six runs and timed out twice, while the
        // file's other tests took 116 to 552 ms, the 2 MiB read among them. Each step's ms since the test began, printed when
        // the test took over a second (a timed-out test prints the steps it reached), so a passing run measures it too.
        const t0 = performance.now(), marks: string[] = [], mark = (step: string) => { marks.push(`${step}=${Math.round(performance.now() - t0)}`); };
        onTestFinished(() => { if (performance.now() - t0 > 1_000) console.log(`DRAFTS_BOUNDED_STEPS ${marks.join(' ')}`); });
        const f = await rig({ size: 512 * 1024 + 7 }); mark('rig'); const c = await f.connect(); mark('connect'); const info = (await f.open(c))!; mark('open');
        const first = await f.call(c, 'engine.drafts.fileRead', [info.handle, 0, 512 * 1024]); mark('read-512KiB'); expect(first).toMatchObject({ ok: true });
        // By hash, as its 2 MiB sibling compares (Tynn #692, measured on omarchy-test: the engine read took 5 ms and a deep
        // equality of the two 512 KiB buffers 4,042 ms, element by element). Length first, so a short read says so plainly.
        if (!first.ok) throw new Error(first.reason); const got = Buffer.from((first.value as { base64: string }).base64, 'base64'); expect(got.length).toBe(512 * 1024); expect(hash(got)).toBe(hash(f.bytes.subarray(0, 512 * 1024))); mark('compare');
        for (const range of [[0, 512 * 1024 + 1], [-1, 1], [0.5, 1], [info.size, 1]]) { expect(await f.call(c, 'engine.drafts.fileRead', [info.handle, ...range])).toMatchObject({ ok: false }); mark(`refused-${range.join(',')}`); }
        expect(await f.call(c, 'engine.drafts.fileRead', [info.handle, info.size, 0])).toEqual({ ok: true, value: { base64: '' } }); mark('read-empty');
        expect(await f.call(c, 'engine.drafts.fileClose', [info.handle])).toMatchObject({ ok: true }); expect(f.closed).toHaveLength(1); mark('close');
        expect(await f.call(c, 'engine.drafts.fileRead', [info.handle, 0, 1])).toMatchObject({ ok: false }); expect(await f.call(c, 'engine.drafts.fileClose', [info.handle])).toMatchObject({ ok: false });
        expect(f.frames.every(text => Buffer.byteLength(text) <= 1024 * 1024)).toBe(true);
    });
    it('the eight-handle limit includes every owner opening; another connection cannot read or close one', async () => {
        const f = await rig(), a = await f.connect(), b = await f.connect(), handles: FileInfo[] = [];
        for (let i = 0; i < 8; i++) handles.push((await f.open(a))!);
        expect(await f.call(a, 'engine.drafts.fileOpen', [f.ref])).toMatchObject({ ok: false, reason: expect.stringContaining('8') }); expect(f.opened).toHaveLength(8);
        expect(await f.call(b, 'engine.drafts.fileRead', [handles[0]!.handle, 0, 1])).toMatchObject({ ok: false }); expect(await f.call(b, 'engine.drafts.fileClose', [handles[0]!.handle])).toMatchObject({ ok: false });
        expect(await f.open(b)).toBeTruthy(); await f.call(a, 'engine.drafts.fileClose', [handles[0]!.handle]); expect(await f.open(a)).toBeTruthy();
    });
    it('disconnect closes the actual host source and a new engine connection cannot reuse its handle', async () => {
        const f = await rig(), a = await f.connect(), info = (await f.open(a))!; expect(f.opened).toHaveLength(1); expect(f.closed).toHaveLength(0);
        a.disconnect(); await vi.waitFor(() => expect(f.closed).toHaveLength(1));
        const b = await f.connect(); expect(await f.call(b, 'engine.drafts.fileRead', [info.handle, 0, 1])).toMatchObject({ ok: false }); expect(await f.open(b)).toBeTruthy();
    });
    it('idle expiry closes an unused actual source without waiting for another call', async () => {
        const f = await rig({ idleMs: 25 }), c = await f.connect(), info = (await f.open(c))!; expect(f.opened).toHaveLength(1);
        await vi.waitFor(() => expect(f.closed).toHaveLength(1)); expect(await f.call(c, 'engine.drafts.fileRead', [info.handle, 0, 1])).toMatchObject({ ok: false });
    });
    it('main uses the bounded engine source on the actual door and never decodes the legacy whole-file response', async () => {
        const f = await rig({ size: 2 * 1024 * 1024 + 17 }), engine = await f.connect();
        const legacy = vi.spyOn(engine.stores().drafts, 'readFile').mockRejectedValue(new Error('whole-file attachment reads are forbidden'));
        const port = await mainPort(f, engine), door = await resourceDoor(cleanups, {}, { chatDrafts: port }), c = await door.client();
        const restored = await c.bridge.chatDrafts!.readFile(f.ref); expect(restored?.length).toBe(f.bytes.length); expect(hash(restored!)).toBe(hash(f.bytes));
        expect(legacy).not.toHaveBeenCalled(); expect(f.legacyRead).not.toHaveBeenCalled(); expect(f.opened).toHaveLength(1); expect(f.closed).toHaveLength(1);
        expect(f.frames.every(text => Buffer.byteLength(text) <= 1024 * 1024)).toBe(true);
        expect(f.frames.map(text => JSON.parse(text)).some(m => m.kind === 'call' && m.method === 'engine.drafts.fileRead')).toBe(true);
        expect(await c.bridge.chatDrafts!.readFile(randomUUID())).toBeNull();
    });
    it('an already-open engine handle belongs to its response even when blob.open never arrives', async () => {
        const f = await rig(), engine = await f.connect(), port = await mainPort(f, engine), door = await resourceDoor(cleanups, {}, { chatDrafts: port }), raw = await door.raw();
        const body = resultValue<{ draftsContent: { ref: string; blob: string } }>(await raw.call('chatDrafts.readFile', [f.ref])).draftsContent;
        expect(f.opened).toHaveLength(1); expect(f.closed).toHaveLength(0);
        expect(resultValue(await raw.call('content.release', [body.ref]))).toEqual({ released: true }); expect(f.closed).toHaveLength(1);
        expect(await raw.call('blob.open', ['draft-file', body.blob])).toMatchObject({ kind: 'result', ok: false });
    });
    it('response expiry releases a never-opened attachment handle on the still-live engine connection', async () => {
        let now = 1000; const f = await rig(), engine = await f.connect(), port = await mainPort(f, engine), door = await resourceDoor(cleanups, { now: () => now }, { chatDrafts: port }), raw = await door.raw();
        const body = resultValue<{ draftsContent: { ref: string; blob: string } }>(await raw.call('chatDrafts.readFile', [f.ref])).draftsContent;
        expect(f.opened).toHaveLength(1); now += LOCAL_UPLOAD_TTL_MS + 1;
        expect(await raw.call('blob.open', ['draft-file', body.blob])).toMatchObject({ kind: 'result', ok: false }); await vi.waitFor(() => expect(f.closed).toHaveLength(1));
        expect(await engine.call('engine.ping', [])).toMatchObject({ ok: true });
    });
    it('a local window closing during fileOpen cannot strand the late host handle', async () => {
        const f = await rig(), engine = await f.connect(), port = await mainPort(f, engine), door = await resourceDoor(cleanups, {}, { chatDrafts: port }), c = await door.client();
        let unblock!: () => void, entered!: () => void; const wait = new Promise<void>(resolve => { unblock = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
        f.control.beforeOpen = async () => { entered(); await wait; };
        const reading = c.bridge.chatDrafts!.readFile(f.ref); await started; c.close(); await expect(reading).rejects.toThrow(/connection|closed/i); unblock();
        await vi.waitFor(() => { expect(f.opened).toHaveLength(1); expect(f.closed).toHaveLength(1); }); expect(await engine.call('engine.ping', [])).toMatchObject({ ok: true });
    });
});
