import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rosterPruner } from '../src/core/chat-drafts.js';

/*
 * beta.60 host stall diagnosis: the window sent `drafts.prune` to the host on EVERY registry snapshot, and a streaming agent
 * touches the registry about 20 times a second. A prune only matters when the roster's identity changes (an agent added or
 * removed), so that is the only time it is sent.
 */
describe('drafts are pruned when the roster changes, not on every registry snapshot', () => {
    function rig(initial: string[]) {
        let roster = initial;
        const calls: string[][] = [];
        const pruner = rosterPruner({
            ids: () => roster,
            prune: async (ids) => { calls.push([...ids]); },
            failed: (error) => { throw error; },
        });
        return { pruner, calls, set: (next: string[]) => { roster = next; } };
    }

    it('prunes once at start, then N streaming snapshots with the same roster send no prune', async () => {
        const r = rig(['a', 'b', 'c']);
        await r.pruner.start();
        expect(r.calls).toEqual([['a', 'b', 'c']]);
        for (let i = 0; i < 200; i += 1) r.pruner.changed();
        // The same agents in another order are the same roster.
        r.set(['c', 'a', 'b']);
        for (let i = 0; i < 200; i += 1) r.pruner.changed();
        await Promise.resolve();
        expect(r.calls).toHaveLength(1);
    });

    it('an agent added sends exactly one prune, however many snapshots follow', async () => {
        const r = rig(['a', 'b']);
        await r.pruner.start();
        r.set(['a', 'b', 'c']);
        for (let i = 0; i < 50; i += 1) r.pruner.changed();
        await Promise.resolve();
        expect(r.calls).toEqual([['a', 'b'], ['a', 'b', 'c']]);
    });

    it('an agent removed sends exactly one prune, with the roster that remains', async () => {
        const r = rig(['a', 'b', 'c']);
        await r.pruner.start();
        r.set(['a', 'c']);
        for (let i = 0; i < 50; i += 1) r.pruner.changed();
        await Promise.resolve();
        expect(r.calls).toEqual([['a', 'b', 'c'], ['a', 'c']]);
    });

    it('a swap (one removed, one added, same count) is a change', async () => {
        const r = rig(['a', 'b']);
        await r.pruner.start();
        r.set(['a', 'z']);
        r.pruner.changed();
        expect(r.calls).toEqual([['a', 'b'], ['a', 'z']]);
    });

    it('a failed start prune is retried on the next snapshot instead of being taken as done', async () => {
        let fail = true;
        const calls: string[][] = [];
        const errors: unknown[] = [];
        const pruner = rosterPruner({
            ids: () => ['a'],
            prune: async (ids) => { calls.push([...ids]); if (fail) throw new Error('host away'); },
            failed: (error) => { errors.push(error); },
        });
        await pruner.start();
        expect(errors).toHaveLength(1);
        fail = false;
        pruner.changed();
        await Promise.resolve();
        pruner.changed();
        await Promise.resolve();
        expect(calls).toEqual([['a'], ['a']]);
    });

    it('main.ts prunes through the roster pruner, not on every registry notification', () => {
        const src = readFileSync('src/main/main.ts', 'utf8');
        expect(src).not.toMatch(/registry\.subscribe\(\(\) => \{ void drafts\.prune\(/);
        expect(src).toMatch(/rosterPruner\(/);
        expect(src).toMatch(/registry\.subscribe\(\(\) => draftPruner\.changed\(\)\)/);
    });
});
