import { readFile, stat, unlink } from 'node:fs/promises';
import type { HostApiDeps } from './host-api.js';
import type { RepoOpsPorts } from './repo-ops-host.js';
import type { SettingsStore } from './settings-store.js';
import { nodeWorkspaceFs } from './workspace-fs.js';

/**
 * A WORKSPACE'S SETTINGS AND REPOSITORIES, ONE WIRING FOR EVERY PROCESS THAT ANSWERS THEM (Tynn #553, host split P5d.5d). The
 * window and genie-host differ only in which settings store and registry they hold.
 */

type WorkspaceSettings = Pick<SettingsStore, 'snapshotFor' | 'workspaceValues' | 'setFor' | 'resetFor'>;

const refusal = (error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) });

export function workspaceSettingsOps(settings: () => WorkspaceSettings): Pick<HostApiDeps['workspaceOps'], 'settings' | 'setSetting' | 'resetSetting'> {
    return {
        settings: (id) => ({ ok: true as const, values: settings().snapshotFor(id), overridden: Object.keys(settings().workspaceValues(id)) }),
        setSetting: async (id, key, value) => { try { await settings().setFor(id, key, value); return { ok: true as const }; } catch (error) { return refusal(error); } },
        resetSetting: async (id, key) => { try { await settings().resetFor(id, key); return { ok: true as const }; } catch (error) { return refusal(error); } },
    };
}

export function repoOpsPorts(workspace: RepoOpsPorts['registry']['workspace']): RepoOpsPorts {
    return {
        fs: {
            ...nodeWorkspaceFs(),
            // The repo chips read `.git/HEAD` and stat `.git/index.lock`; "Remove stale lock" unlinks it (only when stale).
            readText: async (p) => { try { return await readFile(p, 'utf8'); } catch { return null; } },
            mtime: async (p) => { try { return (await stat(p)).mtimeMs; } catch { return null; } },
            unlink: (p) => unlink(p),
        },
        registry: { workspace },
    };
}
