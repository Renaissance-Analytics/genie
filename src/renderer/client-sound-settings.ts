import { useEffect, useState } from 'react';

/**
 * THE LEVELS ARE THIS CLIENT'S (Tynn #1022; the owner's ruling: "activity sounds is a client setting"). Every key in the
 * settings registry is kept in the HOST's one settings.json whatever its declared scope (main/settings-store.ts), and a
 * remote client writes the host's copy — so the master level, mute and per-event levels are not in that registry at all.
 * Each client keeps them here: in its own renderer's localStorage, one JSON object under CLIENT_SOUND_KEY, so a laptop
 * and a phone on the same host each sound as their person set them.
 *
 * The values carry core/sound-volume.ts's key names, so its readers (masterLevel, alertVolume, ...) read them as they
 * are. The player reads them at play time (clientSoundValues), so a change is heard on the next sound; Settings follows
 * them (useClientSound), and another window of this client hears of a change through the browser's `storage` event.
 */
export const CLIENT_SOUND_KEY = 'genie.client.sound-volume';
export type ClientSoundKey = 'alert_volume' | 'alert_muted' | 'alert_levels';

type Values = Readonly<Record<string, boolean | string>>;
const TYPES: Readonly<Record<ClientSoundKey, 'string' | 'boolean'>> = { alert_volume: 'string', alert_muted: 'boolean', alert_levels: 'string' };

function storage(): Storage | null {
    try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** What this client keeps: only the three keys, each of its own type; a broken store is nothing kept, never a throw. */
export function clientSoundValues(): Values {
    let raw: unknown;
    try { raw = JSON.parse(storage()?.getItem(CLIENT_SOUND_KEY) ?? '{}'); } catch { return {}; }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, boolean | string> = {};
    for (const [k, t] of Object.entries(TYPES)) {
        const v = (raw as Record<string, unknown>)[k];
        if (typeof v === t) out[k] = v as boolean | string;
    }
    return out;
}

const listeners = new Set<() => void>();

/** Keep one of the three on this client, and tell whoever listens in this window. */
export function setClientSound(key: ClientSoundKey, value: boolean | string): void {
    const s = storage();
    if (!s) return;
    try { s.setItem(CLIENT_SOUND_KEY, JSON.stringify({ ...clientSoundValues(), [key]: value })); } catch { return; /* storage full or refused: the level stays as it was */ }
    for (const l of [...listeners]) l();
}

/** Hear every change: this window's, and another window's of this client (the `storage` event, for this key only). */
export function subscribeClientSound(listener: () => void): () => void {
    listeners.add(listener);
    const onStorage = (e: StorageEvent) => { if (e.key === CLIENT_SOUND_KEY || e.key === null) listener(); };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
        listeners.delete(listener);
        if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
}

/** This client's levels, kept current: for Settings, which draws them. */
export function useClientSound(): Values {
    const [values, setValues] = useState<Values>(clientSoundValues);
    useEffect(() => subscribeClientSound(() => setValues(clientSoundValues())), []);
    return values;
}
