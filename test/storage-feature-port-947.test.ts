import { describe, expect, it } from 'vitest';
import type { StorageReport, TrashApproval } from '../src/core/workspace-storage.js';
import { storageFeaturePort, type StorageFeatureDeps } from '../src/main/storage-feature-port.js';
import type { StorageProgressEvent } from '../src/main/workspace-storage-host.js';

/**
 * THE HOST'S STORAGE ACTIONS (Tynn #947). The owner clicked Move to .trash and Empty trash in beta.65 and saw nothing for
 * twenty minutes: the action ran inside the caller's feature queue (so Empty trash waited behind the move), the tab had no
 * progress, the result named only counts, and genie-host.log had no line about either. Pinned here, with a storage double:
 *  - an action STARTS the work and answers at once; the work runs on, and the view says how far it is (n of m, bytes);
 *  - it ends with a result in words, naming each item it did not move or delete and why;
 *  - each start, each failure and each result is a line in the host log;
 *  - a second Move or Empty in the same workspace while one runs is refused in words (and logged), never queued silently;
 *  - work that throws is said in the view and the log, never swallowed.
 */
const REPORT: StorageReport = { measuredAt: 1, truncated: false, totals: { repos: 0, worktrees: 0, 'ci-artifacts': 0, 'chat-files': 0, dirty: 0, trash: 0 }, reclaimableBytes: 0, items: [], trash: [] };

