import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ctrl+Shift+W opens FEEDBACK for the active workspace (genie#675).
 *
 * The owner: "the Wish window that opens when you hit the ctrl+shift+w key is
 * broken. I don't think it was ever updated when we dropped wishes and moved to
 * the Feedback modal. Fix that." The global hotkey still raised the frameless
 * quick-capture window, a leftover of the Wish era with its own project guess.
 * It now brings Genie forward and asks the main window to open Feedback.
 */

const registered: Array<{ accel: string; cb: () => void }> = [];

vi.mock('electron', () => ({
    globalShortcut: {
        register: (accel: string, cb: () => void) => {
            registered.push({ accel, cb });
            return true;
        },
        unregister: () => {},
        unregisterAll: () => {},
    },
}));

vi.mock('../db', () => ({
    getAllSettings: () => ({ global_hotkey: 'Control+Shift+W' }),
}));

const openFeedbackWindow = vi.fn();
vi.mock('../background', () => ({ openFeedbackWindow: () => openFeedbackWindow() }));

describe('the global hotkey', () => {
    beforeEach(() => {
        registered.length = 0;
        openFeedbackWindow.mockClear();
    });

    it('opens Feedback in the main window', async () => {
        const { registerShortcuts } = await import('../shortcuts');
        registerShortcuts();

        expect(registered.map((r) => r.accel)).toEqual(['Control+Shift+W']);
        // Control: registering alone opens nothing.
        expect(openFeedbackWindow).not.toHaveBeenCalled();

        registered[0].cb();
        expect(openFeedbackWindow).toHaveBeenCalledTimes(1);
    });
});

describe('requestFeedback — delivering the open to the main window', () => {
    function fakeWindow(loading: boolean) {
        const sent: string[] = [];
        return {
            sent,
            win: {
                isDestroyed: () => false,
                webContents: { isLoading: () => loading, send: (ch: string) => void sent.push(ch) },
            },
        };
    }

    beforeEach(async () => {
        const { claimPendingFeedback } = await import('../feedback-open');
        claimPendingFeedback(); // start every case with nothing parked
    });

    it('sends straight to a window that is already loaded', async () => {
        const { requestFeedback, claimPendingFeedback, OPEN_FEEDBACK_CHANNEL } = await import('../feedback-open');
        const { win, sent } = fakeWindow(false);
        requestFeedback(win);
        expect(sent).toEqual([OPEN_FEEDBACK_CHANNEL]);
        // …and parks nothing, so a later mount does not open it a second time.
        expect(claimPendingFeedback()).toBe(false);
    });

    it('parks the request for a window still loading, for its page to claim once', async () => {
        const { requestFeedback, claimPendingFeedback } = await import('../feedback-open');
        const { win, sent } = fakeWindow(true);
        // A send now would reach a page with no listener yet and be lost.
        requestFeedback(win);
        expect(sent).toEqual([]);
        expect(claimPendingFeedback()).toBe(true);
        expect(claimPendingFeedback()).toBe(false);
    });

    it('does nothing without a window (a headless host has none)', async () => {
        const { requestFeedback, claimPendingFeedback } = await import('../feedback-open');
        requestFeedback(null);
        expect(claimPendingFeedback()).toBe(false);
    });
});

describe('the retired quick-capture window', () => {
    const repo = path.resolve(__dirname, '..', '..');

    it('is gone: no page, no window, no project guess', () => {
        // Positive control: the neighbouring pages exist, so a missing file below
        // means removed rather than a wrong path.
        expect(fs.existsSync(path.join(repo, 'renderer/pages/settings.tsx'))).toBe(true);
        expect(fs.existsSync(path.join(repo, 'renderer/pages/capture.tsx'))).toBe(false);
        expect(fs.existsSync(path.join(repo, 'main/workspace/last-opened.ts'))).toBe(false);

        const background = fs.readFileSync(path.join(repo, 'main/background.ts'), 'utf8');
        expect(background).toContain('export function showMasterWindow');
        expect(background).not.toMatch(/CaptureWindow|capture\.html|app:get-current-project/);
    });
});
