import { describe, expect, it } from 'vitest';
import {
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
