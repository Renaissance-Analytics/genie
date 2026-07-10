import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi, Settings } from '../genie';

/**
 * In a remote/host window `api()` is the remote bridge. This asserts its
 * host-sourced WORKSPACE / AGENT-ENVIRONMENT settings: the bucket-2 keys (Ai.System,
 * the Agent-MCP config, the host terminal toolkit env) are read from + written to the
 * HOST via `/api/desktop/settings`, while every other key stays CLIENT-LOCAL. The
 * agent runs on the host, so those settings must reflect the host, not this device.
 */
function fakeLocal(
    request: ReturnType<typeof vi.fn>,
    settings: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> },
): GenieApi {
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
        settings: {
            ...settings,
            chooseFolder: vi.fn(),
            chooseFile: vi.fn(),
            soundDataUrl: vi.fn(),
            detectShells: vi.fn(),
        },
        // Namespaces the bridge spreads/rebuilds at construction (empty is fine).
        workspaces: {},
        files: {},
        terminal: {},
        clipboard: {},
        issueWatch: {},
    } as unknown as GenieApi;
}

describe('makeRemoteBridge — host-sourced settings', () => {
    it('get() overlays the host bucket-2 values on the client-local settings', async () => {
        const request = vi.fn();
        const get = vi.fn().mockResolvedValue({
            notify_sound: 'on', // device-local
            terminal_copy_paste: 'winmac', // device-local
            ai_system: 'CLIENT-STALE', // client's own copy — must be overridden
        } as Partial<Settings>);
        const set = vi.fn();
        const api = makeRemoteBridge(fakeLocal(request, { get, set }));

        request.mockResolvedValueOnce({
            settings: { ai_system: 'HOST', mcp_port: '52000', mcp_sync_claude: 'off', mcp_sync_codex: 'on' },
        });
        const merged = await api.settings.get();

        expect(request).toHaveBeenCalledWith('/api/desktop/settings');
        // Device prefs stay local; host bucket-2 overlays (ai_system → host value).
        expect(merged).toMatchObject({
            notify_sound: 'on',
            terminal_copy_paste: 'winmac',
            ai_system: 'HOST',
            mcp_port: '52000',
            mcp_sync_claude: 'off',
            mcp_sync_codex: 'on',
        });
    });

    it('get() falls back to the local view when the host read fails', async () => {
        const request = vi.fn().mockRejectedValue(new Error('link down'));
        const get = vi.fn().mockResolvedValue({ notify_sound: 'off', ai_system: 'LOCAL' });
        const api = makeRemoteBridge(fakeLocal(request, { get, set: vi.fn() }));
        expect(await api.settings.get()).toEqual({ notify_sound: 'off', ai_system: 'LOCAL' });
    });

    it('set() splits the patch: host keys → the host, device keys → local', async () => {
        const request = vi.fn();
        const get = vi.fn();
        const set = vi.fn().mockResolvedValue({ notify_sound: 'on' } as Partial<Settings>);
        const api = makeRemoteBridge(fakeLocal(request, { get, set }));

        request.mockResolvedValueOnce({
            settings: { ai_system: 'NEW', mcp_port: '52000', mcp_sync_codex: 'off', mcp_sync_agents: 'off' },
        });

        const result = await api.settings.set({
            // Host-sourced (bucket 2):
            ai_system: 'NEW',
            mcp_port: '52000',
            mcp_sync_codex: 'off',
            mcp_sync_agents: 'off',
            // Device-local:
            notify_sound: 'on',
            terminal_copy_paste: 'linux',
        } as Partial<Settings>);

        // Host keys POSTed to the host, allow-listed subset only.
        expect(request).toHaveBeenCalledWith('/api/desktop/settings', {
            method: 'POST',
            json: {
                patch: { ai_system: 'NEW', mcp_port: '52000', mcp_sync_codex: 'off', mcp_sync_agents: 'off' },
            },
        });
        // Device keys written locally — NEVER the host keys.
        expect(set).toHaveBeenCalledWith({
            notify_sound: 'on',
            terminal_copy_paste: 'linux',
        });
        // Returned Settings merges the local result + fresh host values.
        expect(result).toMatchObject({
            notify_sound: 'on',
            ai_system: 'NEW',
            mcp_port: '52000',
            mcp_sync_codex: 'off',
            mcp_sync_agents: 'off',
        });
    });

    it('set() with only device keys writes locally and does not POST a patch', async () => {
        const request = vi.fn().mockResolvedValue({ settings: { ai_system: 'HOST' } });
        const set = vi.fn().mockResolvedValue({ notify_toast: 'on' });
        const api = makeRemoteBridge(fakeLocal(request, { get: vi.fn(), set }));

        await api.settings.set({ notify_toast: 'on' } as Partial<Settings>);

        expect(set).toHaveBeenCalledWith({ notify_toast: 'on' });
        // No POST — the host is only GET-read to keep the returned host values fresh.
        expect(request).toHaveBeenCalledWith('/api/desktop/settings');
        expect(request).not.toHaveBeenCalledWith(
            '/api/desktop/settings',
            expect.objectContaining({ method: 'POST' }),
        );
    });
});