function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function harness(over: Partial<StorageFeatureDeps['storage']> = {}) {
    const log: string[] = [];
    let changes = 0;
    const storage: StorageFeatureDeps['storage'] = {
        measure: async () => REPORT,
        moveToTrash: async () => ({ ok: true, trashId: 'genie-1-a', label: 'wt/a' }),
        cleanUp: async () => ({ moved: [], skipped: [], failed: [], problems: [], bytes: 0 }),
        restore: async () => ({ ok: true, label: 'wt/a' }),
        emptyTrash: async () => ({ ok: true, deleted: 0, bytes: 0, failed: [] }),
        ...over,
    };
    const port = storageFeaturePort({ storage, root: (id) => { if (id !== 'ws1') throw new Error('That workspace is not open on this machine.'); return '/w/ws1'; }, chatFiles: async () => [], changed: () => { changes += 1; }, log: (line) => { log.push(line); } });
    return { port, log, changes: () => changes };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('Move to .trash on the host (Tynn #947)', () => {
    it('answers at once while the work runs on, and the view says how far it is: n of m, bytes, the item now', async () => {
        const gate = deferred<void>();
        let progress: ((e: StorageProgressEvent) => void) | undefined;
        const h = harness({
            cleanUp: async (_root, ids, _input, onProgress) => {
                progress = onProgress;
                onProgress?.({ done: 1, total: ids.length, bytes: 1024, current: 'wt/a' });
                await gate.promise;
                return { moved: ['worktrees:wt/a'], skipped: [], failed: [], problems: [], bytes: 1024 };
            },
        });
        await h.port.cleanUp('ws1', ['worktrees:wt/a', 'worktrees:wt/b']);
        await tick();
        expect(progress).toBeTypeOf('function');
        expect(h.port.views().ws1!.progress).toEqual({ action: 'move', done: 1, total: 2, bytes: 1024, current: 'wt/a' });
        gate.resolve();
        await h.port.idle('ws1');
        expect(h.port.views().ws1!.progress ?? null).toBeNull();
    });

    it('ends with a result in words that names each item left and why; every start, failure and result is logged', async () => {
        const h = harness({
            cleanUp: async () => ({ moved: ['worktrees:wt/a'], skipped: ['worktrees:wt/dirty'], failed: ['ci-artifacts:x/coverage'], bytes: 2048,
                problems: [{ id: 'worktrees:wt/dirty', label: 'wt/dirty', reason: 'It has uncommitted changes.' }, { id: 'ci-artifacts:x/coverage', label: 'x/coverage', reason: 'EBUSY: resource busy or locked' }] }),
        });
        await h.port.cleanUp('ws1', ['worktrees:wt/a', 'worktrees:wt/dirty', 'ci-artifacts:x/coverage']);
        await h.port.idle('ws1');
        const v = h.port.views().ws1!;
        expect(v.outcome).toMatch(/Moved 1 of 3 items \(2\.0 KB\) to \.trash/);
        expect(v.outcome).toMatch(/2 were not moved/);
        expect(v.failures).toEqual([{ label: 'wt/dirty', reason: 'It has uncommitted changes.' }, { label: 'x/coverage', reason: 'EBUSY: resource busy or locked' }]);
        expect(h.log.some((l) => /storage: ws1: moving 3 items to \.trash/.test(l))).toBe(true);
        expect(h.log.some((l) => /wt\/dirty.*uncommitted changes/.test(l))).toBe(true);
        expect(h.log.some((l) => /x\/coverage.*EBUSY/.test(l))).toBe(true);
        expect(h.log.some((l) => /Moved 1 of 3/.test(l))).toBe(true);
    });

    it('one item: the same, its refusal said and logged', async () => {
        const h = harness({ moveToTrash: async () => ({ ok: false, reason: 'It has 2 commits no remote has.' }) });
        await h.port.trash('ws1', 'worktrees:wt/ahead');
        await h.port.idle('ws1');
        expect(h.port.views().ws1!.outcome).toMatch(/2 commits no remote has/);
        expect(h.log.some((l) => /worktrees:wt\/ahead/.test(l) && /2 commits no remote has/.test(l))).toBe(true);
    });

    it('a second Move or an Empty while one runs is refused in words and logged, never queued silently', async () => {
        const gate = deferred<void>();
        const h = harness({ cleanUp: async () => { await gate.promise; return { moved: [], skipped: [], failed: [], problems: [], bytes: 0 }; } });
        await h.port.cleanUp('ws1', ['worktrees:wt/a']);
        await expect(h.port.empty('ws1', { ids: [], bytes: 0 })).rejects.toThrow(/still moving/i);
        await expect(h.port.cleanUp('ws1', ['worktrees:wt/a'])).rejects.toThrow(/still moving/i);
        expect(h.log.some((l) => /refused/.test(l) && /still moving/i.test(l))).toBe(true);
        gate.resolve();
        await h.port.idle('ws1');
        // CONTROL: once it is done, the next action starts.
        await expect(h.port.empty('ws1', { ids: [], bytes: 0 })).resolves.toBeUndefined();
    });

    it('work that throws is said in the view and the log, never swallowed', async () => {
        const h = harness({ cleanUp: async () => { throw new Error('ENOSPC: no space left on device'); } });
        await h.port.cleanUp('ws1', ['worktrees:wt/a']);
        await h.port.idle('ws1');
        expect(h.port.views().ws1!.outcome).toMatch(/could not finish.*ENOSPC/);
        expect(h.port.views().ws1!.progress ?? null).toBeNull();
        expect(h.log.some((l) => /ENOSPC/.test(l))).toBe(true);
    });

    it('a workspace that is not open here is refused at once, in words', async () => {
        const h = harness();
        await expect(h.port.cleanUp('nope', ['x'])).rejects.toThrow('That workspace is not open on this machine.');
    });
});

describe('Empty trash on the host (Tynn #947)', () => {
    it('progress while it runs; the result names what it could not delete; each step logged', async () => {
        const gate = deferred<void>();
        const approval: TrashApproval = { ids: ['a', 'b'], bytes: 3 * 1024 * 1024 };
        const h = harness({
            emptyTrash: async (_root, _approval, onProgress) => {
                onProgress?.({ done: 1, total: 2, bytes: 1024 * 1024, current: 'a' });
                await gate.promise;
                return { ok: true, deleted: 1, bytes: 1024 * 1024, failed: [{ id: 'b', label: 'b', reason: 'EPERM: operation not permitted' }] };
            },
        });
        await h.port.empty('ws1', approval);
        await tick();
        expect(h.port.views().ws1!.progress).toEqual({ action: 'empty', done: 1, total: 2, bytes: 1024 * 1024, current: 'a' });
        gate.resolve();
        await h.port.idle('ws1');
        const v = h.port.views().ws1!;
        expect(v.outcome).toMatch(/Deleted 1 of 2 items \(1\.0 MB\) from \.trash/);
        expect(v.failures).toEqual([{ label: 'b', reason: 'EPERM: operation not permitted' }]);
        expect(h.log.some((l) => /emptying \.trash: 2 items/.test(l))).toBe(true);
        expect(h.log.some((l) => /b.*EPERM/.test(l))).toBe(true);
    });

    it('a refused approval is said and logged', async () => {
        const h = harness({ emptyTrash: async () => ({ ok: false, reason: 'The trash changed since you approved it: look again and approve what is there now.' }) });
        await h.port.empty('ws1', { ids: ['a'], bytes: 1 });
        await h.port.idle('ws1');
        expect(h.port.views().ws1!.outcome).toMatch(/trash changed/);
        expect(h.log.some((l) => /trash changed/.test(l))).toBe(true);
    });
});
