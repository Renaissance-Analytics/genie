import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * FIRING an alert — the one gate every kind goes through (genie#546).
 *
 * `playAlertSound` is the whole audible path in one function: read the master
 * switch, resolve this kind's choice, build the payload, hand it to the master
 * renderer. Before this there were two copies of that sequence (background.ts's
 * `notifyImDone` and force-question's `playForceQuestionChime`) and six more
 * would have meant six more.
 *
 * Nothing here plays audio. What is asserted is which payload reaches a fake
 * window, and — the part that matters most — which payloads DO NOT.
 */

const mockDb = vi.hoisted(() => ({ settings: {} as Record<string, string> }));
vi.mock('../db', () => ({
    getAllSettings: () => {
        if (mockDb.settings.__throw === 'yes') throw new Error('settings unreadable');
        return mockDb.settings;
    },
}));

import { playAlertSound, playAlert, setAlertSoundWindowSource } from '../notify-sound';
import { ALERT_KINDS, alertKindDef } from '../notify-sound-kinds';

/** Alias so each test reads as "these are the settings", not "this is a mock". */
const set = (next: Record<string, string>): void => {
    mockDb.settings = next;
};
const settings = (): Record<string, string> => mockDb.settings;

/** A fake BrowserWindow matching the structural AlertSoundWindow slice. */
function fakeWin() {
    const send = vi.fn();
    return {
        send,
        win: {
            isDestroyed: () => false,
            webContents: { isLoading: () => false, send, once: vi.fn() },
        },
    };
}

/** Master switch on, every kind audible — the baseline a test then breaks ONE
 *  thing in, so the break is what the assertion is measuring. */
function allAudible(): void {
    set({ notify_sound: 'on' });
    for (const kind of ALERT_KINDS) settings()[alertKindDef(kind).setting] = 'synth';
}

beforeEach(() => {
    set({});
    setAlertSoundWindowSource(null);
});

describe('the payload a kind sends', () => {
    it('carries the kind wire name, its motif, and the resolved sound', () => {
        allAudible();
        const { win, send } = fakeWin();
        expect(playAlertSound('failure', win)).toBe(true);
        expect(send).toHaveBeenCalledWith('notify:sound', {
            kind: 'failure',
            motif: 'attention',
            sound: { mode: 'synth' },
        });
    });

    it('sends the two shipped kinds under the wire names they already used', () => {
        // A remote client on an older Genie reads `kind` and nothing else, so
        // these two strings are load-bearing across versions.
        allAudible();
        const { win, send } = fakeWin();
        playAlertSound('imDone', win);
        expect(send).toHaveBeenCalledWith(
            'notify:sound',
            expect.objectContaining({ kind: 'imDone', motif: 'done' }),
        );
        send.mockClear();
        playAlertSound('forceQuestion', win);
        expect(send).toHaveBeenCalledWith(
            'notify:sound',
            expect.objectContaining({ kind: 'force-question', motif: 'attention' }),
        );
    });

    it('fires for EVERY kind in the registry — no kind is unreachable from here', () => {
        allAudible();
        for (const kind of ALERT_KINDS) {
            const { win, send } = fakeWin();
            expect(playAlertSound(kind, win), `${kind} should fire`).toBe(true);
            expect(send).toHaveBeenCalledTimes(1);
        }
    });
});

describe('the master switch still silences everything', () => {
    it('sends nothing for any kind while notify_sound is off', () => {
        set({ notify_sound: 'off' });
        for (const kind of ALERT_KINDS) settings()[alertKindDef(kind).setting] = 'synth';
        for (const kind of ALERT_KINDS) {
            const { win, send } = fakeWin();
            expect(playAlertSound(kind, win), `${kind} under a global off`).toBe(false);
            expect(send).not.toHaveBeenCalled();
        }
    });

    it('POSITIVE CONTROL: the same settings with the switch ON do fire', () => {
        // The assertion above passes just as well against a function that never
        // sends anything at all. This is the half that says it was the SWITCH.
        allAudible();
        for (const kind of ALERT_KINDS) {
            const { win, send } = fakeWin();
            expect(playAlertSound(kind, win), `${kind} under a global on`).toBe(true);
            expect(send).toHaveBeenCalledTimes(1);
        }
    });

    it('treats an unset master switch as off, as it always has', () => {
        set({ sound_imdone: 'synth' });
        const { win, send } = fakeWin();
        expect(playAlertSound('imDone', win)).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });

    it('stays silent, never throws, when the settings are unreadable', () => {
        set({ __throw: 'yes' });
        const { win, send } = fakeWin();
        expect(playAlertSound('imDone', win)).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });
});

describe('one kind set to None does not silence the others', () => {
    it('drops only the kind that is off', () => {
        allAudible();
        settings()[alertKindDef('agentMessage').setting] = 'off';
        const off = fakeWin();
        expect(playAlertSound('agentMessage', off.win)).toBe(false);
        expect(off.send).not.toHaveBeenCalled();
        for (const kind of ALERT_KINDS) {
            if (kind === 'agentMessage') continue;
            const other = fakeWin();
            expect(playAlertSound(kind, other.win), `${kind} must still fire`).toBe(true);
            expect(other.send).toHaveBeenCalledTimes(1);
        }
    });
});

describe('with no window to play in', () => {
    it('reports that no chime happened rather than pretending it did', () => {
        // Tray-resident Genie: no renderer can produce audio. The caller uses
        // this to decide whether to let the OS toast make its own sound.
        allAudible();
        expect(playAlertSound('imDone', null)).toBe(false);
    });
});

describe('playAlert — for callers that do not hold the master window', () => {
    it('routes to whatever window source the app registered', () => {
        // Flows, the process supervisor and the AgentInbox fan-out all fire
        // alerts and none of them owns a BrowserWindow. Passing one down through
        // each of those modules is how the two existing call sites each grew
        // their own copy of the master-window lookup.
        allAudible();
        const { win, send } = fakeWin();
        setAlertSoundWindowSource(() => win);
        expect(playAlert('flowRun')).toBe(true);
        expect(send).toHaveBeenCalledWith(
            'notify:sound',
            expect.objectContaining({ kind: 'flow-run' }),
        );
    });

    it('is inert before anything registers a source, and after it is cleared', () => {
        allAudible();
        expect(playAlert('flowRun')).toBe(false);
        const { win } = fakeWin();
        setAlertSoundWindowSource(() => win);
        expect(playAlert('flowRun')).toBe(true);
        setAlertSoundWindowSource(null);
        expect(playAlert('flowRun')).toBe(false);
    });

    it('survives a source that throws', () => {
        allAudible();
        setAlertSoundWindowSource(() => {
            throw new Error('window gone');
        });
        expect(playAlert('flowRun')).toBe(false);
    });
});
