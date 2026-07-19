import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * A remote terminal must come up at the WINDOW's grid, not the pty engine's
 * 80×24 default.
 *
 * The reported bug: a remote window rendering ~150 cols showed text hard-wrapped
 * at column 80 and a mangled status line, because the pty was never told how big
 * the viewport was. Two independent holes caused it, and this file pins both:
 *
 *  1. `create` computed cols/rows in Terminal.tsx and then DROPPED them — the
 *     spawn body carried only id/cwd/shell/args, so the host spawned at 80×24.
 *  2. The size was handed over as a fire-and-forget `resize` that raced the term
 *     socket's handshake. Passing it to `terminalAttach` instead lets main hold
 *     it and flush on `open` (see remote/index.ts `termSize`), which is what
 *     makes it stick — the renderer only re-fits on an actual size CHANGE, so
 *     nothing would ever have re-sent it.
 */
function fakeLocal(request: ReturnType<typeof vi.fn>, terminalAttach: ReturnType<typeof vi.fn>): GenieApi {
    return {
        remote: {
            request,
            terminalAttach,
            terminalInput: vi.fn(),
            terminalResize: vi.fn(),
            terminalDetach: vi.fn(),
            controlState: vi.fn().mockResolvedValue({ locked: false }),
            onControl: vi.fn(),
        },
        files: { readExternalBytes: vi.fn(), pathForFile: vi.fn() },
        workspaces: {},
        terminal: {},
        clipboard: {},
        issueWatch: {},
        settings: { get: vi.fn(), set: vi.fn() },
    } as unknown as GenieApi;
}

describe('makeRemoteBridge — remote terminal sizing', () => {
    it('sends the fitted grid in the spawn body', async () => {
        const request = vi.fn().mockResolvedValue({ existing: false });
        const attach = vi.fn().mockResolvedValue({ ok: true });
        const api = makeRemoteBridge(fakeLocal(request, attach));

        await api.terminal.create({
            id: 't1',
            cwd: '/w',
            workspaceId: 'ws-1',
            cols: 203,
            rows: 51,
        });

        const [path, init] = request.mock.calls[0];
        expect(path).toBe('/api/desktop/terminal-open');
        // Without these the host spawns at 80×24 and the TUI wraps at column 80.
        expect(init.json).toMatchObject({ id: 't1', cols: 203, rows: 51 });
    });

    it('hands the grid to attach, so main can flush it once the socket opens', async () => {
        const request = vi.fn().mockResolvedValue({ existing: false });
        const attach = vi.fn().mockResolvedValue({ ok: true });
        const api = makeRemoteBridge(fakeLocal(request, attach));

        await api.terminal.create({
            id: 't1',
            cwd: '/w',
            workspaceId: 'ws-1',
            cols: 203,
            rows: 51,
        });

        expect(attach).toHaveBeenCalledWith('t1', 'ws-1', 203, 51);
    });

    it('still attaches (with the grid) when the host has no spawn endpoint', async () => {
        // An un-upgraded host 404s /api/desktop/terminal-open. The attach-only
        // fallback must still carry the size, or a version-skewed client goes back
        // to being stuck at 80 columns.
        const request = vi.fn().mockRejectedValue(new Error('404'));
        const attach = vi.fn().mockResolvedValue({ ok: true });
        const api = makeRemoteBridge(fakeLocal(request, attach));

        const res = await api.terminal.create({
            id: 't1',
            cwd: '/w',
            workspaceId: 'ws-1',
            cols: 120,
            rows: 40,
        });

        expect(attach).toHaveBeenCalledWith('t1', 'ws-1', 120, 40);
        // Falls back to assuming the pty already existed (the pre-spawn behavior).
        expect(res.existing).toBe(true);
    });

    it('omits the grid when the caller has not fitted yet', async () => {
        const request = vi.fn().mockResolvedValue({ existing: false });
        const attach = vi.fn().mockResolvedValue({ ok: true });
        const api = makeRemoteBridge(fakeLocal(request, attach));

        await api.terminal.create({ id: 't1', cwd: '/w', workspaceId: 'ws-1' });

        expect(request.mock.calls[0][1].json.cols).toBeUndefined();
        expect(attach).toHaveBeenCalledWith('t1', 'ws-1', undefined, undefined);
    });
});
