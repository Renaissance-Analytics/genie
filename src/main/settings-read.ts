import { SETTINGS, type SettingDef } from '../core/settings.js';

/**
 * THE SETTINGS' READS, over their data (the host split, P3.2). One implementation for the store that owns the file
 * (main/settings-store.ts, in genie-host) and every window's replica of it (main/agent-stores-replica.ts), so a value read
 * in a window is the value the host holds — defaults and workspace overrides included.
 */

export type SettingValue = boolean | string;

/** What the settings keep: the person's own values, each workspace's overrides, and the Genie 1 carry-over record. */
export interface SettingsData {
    readonly values: Readonly<Record<string, SettingValue>>;
    readonly workspaces: Readonly<Record<string, Readonly<Record<string, SettingValue>>>>;
    readonly carriedOver: unknown;
}

const BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((s) => [s.key, s]));

export function settingOf(data: SettingsData, key: string): SettingValue {
    const def = BY_KEY.get(key);
    if (!def) throw new Error(`${key} is not a setting Genie knows`);
    return data.values[key] ?? def.default;
}

export function snapshotOf(data: SettingsData): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {};
    for (const def of SETTINGS) out[def.key] = data.values[def.key] ?? def.default;
    return out;
}

export function workspaceValuesOf(data: SettingsData, workspaceId: string): Record<string, SettingValue> {
    return { ...(data.workspaces[workspaceId] ?? {}) };
}

export function snapshotForOf(data: SettingsData, workspaceId: string): Record<string, SettingValue> {
    return { ...snapshotOf(data), ...(data.workspaces[workspaceId] ?? {}) };
}
