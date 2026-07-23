import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * genie#54 (second half) — clicking a `.md` file in a remote window opens it as a
 * PLUGIN tab (the Document plugin claims `.md`), whose read/write bridge
 * (`plugins.editorRead`/`editorWrite`) resolves the file. `plugins` was NOT among
 * the bridged namespaces, so it fell through to the CLIENT's main and fed the host's
 * POSIX root (`/data/workspaces/…`) to win32 `path.resolve` + `fsp.stat` →
 * `ENOENT … stat 'C:\data\…\AGENTS.md'`. These assert the binary I/O routes to the
 * host (which resolves with its own POSIX `path`), while `editorFor` — which editor
 * to use — stays a CLIENT-registry decision.
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
        mcp: {},
        plugins: {
            editorRead: vi.fn().mockResolvedValue({ ok: false }),
            editorWrite: vi.fn().mockResolvedValue({ ok: false }),
            editorFor: vi.fn().mockResolvedValue(null),
        },
    } as unknown as GenieApi;
}

describe('makeRemoteBridge — host-sourced plugin editor I/O (genie#54)', () => {
    it('editorRead() reads the plugin file on the HOST, not the client win32 FS', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true, base64: 'aGk=' });
        const api = makeRemoteBridge(fakeLocal(request));

        expect(await api.plugins.editorRead('ai.genie.document', '/data/ws', 'AGENTS.md')).toEqual({
            ok: true,
            base64: 'aGk=',
        });
        expect(request).toHaveBeenCalledWith('/api/plugins/editor-read', {
            method: 'POST',
            json: { pluginId: 'ai.genie.document', root: '/data/ws', relPath: 'AGENTS.md' },
        });
    });

    it('editorWrite() writes the plugin file on the HOST', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true });
        const api = makeRemoteBridge(fakeLocal(request));

        expect(
            await api.plugins.editorWrite('ai.genie.document', '/data/ws', 'AGENTS.md', 'aGk='),
        ).toEqual({ ok: true });
        expect(request).toHaveBeenCalledWith('/api/plugins/editor-write', {
            method: 'POST',
            json: {
                pluginId: 'ai.genie.document',
                root: '/data/ws',
                relPath: 'AGENTS.md',
                base64: 'aGk=',
            },
        });
    });

    it('editorFor() stays LOCAL — which editor to use is the client registry decision', async () => {
        const request = vi.fn();
        const local = fakeLocal(request);
        const api = makeRemoteBridge(local);

        await api.plugins.editorFor('AGENTS.md');
        expect(local.plugins.editorFor as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('AGENTS.md');
        expect(request).not.toHaveBeenCalled();
    });
});
