import { describe, expect, it } from 'vitest';
import { FilesWatchHub, type FilesHubEvent, type WatchSource } from '../src/main/files-watch-hub.js';
import type { RepoResult } from '../src/main/repo-git.js';
import type { RepoStatus } from '../src/main/repo-model.js';

/**
 * THE FILE WATCHER AND GIT, BEHIND PER-VIEW SUBSCRIPTIONS (the host split, P2.2: plan §11b).
 *
 * Before: every view that wanted disk changes called `files.watch(workspaceId)`, nothing ever unwatched, so a recursive
 * watcher ran in Electron main for the rest of the session once a workspace had been opened; and on every batch EACH view
 * ran git on its own (the tree's `gitStatus`, the Repository panel's `repo status`). The hub holds the rule instead:
 * one watcher per workspace for as long as a view wants it, one batch per 250 ms to the connections whose views watch
 * it, and git ONCE per batch however many views want it, never two runs at a time.
 */

const WS = { id: 'tynn', path: '/w/tynn' };

function rig(opts: { git?: boolean } = {}) {
    const watchers: Array<{ root: string; emit: (rel: string) => void; closed: boolean }> = [];
    const source: WatchSource = (root, onPath) => {
        const w = { root, emit: onPath, closed: false };
        watchers.push(w);
        return { close: () => { w.closed = true; } };
    };
    const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
    const sent: Array<{ owner: string; event: FilesHubEvent }> = [];
    let gitRuns = 0;
    let repoRuns = 0;
    let releaseGit: (() => void) | null = null;
    let holdGit = false;
    let now = 1_000;
    const hub = new FilesWatchHub({
        source,
        send: (owner, event) => sent.push({ owner, event }),
        now: () => now,
        schedule: (fn) => { const t = { fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
        ...(opts.git === false ? {} : {
            gitTree: async () => {
                gitRuns += 1;
                if (holdGit) await new Promise<void>((r) => { releaseGit = r; });
                return { 'a.ts': 'modified' as const };
            },
            repoStatus: async (_root: string, rel: string): Promise<RepoResult<RepoStatus>> => {
                repoRuns += 1;
                return { ok: true, value: { branch: rel || 'main', changes: [] } as unknown as RepoStatus };
            },
        }),
    });
    /** Fire every batch timer that is due (the 250 ms window ends). */
    const flush = () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn(); };
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return {
        hub, watchers, sent, flush, settle,
        gitRuns: () => gitRuns, repoRuns: () => repoRuns,
        hold: () => { holdGit = true; }, release: () => { holdGit = false; releaseGit?.(); releaseGit = null; },
        at: (t: number) => { now = t; },
        pendingTimers: () => timers.filter((t) => !t.cancelled).length,
    };
}

describe('one watcher per workspace, for as long as a view wants it', () => {
    it('the first view starts the watcher; a second view of the same workspace shares it', () => {
        const r = rig();
        expect(r.watchers).toEqual([]); // CONTROL: nothing watches before a view asks
        r.hub.subscribe('win1', 'files-panel', WS, {});
        r.hub.subscribe('win1', 'repo-panel', WS, {});
        r.hub.subscribe('win2', 'agent-view', WS, {});
        expect(r.watchers.map((w) => w.root)).toEqual(['/w/tynn']);
    });

    it('the watcher is CLOSED when the last view leaves — not before', () => {
        const r = rig();
        r.hub.subscribe('win1', 'a', WS, {});
        r.hub.subscribe('win1', 'b', WS, {});
        r.hub.unsubscribe('win1', 'a');
        expect(r.watchers[0]!.closed).toBe(false);
        r.hub.unsubscribe('win1', 'b');
        expect(r.watchers[0]!.closed).toBe(true);
        expect(r.hub.watching()).toEqual([]);
    });

    it('a connection that goes drops every view it had: a closed or crashed window watches nothing', () => {
        const r = rig();
        r.hub.subscribe('win1', 'a', WS, {});
        r.hub.subscribe('win1', 'b', { id: 'other', path: '/w/other' }, {});
        r.hub.subscribe('win2', 'c', WS, {});
        r.hub.dropOwner('win1');
        expect(r.watchers.map((w) => [w.root, w.closed])).toEqual([['/w/tynn', false], ['/w/other', true]]);
        r.hub.dropOwner('win2');
        expect(r.watchers.every((w) => w.closed)).toBe(true);
    });

    it('a pending batch of a workspace nobody watches any more is dropped, never sent', () => {
        const r = rig();
        r.hub.subscribe('win1', 'a', WS, {});
        r.watchers[0]!.emit('a.ts');
        r.hub.unsubscribe('win1', 'a');
        r.flush();
        expect(r.sent).toEqual([]);
    });
});

describe('one batch per window of changes, to the connections watching', () => {
    it('a burst is ONE event with every path and when it was seen, to each watching connection once', () => {
        const r = rig();
        r.hub.subscribe('win1', 'a', WS, {});
        r.hub.subscribe('win1', 'b', WS, {});
        r.hub.subscribe('win2', 'c', WS, {});
        r.hub.subscribe('win3', 'd', { id: 'other', path: '/w/other' }, {});
        r.at(5_000);
        r.watchers[0]!.emit('a.ts');
        r.at(5_100);
        r.watchers[0]!.emit('src/b.ts');
        r.watchers[0]!.emit('a.ts'); // seen again: once, at its latest time
        expect(r.sent).toEqual([]); // not before the window ends
        r.flush();
        const event: FilesHubEvent = { kind: 'changed', workspaceId: 'tynn', changes: [{ path: 'a.ts', at: 5_100 }, { path: 'src/b.ts', at: 5_100 }] };
        expect(r.sent).toEqual([{ owner: 'win1', event }, { owner: 'win2', event }]);
    });
});

describe('git once per batch, however many views want it', () => {
    it('three views wanting git: ONE git run per batch, its result to each connection that wants it', async () => {
        const r = rig();
        r.hub.subscribe('win1', 'tree', WS, { git: true });
        r.hub.subscribe('win1', 'tree-popout', WS, { git: true });
        r.hub.subscribe('win2', 'tree', WS, { git: true });
        r.hub.subscribe('win3', 'artboard', WS, {});
        r.watchers[0]!.emit('a.ts');
        r.flush();
        await r.settle();
        expect(r.gitRuns()).toBe(1);
        const git = r.sent.filter((s) => s.event.kind === 'git');
        expect(git.map((s) => s.owner)).toEqual(['win1', 'win2']); // not win3: its view wants no git
        expect(git[0]!.event).toEqual({ kind: 'git', workspaceId: 'tynn', tree: { 'a.ts': 'modified' } });
    });

    it('no view wants git: none is run (CONTROL for the count above)', async () => {
        const r = rig();
        r.hub.subscribe('win1', 'artboard', WS, {});
        r.watchers[0]!.emit('a.ts');
        r.flush();
        await r.settle();
        expect(r.gitRuns()).toBe(0);
    });

    it('a batch while git runs does not start a second run: it marks it, and git runs ONCE more after', async () => {
        const r = rig();
        r.hub.subscribe('win1', 'tree', WS, { git: true });
        r.hold();
        r.watchers[0]!.emit('a.ts');
        r.flush();
        await r.settle();
        expect(r.gitRuns()).toBe(1);
        r.watchers[0]!.emit('b.ts');
        r.flush();
        r.watchers[0]!.emit('c.ts');
        r.flush();
        await r.settle();
        expect(r.gitRuns()).toBe(1); // still the first: two batches came in while it ran
        r.release();
        await r.settle(); await r.settle();
        expect(r.gitRuns()).toBe(2); // one more, for both
        await r.settle(); await r.settle();
        expect(r.gitRuns()).toBe(2);
    });

    it('a repo a view wants is read once per batch, under its own name; the tree only when a view wants the tree', async () => {
        const r = rig();
        r.hub.subscribe('win1', 'repo-panel', WS, { repos: ['repos/genie'] });
        r.hub.subscribe('win1', 'repo-panel-2', WS, { repos: ['repos/genie'] });
        r.watchers[0]!.emit('repos/genie/a.ts');
        r.flush();
        await r.settle(); await r.settle();
        expect(r.gitRuns()).toBe(0);
        expect(r.repoRuns()).toBe(1);
        expect(r.sent.filter((s) => s.event.kind === 'git').map((s) => s.event)).toEqual([
            { kind: 'git', workspaceId: 'tynn', repos: { 'repos/genie': { ok: true, value: { branch: 'repos/genie', changes: [] } } } },
        ]);
    });
});
