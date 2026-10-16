import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALERT_KINDS, alertSoundSettings, soundFor, toastFor } from '../src/core/alerts.js';
import { SETTINGS } from '../src/core/settings.js';

/**
 * ALERTS (§6.3) — one registry of the kinds Genie can alert about; the sound settings are DERIVED
 * from it (one row per kind, never a hand-kept list); a kind's sound is `null` when its row or the
 * master switch is off; a tray toast names the WORKSPACE and the AGENT. The sound files ship with
 * the app (the owner's own design sounds) and each named file exists and is a real RIFF/WAVE.
 */

describe('the registry', () => {
    it('names five kinds, each with a label and a shipped sound; the settings registry carries one boolean row per kind', () => {
        expect(ALERT_KINDS.map((k) => k.kind)).toEqual(['question', 'approval', 'finished', 'broken', 'mail']);
        for (const k of ALERT_KINDS) {
            expect(k.label.length).toBeGreaterThan(0);
            const file = new URL(`../src/renderer/sounds/${k.sound}`, import.meta.url);
            expect(existsSync(file), k.sound).toBe(true);
            expect(readFileSync(file).subarray(0, 4).toString('latin1'), k.sound).toBe('RIFF');
        }
        const rows = alertSoundSettings();
        expect(rows.map((r) => r.key)).toEqual(['sound_question', 'sound_approval', 'sound_finished', 'sound_broken', 'sound_mail']);
        expect(rows.every((r) => r.group === 'general' && r.scope === 'device' && r.type === 'boolean' && r.default === true)).toBe(true);
        // COUNTED in the live registry too: the rows are in SETTINGS, once each.
        expect(SETTINGS.filter((s) => s.key.startsWith('sound_')).map((s) => s.key)).toEqual(rows.map((r) => r.key));
    });
});

describe('soundFor', () => {
    it('answers the kind’s file when the master switch and its row are on; null when either is off', () => {
        const on = { notification_sounds: true, sound_question: true, sound_finished: false };
        expect(soundFor('question', on)).toBe('dingdongdoink.wav');
        expect(soundFor('finished', on)).toBeNull();
        expect(soundFor('question', { ...on, notification_sounds: false })).toBeNull();
        // A row never set reads as its default (on).
        expect(soundFor('approval', { notification_sounds: true })).toBe('3tootpipe.wav');
    });
});

describe('toastFor', () => {
    it('names the workspace and the agent in the title, the detail in the body', () => {
        expect(toastFor({ kind: 'question', workspace: 'tynn', agent: 'atlas', detail: 'Ship now?' })).toEqual({ title: 'tynn · atlas', body: 'Asks: Ship now?' });
        expect(toastFor({ kind: 'finished', workspace: 'fancy', agent: 'wren', detail: 'PR #12 is up' })).toEqual({ title: 'fancy · wren', body: 'Finished: PR #12 is up' });
        expect(toastFor({ kind: 'broken', workspace: 'tynn', agent: 'bolt', detail: 'exited with code 1' })).toEqual({ title: 'tynn · bolt', body: 'Broken: exited with code 1' });
    });
});
