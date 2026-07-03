import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * In a remote/host window `api()` is the remote bridge. Internal file ops
 * (read/write/rename/…) re-point to HOST endpoints — so an internal MOVE already
 * works remote (rename is bridged). This asserts the EXTERNAL-file-drop path: the
 * dropped file lives on the CLIENT's disk, so `importExternal` must read the bytes
 * LOCALLY (via the client's own `files.readExternalBytes`) and POST them to the
 * host's `/api/files/import-external`, rather than calling a local importer with
 * the host's workspace path (which would hit the wrong machine).
 */
function fakeLocal(
    request: ReturnType<typeof vi.fn>,
    readExternalBytes: ReturnType<typeof vi.fn>,
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
        // pathForFile stays LOCAL (spread) and readExternalBytes is the client-side
        // local read the override relies on.
        files: {
            readExternalBytes,
            pathForFile: vi.fn(),
        },
        // Namespaces the bridge spreads/rebuilds at construction (empty is fine).
        workspaces: {},
        terminal: {},
        clipboard: {},
        issueWatch: {},
        settings: { get: vi.fn(), set: vi.fn() },
    } as unknown as GenieApi;
}

describe('makeRemoteBridge — external-file drop (importExternal)', () => {
    it('reads the CLIENT-local bytes and POSTs them to the host import endpoint', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, relPath: 'assets/logo.png' });
        const readExternalBytes = vi
            .fn()
            .mockResolvedValue({ name: 'logo.png', base64: 'UE5H' });
        const api = makeRemoteBridge(fakeLocal(request, readExternalBytes));

        const result = await api.files.importExternal(
            '/host/ws',
            'C:/Users/me/Downloads/logo.png', // a CLIENT-local absolute path
            'assets',
        );

        // The client read its OWN local file (never the host).
        expect(readExternalBytes).toHaveBeenCalledWith('C:/Users/me/Downloads/logo.png');
        // The bytes + dest were POSTed to the host, keyed by the host workspace path.
        expect(request).toHaveBeenCalledWith('/api/files/import-external', {
            method: 'POST',
            json: {
                workspacePath: '/host/ws',
                destFolder: 'assets',
                filename: 'logo.png',
                dataBase64: 'UE5H',
            },
        });
        // The host's result is returned verbatim.
        expect(result).toEqual({ ok: true, relPath: 'assets/logo.png' });
    });

    it('propagates a local read failure without POSTing to the host', async () => {
        const request = vi.fn();
        const readExternalBytes = vi
            .fn()
            .mockRejectedValue(new Error('Folder drops are not supported over a remote link'));
        const api = makeRemoteBridge(fakeLocal(request, readExternalBytes));

        await expect(
            api.files.importExternal('/host/ws', '/client/some/dir', ''),
        ).rejects.toThrow(/Folder drops are not supported/);
        expect(request).not.toHaveBeenCalled();
    });
});
