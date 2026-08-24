import { describe, expect, it, vi } from 'vitest';

/**
 * Forcing a workspace's IssueWatch feed to refresh, from Genie.
 *
 * Tynn owns the rate limit — one 5-minute window per WORKSPACE, shared by every
 * agent and the human — so this side deliberately holds NO counter of its own. It
 * resolves which Tynn project the local workspace is, asks, applies whatever
 * snapshot comes back, and passes the cooldown through untouched. A second
 * limiter here would be a second answer to "when may I refresh", and the two
 * would drift the moment a different Genie window (or the flyout) spent the
 * window first.
 *
 * The three outcomes each have to survive the trip intact:
 *   - refreshed: the snapshot is applied and the cooldown says 5 minutes;
 *   - refused: NOT an error — the current snapshot still applies, and the
 *     cooldown says what is actually left;
 *   - unreachable: reported as a failure, never as a refresh that happened.
 */

import { forceRefreshWorkspace, type TynnRefreshResponse } from '../force-refresh';

const LINKED = {
    id: 'ws-local',
    backend: 'tynn',
    path: '/ws/demo.agi',
    tynn_project_id: 'tynn-project-9',
    tynn_project_name: 'Demo',
};

function tynnAnswer(over: Partial<TynnRefreshResponse> = {}): TynnRefreshResponse {
    return {
        refreshed: true,
        reason: 'refreshed',
        error: null,
        cooldown: { seconds: 300, nextAllowedAt: '2026-08-24T10:05:00+00:00', label: '5m' },
        workspace: {
            workspaceId: 'tynn-project-9',
            counts: { issue: 2, pr: 0, security: 0, feedback: 0 },
            items: [],
        },
        ...over,
    };
}

describe('forceRefreshWorkspace', () => {
    it('asks Tynn for the workspace by its TYNN PROJECT id, not the local one', async () => {
        const requestRefresh = vi.fn().mockResolvedValue(tynnAnswer());

        await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => LINKED,
            requestRefresh,
            applyDelta: () => {},
        });

        // Tynn keys IssueWatch by PROJECT; a locally scaffolded envelope mints its
        // own workspace id and records the link in project.json, so sending the
        // local id would ask Tynn to refresh a project that does not exist.
        expect(requestRefresh).toHaveBeenCalledWith('tynn-project-9');
    });

    it('falls back to the workspace id when no explicit link is recorded', async () => {
        const requestRefresh = vi.fn().mockResolvedValue(tynnAnswer());

        await forceRefreshWorkspace('ws-local', {
            // No project.json link and no row link: the Add-workspace flow uses
            // `id := project.id`, so the workspace id IS the project id.
            workspaceRow: () => ({ ...LINKED, tynn_project_id: null, tynn_project_name: null }),
            resolveLink: () => null,
            requestRefresh,
            applyDelta: () => {},
        });

        expect(requestRefresh).toHaveBeenCalledWith('ws-local');
    });

    it('applies the refreshed snapshot and passes the cooldown through', async () => {
        const applyDelta = vi.fn();

        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => LINKED,
            requestRefresh: async () => tynnAnswer(),
            applyDelta,
        });

        expect(applyDelta).toHaveBeenCalledTimes(1);
        expect(applyDelta.mock.calls[0][0]).toMatchObject({
            workspaceId: 'tynn-project-9',
            counts: { issue: 2 },
        });
        expect(result).toMatchObject({
            refreshed: true,
            reason: 'refreshed',
            cooldown: { seconds: 300, label: '5m' },
        });
    });

    it('treats a REFUSED refresh as a normal answer — snapshot applied, cooldown reported, no throw', async () => {
        const applyDelta = vi.fn();

        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => LINKED,
            requestRefresh: async () =>
                tynnAnswer({
                    refreshed: false,
                    reason: 'cooldown',
                    cooldown: { seconds: 192, nextAllowedAt: '2026-08-24T10:03:12+00:00', label: '3m 12s' },
                }),
            applyDelta,
        });

        // Another agent (or the human) already spent this workspace's window.
        // Asking was not a mistake, so the caller still gets real state.
        expect(applyDelta).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            refreshed: false,
            reason: 'cooldown',
            cooldown: { seconds: 192, label: '3m 12s' },
        });
        expect(result.error).toBeUndefined();
    });

    it('reports a failed request as a failure — never as a refresh that happened', async () => {
        const applyDelta = vi.fn();

        const result = await forceRefreshWorkspace('ws-local', {
            workspaceRow: () => LINKED,
            requestRefresh: async () => {
                throw new Error('Tynn POST /api/v1/user/issue-watch/refresh → 503');
            },
            applyDelta,
        });

        expect(result.refreshed).toBe(false);
        expect(result.reason).toBe('failed');
        expect(result.error).toContain('503');
        // Nothing came back, so nothing may be written over the feed — a
        // fabricated empty snapshot would wipe real issues from the panel.
        expect(applyDelta).not.toHaveBeenCalled();
        // Tynn never charged the window for a request it did not serve, so the
        // caller is free to try again immediately.
        expect(result.cooldown.seconds).toBe(0);
    });

    it('reports an unknown workspace instead of asking Tynn to refresh nothing', async () => {
        const requestRefresh = vi.fn();

        const result = await forceRefreshWorkspace('ws-nope', {
            workspaceRow: () => null,
            requestRefresh,
            applyDelta: () => {},
        });

        expect(requestRefresh).not.toHaveBeenCalled();
        expect(result).toMatchObject({ refreshed: false, reason: 'unavailable' });
        expect(result.cooldown.seconds).toBe(0);
    });
});
