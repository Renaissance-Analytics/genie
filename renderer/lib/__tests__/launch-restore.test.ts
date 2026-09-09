import { describe, expect, it } from 'vitest';
import {
    computeLaunchSelection,
    effectiveWorkspaceId,
    parseMaxViews,
} from '../launch-restore';
import {
    parseViewStateStore,
    writeWorkspaceView,
    type ViewStateStore,
} from '../view-state';
import type { TerminalSpec, WorkspaceRow } from '../genie';

const emptyView = {
    visibleIds: [] as string[],
    focusId: null,
    maximizedId: null,
    layoutMode: 'auto' as const,
};

/**
 * Unit tests for the launch-restore brain that decides which workspace fills
 * the grid on launch and which of its terminals are restored as panels.
 *
 * Regression context: a quit+relaunch came up with an EMPTY grid even though
 * every terminal spec survived in the DB (all `enabled`). The old seed lived in
 * a `[workspaces.length]` effect that read `specs` through a closure and latched
 * a one-shot guard — so if it ran before the target workspace's specs were in
 * state, it selected nothing and never retried. `computeLaunchSelection` is the
 * pure replacement the caller now feeds the freshly-fetched arrays, so the
 * selection can never race a not-yet-loaded `specs`.
 */

const SYSTEM = '__system__';

function ws(id: string, over: Partial<WorkspaceRow> = {}): WorkspaceRow {
    return {
        id,
        backend: 'tynn',
        project_id: id,
        project_name: id,
        tynn_project_id: id,
        tynn_project_name: id,
        shape: 'agi',
        path: `/projects/${id}`,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 0,
        ...over,
    } as WorkspaceRow;
}

function spec(
    id: string,
    workspace_id: string | null,
    over: Partial<TerminalSpec> = {},
): TerminalSpec {
    return {
        id,
        workspace_id,
        label: id,
        cwd: '/tmp',
        shell: null,
        args: [],
        env: {},
        type: 'terminal',
        meta: {},
        sort_order: 0,
        created_at: '',
        last_opened_at: null,
        snapshot_at: null,
        snapshot_bytes: null,
        live_cwd: null,
        enabled: true,
        ...over,
    };
}

