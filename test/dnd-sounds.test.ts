import { describe, expect, it } from 'vitest';
import { ALERT_KINDS, alertSound } from '../src/core/alerts.js';
import { carryOverV1, SETTINGS } from '../src/core/settings.js';

/**
 * DO NOT DISTURB SILENCES THE SOUNDS (Tynn #766 row D). Do not disturb means the person is away from the desk or does not
 * want to be interrupted, so no alert makes a sound — whatever each row is set to. Genie 1's one exception carries over
 * (`ftq_dnd_sound`, its question inbox's "still chime"): the person may opt in to hearing an agent ASK something while
 * DND is on. Off by default. DND off, every row plays as chosen (CONTROL).
 */
const on = { notification_sounds: true };

describe('do not disturb', () => {
    it('silences every alert kind, whatever its row is set to — COUNTED over every kind', () => {
        const loud = Object.fromEntries(ALERT_KINDS.map((k) => [`sound_${k.kind}`, 'sparkle']));
        const heard = ALERT_KINDS.filter((k) => alertSound(k.kind, { ...on, ...loud, do_not_disturb: true }) !== null);
        expect(heard).toEqual([]);
        // CONTROL: the same settings with DND off play every row.
        expect(ALERT_KINDS.filter((k) => alertSound(k.kind, { ...on, ...loud, do_not_disturb: false }) !== null)).toHaveLength(ALERT_KINDS.length);
    });

    it('opted in, a QUESTION still chimes with its own sound; nothing else does', () => {
        const settings = { ...on, do_not_disturb: true, dnd_question_sound: true };
        expect(alertSound('question', settings)).toEqual({ kind: 'wav', file: 'dingdongdoink.wav' });
        expect(alertSound('approval', settings)).toBeNull();
        expect(alertSound('mail', settings)).toBeNull();
        // ...and the question's own None still wins: opting in never overrides a row set to silence.
        expect(alertSound('question', { ...settings, sound_question: 'off' })).toBeNull();
    });

    it('the master switch off silences even the opted-in question', () => {
        expect(alertSound('question', { notification_sounds: false, do_not_disturb: true, dnd_question_sound: true })).toBeNull();
    });
});

describe('the setting', () => {
    it('is a host setting beside Do not disturb, off by default', () => {
        const def = SETTINGS.find((s) => s.key === 'dnd_question_sound');
        expect(def).toMatchObject({ type: 'boolean', default: false, group: 'general' });
        expect(def!.label).toMatch(/question/i);
    });

    it('Genie 1’s ftq_dnd_sound carries over, on and off', () => {
        expect(carryOverV1({ ftq_dnd_sound: 'on' }).applied).toMatchObject({ dnd_question_sound: true });
        expect(carryOverV1({ ftq_dnd_sound: 'off' }).applied).toMatchObject({ dnd_question_sound: false });
    });
});
