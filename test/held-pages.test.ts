import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_OPEN_PAGES } from '../src/core/local-content.js';
import type { GenieBridge } from '../src/renderer/bridge.js';
import { resourceDoor } from './support/local-resource-door.js';

/*
 * Tynn #547: opening a file failed with "only 8 lists or responses may be held on this connection". Nothing leaked; the
 * cap counted every Files call while the host was still running it, and the window fired its reads without limit or
 * coalescing (every open folder, every state read per batch per view, git status). These hold that shut.
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const big = 'held 雪'.repeat(40_000);
const opened = (path: string, text = big) => ({ ok: true, path, text, sha: hash(text), git: null });
const listing = (dir: string) => Array.from({ length: 3 }, (_, i) => ({ path: `${dir}/f${i}.txt`, kind: 'file' }));
const state = { files: [], activity: [], unreported: Array.from({ length: 5_000 }, (_, i) => `changed/${i}-${'x'.repeat(20)}.txt`), changed: null, diskChanges: [] };
const gitTree = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`changed/${i}-${'y'.repeat(20)}.txt`, 'modified']));

function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }

async function fixture(ports: Record<string, (...args: any[]) => Promise<unknown>>) {
    const files: Record<string, ReturnType<typeof vi.fn>> = {};
    const defaults: Record<string, (...args: any[]) => Promise<unknown>> = {
        open: async (_id: string, path: string) => opened(path), children: async (_id: string, dir: string) => listing(dir),
        state: async () => state, gitStatus: async () => gitTree, lastCommitted: async () => big, tree: async () => [],
    };
    for (const [name, fn] of Object.entries({ ...defaults, ...ports })) files[name] = vi.fn(fn);
    const localFiles = { files: () => files, editor: () => ({ gate: () => ({ allowed: true as const }), files }), repo: vi.fn(async () => ({ ok: true, value: null })) };
    const f = await resourceDoor(cleanups, {}, { localFiles });
    return { ...f, files };
}

describe('a running Files call holds no slot (host)', () => {
    it('opens a file while more Files calls than the cap are still running on the same connection', async () => {
        const g = gate();
        const f = await fixture({ children: async () => { await g.promise; return []; } }), raw = await f.raw();
        const running = Array.from({ length: MAX_OPEN_PAGES + 4 }, (_, i) => raw.call('files.localChildren', ['work', `d${i}`]));
        await vi.waitFor(() => expect(f.files.children!.mock.calls.length).toBeGreaterThanOrEqual(MAX_OPEN_PAGES));
        const open = await raw.call('files.localOpen', ['work', 'notes.md']);
        expect(open).toMatchObject({ kind: 'result', ok: true });
        g.open();
        for (const r of await Promise.all(running)) expect(r).toMatchObject({ kind: 'result', ok: true, value: [] });
        expect(f.files.children).toHaveBeenCalledTimes(MAX_OPEN_PAGES + 4);
    });

    it('a full cap names what holds it and evicts nothing', async () => {
        const f = await fixture({}), raw = await f.raw();
        const held: string[] = [];
        for (let i = 0; i < MAX_OPEN_PAGES; i++) {
            const r = await raw.call('files.localOpen', ['work', `held-${i}.md`]) as unknown as { ok: boolean; value: { filesContent: { ref: string } } };
            expect(r.ok).toBe(true); held.push(r.value.filesContent.ref);
        }
        const refused = await raw.call('files.localOpen', ['work', 'one-more.md']) as unknown as { ok: boolean; reason: string };
        expect(refused.ok).toBe(false);
        expect(refused.reason).toMatch(/only 8 lists or responses/);
        expect(refused.reason).toMatch(/files\.localOpen/);
        // Nothing was evicted to make room: every held response is still there to release.
        for (const ref of held) expect(await raw.call('content.release', [ref])).toMatchObject({ ok: true, value: { released: true } });
        expect(await raw.call('files.localOpen', ['work', 'one-more.md'])).toMatchObject({ ok: true });
    });
});

describe('the window never asks for more than the connection holds', () => {
    it('opens files again and again while folder, state and git reads run, and never hits the cap', async () => {
        const slow = () => new Promise(resolve => setTimeout(resolve, 2));
        const f = await fixture({
            children: async (_id: string, dir: string) => { await slow(); return listing(dir); },
            state: async () => { await slow(); return state; },
            gitStatus: async () => { await slow(); return gitTree; },
        });
        const c = await f.client(), files = c.bridge.files;
        const reads: Array<Promise<unknown>> = [];
        for (let round = 0; round < 5; round++) {
            for (let d = 0; d < 12; d++) reads.push(files.children!('work', `dir-${d}`));
            for (let s = 0; s < 4; s++) reads.push(files.state('work'));
            reads.push(files.gitStatus!('work'));
            for (let o = 0; o < 6; o++) reads.push(files.open('work', `doc-${round}-${o}.md`));
        }
        const settled = await Promise.allSettled(reads);
        const refusals = settled.flatMap(s => s.status === 'rejected' ? [String((s.reason as Error)?.message ?? s.reason)] : []);
        expect(refusals).toEqual([]);
        expect(await files.open('work', 'notes.md')).toEqual(opened('notes.md'));
        expect(c.state().lastRefusal ?? null).toBeNull();
    });

    it('keeps the Files calls in flight below the cap', async () => {
        const g = gate(); let running = 0, most = 0;
        const f = await fixture({ children: async (_id: string, dir: string) => { running++; most = Math.max(most, running); await g.promise; running--; return listing(dir); } });
        const c = await f.client();
        const reads = Array.from({ length: 20 }, (_, i) => c.bridge.files.children!('work', `dir-${i}`)); for (const r of reads) r.catch(() => {});
        await vi.waitFor(() => expect(f.files.children!.mock.calls.length).toBeGreaterThan(0));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(most).toBeLessThan(MAX_OPEN_PAGES);
        g.open();
        expect(await Promise.all(reads)).toEqual(Array.from({ length: 20 }, (_, i) => listing(`dir-${i}`)));
    });

    type Path = { name: string; port: string; call: (files: GenieBridge['files']) => Promise<unknown>; value: unknown };
    const paths: Path[] = [
        { name: 'folder children', port: 'children', call: files => files.children!('work', 'same'), value: listing('same') },
        { name: 'Files state', port: 'state', call: files => files.state('work'), value: state },
        { name: 'git status', port: 'gitStatus', call: files => files.gitStatus!('work'), value: gitTree },
        { name: 'a file open', port: 'open', call: files => files.open('work', 'same.md'), value: opened('same.md') },
        { name: 'last committed text', port: 'lastCommitted', call: files => files.lastCommitted!('work', 'same.md'), value: big },
    ];
    it.each(paths)('$name: a newer read joins the one queued behind the running read, never stacks', async path => {
        const g = gate();
        const f = await fixture({ [path.port]: async () => { await g.promise; return path.value; } });
        const c = await f.client();
        const reads = Array.from({ length: 10 }, () => path.call(c.bridge.files)); for (const r of reads) r.catch(() => {});
        await vi.waitFor(() => expect(f.files[path.port]!.mock.calls.length).toBeGreaterThan(0));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(f.files[path.port]).toHaveBeenCalledTimes(1);
        g.open();
        for (const value of await Promise.all(reads)) expect(value).toEqual(path.value);
        // One running read, and one more for every caller that asked while it ran: fresh, and never ten.
        expect(f.files[path.port]).toHaveBeenCalledTimes(2);
    });
});
