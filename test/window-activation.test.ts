import { describe, expect, it } from 'vitest';
import { ActivationLedger, FIRST_SHOW_FOCUS_MS, FirstShowTrace, bringUp, onceShowable, showWhenReady, windowLabelOf, type ActivatableWindow, type FirstShowWindow } from '../src/core/window-activation.js';

/**
 * GENIE NEVER TAKES THE KEYBOARD ON ITS OWN (genie#1235; the owner, 2026-10-26: "the most annoying thing ever").
 * A window is shown active, raised or focused ONLY as the direct result of a gesture the person made in Genie — the tray,
 * a menu, a Genie notification clicked, a button or link they pressed. Anything an agent or a background job does is
 * `background`: it may navigate, and it may flash the taskbar button, and nothing else.
 */

type Call = 'restore' | 'show' | 'showInactive' | 'focus' | 'flashFrame(true)' | 'flashFrame(false)';

function fakeWindow(state: { minimized?: boolean; visible?: boolean; focused?: boolean; destroyed?: boolean } = {}): ActivatableWindow & { calls: Call[] } {
    const calls: Call[] = [];
    return {
        calls,
        isDestroyed: () => state.destroyed === true,
        isMinimized: () => state.minimized === true,
        isVisible: () => state.visible !== false,
        isFocused: () => state.focused === true,
        restore: () => { calls.push('restore'); },
        show: () => { calls.push('show'); },
        showInactive: () => { calls.push('showInactive'); },
        focus: () => { calls.push('focus'); },
        flashFrame: (flag: boolean) => { calls.push(flag ? 'flashFrame(true)' : 'flashFrame(false)'); },
    };
}

/** Every call that puts a window in front of the person's keyboard. */
const ACTIVATING: readonly Call[] = ['restore', 'show', 'focus'];
const activating = (calls: readonly Call[]) => calls.filter((c) => ACTIVATING.includes(c));

describe('bringUp — an EXISTING window', () => {
    it('a user gesture brings it up: restored from the taskbar, shown from the tray, focused', () => {
        const hidden = fakeWindow({ visible: false });
        bringUp(hidden, { activation: 'user-gesture', reason: 'tray: Open' });
        expect(hidden.calls).toEqual(['show', 'focus']);
        const minimized = fakeWindow({ minimized: true });
        bringUp(minimized, { activation: 'user-gesture', reason: 'notification click' });
        expect(minimized.calls).toEqual(['restore', 'show', 'focus']);
    });

    it('BACKGROUND (an agent, a job) never restores, shows or focuses — whatever state the window is in', () => {
        for (const state of [{ visible: false }, { minimized: true }, { visible: true }, { visible: true, focused: false }]) {
            const w = fakeWindow(state);
            bringUp(w, { activation: 'background', reason: 'openFileForUser' });
            expect(activating(w.calls)).toEqual([]);
            expect(w.calls).not.toContain('showInactive');
        }
    });

    it('background flashes the taskbar button of a window the person is not in — and leaves a focused one alone', () => {
        const away = fakeWindow({ visible: true, focused: false });
        bringUp(away, { activation: 'background', reason: 'openFileForUser' });
        expect(away.calls).toEqual(['flashFrame(true)']);
        const here = fakeWindow({ visible: true, focused: true });
        bringUp(here, { activation: 'background', reason: 'openFileForUser' });
        expect(here.calls).toEqual([]);
    });

    it('a destroyed window is left alone either way', () => {
        for (const activation of ['user-gesture', 'background'] as const) {
            const w = fakeWindow({ destroyed: true });
            bringUp(w, { activation, reason: 'x' });
            expect(w.calls).toEqual([]);
        }
    });

    it('every request is written to the ledger, so a focus can be pinned on it', () => {
        const ledger = new ActivationLedger();
        bringUp(fakeWindow(), { activation: 'background', reason: 'openFileForUser', ledger, now: 1_000, label: 'main' });
        expect(ledger.last()).toEqual({ reason: 'openFileForUser', activation: 'background', label: 'main', at: 1_000 });
    });
});

