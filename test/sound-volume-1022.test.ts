import { describe, expect, it } from 'vitest';
import { ALERT_KINDS } from '../src/core/alerts.js';
import { splitSettings } from '../src/core/remote.js';
import { SETTINGS } from '../src/core/settings.js';
import { sectionOf } from '../src/core/settings-nav.js';
import { SOUND_LEVELS_SETTING, SOUND_MUTED_SETTING, SOUND_VOLUME_SETTING, alertVolume, eventLevel, masterLevel, previewVolume, withEventLevel } from '../src/core/sound-volume.js';

/**
 * SOUND VOLUME (Tynn #1022; the owner, 2026-11-22: "can we add volume control to the sound system? And an advanced Volume
 * control for setting levels per event."). A master level with a mute, and a level per alert kind; what plays is the
 * master times the event's level. The levels are HOST settings, so every client of a host hears the same levels.
 */

describe('the settings', () => {
    it('master, mute and the per-event levels are host-scoped, hidden (drawn by their own block), on Notifications', () => {
        const byKey = Object.fromEntries(SETTINGS.map((s) => [s.key, s]));
        expect(byKey[SOUND_VOLUME_SETTING]).toMatchObject({ scope: 'host', type: 'string', default: '100', hidden: true });
        expect(byKey[SOUND_MUTED_SETTING]).toMatchObject({ scope: 'host', type: 'boolean', default: false, hidden: true });
        expect(byKey[SOUND_LEVELS_SETTING]).toMatchObject({ scope: 'host', type: 'string', default: '{}', hidden: true });
        for (const k of [SOUND_VOLUME_SETTING, SOUND_MUTED_SETTING, SOUND_LEVELS_SETTING]) expect(sectionOf(k), k).toBe('notifications');
    });

    it('they are the host’s, never kept locally by a client (so every client hears the same levels)', () => {
        const split = splitSettings(SETTINGS);
        for (const k of [SOUND_VOLUME_SETTING, SOUND_MUTED_SETTING, SOUND_LEVELS_SETTING]) {
            expect(split.hostOnly, k).toContain(k);
            expect(split.clientLocal, k).not.toContain(k);
        }
    });
});

describe('the master level', () => {
    it('reads the percent the person set, 100 when never set', () => {
        expect(masterLevel({})).toBe(100);
        expect(masterLevel({ sound_volume: '35' })).toBe(35);
        expect(masterLevel({ sound_volume: '0' })).toBe(0);
    });
    it('clamps to 0..100 and reads anything that is not a number as 100, never silence', () => {
        expect(masterLevel({ sound_volume: '250' })).toBe(100);
        expect(masterLevel({ sound_volume: '-4' })).toBe(0);
        expect(masterLevel({ sound_volume: 'loud' })).toBe(100);
        expect(masterLevel({ sound_volume: '' })).toBe(100);
        expect(masterLevel({ sound_volume: true })).toBe(100);
        expect(masterLevel({ sound_volume: '42.6' })).toBe(43);
    });
});

describe('an event level', () => {
    it('is 100 when never set; the JSON map holds the ones the person moved', () => {
        expect(eventLevel('finished', {})).toBe(100);
        expect(eventLevel('finished', { sound_levels: '{"finished":40,"mail":0}' })).toBe(40);
        expect(eventLevel('mail', { sound_levels: '{"finished":40,"mail":0}' })).toBe(0);
        expect(eventLevel('question', { sound_levels: '{"finished":40}' })).toBe(100);
    });
    it('a broken map or value is 100 (never a crash, never silence); out of range clamps', () => {
        expect(eventLevel('finished', { sound_levels: 'not json' })).toBe(100);
        expect(eventLevel('finished', { sound_levels: '[1,2]' })).toBe(100);
        expect(eventLevel('finished', { sound_levels: '{"finished":"x"}' })).toBe(100);
        expect(eventLevel('finished', { sound_levels: '{"finished":900}' })).toBe(100);
        expect(eventLevel('finished', { sound_levels: '{"finished":-1}' })).toBe(0);
    });
    it('withEventLevel writes one kind and keeps the others; 100 is dropped (it is the default)', () => {
        const once = withEventLevel('{"mail":20}', 'finished', 55);
        expect(JSON.parse(once)).toEqual({ mail: 20, finished: 55 });
        expect(JSON.parse(withEventLevel(once, 'mail', 100))).toEqual({ finished: 55 });
        expect(JSON.parse(withEventLevel('garbage', 'finished', 10.4))).toEqual({ finished: 10 });
        expect(JSON.parse(withEventLevel(undefined, 'finished', 140))).toEqual({});
    });
});

describe('what plays: master × event', () => {
    it('is the product of the two, as a 0..1 gain', () => {
        expect(alertVolume('finished', {})).toBe(1);
        expect(alertVolume('finished', { sound_volume: '50' })).toBeCloseTo(0.5);
        expect(alertVolume('finished', { sound_volume: '50', sound_levels: '{"finished":40}' })).toBeCloseTo(0.2);
        // CONTROL: another kind keeps the master alone.
        expect(alertVolume('question', { sound_volume: '50', sound_levels: '{"finished":40}' })).toBeCloseTo(0.5);
    });
    it('mute is silence whatever the levels; unmuted, the levels come back as they were', () => {
        expect(alertVolume('finished', { sound_muted: true, sound_volume: '80' })).toBe(0);
        expect(alertVolume('finished', { sound_muted: false, sound_volume: '80' })).toBeCloseTo(0.8);
    });
    it('every kind has a level (the Advanced list is derived from the registry)', () => {
        for (const k of ALERT_KINDS) expect(alertVolume(k.kind, {}), k.kind).toBe(1);
    });
    it('a rate-limit alert (no kind of its own) plays at the master level', () => {
        expect(alertVolume(null, { sound_volume: '30', sound_levels: '{"limited":10}' })).toBeCloseTo(0.3);
        expect(alertVolume(null, { sound_muted: true })).toBe(0);
    });
    it('a PREVIEW plays at master × event even while muted, so a sound can still be chosen by ear', () => {
        expect(previewVolume('finished', { sound_muted: true, sound_volume: '50', sound_levels: '{"finished":40}' })).toBeCloseTo(0.2);
        expect(previewVolume(null, { sound_muted: true, sound_volume: '50' })).toBeCloseTo(0.5);
    });
});

describe('every alert plays at its volume (the call sites)', () => {
    it('each playAlertSound in App passes alertVolume for the same kind; COUNTED: four, so a new one without it fails here', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
        const calls = src.split('\n').filter((l) => l.includes('playAlertSound(') && !l.trim().startsWith('import') && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
        expect(calls).toHaveLength(4);
        for (const line of calls) expect(line, line.trim()).toMatch(/playAlertSound\((?:alertSound|limitAlertSound)\([^;]*\), alertVolume\(/);
    });
});
