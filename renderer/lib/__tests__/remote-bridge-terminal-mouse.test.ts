import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * A remote session must never push mouse CLICKS/DRAGS into the host terminal
 * (a remote viewer clicking something in the host's TUI would be surprising
 * and wrong) — but wheel/trackpad SCROLL is exactly what the remote user is
 * asking for. When the host program (tmux, vim, htop, `less -M`) has mouse-
 * tracking on, xterm reports EVERY mouse event (click AND wheel) as an escape
 * sequence via `terminal.write`, and xterm itself stops doing client-side
 * scrollback while tracking is on — so blindly stripping every mouse report
 * (the pre-fix behaviour) left remote scrolling completely dead. See
 * remote-bridge.ts's `isBlockedMouseReport`.
 */
function fakeLocal(terminalInput: ReturnType<typeof vi.fn>): GenieApi {
    return {
        remote: {
            request: vi.fn(),
            terminalAttach: vi.fn(),
            terminalInput,
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

describe('makeRemoteBridge — terminal mouse-report filtering', () => {
    it('forwards a plain keystroke untouched', async () => {
        const terminalInput = vi.fn().mockResolvedValue(true);
        const api = makeRemoteBridge(fakeLocal(terminalInput));

        await api.terminal.write('t1', 'ls -la\r');

        expect(terminalInput).toHaveBeenCalledWith('t1', 'ls -la\r');
    });

    it('forwards an SGR wheel-up report (button 64) — the reported bug', async () => {
        const terminalInput = vi.fn().mockResolvedValue(true);
        const api = makeRemoteBridge(fakeLocal(terminalInput));

        const wheelUp = '\x1b[<64;12;5M';
        await api.terminal.write('t1', wheelUp);

        expect(terminalInput).toHaveBeenCalledWith('t1', wheelUp);
    });

    it('forwards an SGR wheel-down report (button 65)', async () => {
        const terminalInput = vi.fn().mockResolvedValue(true);
        const api = makeRemoteBridge(fakeLocal(terminalInput));

        const wheelDown = '\x1b[<65;12;5M';
        await api.terminal.write('t1', wheelDown);

        expect(terminalInput).toHaveBeenCalledWith('t1', wheelDown);
    });

    it('forwards a modified wheel report (shift+wheel-up, button 68) — still ≥ 64', async () => {
        const terminalInput = vi.fn().mockResolvedValue(true);
        const api = makeRemoteBridge(fakeLocal(terminalInput));

        const shiftWheelUp = '\x1b[<68;12;5M';
        await api.terminal.write('t1', shiftWheelUp);

        expect(terminalInput).toHaveBeenCalledWith('t1', shiftWheelUp);
    });

    it('blocks an SGR left-click press (button 0)', async () => {
        const terminalInput = vi.fn().mockResolvedValue(true);
        const api = makeRemoteBridge(fakeLocal(terminalInput));

        await api.terminal.write('t1', '\x1b[<0;12;5M');

        expect(terminalInput).toHaveBeenCalledWith('t1', '');
    });

    it('blocks an SGR release (button 3) and a ctrl-modified click (button 19)', async () => {
        const terminalInput = vi.fn().mockResolvedValue(true);
        const api = makeRemoteBridge(fakeLocal(terminalInput));

        await api.terminal.write('t1', '\x1b[<3;12;5m');
        await api.terminal.write('t1', '\x1b[<19;12;5M');

        expect(terminalInput).toHaveBeenNthCalledWith(1, 't1', '');
        expect(terminalInput).toHaveBeenNthCalledWith(2, 't1', '');
    });

    it('blocks a legacy X10 mouse report (CSI M...) unconditionally', async () => {
        const terminalInput = vi.fn().mockResolvedValue(true);
        const api = makeRemoteBridge(fakeLocal(terminalInput));

        await api.terminal.write('t1', '\x1b[M !!');

        expect(terminalInput).toHaveBeenCalledWith('t1', '');
    });

    it('swallows everything locally (no host call) once view-only control-lock is active', async () => {
        const terminalInput = vi.fn().mockResolvedValue(true);
        const local = fakeLocal(terminalInput);
        (local.remote.controlState as ReturnType<typeof vi.fn>).mockResolvedValue({ locked: true });
        const api = makeRemoteBridge(local);
        await Promise.resolve(); // flush the controlState().then(...) microtask

        const result = await api.terminal.write('t1', '\x1b[<64;12;5M');

        expect(result).toBe(false);
        expect(terminalInput).not.toHaveBeenCalled();
    });
});
