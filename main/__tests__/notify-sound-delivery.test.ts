import { describe, it, expect, vi } from 'vitest';
import {
    planAlertSoundDelivery,
    deliverAlertSound,
    type AlertSoundWindow,
} from '../notify-sound';

/**
 * Tests the alert-sound DELIVERY decision — the genuine startup-readiness fix.
 *
 * The chime is a one-shot `notify:sound` IPC and ONLY the master renderer
 * subscribes. Before the fix it was sent immediately to `getAllWindows()[0]`,
 * so it was dropped when (a) the targeted window wasn't the master, or (b) the
 * master window existed but its renderer was still loading (a cold launch or an
 * upgrade-restart) — which is exactly why a freshly-upgraded Genie "stopped"
 * playing sounds until a window was up. The fix targets the master window and
 * defers to did-finish-load while it's loading.
 */

/** A fake BrowserWindow matching the structural AlertSoundWindow slice. */
function fakeWin(opts: { destroyed?: boolean; loading?: boolean } = {}): {
    win: AlertSoundWindow;
    send: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    fireLoaded: () => void;
    setDestroyed: (v: boolean) => void;
} {
    let destroyed = !!opts.destroyed;
    const loadedCbs: Array<() => void> = [];
    const send = vi.fn();
    const once = vi.fn((_event: 'did-finish-load', cb: () => void) => {
        loadedCbs.push(cb);
    });
    const win: AlertSoundWindow = {
        isDestroyed: () => destroyed,
        webContents: {
            isLoading: () => !!opts.loading,
            send,
            once,
        },
    };
    return {
        win,
        send,
        once,
        fireLoaded: () => loadedCbs.forEach((cb) => cb()),
        setDestroyed: (v: boolean) => {
            destroyed = v;
        },
    };
}

describe('planAlertSoundDelivery', () => {
    it('targets a loaded master window and sends immediately', () => {
        const { win } = fakeWin({ loading: false });
        const plan = planAlertSoundDelivery(win);
        expect(plan.target).toBe(win);
        expect(plan.deferUntilLoaded).toBe(false);
    });

    it('targets a still-loading master window but defers the send', () => {
        const { win } = fakeWin({ loading: true });
        const plan = planAlertSoundDelivery(win);
        expect(plan.target).toBe(win);
        expect(plan.deferUntilLoaded).toBe(true);
    });

    it('has no target when there is no master window (tray-resident)', () => {
        const plan = planAlertSoundDelivery(null);
        expect(plan.target).toBeNull();
        expect(plan.deferUntilLoaded).toBe(false);
    });

    it('treats a destroyed master window as no target', () => {
        const { win } = fakeWin({ destroyed: true });
        const plan = planAlertSoundDelivery(win);
        expect(plan.target).toBeNull();
    });
});

describe('deliverAlertSound', () => {
    it('sends the chime now when the master renderer is ready', () => {
        const { win, send, once } = fakeWin({ loading: false });
        const ok = deliverAlertSound(win, { kind: 'imDone' });
        expect(ok).toBe(true);
        expect(send).toHaveBeenCalledWith('notify:sound', { kind: 'imDone' });
        expect(once).not.toHaveBeenCalled();
    });

    it('defers the chime to did-finish-load while the renderer is loading', () => {
        const { win, send, once, fireLoaded } = fakeWin({ loading: true });
        const ok = deliverAlertSound(win, { kind: 'force-question' });
        expect(ok).toBe(true);
        // Nothing sent yet — it waits for the renderer to finish loading.
        expect(send).not.toHaveBeenCalled();
        expect(once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
        fireLoaded();
        expect(send).toHaveBeenCalledWith('notify:sound', { kind: 'force-question' });
    });

    it('does not re-send if the window is destroyed before it finishes loading', () => {
        const { win, send, fireLoaded, setDestroyed } = fakeWin({ loading: true });
        deliverAlertSound(win, { kind: 'imDone' });
        setDestroyed(true); // window closed during load
        fireLoaded();
        expect(send).not.toHaveBeenCalled();
    });

    it('returns false (no audio possible) when there is no master window', () => {
        const ok = deliverAlertSound(null, { kind: 'imDone' });
        expect(ok).toBe(false);
    });
});
