import { snapshotForOf, snapshotOf, type SettingValue, type SettingsData } from './settings-read.js';
import { callRefusal, type OwnCallAnswer } from './own-protocol-client.js';
import { EMPTY_SETTINGS_DATA, type SettingsWatchView } from './settings-watch.js';

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
    /** Settles once genie-host has said its settings, or at the deadline: what the boot reads (start minimized, the login item). */
    ready(deadlineMs: number): Promise<void>;
    /** Starts the watch: once main's own client's door is tunnelled, so its first ask is answered rather than retried. */
    start(): void;
}

export function windowSettings(own: { call(method: 'features.act' | 'workspaces.setSetting', args: unknown[]): Promise<OwnCallAnswer>; watchSettings(onView: (view: SettingsWatchView) => void): () => void }): WindowSettings {
    let data: SettingsData = EMPTY_SETTINGS_DATA;
    let said = false;
    const waiting = new Set<() => void>();
    const listeners = new Set<(key: string, value: SettingValue, workspaceId?: string) => void>();
    let started = false;
    const start = (): void => {
        if (started) return;
        started = true;
        own.watchSettings((view) => {
            data = view.data;
            if (!said) { said = true; for (const w of [...waiting]) w(); waiting.clear(); }
            if (view.key === null) return;
            for (const l of [...listeners]) {
                if (view.workspaceId === null) l(view.key, view.value as SettingValue); else l(view.key, view.value as SettingValue, view.workspaceId);
            }
        });
    };
    const done = async (answer: Promise<OwnCallAnswer>): Promise<void> => {
        const reason = callRefusal(await answer);
        if (reason !== null) throw new Error(reason);
    };
    return {
        start,
        snapshot: () => snapshotOf(data),
        snapshotFor: (workspaceId) => snapshotForOf(data, workspaceId),
        onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        set: (key, value) => done(own.call('features.act', [{ kind: 'settings.set', key, value }])),
        setFor: (workspaceId, key, value) => done(own.call('workspaces.setSetting', [workspaceId, key, value])),
        ready: (deadlineMs) => (said ? Promise.resolve() : new Promise<void>((resolve) => {
            const timer = setTimeout(() => { waiting.delete(go); resolve(); }, deadlineMs);
            const go = () => { clearTimeout(timer); resolve(); };
            waiting.add(go);
        })),
    };
}
