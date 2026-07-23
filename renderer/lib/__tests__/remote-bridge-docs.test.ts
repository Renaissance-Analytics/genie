import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * genie#54 — in a remote/host window the "Workspace docs" panel must resolve
 * AGENTS.md / CLAUDE.md ON THE HOST. Before this fix the `mcp` namespace was NOT
 * bridged, so `api().mcp.docHealth/repairDocs` ran in the CLIENT's main and fed the
 * host's POSIX root (`/data/workspaces/…`) to win32 `path.*`, producing
 * `ENOENT … stat 'C:\data\workspaces\…\AGENTS.md'`. These assert the calls route to
 * the host's own doc endpoints (which resolve the path with the host's POSIX `path`).
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
        settings: { get: vi.fn(), set: vi.fn() },
        workspaces: {},
        files: {},
        terminal: {},
        clipboard: {},
        issueWatch: {},
        tynn: {},
        tynnHost: {},
        // The LOCAL mcp namespace (client's own). The bridge must OVERRIDE docHealth /
        // repairDocs to hit the host; if it falls through to these, the assertions on
        // `request` fail — which is exactly the pre-fix (red) state.
        mcp: {
            status: vi.fn(),
            restart: vi.fn(),
            docHealth: vi.fn().mockResolvedValue(null),
            repairDocs: vi.fn().mockResolvedValue(null),
            pushStatus: vi.fn(),
        },
    } as unknown as GenieApi;
}

describe('makeRemoteBridge — host-sourced workspace docs (genie#54)', () => {
    it('docHealth() reads AGENTS.md on the HOST, not the client win32 FS', async () => {
        const request = vi.fn().mockResolvedValue({ health: { agentsPresent: true } });
        const api = makeRemoteBridge(fakeLocal(request));

        expect(await api.mcp.docHealth('ws-1')).toEqual({ agentsPresent: true });
        expect(request).toHaveBeenCalledWith('/api/desktop/docs/health', {
            method: 'POST',
            json: { workspaceId: 'ws-1' },
        });
    });

    it('repairDocs() repairs AGENTS.md on the HOST', async () => {
        const request = vi
            .fn()
            .mockResolvedValue({ result: { actions: ['wrote AGENTS.md'], claudeDivergent: false } });
        const api = makeRemoteBridge(fakeLocal(request));

        expect(await api.mcp.repairDocs('ws-1')).toEqual({
            actions: ['wrote AGENTS.md'],
            claudeDivergent: false,
        });
        expect(request).toHaveBeenCalledWith('/api/desktop/docs/repair', {
            method: 'POST',
            json: { workspaceId: 'ws-1' },
        });
    });

    it('does NOT fall through to the local (client-FS) mcp doc handlers', async () => {
        const request = vi.fn().mockResolvedValue({ health: null });
        const local = fakeLocal(request);
        const api = makeRemoteBridge(local);

        await api.mcp.docHealth('ws-1');
        expect((local.mcp.docHealth as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });
});
