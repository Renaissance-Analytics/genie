import type { SettingValue, SettingsData } from './settings-read.js';

/**
 * THE SETTINGS, AS MAIN'S OWN CLIENT WATCHES THEM (Tynn #998, client/host split step 2g-4b1): genie-host's whole settings
 * data, said on `settings.watch` / `local-settings` to main's own client only, then again with each change (which key, for
 * which workspace). main's reads (do not disturb, start minimized, the login item, the tray notice, the window tools)
 * need no stores replica.
 */
export interface SettingsWatchView {
    readonly data: SettingsData;
    /** The change this view follows; null for the first view. */
    readonly key: string | null;
    readonly value: SettingValue | null;
    readonly workspaceId: string | null;
}

export const EMPTY_SETTINGS_DATA: SettingsData = Object.freeze({ values: {}, workspaces: {}, carriedOver: null });
export const EMPTY_SETTINGS_WATCH: SettingsWatchView = Object.freeze({ data: EMPTY_SETTINGS_DATA, key: null, value: null, workspaceId: null });

/** What came over the wire; anything that does not read is no settings at all (each read answers its default). */
const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function readSettingsWatch(raw: unknown): SettingsWatchView {
    if (!rec(raw) || !rec(raw.data) || !rec(raw.data.values) || !rec(raw.data.workspaces)) return EMPTY_SETTINGS_WATCH;
    const workspaces: Record<string, Record<string, SettingValue>> = {};
    for (const [id, values] of Object.entries(raw.data.workspaces)) if (rec(values)) workspaces[id] = values as Record<string, SettingValue>;
    const data: SettingsData = { values: raw.data.values as Record<string, SettingValue>, workspaces, carriedOver: raw.data.carriedOver ?? null };
    const key = typeof raw.key === 'string' ? raw.key : null;
    return { data, key, value: key === null ? null : ((raw.value ?? null) as SettingValue | null), workspaceId: key !== null && typeof raw.workspaceId === 'string' ? raw.workspaceId : null };
}

/** genie-host's settings as a feed: the data now, and each change with what changed. */
export function settingsWatchFeed(ports: { data(): SettingsData; onChange(listener: (key: string, value: SettingValue, workspaceId?: string) => void): () => void }): { now(): SettingsWatchView; subscribe(listener: (view: SettingsWatchView) => void): () => void } {
    const listeners = new Set<(view: SettingsWatchView) => void>();
    ports.onChange((key, value, workspaceId) => {
        const view: SettingsWatchView = { data: ports.data(), key, value, workspaceId: workspaceId ?? null };
        for (const l of [...listeners]) l(view);
    });
    return {
        now: () => ({ data: ports.data(), key: null, value: null, workspaceId: null }),
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}
