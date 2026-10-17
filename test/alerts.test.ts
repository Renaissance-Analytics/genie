import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { existsSync as exists, readdirSync } from 'node:fs';
import { ALERT_KINDS, SOUND_CHOICES, alertSound, alertSoundSettings, isAlertSoundKey, previewSound, toastFor } from '../src/core/alerts.js';
import { CHIME_CLOSE_MS, chimeTones } from '../src/core/alert-chime.js';
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
    it('Genie 1’s choices in Genie 1’s order — the Default chime first, None last; every wav ships and is a real RIFF/WAVE', () => {
        expect(SOUND_CHOICES).toEqual([
            { value: 'synth', label: 'Default chime' },
            { value: '3tootpipe', label: '3 Toot Pipe' },
            { value: 'dingdongdoink', label: 'Ding Dong Doink' },
            { value: 'sparkle', label: 'Sparkle' },
            { value: 'triumphant', label: 'Triumphant' },
            { value: 'winddown', label: 'Wind Down' },
            { value: 'off', label: 'None' },
        ]);
        for (const c of SOUND_CHOICES.filter((c) => c.value !== 'off' && c.value !== 'synth')) {
            const file = new URL(`../src/renderer/sounds/${c.value}.wav`, import.meta.url);
            expect(existsSync(file), c.value).toBe(true);
            expect(readFileSync(file).subarray(0, 4).toString('latin1'), c.value).toBe('RIFF');
        }
    });

    it('pinned against the directory: a wav added or removed there and not here fails, never an option that plays nothing', () => {
        const dir = new URL('../src/renderer/sounds/', import.meta.url);
        expect(exists(dir)).toBe(true);
        const shipped = readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => f.replace(/\.wav$/, '')).sort();
        expect(shipped).toEqual(SOUND_CHOICES.filter((c) => c.value !== 'off' && c.value !== 'synth').map((c) => c.value).sort());
    });
});

describe('alertSound', () => {
    it('answers the CHOSEN sound — a wav, or the Default chime’s motif; None and the master switch silence; a row never set is the kind’s own sound', () => {
        const on = { notification_sounds: true, sound_question: 'sparkle', sound_finished: 'off', sound_broken: 'synth', sound_mail: 'synth' };
        expect(alertSound('question', on)).toEqual({ kind: 'wav', file: 'sparkle.wav' });
        expect(alertSound('finished', on)).toBeNull();
        expect(alertSound('question', { ...on, notification_sounds: false })).toBeNull();
        expect(alertSound('approval', { notification_sounds: true })).toEqual({ kind: 'wav', file: '3tootpipe.wav' });
        // Genie 1's motifs: someone needs you NOW (attention) against something you waited on ended (done).
        expect(alertSound('broken', on)).toEqual({ kind: 'synth', motif: 'attention' });
        expect(alertSound('mail', on)).toEqual({ kind: 'synth', motif: 'done' });
        // A value Genie does not ship plays the kind's own sound, never a file that is not there.
        expect(alertSound('question', { notification_sounds: true, sound_question: 'kazoo' })).toEqual({ kind: 'wav', file: 'dingdongdoink.wav' });
    });

    it('every kind has a motif: question, approval and broken knock (attention); finished and mail rise (done)', () => {
        expect(Object.fromEntries(ALERT_KINDS.map((k) => [k.kind, k.motif]))).toEqual({ question: 'attention', approval: 'attention', finished: 'done', broken: 'attention', mail: 'done' });
    });

    it('Preview plays what the alert would — the master switch aside; None previews nothing', () => {
        expect(previewSound('question', 'winddown')).toEqual({ kind: 'wav', file: 'winddown.wav' });
        expect(previewSound('question', 'synth')).toEqual({ kind: 'synth', motif: 'attention' });
        expect(previewSound('finished', 'synth')).toEqual({ kind: 'synth', motif: 'done' });
        expect(previewSound('finished', 'off')).toBeNull();
        expect(isAlertSoundKey('sound_question')).toBe(true);
        expect(isAlertSoundKey('notification_sounds')).toBe(false);
    });

    it('a row saved by an earlier Genie 2 as on/off reads as the kind’s sound / None', () => {
        expect(migrateLegacyValue('sound_question', true)).toBe('dingdongdoink');
        expect(migrateLegacyValue('sound_finished', false)).toBe('off');
        expect(alertSound('finished', { notification_sounds: true, sound_finished: true })).toEqual({ kind: 'wav', file: 'triumphant.wav' });
        expect(alertSound('finished', { notification_sounds: true, sound_finished: false })).toBeNull();
    });
});

describe('Genie 1’s sound settings carry over (they never did: its master switch is `notify_sound`)', () => {
    it('the master switch, and each choice whose kind Genie 2 has, as chosen', () => {
        const r = carryOverV1({ notify_sound: 'on', sound_forcequestion: 'winddown', sound_imdone: 'sparkle', sound_failure: 'off' });
        expect(r.applied).toEqual({ notification_sounds: true, sound_question: 'winddown', sound_finished: 'sparkle', sound_broken: 'off' });
        expect(r.dropped).toEqual([]);
        expect(carryOverV1({ notify_sound: 'off' }).applied).toEqual({ notification_sounds: false });
    });

    it('Genie 1’s Default chime carries over as the Default chime; a custom file (not here yet) is reported, not guessed', () => {
        const r = carryOverV1({ sound_imdone: 'synth', sound_forcequestion: 'custom' });
        expect(r.applied).toEqual({ sound_finished: 'synth' });
        expect(r.dropped.map((d) => d.key)).toEqual(['sound_forcequestion']);
    });
});

describe('the Default chime’s notes (Genie 1’s, pinned — genie renderer/lib/alert-chime.ts)', () => {
    it('done: E5 then A5, a gentle sine rise; attention: A5, A5, D6 on a triangle, a fast knock that lifts', () => {
        expect(chimeTones('done')).toEqual([
            { freq: 660, start: 0, dur: 0.18, type: 'sine' },
            { freq: 880, start: 0.16, dur: 0.24, type: 'sine' },
        ]);
        expect(chimeTones('attention')).toEqual([
            { freq: 880, start: 0, dur: 0.1, type: 'triangle' },
            { freq: 880, start: 0.14, dur: 0.1, type: 'triangle' },
            { freq: 1175, start: 0.28, dur: 0.26, type: 'triangle' },
        ]);
    });

    it('each context closes after its last note has decayed — a context per alert leaks over a days-long session', () => {
        for (const motif of ['done', 'attention'] as const) {
            const end = Math.max(...chimeTones(motif).map((t) => t.start + t.dur)) * 1000;
            expect(CHIME_CLOSE_MS[motif]).toBeGreaterThan(end);
        }
    });
});

describe('toastFor', () => {
    it('names the workspace and the agent in the title, the detail in the body', () => {
        expect(toastFor({ kind: 'question', workspace: 'tynn', agent: 'atlas', detail: 'Ship now?' })).toEqual({ title: 'tynn · atlas', body: 'Asks: Ship now?' });
        expect(toastFor({ kind: 'finished', workspace: 'fancy', agent: 'wren', detail: 'PR #12 is up' })).toEqual({ title: 'fancy · wren', body: 'Finished: PR #12 is up' });
        expect(toastFor({ kind: 'broken', workspace: 'tynn', agent: 'bolt', detail: 'exited with code 1' })).toEqual({ title: 'tynn · bolt', body: 'Broken: exited with code 1' });
    });
});
