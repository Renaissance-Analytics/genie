import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * In a remote/host window `api()` is the remote bridge. This asserts FULL Hosting-
 * Manager parity: `devServer.site` / `.service` / `.runtimeStatus` / `.repos` route
 * to the host's `/api/desktop/dev-server/*` endpoints (via the local-main proxy
 * `remote.request`) instead of the local-only stubs — so a host window can drive
 * the HOST's sites + services, not just view the `.gen` popover.
 *
 * The one call that STAYS local is `open`: opening a `.gen` site is a Testing
 * Browser WINDOW on THIS client pointed at the host's carrier, never a browser on
 * the host. The bridge resolves the site's genName from the host, then opens
 * locally.
 */
function fakeLocal(request: ReturnType<typeof vi.fn>, open?: ReturnType<typeof vi.fn>): GenieApi {
    return {
        remote: {
            request,
            terminalAttach: vi.fn(),
            terminalInput: vi.fn(),
            terminalResize: vi.fn(),
            terminalDetach: vi.fn(),
            controlState: vi.fn().mockResolvedValue({ locked: false }),
            onControl: vi.fn(),
        },
        // Namespaces the bridge spreads/rebuilds at construction.
        workspaces: {},
        files: {},
        terminal: {},
        clipboard: {},
        issueWatch: {},
        sites: { open: open ?? vi.fn() },
        devServer: {},
    } as unknown as GenieApi;
}

describe('makeRemoteBridge — host-sourced Hosting Manager', () => {
    it('routes site/service/runtime/repos to /api/desktop/dev-server/*', async () => {
        const request = vi.fn();
        const api = makeRemoteBridge(fakeLocal(request));

        request.mockResolvedValueOnce({ ok: true, sites: [{ id: 's1' }], runtime: { kind: 'docker' } });
        const listed = await api.devServer.site('w1', { action: 'list' });
        expect(listed).toEqual({ ok: true, sites: [{ id: 's1' }], runtime: { kind: 'docker' } });
        expect(request).toHaveBeenLastCalledWith('/api/desktop/dev-server/site', {
            method: 'POST',
            json: { workspaceId: 'w1', req: { action: 'list' } },
        });

        request.mockResolvedValueOnce({
            ok: true,
            services: [],
            catalog: [{ engine: 'postgres' }],
            runtime: { kind: 'docker' },
        });
        await api.devServer.service('w1', { action: 'catalog' });
        expect(request).toHaveBeenLastCalledWith('/api/desktop/dev-server/service', {
            method: 'POST',
            json: { workspaceId: 'w1', req: { action: 'catalog' } },
        });

        request.mockResolvedValueOnce({ runtime: { kind: 'podman', version: '5' } });
        expect(await api.devServer.runtimeStatus()).toEqual({ kind: 'podman', version: '5' });
        expect(request).toHaveBeenLastCalledWith('/api/desktop/dev-server/runtime');

        request.mockResolvedValueOnce({ repos: ['api', 'web'] });
        expect(await api.devServer.repos('w1')).toEqual(['api', 'web']);
        expect(request).toHaveBeenLastCalledWith('/api/desktop/dev-server/repos', {
            method: 'POST',
            json: { workspaceId: 'w1' },
        });
    });

    it('forwards a WRITE (create) verbatim to the host site endpoint', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, sites: [], runtime: { kind: 'docker' } });
        const api = makeRemoteBridge(fakeLocal(request));
        await api.devServer.site('w1', { action: 'create', name: 'web', port: 8000 });
        expect(request).toHaveBeenLastCalledWith('/api/desktop/dev-server/site', {
            method: 'POST',
            json: { workspaceId: 'w1', req: { action: 'create', name: 'web', port: 8000 } },
        });
    });

    it('opens a `.gen` site LOCALLY (never on the host): resolves genName, then local.sites.open', async () => {
        const request = vi.fn();
        const open = vi.fn().mockResolvedValue({ ok: true });
        const api = makeRemoteBridge(fakeLocal(request, open));

        // The bridge fetches the host site list to resolve the genName…
        request.mockResolvedValueOnce({
            ok: true,
            sites: [{ id: 's1', genName: 'web.acme.gen' }],
            runtime: { kind: 'docker' },
        });
        const r = await api.devServer.site('w1', { action: 'open', id: 's1' });

        // …asks the host to LIST (never to `open`)…
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith('/api/desktop/dev-server/site', {
            method: 'POST',
            json: { workspaceId: 'w1', req: { action: 'list' } },
        });
        // …and opens the Testing Browser on THIS client.
        expect(open).toHaveBeenCalledWith('web.acme.gen');
        expect(r.ok).toBe(true);
        expect(r.affectedId).toBe('s1');
    });
});
