import { afterEach, expect, it, vi } from 'vitest';
import { LOCAL_UPLOAD_TTL_MS } from '../src/core/local-content.js';
import { resourceDoor } from './support/local-resource-door.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.useRealTimers(); });
async function module() { const path: string = '../src/main/local-files-content.js'; return import(path); }
const text = 'content 雪'.repeat(40_000);
function envelope(value: any) { expect(value?.filesContent?.ref).toMatch(/^[A-Za-z0-9_-]{1,128}$/); return value.filesContent; }

it('a live response ref resolves before expiry; release invalidates it and frees the existing page slot', async () => {
    const { LocalFilesContent } = await module(), resources = new LocalFilesContent(); cleanups.push(async () => resources.dispose());
    const responses = Array.from({ length: 8 }, () => envelope(resources.capture(text, 'workspace-tree')));
    expect(() => resources.capture(text, 'workspace-tree')).toThrow(/8|page|response|limit/i);
    const a = responses[0]!, blob = await resources.blobs.open('workspace-file', a.value.ref);
    expect(Buffer.from((await resources.blobs.read(blob.id, 0, 12)).base64, 'base64').equals(Buffer.from(text).subarray(0, 12))).toBe(true);
    expect(resources.release(a.ref)).toEqual({ released: true });
    await expect(resources.blobs.open('workspace-file', a.value.ref)).rejects.toThrow(/released|ref|closed|expired/i);
    await expect(resources.blobs.read(blob.id, 0, 1)).rejects.toThrow();
    envelope(resources.capture(text, 'workspace-tree'));
    // Unreleased siblings remain a positive control after a different response's cleanup.
    const b = responses[1]!, live = await resources.blobs.open('workspace-file', b.value.ref);
    expect(live.size).toBe(Buffer.byteLength(text));
});
it('expiry uses the staging TTL, invalidates refs and releases every retained slot without disconnecting', async () => {
    vi.useFakeTimers();
    const { LocalFilesContent } = await module(), resources = new LocalFilesContent(); cleanups.push(async () => resources.dispose());
    const responses = Array.from({ length: 8 }, () => envelope(resources.capture(text, 'workspace-tree')));
    await vi.advanceTimersByTimeAsync(LOCAL_UPLOAD_TTL_MS - 1);
    const opened = await resources.blobs.open('workspace-file', responses[0]!.value.ref); expect(opened.size).toBe(Buffer.byteLength(text));
    await vi.advanceTimersByTimeAsync(1);
    await expect(resources.blobs.open('workspace-file', responses[0]!.value.ref)).rejects.toThrow(/released|ref|closed|expired/i);
    await expect(resources.blobs.read(opened.id, 0, 1)).rejects.toThrow();
    for (let i = 0; i < 8; i++) envelope(resources.capture(text, 'workspace-tree'));
});
it('disconnect clears response pages, open blobs and reservations, and never revives a disposed scope', async () => {
    const { LocalFilesContent } = await module(), resources = new LocalFilesContent();
    const response = envelope(resources.capture(Array.from({ length: 300 }, (_, i) => ({ id: String(i), label: 'node' })), 'workspace-tree'));
    const first = await resources.pages.open('workspace-tree', response.value.ref); expect(first.items).toHaveLength(128); expect(first.cursor).not.toBeNull();
    resources.dispose();
    await expect(resources.pages.next(first.cursor)).rejects.toThrow();
    expect(() => resources.capture(text, 'workspace-tree')).toThrow(/closed/i);
});
it('each response and its own cursor share one of eight page slots; release also closes its live cursor', async () => {
    const { LocalFilesContent } = await module(), resources = new LocalFilesContent(); cleanups.push(async () => resources.dispose());
    const responses = Array.from({ length: 8 }, () => envelope(resources.capture(Array.from({ length: 300 }, (_, i) => i), 'workspace-tree')));
    const pages = [];
    for (const response of responses) pages.push(await resources.pages.open('workspace-tree', response.value.ref));
    expect(pages).toHaveLength(8);
    expect(() => resources.capture(text, 'workspace-tree')).toThrow();
    resources.release(responses[0]!.ref);
    await expect(resources.pages.next(pages[0]!.cursor)).rejects.toThrow();
    envelope(resources.capture(text, 'workspace-tree'));
    expect((await resources.pages.next(pages[1]!.cursor)).items).toHaveLength(128);
});
it('another connection cannot resolve or release the response, page or blob references', async () => {
    const { LocalFilesContent } = await module(), owner = new LocalFilesContent(), other = new LocalFilesContent(); cleanups.push(async () => { owner.dispose(); other.dispose(); });
    const value = envelope(owner.capture(text, 'workspace-tree'));
    expect(other.release(value.ref)).toEqual({ released: false });
    await expect(other.blobs.open('workspace-file', value.value.ref)).rejects.toThrow();
    expect((await owner.blobs.open('workspace-file', value.value.ref)).size).toBe(Buffer.byteLength(text));
    const list = envelope(owner.capture([1, 2], 'folder-children'));
    await expect(other.pages.open('folder-children', list.value.ref)).rejects.toThrow();
    expect((await owner.pages.open('folder-children', list.value.ref)).items).toHaveLength(2);
});
it.each(['tailnet', 'relay', 'guest', 'phone'])('content.release is local only, with %s refused before invocation', async kind => {
    const f = await resourceDoor(cleanups), raw = kind === 'tailnet' || kind === 'phone' ? await f.raw('tailnet', kind === 'phone') : await f.raw({ kind: 'relay', label: kind, isOwner: kind === 'relay', workspaceId: kind === 'guest' ? 'work' : null, readonly: false });
    f.invoke.mockClear();
    expect(await raw.call('content.release', ['foreign-ref'])).toMatchObject({ kind: 'result', ok: false, reason: expect.stringContaining('own Genie window') });
    expect(f.invoke).not.toHaveBeenCalled();
});
it('content.release has an admitted local positive control and a visible idempotent missing-ref result', async () => {
    const f = await resourceDoor(cleanups), raw = await f.raw();
    expect(await raw.call('content.release', ['missing-ref'])).toMatchObject({ kind: 'result', ok: true, value: { released: false } });
    expect(await raw.call('baton.status', [])).toMatchObject({ kind: 'result', ok: true });
});
