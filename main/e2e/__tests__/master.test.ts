import { describe, expect, it } from 'vitest';
import { pruneFixtureViews } from '../master';

/**
 * The half of the master-window fixture that decides whether the spec asserts
 * against a FRESH window or against the leftovers of the last run.
 *
 * `launchGenieE2E` reuses one throwaway profile across runs, and the master page
 * persists each window's panel layout in the `view_state_json` setting keyed by
 * `${connKey}|${workspaceId}`. That store is authoritative on launch: when an
 * entry exists for the target workspace, `computeLaunchSelection` restores
 * EXACTLY its `visibleIds` and never falls back to the workspace's enabled specs.
 *
 * So a run that closes a panel (or one that simply ran before the fixture's spec
 * ids changed) leaves behind a saved view that hides the seeded terminal — and
 * the next run comes up with an empty floor while every seeded row is present in
 * the database. The seed must therefore DROP its own workspaces' entries, and
 * only its own: the blob spans every window's connKey and every other fixture's
 * workspaces, none of which this seed owns.
 */

const view = (visibleIds: string[]) => ({
    visibleIds,
    focusId: null,
    maximizedId: null,
    layoutMode: 'auto',
});

describe('pruneFixtureViews', () => {
    it('drops the fixture workspaces saved layout, whatever the connKey', () => {
        const store = JSON.stringify({
            'local|e2e-master-window': view(['stale-panel']),
            'host:abc|e2e-master-window-peer': view([]),
        });
        expect(
            pruneFixtureViews(store, ['e2e-master-window', 'e2e-master-window-peer']),
        ).toEqual({});
    });

    it('leaves every other workspace alone — the blob is shared', () => {
        // Other fixtures (agent-access, repo-panel, agent-pulse) seed into the
        // SAME profile, and a real window's layout for them is none of this
        // seed's business.
        const store = JSON.stringify({
            'local|e2e-master-window': view(['stale-panel']),
            'local|e2e-agent-access-primary': view(['someone-elses-panel']),
        });
        expect(pruneFixtureViews(store, ['e2e-master-window'])).toEqual({
            'local|e2e-agent-access-primary': view(['someone-elses-panel']),
        });
    });

    it('does not confuse a workspace whose id merely starts the same', () => {
        // `e2e-master-window-peer` starts with `e2e-master-window`; pruning by
        // prefix would take a workspace the caller never named.
        const store = JSON.stringify({
            'local|e2e-master-window-peer': view(['peer-panel']),
        });
        expect(pruneFixtureViews(store, ['e2e-master-window'])).toEqual({
            'local|e2e-master-window-peer': view(['peer-panel']),
        });
    });

    it('treats an absent or unreadable store as empty rather than throwing', () => {
        // A profile that has never persisted a layout has no setting at all, and
        // a half-written one must not take the seed (and so the whole harness
        // window) down with it.
        expect(pruneFixtureViews(undefined, ['e2e-master-window'])).toEqual({});
        expect(pruneFixtureViews('', ['e2e-master-window'])).toEqual({});
        expect(pruneFixtureViews('{not json', ['e2e-master-window'])).toEqual({});
        expect(pruneFixtureViews('[1,2,3]', ['e2e-master-window'])).toEqual({});
    });
});