describe('computeLaunchSelection', () => {
    it('restores the persisted active_workspace and its enabled specs (the fix)', () => {
        // Mirrors the real DB state that produced the bug: many specs across
        // many workspaces, active_workspace pinned to one that has a terminal +
        // an editor. The restore MUST return that workspace + its two spec ids
        // (the old effect could yield an empty selection here).
        const workspaces = [ws('A'), ws('B'), ws('C')];
        const specs = [
            spec('a-term', 'A'),
            spec('a-editor', 'A', { type: 'code' }),
            spec('b-term', 'B'),
            spec('c-term', 'C'),
        ];
        const result = computeLaunchSelection({
            specs,
            workspaces,
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.activeWorkspaceId).toBe('A');
        expect(result.selectedIds.sort()).toEqual(['a-editor', 'a-term']);
        // The regression assertion: a populated specs list + valid saved
        // workspace never yields an empty grid.
        expect(result.selectedIds.length).toBeGreaterThan(0);
    });

    it('excludes suspended (enabled:false) specs from the restore', () => {
        const result = computeLaunchSelection({
            specs: [
                spec('live', 'A'),
                spec('suspended', 'A', { enabled: false }),
            ],
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.selectedIds).toEqual(['live']);
    });

    it('keeps process specs in the selection (the grid memo filters them, not us)', () => {
        const result = computeLaunchSelection({
            specs: [spec('term', 'A'), spec('proc', 'A', { type: 'process' })],
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.selectedIds.sort()).toEqual(['proc', 'term']);
    });

    it('falls back to the most-recent workspace when active_workspace is unset', () => {
        const result = computeLaunchSelection({
            specs: [spec('first-term', 'first'), spec('second-term', 'second')],
            // Caller passes workspaces pre-sorted (most-recent first).
            workspaces: [ws('first'), ws('second')],
            savedActiveWorkspace: null,
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.activeWorkspaceId).toBe('first');
        expect(result.selectedIds).toEqual(['first-term']);
    });

    it('falls back when active_workspace points at a workspace that no longer exists', () => {
        const result = computeLaunchSelection({
            specs: [spec('a-term', 'A')],
            workspaces: [ws('A')],
            savedActiveWorkspace: 'deleted-workspace',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.activeWorkspaceId).toBe('A');
        expect(result.selectedIds).toEqual(['a-term']);
    });

    it('pins a Stage window to its ?stage= workspace over active_workspace', () => {
        const result = computeLaunchSelection({
            specs: [spec('a-term', 'A'), spec('b-term', 'B')],
            workspaces: [ws('A'), ws('B')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: 'B',
            systemWorkspaceId: SYSTEM,
        });
        expect(result.activeWorkspaceId).toBe('B');
        expect(result.selectedIds).toEqual(['b-term']);
    });

    it('maps System Workspace specs (workspace_id null + meta.system) onto the system id', () => {
        const result = computeLaunchSelection({
            specs: [
                spec('sys-term', null, { meta: { system: true } }),
                // A null-workspace spec WITHOUT the system tag is not a system
                // spec and must not be picked up by the system target.
                spec('orphan', null),
            ],
            workspaces: [ws('A')],
            savedActiveWorkspace: SYSTEM,
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        // savedActiveWorkspace=SYSTEM isn't in `workspaces` (the System Workspace
        // is synthetic), so it falls back to workspaces[0]=A → nothing selected.
        expect(result.activeWorkspaceId).toBe('A');
        expect(result.selectedIds).toEqual([]);
    });

    it('restores THIS window\'s saved visible set over the enabled default (X-button hide survives a relaunch)', () => {
        // A2 was closed with the X button in this window → it persisted a
        // visible set of just [a1]. Both specs are still enabled on the host, but
        // the restore must honour the client-local hide, not resurrect a2.
        const store = writeWorkspaceView({}, 'local', 'A', {
            ...emptyView,
            visibleIds: ['a1'],
        });
        const result = computeLaunchSelection({
            specs: [spec('a1', 'A'), spec('a2', 'A')],
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
            viewStore: store,
            connKey: 'local',
        });
        expect(result.selectedIds).toEqual(['a1']);
    });

    it('drops a stored id whose spec was since deleted', () => {
        const store = writeWorkspaceView({}, 'local', 'A', {
            ...emptyView,
            visibleIds: ['a1', 'gone'],
        });
        const result = computeLaunchSelection({
            specs: [spec('a1', 'A')],
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
            viewStore: store,
            connKey: 'local',
        });
        expect(result.selectedIds).toEqual(['a1']);
    });

    it('first run for a (connKey, workspace) with no saved view falls back to enabled specs', () => {
        const result = computeLaunchSelection({
            specs: [spec('a1', 'A'), spec('a2', 'A', { enabled: false })],
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
            viewStore: {},
            connKey: 'local',
        });
        expect(result.selectedIds).toEqual(['a1']);
    });

    it('a host window and the local window read independent saved views (no collision)', () => {
        let store: ViewStateStore = {};
        store = writeWorkspaceView(store, 'local', 'A', { ...emptyView, visibleIds: ['a1'] });
        store = writeWorkspaceView(store, 'host-x', 'A', { ...emptyView, visibleIds: ['a2'] });
        const specs = [spec('a1', 'A'), spec('a2', 'A')];
        const common = {
            specs,
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
            viewStore: store,
        };
        expect(computeLaunchSelection({ ...common, connKey: 'local' }).selectedIds).toEqual(['a1']);
        expect(computeLaunchSelection({ ...common, connKey: 'host-x' }).selectedIds).toEqual(['a2']);
    });

    it('returns no selection when there are no workspaces (no crash)', () => {
        const result = computeLaunchSelection({
            specs: [spec('x', 'A')],
            workspaces: [],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.activeWorkspaceId).toBeNull();
        expect(result.selectedIds).toEqual([]);
    });
});

/**
 * The two owner-reported symptoms as launch-restore invariants:
 *  1. RECONNECT to a host — the client-local view is keyed by the host's STABLE
 *     `host:<hostId>` connKey (Work Mode Phase A), which does NOT change between
 *     reconnects, so a panel closed in a host window stays closed on the next
 *     reconnect (the saved view is FOUND under the same key, never re-seeded).
 *  2. LOCAL restart / upgrade — connKey is the stable `'local'` sentinel, so the
 *     `local|<ws>` view survives; closed panels stay closed.
 * Both reduce to: the saved view is found under a STABLE key and honoured over the
 * host's `enabled` default. The counter-case shows the failure mode a key CHANGE
 * would cause (why the key must be stable).
 */
describe('closed panels survive reconnect + restart (stable-connKey restore)', () => {
    // A host with three enabled specs; b was CLOSED in this window → the saved view
    // holds just [a, c] under the stable host key.
    const HOST_KEY = 'host:2f9c-uuid';
    const hostSpecs = [spec('a', 'A'), spec('b', 'A'), spec('c', 'A')];
    const savedHostView = writeWorkspaceView({}, HOST_KEY, 'A', {
        ...emptyView,
        visibleIds: ['a', 'c'],
    });

    it('a RECONNECT with the same stable host key keeps the closed panel closed', () => {
        const result = computeLaunchSelection({
            specs: hostSpecs,
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
            viewStore: savedHostView,
            connKey: HOST_KEY,
        });
        // b stays hidden even though it is still `enabled` on the host.
        expect(result.selectedIds.sort()).toEqual(['a', 'c']);
        expect(result.selectedIds).not.toContain('b');
    });

    it('a CHANGED connKey (the pre-Phase-A / unstable-key bug) loses the view → re-seeds ALL', () => {
        // If the window's connKey drifted (e.g. an old ip:port that Tailscale
        // recycled), the saved `host:<hostId>|A` entry is not found and every
        // enabled spec — including the closed b — is re-seeded. This documents WHY
        // the connKey must be the stable identity, not a mutable address.
        const result = computeLaunchSelection({
            specs: hostSpecs,
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
            viewStore: savedHostView,
            connKey: '100.64.0.7:51717', // a different key than the view was saved under
        });
        expect(result.selectedIds.sort()).toEqual(['a', 'b', 'c']);
    });

    it('a LOCAL restart/upgrade keeps the local|<ws> view (closed stays closed)', () => {
        const savedLocalView = writeWorkspaceView({}, 'local', 'A', {
            ...emptyView,
            visibleIds: ['a'],
        });
        const result = computeLaunchSelection({
            specs: [spec('a', 'A'), spec('b', 'A')],
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
            viewStore: savedLocalView,
            connKey: 'local',
        });
        expect(result.selectedIds).toEqual(['a']);
    });

    it('reloaded EXISTING specs never override the saved closed set; only the saved ids open', () => {
        // The host gains a spec `d` that was created+persisted-open earlier: it is
        // part of the saved view, so it opens. `b`/`e` are enabled but absent from
        // the saved view (closed) → they stay closed. Restore honours the view, not
        // the enabled flags — so a reload can't resurrect a closed panel.
        const store = writeWorkspaceView({}, 'local', 'A', {
            ...emptyView,
            visibleIds: ['a', 'd'],
        });
        const result = computeLaunchSelection({
            specs: [spec('a', 'A'), spec('b', 'A'), spec('d', 'A'), spec('e', 'A')],
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
            viewStore: store,
            connKey: 'local',
        });
        expect(result.selectedIds.sort()).toEqual(['a', 'd']);
    });
});

describe('effectiveWorkspaceId', () => {
    it('maps an unattached system spec to the system workspace id', () => {
        expect(
            effectiveWorkspaceId(
                { workspace_id: null, meta: { system: true } },
                SYSTEM,
            ),
        ).toBe(SYSTEM);
    });

    it('uses the stored workspace_id for normal specs', () => {
        expect(effectiveWorkspaceId({ workspace_id: 'A', meta: {} }, SYSTEM)).toBe('A');
    });

    it('leaves a null-workspace spec without the system tag null', () => {
        expect(effectiveWorkspaceId({ workspace_id: null, meta: {} }, SYSTEM)).toBeNull();
    });
});

/**
 * genie#577 — the panel cap was only ever consulted to DISABLE the Add
 * affordances (`master.tsx`'s `atMaxViews`). Nothing clamped the set the launch
 * restore produced, so a first connect for a `(connKey, workspace)` pair — which
 * every NEW REMOTE window is — opened every enabled host spec: the owner saw 6
 * panels against a cap of 4, on a grid whose Add button was already disabled.
 *
 * The cap now applies to the restored set on BOTH paths (the first-run seed and
 * a saved view whose cap was since lowered). Which panels win is deliberate and
 * DETERMINISTIC — most-recently-active first, ties broken by the workspace's own
 * panel order — so two reconnects of the same window restore the same panels.
 */
describe('max_views clamps the restored panel set (#577)', () => {
    const common = {
        workspaces: [ws('A')],
        savedActiveWorkspace: 'A',
        stageSeedWorkspace: null,
        systemWorkspaceId: SYSTEM,
    };

    it('clamps the FIRST-RUN seed to max_views (the 6-panels-against-a-cap-of-4 report)', () => {
        const result = computeLaunchSelection({
            ...common,
            specs: [
                spec('p1', 'A', { sort_order: 0 }),
                spec('p2', 'A', { sort_order: 1 }),
                spec('p3', 'A', { sort_order: 2 }),
                spec('p4', 'A', { sort_order: 3 }),
                spec('p5', 'A', { sort_order: 4 }),
                spec('p6', 'A', { sort_order: 5 }),
            ],
            viewStore: {},
            connKey: 'host:2f9c-uuid',
            maxViews: 4,
        });
        expect(result.selectedIds).toHaveLength(4);
    });

    it('keeps the MOST-RECENTLY-ACTIVE panels when the host has more than the cap', () => {
        const result = computeLaunchSelection({
            ...common,
            specs: [
                spec('stale', 'A', { sort_order: 0, last_opened_at: '2026-01-01T00:00:00.000Z' }),
                spec('newest', 'A', { sort_order: 1, last_opened_at: '2026-09-01T00:00:00.000Z' }),
                spec('never', 'A', { sort_order: 2, last_opened_at: null }),
                spec('older', 'A', { sort_order: 3, last_opened_at: '2026-06-01T00:00:00.000Z' }),
            ],
            viewStore: {},
            connKey: 'host:2f9c-uuid',
            maxViews: 2,
        });
        // A spec that has never been opened ranks BELOW every one that has.
        expect([...result.selectedIds].sort()).toEqual(['newest', 'older']);
    });

    it('breaks recency ties on the workspace panel order, so a reconnect restores the SAME panels', () => {
        // `last_opened_at` is null on every spec here — the common case, since the
        // renderer never calls `terminalSpec.touch`. The cap must still pick a
        // stable set rather than whatever order the array happened to arrive in.
        const specs = [
            spec('third', 'A', { sort_order: 2 }),
            spec('first', 'A', { sort_order: 0 }),
            spec('fourth', 'A', { sort_order: 3 }),
            spec('second', 'A', { sort_order: 1 }),
        ];
        const once = computeLaunchSelection({
            ...common, specs, viewStore: {}, connKey: 'host:x', maxViews: 2,
        });
        const twice = computeLaunchSelection({
            ...common, specs: [...specs].reverse(), viewStore: {}, connKey: 'host:x', maxViews: 2,
        });
        expect([...once.selectedIds].sort()).toEqual(['first', 'second']);
        expect([...twice.selectedIds].sort()).toEqual(['first', 'second']);
    });

    it('preserves GRID order in the clamped result — the cap drops panels, it never reorders them', () => {
        const result = computeLaunchSelection({
            ...common,
            specs: [
                spec('a', 'A', { sort_order: 0 }),
                spec('b', 'A', { sort_order: 1, last_opened_at: '2026-09-01T00:00:00.000Z' }),
                spec('c', 'A', { sort_order: 2 }),
            ],
            viewStore: {},
            connKey: 'host:x',
            maxViews: 2,
        });
        // b wins on recency and a wins the tie-break, but the result stays in the
        // order the grid lays them out.
        expect(result.selectedIds).toEqual(['a', 'b']);
    });

    it('clamps a SAVED view too — lowering the cap in Settings takes effect on the next launch', () => {
        const store = writeWorkspaceView({}, 'local', 'A', {
            ...emptyView,
            visibleIds: ['a', 'b', 'c', 'd', 'e'],
        });
        const result = computeLaunchSelection({
            ...common,
            specs: ['a', 'b', 'c', 'd', 'e'].map((id, i) => spec(id, 'A', { sort_order: i })),
            viewStore: store,
            connKey: 'local',
            maxViews: 3,
        });
        expect(result.selectedIds).toEqual(['a', 'b', 'c']);
    });

    it('process specs do not consume the cap and are never clamped away', () => {
        // The grid memo filters `type === 'process'` out, and `atMaxViews` counts
        // only what the grid draws — so the clamp has to count the same things or
        // it would silently under-fill a workspace that owns background processes.
        const result = computeLaunchSelection({
            ...common,
            specs: [
                spec('proc1', 'A', { type: 'process', sort_order: 0 }),
                spec('proc2', 'A', { type: 'process', sort_order: 1 }),
                spec('t1', 'A', { sort_order: 2 }),
                spec('t2', 'A', { sort_order: 3 }),
                spec('t3', 'A', { sort_order: 4 }),
            ],
            viewStore: {},
            connKey: 'host:x',
            maxViews: 2,
        });
        expect(result.selectedIds).toEqual(['proc1', 'proc2', 't1', 't2']);
    });

    it('the Genie OS terminal is not a grid panel, so it does not consume the cap', () => {
        const result = computeLaunchSelection({
            ...common,
            specs: [
                spec('os', 'A', { meta: { agent_id: 'genie:workstation' }, sort_order: 0 }),
                spec('t1', 'A', { sort_order: 1 }),
                spec('t2', 'A', { sort_order: 2 }),
            ],
            viewStore: {},
            connKey: 'host:x',
            maxViews: 2,
        });
        expect(result.selectedIds).toEqual(['os', 't1', 't2']);
    });

    it('an unset / nonsense cap does not clamp (a missing setting must not empty the grid)', () => {
        const specs = ['a', 'b', 'c'].map((id, i) => spec(id, 'A', { sort_order: i }));
        for (const maxViews of [undefined, 0, -1, Number.NaN]) {
            const result = computeLaunchSelection({
                ...common, specs, viewStore: {}, connKey: 'host:x', maxViews,
            });
            expect(result.selectedIds).toEqual(['a', 'b', 'c']);
        }
    });
});

/**
 * genie#579 — closed panels reopened on every remote reconnect. Closing a panel
 * hides it in the CLIENT-LOCAL view store and deliberately never clears the
 * host's `enabled` flag (panel identity is the host's; panel view state is this
 * device's). So the first-run fallback — "seed from the host's enabled specs" —
 * is not a neutral default: any connect that does not find an entry for
 * `${connKey}|${workspaceId}` resurrects EVERY panel the user ever closed.
 *
 * The fix is to make the fallback run exactly ONCE per `(connKey, workspace)`:
 * the selection now reports whether it seeded, so the caller persists that seed
 * immediately instead of waiting for the user to change something.
 */
describe('the first-run fallback runs exactly once (#579)', () => {
    const common = {
        workspaces: [ws('A')],
        savedActiveWorkspace: 'A',
        stageSeedWorkspace: null,
        systemWorkspaceId: SYSTEM,
    };
    const HOST_KEY = 'host:2f9c-uuid';

    it('reports `seeded` when it fell back to the host enabled specs', () => {
        const result = computeLaunchSelection({
            ...common,
            specs: [spec('a', 'A'), spec('b', 'A')],
            viewStore: {},
            connKey: HOST_KEY,
        });
        expect(result.seeded).toBe(true);
    });

    it('does NOT report `seeded` when a saved view was honoured', () => {
        const store = writeWorkspaceView({}, HOST_KEY, 'A', {
            ...emptyView,
            visibleIds: ['a'],
        });
        const result = computeLaunchSelection({
            ...common,
            specs: [spec('a', 'A'), spec('b', 'A')],
            viewStore: store,
            connKey: HOST_KEY,
        });
        expect(result.seeded).toBe(false);
    });

    it('an entry with an EMPTY visible set is a real preference, not an absent one', () => {
        // The user closed every panel in the workspace. That is a recorded choice
        // and must survive a reconnect — treating it as "nothing saved" would run
        // the fallback and reopen all of them.
        const store = writeWorkspaceView({}, HOST_KEY, 'A', {
            ...emptyView,
            visibleIds: [],
        });
        const result = computeLaunchSelection({
            ...common,
            specs: [spec('a', 'A'), spec('b', 'A')],
            viewStore: store,
            connKey: HOST_KEY,
        });
        expect(result.selectedIds).toEqual([]);
        expect(result.seeded).toBe(false);
    });

    it('a close survives a reconnect through the PERSISTED STRING (the whole round trip)', () => {
        const specs = [spec('a', 'A'), spec('b', 'A'), spec('c', 'A')];
        // 1. FIRST connect: nothing saved for this host key → seed from enabled.
        const first = computeLaunchSelection({
            ...common, specs, viewStore: {}, connKey: HOST_KEY,
        });
        expect(first.seeded).toBe(true);
        expect([...first.selectedIds].sort()).toEqual(['a', 'b', 'c']);

        // 2. The caller persists the seed at once (what `seeded` is FOR), then the
        //    user closes `b`. Both go through the real settings string.
        let store = writeWorkspaceView({}, HOST_KEY, 'A', {
            ...emptyView,
            visibleIds: first.selectedIds,
        });
        store = writeWorkspaceView(store, HOST_KEY, 'A', {
            ...emptyView,
            visibleIds: ['a', 'c'],
        });
        const persisted = JSON.stringify(store);

        // 3. RECONNECT: the window re-reads `view_state_json` from disk. `b` is
        //    still `enabled` on the host — it must stay closed anyway.
        const second = computeLaunchSelection({
            ...common,
            specs,
            viewStore: parseViewStateStore(persisted),
            connKey: HOST_KEY,
        });
        expect(second.seeded).toBe(false);
        expect(second.selectedIds).toEqual(['a', 'c']);
        expect(second.selectedIds).not.toContain('b');
    });
});

describe('parseMaxViews', () => {
    it('reads the stored string setting', () => {
        expect(parseMaxViews('6')).toBe(6);
    });

    it('falls back to 4 for an unset, non-numeric, zero or negative value', () => {
        for (const raw of [undefined, null, '', 'abc', '0', '-2']) {
            expect(parseMaxViews(raw)).toBe(4);
        }
    });
});
