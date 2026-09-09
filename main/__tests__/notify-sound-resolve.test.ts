import { describe, expect, it, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolving ONE alert's sound out of the settings (genie#546).
 *
 * `resolveAlertSound` is a pure function over the settings table, which is why
 * it is testable at all — it decides silence, chime, wav or data-URL without
 * touching audio, Electron, or a window. Nothing here plays a sound.
 *
 * ## What has to be proved, and why one-sided tests would not prove it
 *
 * The change generalises a two-branch if/else into a table lookup, and the
 * failure modes of that are asymmetric:
 *
 *  - "`off` is silent" passes on a corpse. A bug that silenced EVERY kind
 *    satisfies it perfectly. So every `off` assertion here is paired with a
 *    POSITIVE CONTROL: another kind, in the same settings object, still fires.
 *  - "the new kinds work" says nothing about the two that already shipped. A
 *    user's saved `sound_imdone` choice surviving this change matters more than
 *    the feature does, so it is pinned against the literal key strings rather
 *    than against the registry that could have renamed them.
 */

/** The settings object the mocked db hands back — swapped per test. */
const mockDb = vi.hoisted(() => ({ settings: {} as Record<string, string> }));
vi.mock('../db', () => ({
    getAllSettings: () => {
        if (mockDb.settings.__throw === 'yes') throw new Error('settings unreadable');
        return mockDb.settings;
    },
}));

import { resolveAlertSound, readSoundDataUrl } from '../notify-sound';
import { ALERT_KINDS, alertKindDef } from '../notify-sound-kinds';

/** Alias so each test reads as "these are the settings", not "this is a mock". */
const set = (next: Record<string, string>): void => {
    mockDb.settings = next;
};
const settings = (): Record<string, string> => mockDb.settings;

beforeEach(() => {
    set({});
});

/** Turn the master switch on and set every kind to a known-audible value, so a
 *  test can then turn ONE off and see only that one go quiet. */
function allAudible(): void {
    set({ notify_sound: 'on' });
    for (const kind of ALERT_KINDS) settings()[alertKindDef(kind).setting] = 'synth';
}

describe('every kind resolves — none is a dead control', () => {
    it('gives each kind its own chime when each is set to one', () => {
        allAudible();
        for (const kind of ALERT_KINDS) {
            expect(resolveAlertSound(kind), `${kind} should resolve`).toEqual({ mode: 'synth' });
        }
    });

    it('plays the bundled wav a kind names', () => {
        for (const kind of ALERT_KINDS) {
            set({ [alertKindDef(kind).setting]: 'triumphant' });
            expect(resolveAlertSound(kind)).toEqual({ mode: 'asset', name: 'triumphant' });
        }
    });

    it('falls back to each kind own default when the user has never chosen', () => {
        set({});
        for (const kind of ALERT_KINDS) {
            const def = alertKindDef(kind);
            const expected = def.fallback === 'off' ? null : { mode: 'synth' };
            expect(resolveAlertSound(kind), `${kind} unset`).toEqual(expected);
        }
    });
});

describe('None means None — for that kind, and only that kind', () => {
    it('silences the kind set to off', () => {
        allAudible();
        settings()[alertKindDef('flowRun').setting] = 'off';
        expect(resolveAlertSound('flowRun')).toBeNull();
    });

    it('POSITIVE CONTROL: every OTHER kind still fires in that same settings object', () => {
        // Without this, a regression that silenced all eight would pass the
        // assertion above and look like the feature working.
        allAudible();
        settings()[alertKindDef('flowRun').setting] = 'off';
        for (const kind of ALERT_KINDS) {
            if (kind === 'flowRun') continue;
            expect(resolveAlertSound(kind), `${kind} must still fire`).toEqual({ mode: 'synth' });
        }
    });

    it('turns each kind off independently, one at a time, across the whole set', () => {
        for (const off of ALERT_KINDS) {
            allAudible();
            settings()[alertKindDef(off).setting] = 'off';
            expect(resolveAlertSound(off), `${off} off`).toBeNull();
            for (const other of ALERT_KINDS) {
                if (other === off) continue;
                expect(resolveAlertSound(other), `${other} while ${off} is off`).toEqual({
                    mode: 'synth',
                });
            }
        }
    });
});

describe('the two kinds that already shipped keep working exactly as they did', () => {
    it('reads imDone from `sound_imdone`, by that literal key', () => {
        // Against the literal string on purpose: this is what a user's row in the
        // settings table is called, and the registry is precisely the thing that
        // could have renamed it.
        set({ sound_imdone: 'winddown' });
        expect(resolveAlertSound('imDone')).toEqual({ mode: 'asset', name: 'winddown' });
    });

    it('reads forceQuestion from `sound_forcequestion`, by that literal key', () => {
        set({ sound_forcequestion: 'dingdongdoink' });
        expect(resolveAlertSound('forceQuestion')).toEqual({
            mode: 'asset',
            name: 'dingdongdoink',
        });
    });

    it('still defaults BOTH to the built-in chime when unset', () => {
        set({});
        expect(resolveAlertSound('imDone')).toEqual({ mode: 'synth' });
        expect(resolveAlertSound('forceQuestion')).toEqual({ mode: 'synth' });
    });

    it('still honours a saved `off` on each of them', () => {
        set({ sound_imdone: 'off', sound_forcequestion: 'synth' });
        expect(resolveAlertSound('imDone')).toBeNull();
        expect(resolveAlertSound('forceQuestion')).toEqual({ mode: 'synth' });
    });

    it('still reads their custom paths from the keys they already use', () => {
        const file = path.join(os.tmpdir(), `genie-sound-${process.pid}.wav`);
        fs.writeFileSync(file, Buffer.from([0x52, 0x49, 0x46, 0x46]));
        try {
            set({ sound_imdone: 'custom', sound_imdone_custom: file });
            const got = resolveAlertSound('imDone');
            expect(got).toEqual({ mode: 'data', dataUrl: 'data:audio/wav;base64,UklGRg==' });
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    it('treats an unknown legacy value as the built-in chime, not as silence', () => {
        // A settings row written by a future or a hand-edited build must never
        // resolve to "no alert at all" — the historic behaviour was always-synth.
        set({ sound_imdone: 'some-choice-that-no-longer-exists' });
        expect(resolveAlertSound('imDone')).toEqual({ mode: 'synth' });
    });
});

describe('custom files, for every kind', () => {
    it('reads a custom file per kind from that kind own `_custom` key', () => {
        const file = path.join(os.tmpdir(), `genie-sound-per-kind-${process.pid}.wav`);
        fs.writeFileSync(file, Buffer.from([0x52, 0x49, 0x46, 0x46]));
        try {
            for (const kind of ALERT_KINDS) {
                const def = alertKindDef(kind);
                set({ [def.setting]: 'custom', [def.custom]: file });
                expect(resolveAlertSound(kind), `${kind} custom`).toEqual({
                    mode: 'data',
                    dataUrl: 'data:audio/wav;base64,UklGRg==',
                });
            }
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    it('goes silent rather than throwing when a custom file is missing', () => {
        set({
            sound_failure: 'custom',
            sound_failure_custom: path.join(os.tmpdir(), 'genie-no-such-sound.wav'),
        });
        expect(resolveAlertSound('failure')).toBeNull();
    });

    it('refuses a file that is not there or is absurdly large', () => {
        expect(readSoundDataUrl('')).toBeNull();
        expect(readSoundDataUrl(path.join(os.tmpdir(), 'genie-definitely-absent.wav'))).toBeNull();
    });
});

describe('unreadable settings fall back to the chime, never to silence', () => {
    it('resolves synth for every kind when the db throws', () => {
        set({ __throw: 'yes' });
        for (const kind of ALERT_KINDS) {
            expect(resolveAlertSound(kind), `${kind} on a db error`).toEqual({ mode: 'synth' });
        }
    });
});
