import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * In a remote/host window `api()` is the remote bridge. This asserts its
 * host-sourced IssueWatch: every issueWatch method routes to the host's
 * `/api/desktop/issue-watch/*` endpoints (via the local-main proxy `remote.request`)
 * instead of the client-local IPC — so a host window's rail pill / flyout / badge
 * reflect the HOST's repos + counts.
 */
function fakeLocal(request: ReturnType<typeof vi.fn>): GenieApi {
    return {
        remote: {
            request,
            terminalAttach: vi.fn(),
            terminalInput: vi.fn(),
            terminalResize: vi.fn(),
            terminalDetach: vi.fn(),
        },
        // Namespaces the bridge spreads/rebuilds at construction (empty is fine).
        workspaces: {},
        files: {},
        terminal: {},
        clipboard: {},
        issueWatch: {},
    } as unknown as GenieApi;
}

describe('makeRemoteBridge — host-sourced IssueWatch', () => {
    it('routes every issueWatch method to /api/desktop/issue-watch/*', async () => {
        const request = vi.fn();
        const api = makeRemoteBridge(fakeLocal(request));

        request.mockResolvedValueOnce({ counts: { w1: { issue: 1, pr: 0, security: 2 } } });
        expect(await api.issueWatch.counts()).toEqual({ w1: { issue: 1, pr: 0, security: 2 } });
        expect(request).toHaveBeenLastCalledWith('/api/desktop/issue-watch/counts');

        request.mockResolvedValueOnce({ repos: [{ owner: 'o', repo: 'r' }] });
        await api.issueWatch.repos('w1');
        expect(request).toHaveBeenLastCalledWith('/api/desktop/issue-watch/repos?workspaceId=w1');

        request.mockResolvedValueOnce({ feed: [] });
        await api.issueWatch.feed('w 1'); // a space must be URL-encoded in the query
        expect(request).toHaveBeenLastCalledWith(
            '/api/desktop/issue-watch/feed?workspaceId=w%201',
        );

        request.mockResolvedValueOnce({ status: { connected: true } });
        await api.issueWatch.status('w1');
        expect(request).toHaveBeenLastCalledWith('/api/desktop/issue-watch/status?workspaceId=w1');

        request.mockResolvedValueOnce({ ok: true });
        await api.issueWatch.markSeen('w1');
        expect(request).toHaveBeenLastCalledWith('/api/desktop/issue-watch/mark-seen', {
            method: 'POST',
            json: { workspaceId: 'w1' },
        });

        request.mockResolvedValueOnce({ ok: true });
        await api.issueWatch.set('w1', 'o', 'r', false);
        expect(request).toHaveBeenLastCalledWith('/api/desktop/issue-watch/set', {
            method: 'POST',
            json: { workspaceId: 'w1', owner: 'o', repo: 'r', enabled: false },
        });
    });

    it('returns the unwrapped payloads (counts/repos/feed/status)', async () => {
        const request = vi.fn();
        const api = makeRemoteBridge(fakeLocal(request));
        request.mockResolvedValueOnce({ repos: [{ owner: 'a', repo: 'b', enabled: true }] });
        expect(await api.issueWatch.repos('w1')).toEqual([{ owner: 'a', repo: 'b', enabled: true }]);
        request.mockResolvedValueOnce({ feed: [{ key: 'k' }] });
        expect(await api.issueWatch.feed('w1')).toEqual([{ key: 'k' }]);
        request.mockResolvedValueOnce({ status: { connected: false } });
        expect(await api.issueWatch.status('w1')).toEqual({ connected: false });
    });

    it('passes the host status through verbatim, including the GitHub gate state', async () => {
        // The bug: a host window falsely showed the CLIENT's unauthed GitHub gate.
        // The fix host-sources the whole gate state through issueWatch.status —
        // connected / needsReauth AND the host App's missing IW capabilities — so
        // the flyout gates on the HOST. Assert the bridge forwards it untouched.
        const request = vi.fn();
        const api = makeRemoteBridge(fakeLocal(request));
        const hostStatus = {
            connected: true,
            error: null,
            detail: null,
            needsReauth: false,
            missingCapabilities: ['issue-watch.dependabot'],
        };
        request.mockResolvedValueOnce({ status: hostStatus });
        expect(await api.issueWatch.status('w1')).toEqual(hostStatus);
        expect(request).toHaveBeenLastCalledWith(
            '/api/desktop/issue-watch/status?workspaceId=w1',
        );
    });
});
