import type { AlertKind } from './alerts.js';

/**
 * SOUND VOLUME (Tynn #1022; the owner, 2026-11-22: "can we add volume control to the sound system? And an advanced Volume
 * control for setting levels per event."). A master level (0–100) with a mute, and a level per alert kind (0–100, 100 when
 * never moved); what plays is master × event, as a 0..1 gain the one player (renderer/alert-sound.ts) applies. All three
 * are HOST settings (core/settings.ts), so every client of a host hears the same levels, and a change is heard at once:
 * the renderer reads them from the settings it already holds, nothing is cached.
 *
 * Every reading is forgiving: a level that is not a number reads as 100, never as silence — a broken value must not
 * quietly turn every alert off.
 */
export const SOUND_VOLUME_SETTING = 'alert_volume';
export const SOUND_MUTED_SETTING = 'alert_muted';
export const SOUND_LEVELS_SETTING = 'alert_levels';

type Values = Readonly<Record<string, boolean | string | undefined>>;

/** A percent from anything: a finite number is rounded and clamped to 0..100; anything else is 100. */
function percent(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 100;
}

/** The per-event map as saved: only the kinds the person moved, each a percent. A broken map is no map. */
function levels(raw: boolean | string | undefined): Record<string, number> {
    if (typeof raw !== 'string') return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = percent(v);
        return out;
    } catch {
        return {};
    }
}

/** The master level the person set, 0..100; 100 when never set. */
export function masterLevel(settings: Values): number {
    return percent(settings[SOUND_VOLUME_SETTING]);
}

/** One kind's own level, 0..100; 100 when never moved. */
export function eventLevel(kind: AlertKind, settings: Values): number {
    return levels(settings[SOUND_LEVELS_SETTING])[kind] ?? 100;
}

/** The map with one kind set: the others kept, and 100 dropped (it is what a kind never moved plays at). */
export function withEventLevel(raw: boolean | string | undefined, kind: AlertKind, pct: number): string {
    const next = levels(raw);
    const p = percent(pct);
    if (p === 100) delete next[kind];
    else next[kind] = p;
    return JSON.stringify(next);
}

/**
 * The gain a PREVIEW plays at: master × the kind's level, as 0..1. Mute does not hold a preview, so a sound can still be
 * chosen by ear while Genie is muted. `null` is a sound with no kind of its own (a rate-limit alert): the master alone.
 */
export function previewVolume(kind: AlertKind | null, settings: Values): number {
    return (masterLevel(settings) / 100) * ((kind === null ? 100 : eventLevel(kind, settings)) / 100);
}

/** The gain an ALERT plays at: as a preview, and 0 while muted. */
export function alertVolume(kind: AlertKind | null, settings: Values): number {
    return settings[SOUND_MUTED_SETTING] === true ? 0 : previewVolume(kind, settings);
}