describe('showWhenReady — a NEW window\u2019s first paint (ready-to-show)', () => {
    it('opened by the person: shown active', () => {
        const w = fakeWindow({ visible: false });
        showWhenReady(w, { activation: 'user-gesture', reason: 'Take Over click' });
        expect(w.calls).toEqual(['show']);
    });

    it('opened by an agent or the background: showInactive, never show() — show() activates', () => {
        const w = fakeWindow({ visible: false });
        showWhenReady(w, { activation: 'background', reason: 'sites open (agent)' });
        expect(w.calls).toEqual(['showInactive']);
        expect(activating(w.calls)).toEqual([]);
    });
});

/**
 * WHEN A NEW WINDOW IS SHOWN (genie#1370). Measured on omarchy-test (Hyprland, Electron 45, native Wayland): a hidden
 * window gets no frames, because Wayland sends frame callbacks only to a mapped surface. Genie's page is an empty
 * `<div id="root">` until React renders after load, so its first visually non-empty paint, which `ready-to-show`
 * waits for, never comes. The window loaded (`did-finish-load`) and stayed hidden. On X11 `ready-to-show` came 1 ms
 * after `did-finish-load`.
 */
function fakeNewWindow(): FirstShowWindow & { emit(event: 'ready-to-show' | 'did-finish-load'): void } {
    const listeners = new Map<string, Array<() => void>>();
    const once = (event: string, listener: () => void): void => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    };
    return {
        once,
        webContents: { once },
        emit(event) {
            const fns = listeners.get(event) ?? [];
            listeners.delete(event);
            for (const fn of fns) fn();
        },
    };
}

describe('onceShowable — when a NEW window is shown (genie#1370)', () => {
    it('Linux, native Wayland: the page loads and ready-to-show never comes — the window is shown at the load', () => {
        const w = fakeNewWindow();
        let shown = 0;
        onceShowable(w, 'linux', () => { shown += 1; });
        w.emit('did-finish-load');
        expect(shown).toBe(1);
    });

    it('Linux, X11: both come, a millisecond apart — shown once, not twice', () => {
        const w = fakeNewWindow();
        let shown = 0;
        onceShowable(w, 'linux', () => { shown += 1; });
        w.emit('did-finish-load');
        w.emit('ready-to-show');
        expect(shown).toBe(1);
    });

    it('Linux: ready-to-show first still shows, and a later load does not show again', () => {
        const w = fakeNewWindow();
        let shown = 0;
        onceShowable(w, 'linux', () => { shown += 1; });
        w.emit('ready-to-show');
        w.emit('did-finish-load');
        expect(shown).toBe(1);
    });

    it('Windows and macOS keep waiting for the first paint: no empty frame at the load', () => {
        for (const platform of ['win32', 'darwin'] as const) {
            const w = fakeNewWindow();
            let shown = 0;
            onceShowable(w, platform, () => { shown += 1; });
            w.emit('did-finish-load');
            expect(shown).toBe(0);
            w.emit('ready-to-show');
            expect(shown).toBe(1);
        }
    });
});

