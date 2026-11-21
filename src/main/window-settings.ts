import type { SettingValue } from './settings-read.js';
import type { OwnCallAnswer } from './own-protocol-client.js';
import type { SettingsWatchView } from './settings-watch.js';

/**
 * THE SETTINGS MAIN READS, FROM GENIE-HOST (Tynn #998, 2g-4b1): kept from `settings.watch` on main's own client, read with
 * the store's own rules (settings-read.ts), and written over the one protocol (features.act settings.set, and
 * workspaces.setSetting for one workspace). HOT-SWAP kept: the data first, then the listeners.
 */
export interface WindowSettings {
    snapshot(): Record<string, SettingValue>;
    snapshotFor(workspaceId: string): Record<string, SettingValue>;
    onChange(listener: (key: string, value: SettingValue, workspaceId?: string) => void): () => void;
    set(key: string, value: unknown): Promise<void>;
    setFor(workspaceId: string, key: string, value: unknown): Promise<void>;
}

export function windowSettings(_own: { call(method: 'features.act' | 'workspaces.setSetting', args: unknown[]): Promise<OwnCallAnswer>; watchSettings(onView: (view: SettingsWatchView) => void): () => void }): WindowSettings {
    throw new Error('2g-4b1: not built yet');
}
