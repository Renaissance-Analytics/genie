import { describe, expect, it } from 'vitest';
import {
    overlayOwnConnKey,
    parseViewStateStore,
    readWorkspaceView,
    viewStateKey,
    writeWorkspaceView,
    type ViewStateStore,
    type WorkspaceViewState,
} from '../view-state';

/**
 * The client-local panel VIEW store: per-`(connKey, workspace)` layout that
 * lives in the LOCAL settings (never bridged to a host), so the local window and
 * each host window keep independent layouts of the same workspace.
 */

const view = (over: Partial<WorkspaceViewState> = {}): WorkspaceViewState => ({
    visibleIds: [],
    focusId: null,
    maximizedId: null,
    layoutMode: 'auto',
    ...over,
});

describe('viewStateKey', () => {
    it('namespaces a workspace by its window connection key', () => {
        expect(viewStateKey('local', 'ws1')).toBe('local|ws1');
        expect(viewStateKey('host-abc', 'ws1')).toBe('host-abc|ws1');
    });
});

describe('write/read round-trip', () => {
    it('round-trips a workspace view for a (connKey, workspace)', () => {
        const state = view({ visibleIds: ['a', 'b'], focusId: 'a', maximizedId: 'b', layoutMode: '2x2' });
        const store = writeWorkspaceView({}, 'local', 'ws1', state);
        expect(readWorkspaceView(store, 'local', 'ws1')).toEqual(state);
    });

    it('write is immutable — returns a new store, leaves the input untouched', () => {
        const base: ViewStateStore = {};
        const next = writeWorkspaceView(base, 'local', 'ws1', view({ visibleIds: ['a'] }));
        expect(base).toEqual({});
        expect(next).not.toBe(base);
    });

    it('returns null for a (connKey, workspace) with nothing saved (first run)', () => {
        expect(readWorkspaceView({}, 'local', 'never-seen')).toBeNull();
    });
});

describe('connKey isolation', () => {
    it('the local window and a host window do NOT collide on the same workspace', () => {
        let store: ViewStateStore = {};
        store = writeWorkspaceView(store, 'local', 'ws1', view({ visibleIds: ['a1'] }));
        store = writeWorkspaceView(store, 'host-x', 'ws1', view({ visibleIds: ['a2'] }));
        expect(readWorkspaceView(store, 'local', 'ws1')?.visibleIds).toEqual(['a1']);
        expect(readWorkspaceView(store, 'host-x', 'ws1')?.visibleIds).toEqual(['a2']);
    });
});

describe('overlayOwnConnKey (cross-window merge, no clobber)', () => {
    // A host window closed a panel → its `host:h1|A` slice on disk is fresh ['a'].
    // The LOCAL window still holds a STALE `host:h1|A` = ['a','b'] from its mount
    // seed, plus its own edited `local|A` = ['x']. Persisting the local window must
    // write its `local|*` slice but keep the host's FRESH slice from disk.
    it('writes only OUR connKey slice; preserves a concurrent window\'s slice from disk', () => {
        const latest: ViewStateStore = {
            'local|A': view({ visibleIds: ['old-local'] }),
            'host:h1|A': view({ visibleIds: ['a'] }), // fresh (host just closed b)
        };
        const cache: ViewStateStore = {
            'local|A': view({ visibleIds: ['x'] }), // our edit
            'host:h1|A': view({ visibleIds: ['a', 'b'] }), // our STALE mount seed
        };
        const merged = overlayOwnConnKey(latest, cache, 'local');
        expect(merged['local|A'].visibleIds).toEqual(['x']); // our slice written
        expect(merged['host:h1|A'].visibleIds).toEqual(['a']); // host's fresh slice kept
    });

    it('a new workspace entry we own is added; a disk entry for another conn is untouched', () => {
        const latest: ViewStateStore = { 'host:h1|A': view({ visibleIds: ['a'] }) };
        const cache: ViewStateStore = { 'local|B': view({ visibleIds: ['b'] }) };
        const merged = overlayOwnConnKey(latest, cache, 'local');
        expect(merged).toEqual({
            'host:h1|A': view({ visibleIds: ['a'] }),
            'local|B': view({ visibleIds: ['b'] }),
        });
    });

    it('the prefix test is exact — a connKey that is a string-prefix of another does not leak', () => {
        const latest: ViewStateStore = {};
        const cache: ViewStateStore = {
            'host:ab|A': view({ visibleIds: ['own'] }),
            'host:abc|A': view({ visibleIds: ['other'] }),
        };
        const merged = overlayOwnConnKey(latest, cache, 'host:ab');
        expect(merged['host:ab|A'].visibleIds).toEqual(['own']);
        expect('host:abc|A' in merged).toBe(false); // not our slice → not written
    });

    it('is immutable — returns a new store, leaves latest untouched', () => {
        const latest: ViewStateStore = { 'host:h1|A': view({ visibleIds: ['a'] }) };
        const merged = overlayOwnConnKey(latest, { 'local|A': view({ visibleIds: ['x'] }) }, 'local');
        expect(merged).not.toBe(latest);
        expect('local|A' in latest).toBe(false);
    });
});

describe('parseViewStateStore', () => {
    it('parses a JSON store', () => {
        const store = writeWorkspaceView({}, 'local', 'ws1', view({ visibleIds: ['a'] }));
        expect(parseViewStateStore(JSON.stringify(store))).toEqual(store);
    });

    it('treats empty/undefined/malformed JSON as an empty store', () => {
        expect(parseViewStateStore(undefined)).toEqual({});
        expect(parseViewStateStore(null)).toEqual({});
        expect(parseViewStateStore('')).toEqual({});
        expect(parseViewStateStore('{')).toEqual({});
        expect(parseViewStateStore('null')).toEqual({});
    });

    it('normalises a malformed entry (missing/older fields) defensively on read', () => {
        const store = { 'local|ws1': { visibleIds: ['a', 42, 'b'] } } as unknown as ViewStateStore;
        expect(readWorkspaceView(store, 'local', 'ws1')).toEqual({
            visibleIds: ['a', 'b'],
            focusId: null,
            maximizedId: null,
            layoutMode: 'auto',
        });
    });
});
