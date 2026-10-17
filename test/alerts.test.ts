import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { existsSync as exists, readdirSync } from 'node:fs';
import { ALERT_KINDS, SOUND_CHOICES, alertSoundSettings, soundFor, toastFor } from '../src/core/alerts.js';
import { SETTINGS, carryOverV1, migrateLegacyValue } from '../src/core/settings.js';

/**
 * ALERTS (§6.3) — one registry of the kinds Genie can alert about; the sound settings are DERIVED
 * from it (one row per kind, never a hand-kept list); a kind's sound is `null` when its row or the
 * master switch is off; a tray toast names the WORKSPACE and the AGENT. The sound files ship with
 * the app (the owner's own design sounds) and each named file exists and is a real RIFF/WAVE.
 */

describe('the registry', () => {
    it('names five kinds, each with a label and a shipped default sound; one CHOICE row per kind (Tynn #766)', () => {
        expect(ALERT_KINDS.map((k) => k.kind)).toEqual(['question', 'approval', 'finished', 'broken', 'mail']);
        for (const k of ALERT_KINDS) {
            expect(k.label.length).toBeGreaterThan(0);
            expect(SOUND_CHOICES.map((c) => c.value)).toContain(k.sound);
        }
        const rows = alertSoundSettings();
        expect(rows.map((r) => r.key)).toEqual(['sound_question', 'sound_approval', 'sound_finished', 'sound_broken', 'sound_mail']);
        for (const [i, r] of rows.entries()) {
            expect(r).toMatchObject({ group: 'general', scope: 'device', type: 'enum', default: ALERT_KINDS[i]!.sound });
            expect(r.type === 'enum' ? r.options : []).toEqual(SOUND_CHOICES.map((c) => c.value));
            // The picker reads as words, never as file names.
            expect(r.type === 'enum' ? r.optionLabels : undefined).toEqual(Object.fromEntries(SOUND_CHOICES.map((c) => [c.value, c.label])));
        }
        // COUNTED in the live registry too: the rows are in SETTINGS, once each.
        expect(SETTINGS.filter((s) => s.key.startsWith('sound_')).map((s) => s.key)).toEqual(rows.map((r) => r.key));
    });
});

describe('the sounds (Genie 1’s five, all shipped — Tynn #766)', () => {
    it('Genie 1’s choices in Genie 1’s order, with None last; every wav ships and is a real RIFF/WAVE', () => {
        expect(SOUND_CHOICES).toEqual([
            { value: '3tootpipe', label: '3 Toot Pipe' },
            { value: 'dingdongdoink', label: 'Ding Dong Doink' },
            { value: 'sparkle', label: 'Sparkle' },
            { value: 'triumphant', label: 'Triumphant' },
            { value: 'winddown', label: 'Wind Down' },
            { value: 'off', label: 'None' },
        ]);
        for (const c of SOUND_CHOICES.filter((c) => c.value !== 'off')) {
            const file = new URL(`../src/renderer/sounds/${c.value}.wav`, import.meta.url);
            expect(existsSync(file), c.value).toBe(true);
            expect(readFileSync(file).subarray(0, 4).toString('latin1'), c.value).toBe('RIFF');
        }
    });

    it('pinned against the directory: a wav added or removed there and not here fails, never an option that plays nothing', () => {
        const dir = new URL('../src/renderer/sounds/', import.meta.url);
        expect(exists(dir)).toBe(true);
        const shipped = readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => f.replace(/\.wav$/, '')).sort();
        expect(shipped).toEqual(SOUND_CHOICES.filter((c) => c.value !== 'off').map((c) => c.value).sort());
    });
});

describe('soundFor', () => {
    it('answers the CHOSEN sound’s file; None and the master switch silence; a row never set is the kind’s own sound', () => {
        const on = { notification_sounds: true, sound_question: 'sparkle', sound_finished: 'off' };
        expect(soundFor('question', on)).toBe('sparkle.wav');
        expect(soundFor('finished', on)).toBeNull();
        expect(soundFor('question', { ...on, notification_sounds: false })).toBeNull();
        expect(soundFor('approval', { notification_sounds: true })).toBe('3tootpipe.wav');
        // A value Genie does not ship plays the kind's own sound, never a file that is not there.
        expect(soundFor('question', { notification_sounds: true, sound_question: 'kazoo' })).toBe('dingdongdoink.wav');
    });

    it('a row saved by an earlier Genie 2 as on/off reads as the kind’s sound / None', () => {
        expect(migrateLegacyValue('sound_question', true)).toBe('dingdongdoink');
        expect(migrateLegacyValue('sound_finished', false)).toBe('off');
        expect(soundFor('finished', { notification_sounds: true, sound_finished: true })).toBe('triumphant.wav');
        expect(soundFor('finished', { notification_sounds: true, sound_finished: false })).toBeNull();
    });
});

describe('Genie 1’s sound settings carry over (they never did: its master switch is `notify_sound`)', () => {
    it('the master switch, and each choice whose kind Genie 2 has, as chosen', () => {
        const r = carryOverV1({ notify_sound: 'on', sound_forcequestion: 'winddown', sound_imdone: 'sparkle', sound_failure: 'off' });
        expect(r.applied).toEqual({ notification_sounds: true, sound_question: 'winddown', sound_finished: 'sparkle', sound_broken: 'off' });
        expect(r.dropped).toEqual([]);
        expect(carryOverV1({ notify_sound: 'off' }).applied).toEqual({ notification_sounds: false });
    });

    it('a choice Genie 2 cannot play yet (the synthesized chime, a custom file) is reported, not guessed', () => {
        const r = carryOverV1({ sound_imdone: 'synth', sound_forcequestion: 'custom' });
        expect(r.applied).toEqual({});
        expect(r.dropped.map((d) => d.key).sort()).toEqual(['sound_forcequestion', 'sound_imdone']);
    });
});

describe('toastFor', () => {
    it('names the workspace and the agent in the title, the detail in the body', () => {
        expect(toastFor({ kind: 'question', workspace: 'tynn', agent: 'atlas', detail: 'Ship now?' })).toEqual({ title: 'tynn · atlas', body: 'Asks: Ship now?' });
        expect(toastFor({ kind: 'finished', workspace: 'fancy', agent: 'wren', detail: 'PR #12 is up' })).toEqual({ title: 'fancy · wren', body: 'Finished: PR #12 is up' });
        expect(toastFor({ kind: 'broken', workspace: 'tynn', agent: 'bolt', detail: 'exited with code 1' })).toEqual({ title: 'tynn · bolt', body: 'Broken: exited with code 1' });
    });
});