describe('ActivationLedger — the focus diagnostic', () => {
    it('names the request that came just before a window took focus', () => {
        const ledger = new ActivationLedger();
        ledger.note({ reason: 'tray: Open', activation: 'user-gesture', label: 'main', at: 10_000 });
        expect(ledger.explain('main', 10_250)).toBe('[genie] focus: main took focus — 250 ms after Genie asked: tray: Open (user-gesture, main)');
    });

    it('says when NO Genie request explains it — the person, the OS, or a path that bypasses bringUp', () => {
        const ledger = new ActivationLedger();
        expect(ledger.explain('main', 5_000)).toBe('[genie] focus: main took focus — no Genie request in the last 2000 ms (the person clicked or alt-tabbed, the OS, or an unrecorded path)');
        ledger.note({ reason: 'openFileForUser', activation: 'background', label: 'main', at: 1_000 });
        expect(ledger.explain('main', 9_000)).toMatch(/no Genie request in the last 2000 ms/);
    });

    it('a BACKGROUND request followed by focus is flagged — that is the bug this guards', () => {
        const ledger = new ActivationLedger();
        ledger.note({ reason: 'openFileForUser', activation: 'background', label: 'main', at: 1_000 });
        expect(ledger.explain('main', 1_100)).toMatch(/^\[genie\] focus: main took focus — 100 ms after Genie asked: openFileForUser \(background, main\) — a background request must never focus \(genie#1235\)$/);
    });
});

describe('windowLabelOf — which Genie window, from its URL', () => {
    it('names each kind', () => {
        expect(windowLabelOf('http://genie.localhost:24567/index.html')).toBe('main');
        expect(windowLabelOf('http://genie.localhost:24567/index.html?remote=wss%3A%2F%2Fx')).toBe('remote');
        expect(windowLabelOf('http://genie.localhost:24567/index.html#genie://takeover/t1')).toBe('takeover');
        expect(windowLabelOf('http://genie.localhost:24567/index.html#genie://takeover/t1?login=claude')).toBe('login');
        expect(windowLabelOf('http://genie.localhost:24567/index.html#genie://files/w1')).toBe('files');
        expect(windowLabelOf('http://genie.localhost:24567/question.html')).toBe('question');
        expect(windowLabelOf('http://genie.localhost:24567/browser.html')).toBe('browser');
        expect(windowLabelOf('http://genie.localhost:24567/doctor.html')).toBe('doctor');
        expect(windowLabelOf('')).toBe('unknown');
    });
});

/**
 * THE FIRST SHOW, TIMED (Tynn #1032). On Linux CI a terminal "dropped" typed input in 4 of 39 smoke runs: the keys
 * reached the shell, the shell echoed them, xterm's buffer held them, and its rows never drew them. In all four, and in
 * none of the 35 passes, the main window never took focus at launch: the window the compositor did not show gets no
 * frames on Wayland (genie#1370), so nothing drawn on a frame (xterm's renderer) draws. Nothing said so. The trace says
 * when each step of a window's first show happened, and says it out loud when the window was shown and never focused.
 */
describe('FirstShowTrace — a new window\'s first show, each step timed (Tynn #1032)', () => {
    it('says each step with its time since the window was made, and which event showed it', () => {
        const lines: string[] = [];
        const t = new FirstShowTrace('main', 1_000, (l) => lines.push(l));
        t.note('did-finish-load', 1_800);
        t.shown('did-finish-load', 1_801);
        t.note('focus', 1_890);
        expect(lines).toEqual([
            '[genie] window main: did-finish-load at +800 ms',
            '[genie] window main: show() at +801 ms, on did-finish-load',
            '[genie] window main: focus at +890 ms (89 ms after show())',
        ]);
    });

    it('a window shown and never focused is said once, when the wait is over: the compositor did not show it', () => {
        const lines: string[] = [];
        const t = new FirstShowTrace('main', 0, (l) => lines.push(l));
        t.shown('did-finish-load', 500);
        t.check(500 + FIRST_SHOW_FOCUS_MS - 1);
        expect(lines.filter((l) => l.includes('NOT FOCUSED'))).toEqual([]);
        t.check(500 + FIRST_SHOW_FOCUS_MS);
        t.check(500 + FIRST_SHOW_FOCUS_MS + 5_000);
        expect(lines.filter((l) => l.includes('NOT FOCUSED'))).toEqual([
            `[genie] window main: NOT FOCUSED ${FIRST_SHOW_FOCUS_MS} ms after show() (on did-finish-load): the compositor has not shown it, and a window it does not show gets no frames (Tynn #1032)`,
        ]);
    });

    it('a window that took focus in time is not reported, and nothing is said before show()', () => {
        const lines: string[] = [];
        const t = new FirstShowTrace('main', 0, (l) => lines.push(l));
        t.check(FIRST_SHOW_FOCUS_MS * 3);
        t.shown('ready-to-show', 100);
        t.note('focus', 200);
        t.check(100 + FIRST_SHOW_FOCUS_MS * 2);
        expect(lines.some((l) => l.includes('NOT FOCUSED'))).toBe(false);
    });

    it('only the FIRST of each step is said: a reload\'s second did-finish-load and a later focus are not the first show', () => {
        const lines: string[] = [];
        const t = new FirstShowTrace('main', 0, (l) => lines.push(l));
        t.note('did-finish-load', 10);
        t.shown('did-finish-load', 11);
        t.note('focus', 20);
        t.note('did-finish-load', 900);
        t.note('focus', 950);
        expect(lines).toHaveLength(3);
    });
});
