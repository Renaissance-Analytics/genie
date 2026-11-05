import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDraft } from '../src/core/chat-drafts.js';
import { LOCAL_UPLOAD_TTL_MS } from '../src/core/local-content.js';
import { capabilityOf, REMOTE_METHODS, type RemoteMethod } from '../src/core/remote-protocol.js';
import { ChatDraftStore, MAX_DRAFT_FILE_BYTES } from '../src/main/chat-draft-store.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { resourceDoor, resultValue } from './support/local-resource-door.js';

const methods = ['chatDrafts.load', 'chatDrafts.save', 'chatDrafts.putFile', 'chatDrafts.readFile', 'chatDrafts.release'] as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const draft = (text = 'unfinished 雪'): ChatDraft => ({ v: 1, text, pills: [{ kind: 'text', id: 'p1', text: 'paste', label: 'kept label' }], attachments: [] });
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(options: Record<string, unknown> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'genie-p4-drafts-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const store = await ChatDraftStore.open(dir);
    const ports = { all: vi.spyOn(store, 'all'), save: vi.spyOn(store, 'save'), putFile: vi.spyOn(store, 'putFile'), readFile: vi.spyOn(store, 'readFile'), release: vi.spyOn(store, 'release') };
    const f = await resourceDoor(cleanups, options, { chatDrafts: store });
    const c = await f.client();
    return { ...f, c, store, ports, drafts: c.bridge.chatDrafts! };
}

