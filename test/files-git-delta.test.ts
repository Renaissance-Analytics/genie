import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WireMessage } from '../src/core/remote-protocol.js';
import { localFilesWatchClient } from '../src/renderer/local-files-watch-client.js';
import { localWatchDoor, watchTick as tick } from './support/local-watch-door.js';

/*
 * A FILES PUSH CARRIES ONLY WHAT CHANGED (Tynn #523, UI lag L3). Every push to a Files view carried the whole git tree:
 * a batch of changed paths carried the tree from before it, and each git run sent the whole tree again. Measured in the
 * real window during a build (genie#1682's row): up to 281 KB per push, 25 MB in 12 s, the top cost on window main.
 * Now a batch carries its paths only, and a git run carries what changed in the tree since the last one the window was
 * sent; the window keeps the tree and gives each view the whole of it, as before.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
type Push = { workspaceId: string; revision: number; state?: { event: { paths?: string[]; git?: Record<string, unknown> } }; changed?: string };
const pushes = (serialized: string[]): Array<{ push: Push; bytes: number }> => serialized
    .map((text) => ({ frame: JSON.parse(text) as WireMessage, bytes: Buffer.byteLength(text) }))
    .filter(({ frame }) => frame.kind === 'event' && frame.channel === 'local-files')
    .map(({ frame, bytes }) => ({ push: (frame as { payload: Push }).payload, bytes }));

describe('a Files push carries only what changed', () => {
    it('a batch of paths carries no git tree, and the second git run sends only the tree\'s changes', async () => {
        const f = await localWatchDoor(cleanups), client = await f.client(), seen = vi.fn();
        f.data.tree = { 'a.txt': 'modified', 'b.txt': 'untracked', 'gone.txt': 'deleted' };
        client.bridge.files.subscribe!('work', { git: true }, seen); await tick();
        await f.emit(['a.txt']);
        f.data.tree = { 'a.txt': 'modified', 'b.txt': 'added', 'c.txt': 'untracked' };
        await f.emit(['b.txt', 'c.txt']);
        await vi.waitFor(() => expect(seen.mock.calls.filter(([e]) => e.git)).toHaveLength(2));

        // Every view still gets the whole tree.
        expect(seen.mock.calls.filter(([e]) => e.git).map(([e]) => e.git.tree)).toEqual([
            { 'a.txt': 'modified', 'b.txt': 'untracked', 'gone.txt': 'deleted' },
            { 'a.txt': 'modified', 'b.txt': 'added', 'c.txt': 'untracked' },
        ]);
        const sent = pushes(f.serialized).map((p) => p.push.state?.event);
        // paths, git (whole: nothing sent before), paths, git (changes only)
        expect(sent.map((e) => (e?.paths ? 'paths' : e?.git ? 'git' : '?'))).toEqual(['paths', 'git', 'paths', 'git']);
        expect(sent[2]!.git).toBeUndefined();
        expect(sent[3]!.git!.tree).toBeUndefined();
        expect(sent[3]!.git!.treeChanges).toEqual({ base: expect.any(Number), set: { 'b.txt': 'added', 'c.txt': 'untracked' }, removed: ['gone.txt'] });
        expect(f.calls.filter((c) => c.method === 'files.watchState')).toHaveLength(0);
    });

    it('a 30,000-entry tree with 3 changes is a push of under 2 KB, and the view still gets all 30,000', async () => {
        const f = await localWatchDoor(cleanups), client = await f.client(), seen = vi.fn();
        const big = Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`gen/m${i % 30}/f${i}.js`, 'untracked' as const]));
        f.data.tree = big;
        client.bridge.files.subscribe!('work', { git: true }, seen); await tick();
        await f.emit(['x.txt']);
        await vi.waitFor(() => expect(seen.mock.calls.some(([e]) => e.git)).toBe(true));
        f.data.tree = { ...big, 'gen/m7/f7.js': 'modified', 'new.txt': 'added' };
        delete f.data.tree['gen/m0/f0.js'];
        await f.emit(['new.txt']);
        await vi.waitFor(() => expect(seen.mock.calls.filter(([e]) => e.git)).toHaveLength(2));
        expect(seen.mock.calls.filter(([e]) => e.git).at(-1)![0].git.tree).toEqual(f.data.tree);
        const last = pushes(f.serialized).at(-1)!;
        expect(last.push.state?.event.git).toBeDefined();
        expect(last.bytes).toBeLessThan(2_000);
        // The batch push before it carried its one path, not the tree.
        expect(pushes(f.serialized).at(-2)!.bytes).toBeLessThan(1_000);
    });
});

describe('the window\'s copy of the tree', () => {
    it('changes against a tree it does not hold are never applied: it reads the whole state instead', async () => {
        const pushed = new Set<(push: unknown) => void>();
        const read = vi.fn(async (method: string) => {
            if (method === 'files.watch') return true;
            if (method === 'files.watchState') return { revision: 5, pathsRevision: 0, gitRevision: 5, event: { git: { tree: { 'whole.txt': 'added' } } } };
            return null;
        });
        const client = localFilesWatchClient({ read: read as never, decode: async (v) => v as never, on: (l) => { pushed.add(l); return () => pushed.delete(l); }, refusal: () => {} });
        const seen = vi.fn();
        client.files.subscribe!('work', { git: true }, seen); await tick();
        // A change to a tree at git revision 3, which this window was never sent.
        for (const l of pushed) l({ workspaceId: 'work', revision: 5, state: { revision: 5, pathsRevision: 0, gitRevision: 5, event: { git: { treeChanges: { base: 3, set: { 'b.txt': 'added' }, removed: [] } } } } });
        await vi.waitFor(() => expect(seen).toHaveBeenCalled());
        expect(read).toHaveBeenCalledWith('files.watchState', expect.any(String));
        expect(seen).toHaveBeenCalledExactlyOnceWith({ git: { tree: { 'whole.txt': 'added' } } });
    });
});
