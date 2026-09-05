import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * In a remote/host window the workspace-settings "Tynn agent" panel must act on the
 * HOST: the workspace files, the running agent, and the user's Tynn session all live
 * there. This asserts the bridge routes projects / status / link / provision / unlink
 * / tynn-host through `/api/desktop/tynn/*` rather than the client's own (empty) local
 * IPC — running them locally minted against the wrong session and wrote to a client
 * path that doesn't exist, which is exactly why remote "Link & provision" did nothing.
 */
function fakeLocal(request: ReturnType<typeof vi.fn>): GenieApi {
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
        // Namespaces the bridge spreads/rebuilds at construction (empty is fine).
        settings: { get: vi.fn(), set: vi.fn() },
        workspaces: {},
        files: {},
        terminal: {},
        clipboard: {},
        issueWatch: {},
        tynn: {},
        tynnHost: {},
    } as unknown as GenieApi;
}

describe('makeRemoteBridge — host-sourced Tynn provisioning', () => {
    it('projects() reads the HOST projects (the picker must offer the host account)', async () => {
        const request = vi
            .fn()
            .mockResolvedValue({ projects: [{ id: 'p1', name: 'Alpha', slug: 'alpha' }] });
        const api = makeRemoteBridge(fakeLocal(request));
        expect(await api.tynn.projects()).toEqual([{ id: 'p1', name: 'Alpha', slug: 'alpha' }]);
        expect(request).toHaveBeenCalledWith('/api/desktop/tynn/projects');
    });

    it('provisionStatus() reads the host status for the workspace path', async () => {
        const request = vi.fn().mockResolvedValue({ status: 'already', link: { project: 'alpha' } });
        const api = makeRemoteBridge(fakeLocal(request));
        expect(await api.tynn.provisionStatus('/host/ws')).toEqual({
            status: 'already',
            link: { project: 'alpha' },
        });
        expect(request).toHaveBeenCalledWith('/api/desktop/tynn/status', {
            method: 'POST',
            json: { workspacePath: '/host/ws' },
        });
    });

    it('link() writes the link block on the host', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true });
        const api = makeRemoteBridge(fakeLocal(request));
        const link = { host: 'https://tynn.ai', owner: 'me', project: 'alpha', projectId: 'p1' };
        expect(await api.tynn.link('/host/ws', link)).toEqual({ ok: true });
        expect(request).toHaveBeenCalledWith('/api/desktop/tynn/link', {
            method: 'POST',
            json: { workspacePath: '/host/ws', link },
        });
    });

    it('provision() mints the token + writes .mcp.json on the host', async () => {
        const request = vi
            .fn()
            .mockResolvedValue({ status: 'provision', agent: { id: 'a1', name: 'Genie' } });
        const api = makeRemoteBridge(fakeLocal(request));
        expect(await api.tynn.provision('/host/ws', true)).toMatchObject({ status: 'provision' });
        expect(request).toHaveBeenCalledWith('/api/desktop/tynn/provision', {
            method: 'POST',
            json: { workspacePath: '/host/ws', force: true },
        });
    });

    it('unlink() clears the link on the host', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true });
        const api = makeRemoteBridge(fakeLocal(request));
        expect(await api.tynn.unlink('/host/ws')).toEqual({ ok: true });
        expect(request).toHaveBeenCalledWith('/api/desktop/tynn/unlink', {
            method: 'POST',
            json: { workspacePath: '/host/ws' },
        });
    });

    it('health() probes the HOST endpoint — a local probe would report the wrong machine', async () => {
        // Left spread-from-local this would read the CLIENT's filesystem for a
        // host workspace path that does not exist there, and confidently paint
        // a healthy workspace as "no Tynn server configured".
        const request = vi.fn().mockResolvedValue({ state: 'healthy', workspaceId: 'w1' });
        const api = makeRemoteBridge(fakeLocal(request));
        expect(await api.tynn.health('w1', '/host/ws', 'Alpha')).toMatchObject({
            state: 'healthy',
        });
        expect(request).toHaveBeenCalledWith('/api/desktop/tynn/health', {
            method: 'POST',
            json: { workspacePath: '/host/ws' },
        });
    });

    it('healthAll() reports an empty warm cache rather than the CLIENT\'s probes', async () => {
        const request = vi.fn();
        const api = makeRemoteBridge(fakeLocal(request));
        expect(await api.tynn.healthAll()).toEqual({});
        expect(request).not.toHaveBeenCalled();
    });

    it('tynnHost.get() reads the host tynn base (the link block references the host)', async () => {
        const request = vi.fn().mockResolvedValue({ host: 'https://tynn.ai' });
        const api = makeRemoteBridge(fakeLocal(request));
        expect(await api.tynnHost.get()).toBe('https://tynn.ai');
        expect(request).toHaveBeenCalledWith('/api/desktop/tynn/host');
    });

    it('leaves the OTHER tynn.* methods spread-from-local (only the panel routes host)', () => {
        const request = vi.fn();
        const local = fakeLocal(request);
        (local.tynn as unknown as { inbox: () => void }).inbox = vi.fn();
        const api = makeRemoteBridge(local);
        // inbox/capture-issue/ops-* were not overridden — they stay the local impl.
        expect(api.tynn.inbox).toBe((local.tynn as unknown as { inbox: unknown }).inbox);
    });
});
