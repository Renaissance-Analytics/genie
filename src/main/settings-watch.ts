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
export function readSettingsWatch(_raw: unknown): SettingsWatchView { throw new Error('2g-4b1: not built yet'); }

/** genie-host's settings as a feed: the data now, and each change with what changed. */
export function settingsWatchFeed(_ports: { data(): SettingsData; onChange(listener: (key: string, value: SettingValue, workspaceId?: string) => void): () => void }): { now(): SettingsWatchView; subscribe(listener: (view: SettingsWatchView) => void): () => void } {
    throw new Error('2g-4b1: not built yet');
}
