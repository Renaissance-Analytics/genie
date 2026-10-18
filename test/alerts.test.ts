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
    it('names every kind of action — needs you, its turn, its work, messages — each with a label and a default sound; one CHOICE row per kind (Tynn #766)', () => {
        expect(ALERT_KINDS.map((k) => k.kind)).toEqual(['question', 'approval', 'broken', 'limited', 'started', 'replied', 'finished', 'thumbsup', 'stopped', 'resumed', 'edits', 'runs', 'reads', 'fetches', 'plans', 'mail', 'agentmail', 'exits', 'siteup', 'sitedown', 'serviceup', 'flowdone', 'ghissue', 'ghpr', 'ghsecurity', 'ghci']);
        for (const k of ALERT_KINDS) {
            expect(k.label.length).toBeGreaterThan(0);
            expect(SOUND_CHOICES.map((c) => c.value)).toContain(k.sound);
        }
        const rows = alertSoundSettings();
        expect(rows.map((r) => r.key)).toEqual(['question', 'approval', 'broken', 'limited', 'started', 'replied', 'finished', 'thumbsup', 'stopped', 'resumed', 'edits', 'runs', 'reads', 'fetches', 'plans', 'mail', 'agentmail', 'exits', 'siteup', 'sitedown', 'serviceup', 'flowdone', 'ghissue', 'ghpr', 'ghsecurity', 'ghci'].map((k) => `sound_${k}`));
        for (const [i, r] of rows.entries()) {
            expect(r).toMatchObject({ group: 'general', scope: 'device', type: 'enum', default: ALERT_KINDS[i]!.sound });
            expect(r.type === 'enum' ? r.options : []).toEqual(SOUND_CHOICES.map((c) => c.value));
            // The picker reads as words, never as file names.
            expect(r.type === 'enum' ? r.optionLabels : undefined).toEqual(Object.fromEntries(SOUND_CHOICES.map((c) => [c.value, c.label])));
        }
        // COUNTED in the live registry too: the rows are in SETTINGS, once each.
        expect(SETTINGS.filter((s) => /^sound_[a-z]+$/.test(s.key)).map((s) => s.key)).toEqual(rows.map((r) => r.key));
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
            { value: 'custom', label: 'Custom file…' },
            { value: 'off', label: 'None' },
        ]);
        for (const c of SOUND_CHOICES.filter((c) => c.value !== 'off' && c.value !== 'synth' && c.value !== 'custom')) {
            const file = new URL(`../src/renderer/sounds/${c.value}.wav`, import.meta.url);
            expect(existsSync(file), c.value).toBe(true);
            expect(readFileSync(file).subarray(0, 4).toString('latin1'), c.value).toBe('RIFF');
        }
    });

    it('pinned against the directory: a wav added or removed there and not here fails, never an option that plays nothing', () => {
        const dir = new URL('../src/renderer/sounds/', import.meta.url);
        expect(exists(dir)).toBe(true);
        const shipped = readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => f.replace(/\.wav$/, '')).sort();
        expect(shipped).toEqual(SOUND_CHOICES.filter((c) => c.value !== 'off' && c.value !== 'synth' && c.value !== 'custom').map((c) => c.value).sort());
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

    it('Custom file: played by its setting key, the kind’s own sound as the fallback; with no file chosen, the fallback itself', () => {
        const s = { notification_sounds: true, sound_question: 'custom', sound_question_custom: '/home/a/ding.wav', sound_mail: 'custom', sound_mail_custom: '' };
        expect(alertSound('question', s)).toEqual({ kind: 'custom', key: 'sound_question', fallback: { kind: 'wav', file: 'dingdongdoink.wav' } });
        expect(alertSound('mail', s)).toEqual({ kind: 'wav', file: 'dingdongdoink.wav' });
        expect(previewSound('question', 'custom', '/home/a/ding.wav')).toEqual({ kind: 'custom', key: 'sound_question', fallback: { kind: 'wav', file: 'dingdongdoink.wav' } });
        expect(previewSound('question', 'custom', '')).toEqual({ kind: 'wav', file: 'dingdongdoink.wav' });
    });

    it('every kind has a motif: what needs you knocks (attention) — a question, an approval, a break, a rate limit, and a process or site that stopped on its own; the rest rise (done)', () => {
        expect(Object.fromEntries(ALERT_KINDS.map((k) => [k.kind, k.motif]))).toEqual({
            question: 'attention', approval: 'attention', broken: 'attention', limited: 'attention',
            started: 'done', replied: 'done', finished: 'done', thumbsup: 'done', stopped: 'done', resumed: 'done',
            edits: 'done', runs: 'done', reads: 'done', fetches: 'done', plans: 'done', mail: 'done', agentmail: 'done',
            exits: 'attention', siteup: 'done', sitedown: 'attention', serviceup: 'done', flowdone: 'done',
            ghissue: 'done', ghpr: 'done', ghsecurity: 'attention', ghci: 'attention',
        });
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

    it('Genie 1’s Default chime and its custom files carry over — the choice and the file’s path', () => {
        const r = carryOverV1({ sound_imdone: 'synth', sound_forcequestion: 'custom', sound_forcequestion_custom: 'C:\\Users\\a\\ask.mp3', sound_failure_custom: '/home/a/oops.wav' });
        expect(r.applied).toEqual({ sound_finished: 'synth', sound_question: 'custom', sound_question_custom: 'C:\\Users\\a\\ask.mp3', sound_broken_custom: '/home/a/oops.wav' });
        expect(r.dropped).toEqual([]);
    });

    it('each alert keeps its file’s path in a hidden setting (drawn by its row, not as a text box)', () => {
        for (const k of ALERT_KINDS) {
            expect(SETTINGS.find((s) => s.key === `sound_${k.kind}_custom`)).toMatchObject({ type: 'string', default: '', hidden: true, scope: 'device', group: 'general' });
        }
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
