import { editorBytesAccess, type ClaimingEditor, type EditorBytesDecision } from '../core/plugin-editors.js';
import type { PluginEntry } from './plugin-host.js';
import type { PluginsDump } from './plugins-host.js';

/**
 * The plugins as a window uses them (Settings → Plugins, the `+plugin` panels, which editor opens a file, whether that
 * editor may touch the file's bytes). Genie-host's, through `PluginsReplica` (ADF A3, Tynn #447); `NO_PLUGINS` when this
 * window has no host to ask (the emergency path has none).
 */
export interface PluginsApi {
    list(): readonly PluginEntry[];
    panels(): PluginsDump['panels'];
    editors(): readonly ClaimingEditor[];
    /** May this plugin's editor read and write this file's bytes? Only an ENABLED plugin, only its claimed + declared types. */
    editorBytes(pluginId: string, path: string): EditorBytesDecision;
    /** Asks the host; `false` for a plugin that is not installable or unknown. */
    setEnabled(pluginId: string, enabled: boolean): Promise<boolean>;
    /** The host re-reads the plugins folder (developer mode flipped, a plugin was dropped in). */
    refresh(): Promise<void>;
}

const EMPTY: PluginsDump = { entries: [], panels: [], editors: [], manifests: {} };

/** genie-host's plugins, as this window holds them: the last dump the host sent, and calls that ask the host. */
export class PluginsReplica implements PluginsApi {
    #dump: PluginsDump = EMPTY;
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) {
        this.#call = call;
    }

    rebase(dump: PluginsDump): void {
        this.#dump = dump;
    }

    list(): readonly PluginEntry[] { return this.#dump.entries; }
    panels(): PluginsDump['panels'] { return this.#dump.panels; }
    editors(): readonly ClaimingEditor[] { return this.#dump.editors; }

    editorBytes(pluginId: string, path: string): EditorBytesDecision {
        const entry = this.#dump.entries.find((e) => e.id === pluginId);
        const manifest = this.#dump.manifests[pluginId];
        if (!entry || entry.state !== 'enabled' || !manifest) return { allowed: false, reason: `${pluginId} is not an enabled plugin` };
        return editorBytesAccess(manifest, path);
    }

    async setEnabled(pluginId: string, enabled: boolean): Promise<boolean> {
        return (await this.#call('setEnabled', [pluginId, enabled])) === true;
    }

    async refresh(): Promise<void> {
        await this.#call('refresh', []);
    }
}

/** A window with no host: no plugins, and nothing to change. */
export const NO_PLUGINS: PluginsApi = {
    list: () => [],
    panels: () => [],
    editors: () => [],
    editorBytes: (pluginId) => ({ allowed: false, reason: `${pluginId} is not available: Genie's host is not running` }),
    setEnabled: async () => false,
    refresh: async () => {},
};
