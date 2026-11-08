import { describe, expect, it } from 'vitest';
import { FilesWatchHub, type FilesHubEvent, type WatchSource } from '../src/main/files-watch-hub.js';
import type { GitTreeState } from '../src/main/git-ports.js';

/*
 * genie-host SENDS THE WINDOW ONLY WHAT CHANGED IN THE GIT TREE (Tynn #524). After genie#1684 the window's pushes to its
 * page carried only the tree's changes, but the window still received the WHOLE tree from genie-host on every git run,
 * parsed it, and diffed it: measured in the real window during a build, those were window main's two top frames
 * (parseFrame and treeChangesOf). Now the hub sends a connection the whole tree once, then only what changed since the
 * tree it last sent THAT connection; a connection new to the workspace gets the whole tree.
 */

const WS = { id: 'tynn', path: '/w/tynn' };

function rig() {
    const watchers: Array<{ emit: (rel: string) => void }> = [];
    const source: WatchSource = (_root, onPath) => { watchers.push({ emit: onPath }); return { close: () => {} }; };
    const timers: Array<() => void> = [];
    const sent: Array<{ owner: string; event: FilesHubEvent }> = [];
    let tree: Record<string, GitTreeState> = {};
    const hub = new FilesWatchHub({
        source, send: (owner, event) => sent.push({ owner, event }),
        schedule: (fn) => { timers.push(fn); return () => {}; },
        gitTree: async () => ({ ...tree }),
    });
    const batch = async () => { watchers.at(-1)!.emit('x.ts'); for (const t of timers.splice(0)) t(); await new Promise((r) => setTimeout(r, 0)); };
    const gits = (owner: string) => sent.filter((s) => s.owner === owner && s.event.kind === 'git').map((s) => s.event);
    return { hub, batch, gits, setTree: (t: Record<string, GitTreeState>) => { tree = t; } };
}

describe('the hub sends each connection only the tree\'s changes after the first', () => {
    it('whole tree first; then set and removed only; nothing changed is an empty change', async () => {
        const r = rig();
        r.hub.subscribe('win', 'files', WS, { git: true });
        r.setTree({ 'a.ts': 'modified', 'b.ts': 'untracked', 'gone.ts': 'deleted' });
        await r.batch();
        r.setTree({ 'a.ts': 'modified', 'b.ts': 'added', 'c.ts': 'untracked' });
        await r.batch();
        await r.batch();
        expect(r.gits('win')).toEqual([
            { kind: 'git', workspaceId: 'tynn', tree: { 'a.ts': 'modified', 'b.ts': 'untracked', 'gone.ts': 'deleted' } },
            { kind: 'git', workspaceId: 'tynn', treeChanges: { set: { 'b.ts': 'added', 'c.ts': 'untracked' }, removed: ['gone.ts'] } },
            { kind: 'git', workspaceId: 'tynn', treeChanges: { set: {}, removed: [] } },
        ]);
    });

    it('a connection that joins later gets the whole tree; one that left and came back gets it again', async () => {
        const r = rig();
        r.hub.subscribe('a', 'files', WS, { git: true });
        r.setTree({ 'a.ts': 'modified' });
        await r.batch();
        r.hub.subscribe('b', 'files', WS, { git: true });
        r.setTree({ 'a.ts': 'modified', 'b.ts': 'added' });
        await r.batch();
        expect(r.gits('a').at(-1)).toEqual({ kind: 'git', workspaceId: 'tynn', treeChanges: { set: { 'b.ts': 'added' }, removed: [] } });
        expect(r.gits('b').at(-1)).toEqual({ kind: 'git', workspaceId: 'tynn', tree: { 'a.ts': 'modified', 'b.ts': 'added' } });
        r.hub.dropOwner('b');
        r.hub.subscribe('b', 'files', WS, { git: true });
        await r.batch();
        expect(r.gits('b').at(-1)).toEqual({ kind: 'git', workspaceId: 'tynn', tree: { 'a.ts': 'modified', 'b.ts': 'added' } });
    });

    it('a tree emptied of more paths than it keeps is sent whole', async () => {
        const r = rig();
        r.hub.subscribe('win', 'files', WS, { git: true });
        r.setTree(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}.ts`, 'untracked' as const])));
        await r.batch();
        r.setTree({ 'new.ts': 'added' });
        await r.batch();
        expect(r.gits('win').at(-1)).toEqual({ kind: 'git', workspaceId: 'tynn', tree: { 'new.ts': 'added' } });
    });
});