describe('7E chat drafts through the admitted local door', () => {
    it.each(methods)('%s is an explicit local business method', method => {
        expect(REMOTE_METHODS).toContain(method); expect(capabilityOf(method as RemoteMethod)).toBe('local');
    });
    it('load reaches the real store and reconstructs its exact native shape', async () => {
        const f = await fixture(); await f.store.save('agent_a', draft()); f.ports.all.mockClear();
        expect(await f.drafts.load()).toEqual({ agent_a: draft() }); expect(f.ports.all).toHaveBeenCalledExactlyOnceWith();
        expect(f.invoke).toHaveBeenCalledWith('chatDrafts.load', []);
    });
    it('save records the native agent and complete draft; null clears and returns undefined', async () => {
        const f = await fixture(); const value = draft();
        expect(await f.drafts.save('agent_a', value)).toBeUndefined(); expect(f.ports.save).toHaveBeenLastCalledWith('agent_a', value);
        expect(await f.drafts.save('agent_a', null)).toBeUndefined(); expect(f.ports.save).toHaveBeenLastCalledWith('agent_a', null); expect(f.store.all()).toEqual({});
    });
    it('putFile, readFile and release keep native byte/ref/void results and arguments', async () => {
        const f = await fixture(), bytes = new Uint8Array([0, 1, 127, 255]);
        const ref = await f.drafts.putFile(bytes); expect(ref).toMatch(/^[0-9a-f-]{36}$/); expect(f.ports.putFile).toHaveBeenCalledExactlyOnceWith(bytes);
        expect(await f.drafts.readFile(ref!)).toEqual(bytes); expect(f.ports.readFile).toHaveBeenCalledExactlyOnceWith(ref);
        expect(await f.drafts.release([ref!])).toBeUndefined(); expect(f.ports.release).toHaveBeenCalledExactlyOnceWith([ref]);
        expect(await f.store.readFile(ref)).toBeNull();
        for (const method of methods.slice(2)) expect(f.invoke.mock.calls.some(([m]) => String(m) === method)).toBe(true);
    });
    it.each(['tailnet', 'relay owner', 'workspace guest', 'host guest', 'readonly', 'phone'])('%s never reaches a draft business port', async kind => {
        const f = await fixture(), raw = kind === 'tailnet' || kind === 'phone' ? await f.raw('tailnet', kind === 'phone') : await f.raw({ kind: 'relay', label: kind, isOwner: kind === 'relay owner', workspaceId: kind === 'workspace guest' ? 'work' : null, readonly: kind === 'readonly' });
        f.invoke.mockClear();
        for (const method of methods) expect(await raw.call(method, [])).toMatchObject({ kind: 'result', ok: false, reason: expect.stringContaining('own Genie window') });
        expect(f.invoke).not.toHaveBeenCalled();
    });
    it.each(['load', 'putFile', 'readFile'] as const)('%s preserves a native null without replacing it', async method => {
        const f = await fixture();
        if (method === 'load') { f.ports.all.mockReturnValueOnce(null as never); expect(await f.drafts.load()).toBeNull(); }
        if (method === 'putFile') { f.ports.putFile.mockResolvedValueOnce(null as never); expect(await f.drafts.putFile(new Uint8Array())).toBeNull(); }
        if (method === 'readFile') expect(await f.drafts.readFile(randomUUID())).toBeNull();
    });
    it('only known agents save, a deleted agent can clear, and invalid draft versions are not guessed', async () => {
        const f = await fixture(); await f.drafts.save('gone', draft()); expect(f.ports.save).not.toHaveBeenCalled();
        await f.drafts.save('gone', null); expect(f.ports.save).toHaveBeenLastCalledWith('gone', null);
        await f.drafts.save('agent_a', draft()); await f.drafts.save('agent_a', { ...draft(), v: 2 } as never);
        expect(f.store.all()).toEqual({ agent_a: draft() });
    });
    it('metadata-only lists page by count and reassemble every complete draft through shared draft-file content', async () => {
        const f = await fixture(); const all = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`agent_${i}`, draft(`${i} ${'雪'.repeat(1200)}`)]));
        f.ports.all.mockReturnValue(all); expect(await f.drafts.load()).toEqual(all);
        const pages = f.serialized.map(s => JSON.parse(s)).filter(m => m.kind === 'result' && Array.isArray(m.value?.items)).map(m => m.value);
        expect(pages.length).toBeGreaterThanOrEqual(3); expect(pages.flatMap(p => p.items)).toHaveLength(301);
        for (const p of pages) {
            expect(p.items.length).toBeLessThanOrEqual(128); expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(512 * 1024);
            for (const item of p.items) { expect(item).toMatchObject({ id: expect.any(String), name: expect.any(String), size: expect.any(Number), type: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), ref: expect.any(String) }); expect(Object.keys(item).some(k => ['text', 'pills', 'attachments', 'content', 'value'].includes(k))).toBe(false); }
        }
        expect(f.calls.some(c => c.method === 'page.open' && c.args[0] === 'chat-drafts')).toBe(true);
        const blobs = f.calls.filter(c => c.method === 'blob.open'); expect(blobs.length).toBeGreaterThan(0); expect(blobs.every(c => c.args[0] === 'draft-file')).toBe(true);
        expect(f.calls.some(c => c.method === 'content.release')).toBe(true);
    });
    it('serialised metadata bytes cut a page before its count limit', async () => {
        const f = await fixture(); const all = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`${i}_${'雪'.repeat(2600)}`, draft()]));
        f.ports.all.mockReturnValue(all); expect(await f.drafts.load()).toEqual(all);
        const pages = f.serialized.map(s => JSON.parse(s)).filter(m => m.kind === 'result' && m.value?.items?.length).map(m => m.value);
        expect(pages.length).toBeGreaterThan(1); expect(pages[0].items.length).toBeLessThan(80);
        expect(pages.every(p => Buffer.byteLength(JSON.stringify(p)) <= 512 * 1024)).toBe(true);
    });
    it('a 2 MiB paste and large text pills stage their complete body, not one large call', async () => {
        const f = await fixture(), value = { ...draft('雪'.repeat(700_000)), pills: [{ kind: 'text' as const, id: 'large', text: 'paste'.repeat(140_000), label: 'kept' }] };
        await f.drafts.save('agent_a', value); expect(f.ports.save).toHaveBeenCalledExactlyOnceWith('agent_a', value);
        expect(f.calls.find(c => c.method === 'localUpload.begin')?.args).toEqual([{ purpose: 'draft-file', subtype: 'text', size: Buffer.byteLength(JSON.stringify(value)) }]);
        expect(f.calls.find(c => c.method === 'chatDrafts.save')?.args).toEqual(['agent_a', { staged: expect.any(String) }]);
        expect(await f.drafts.load()).toEqual({ agent_a: value });
        expect(f.serialized.filter(s => JSON.parse(s).kind === 'call').every(s => Buffer.byteLength(s) <= 512 * 1024)).toBe(true);
        expect(f.serialized.every(s => Buffer.byteLength(s) <= 1024 * 1024)).toBe(true); expect(f.c.state().connected).toBe(true);
    });
    it('attachment staging accepts empty nameless bytes; the host table alone permits up to 100 MiB', async () => {
        const f = await fixture(), ref = await f.drafts.putFile(new Uint8Array()); expect(ref).toMatch(/^[0-9a-f-]{36}$/);
        expect(await f.drafts.readFile(ref!)).toEqual(new Uint8Array());
        expect(f.calls.find(c => c.method === 'localUpload.begin')?.args).toEqual([{ purpose: 'draft-file', subtype: 'attachment', size: 0 }]);
        const opened = await f.c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: MAX_DRAFT_FILE_BYTES }); expect(opened.size).toBe(MAX_DRAFT_FILE_BYTES); await f.c.uploads!.abort(opened.id);
        await expect(f.c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: MAX_DRAFT_FILE_BYTES + 1 })).rejects.toThrow(/104857600/);
    });
    it('a multi-chunk attachment comes back whole through draft-file blobs and is hash checked', async () => {
        const f = await fixture(), bytes = new Uint8Array(2 * 1024 * 1024 + 17).fill(0xa5), ref = await f.drafts.putFile(bytes);
        const restored = await f.drafts.readFile(ref!); expect(hash(restored!)).toBe(hash(bytes)); expect(restored?.length).toBe(bytes.length);
        expect(f.calls.filter(c => c.method === 'localUpload.chunk').length).toBeGreaterThan(1);
        expect(f.calls.some(c => c.method === 'blob.open' && c.args[0] === 'draft-file')).toBe(true);
    });
    it('foreign, wrong-purpose, wrong-subtype and incomplete stages never reach a consuming port', async () => {
        const f = await fixture(), a = await f.raw(), b = await f.raw();
        const wrong = resultValue<{ id: string }>(await a.call('localUpload.begin', [{ purpose: 'file-write', subtype: 'text', size: 0 }]));
        expect(await a.call('chatDrafts.save', ['agent_a', { staged: wrong.id }])).toMatchObject({ kind: 'result', ok: false });
        expect(resultValue(await a.call('localUpload.abort', [wrong.id]))).toEqual({ aborted: true });
        const text = resultValue<{ id: string }>(await a.call('localUpload.begin', [{ purpose: 'draft-file', subtype: 'text', size: 0 }]));
        expect(await a.call('chatDrafts.putFile', [{ staged: text.id }])).toMatchObject({ kind: 'result', ok: false });
        const attachment = resultValue<{ id: string }>(await a.call('localUpload.begin', [{ purpose: 'draft-file', subtype: 'attachment', size: 1 }]));
        expect(await a.call('chatDrafts.putFile', [{ staged: attachment.id }])).toMatchObject({ kind: 'result', ok: false });
        await a.call('localUpload.chunk', [attachment.id, 0, 'AQ==']);
        expect(await b.call('chatDrafts.putFile', [{ staged: attachment.id }])).toMatchObject({ kind: 'result', ok: false }); expect(f.ports.putFile).not.toHaveBeenCalled(); expect(f.ports.save).not.toHaveBeenCalled();
        expect(resultValue(await a.call('chatDrafts.putFile', [{ staged: attachment.id }]))).toMatch(/^[0-9a-f-]{36}$/);
        expect(await a.call('chatDrafts.putFile', [{ staged: attachment.id }])).toMatchObject({ kind: 'result', ok: false });
        const stage = resultValue<{ id: string }>(await a.call('localUpload.begin', [{ purpose: 'draft-file', subtype: 'text', size: 0 }]));
        expect(await a.call('files.write', ['work', 'x', { staged: stage.id }, null])).toMatchObject({ kind: 'result', ok: false });
        expect(resultValue(await a.call('localUpload.abort', [stage.id]))).toEqual({ aborted: true });
    });
    it('raw oversized save arguments refuse visibly before the store and leave the connection usable', async () => {
        const f = await fixture(), raw = await f.raw();
        expect(await raw.call('chatDrafts.save', ['agent_a', draft('x'.repeat(600_000))])).toMatchObject({ kind: 'result', ok: false, reason: expect.stringMatching(/stag|bound|large/i) }); expect(f.ports.save).not.toHaveBeenCalled();
        expect(await raw.call('chatDrafts.save', ['agent_a', null])).toMatchObject({ kind: 'result', ok: true });
    });
    it('a failing attachment consumer releases its claimed stage before another upload', async () => {
        const f = await fixture(); f.ports.putFile.mockRejectedValueOnce(new Error('owned fixture write failed'));
        await expect(f.drafts.putFile(new Uint8Array([1]))).rejects.toThrow('owned fixture write failed');
        const opened = [];
        for (let n = 0; n < 3; n++) opened.push(await f.c.uploads!.begin({ purpose: 'draft-file', subtype: 'attachment', size: 0 }));
        for (const stage of opened) await f.c.uploads!.abort(stage.id);
    });
    it('snapshots, metadata cursors and blob references belong to their connection and explicit release', async () => {
        const f = await fixture(); await f.store.save('agent_a', draft()); const a = await f.raw(), b = await f.raw();
        const body = resultValue<{ draftsContent: { ref: string; list: string; blob: string } }>(await a.call('chatDrafts.load', [])).draftsContent;
        expect(await b.call('page.open', ['chat-drafts', body.list])).toMatchObject({ kind: 'result', ok: false });
        expect(await b.call('blob.open', ['draft-file', body.blob])).toMatchObject({ kind: 'result', ok: false });
        expect(resultValue(await b.call('content.release', [body.ref]))).toEqual({ released: false });
        expect(resultValue(await a.call('content.release', [body.ref]))).toEqual({ released: true });
        expect(await a.call('blob.open', ['draft-file', body.blob])).toMatchObject({ kind: 'result', ok: false });
    });
    it('draft snapshots reserve the existing eight-response budget and release it', async () => {
        const f = await fixture(); await f.store.save('agent_a', draft()); const raw = await f.raw(), bodies: Array<{ ref: string }> = [];
        for (let n = 0; n < 8; n++) bodies.push(resultValue<{ draftsContent: { ref: string } }>(await raw.call('chatDrafts.load', [])).draftsContent);
        expect(await raw.call('chatDrafts.load', [])).toMatchObject({ kind: 'result', ok: false, reason: expect.stringContaining('8') });
        await raw.call('content.release', [bodies[0]!.ref]); expect(await raw.call('chatDrafts.load', [])).toMatchObject({ kind: 'result', ok: true });
    });
    it('forgotten draft snapshot references expire under the shared content lifetime', async () => {
        let now = 1000; const f = await fixture({ now: () => now }); await f.store.save('agent_a', draft()); const raw = await f.raw();
        const body = resultValue<{ draftsContent: { ref: string; blob: string } }>(await raw.call('chatDrafts.load', [])).draftsContent;
        now += LOCAL_UPLOAD_TTL_MS + 1; expect(await raw.call('blob.open', ['draft-file', body.blob])).toMatchObject({ kind: 'result', ok: false });
        expect(resultValue(await raw.call('content.release', [body.ref]))).toEqual({ released: false });
    });
    it('a tampered read is refused by its complete hash and releases the snapshot', async () => {
        const f = await fixture(), ref = await f.drafts.putFile(new Uint8Array([1, 2, 3])); let changed = false;
        f.rewrite.frame = text => { const m = JSON.parse(text); if (!changed && m.kind === 'result' && typeof m.value?.base64 === 'string') { changed = true; m.value.base64 = 'BAUG'; return JSON.stringify(m); } return text; };
        await expect(f.drafts.readFile(ref!)).rejects.toThrow(/hash/i); expect(changed).toBe(true);
        expect(f.calls.some(c => c.method === 'blob.close')).toBe(true); expect(f.calls.some(c => c.method === 'content.release')).toBe(true);
    });
    it('pageBridge composes the local draft port and preserves null after a manual connection recovery', async () => {
        const f = await fixture(), port = f.port(); let handle = '';
        vi.stubGlobal('window', { genieLocalProtocol: { ...port, send: (action: 'open' | 'frame' | 'close', id: string, text: string) => { if (action === 'open') handle = id; port.send(action, id, text); } } });
        const preload = { subscribeAgentWire: () => () => {}, workspaces: {}, files: {} } as unknown as PreloadBridge;
        const bridge = pageBridge(preload); await bridge.chatDrafts!.save('agent_a', draft()); expect(await bridge.chatDrafts!.load()).toEqual({ agent_a: draft() });
        port.send('close', handle, ''); await tick(); await tick(); bridge.localProtocol!.retry();
        await vi.waitFor(() => expect(bridge.localProtocol!.state().phase).toBe('ready')); expect(pageBridge(preload)).toBe(bridge);
        expect(await bridge.chatDrafts!.readFile(randomUUID())).toBeNull(); await bridge.chatDrafts!.save('agent_a', null); expect(await bridge.chatDrafts!.load()).toEqual({});
    });
    it('a remote bridge exposes no workstation draft port', async () => {
        const f = await fixture(), remote = await f.client({ kind: 'relay', label: 'owner', isOwner: true, workspaceId: null, readonly: false }); expect(remote.bridge.chatDrafts).toBeUndefined();
    });
    it('all five native handlers/preload paths/inventory rows retire together', () => {
        for (const path of ['src/main/main.ts', 'src/main/preload.ts', 'src/core/ipc-inventory.ts']) {
            const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
            for (const op of ['load', 'save', 'put-file', 'read-file', 'release']) expect(text).not.toContain(`'genie:chat-drafts-${op}'`);
        }
    });
});
