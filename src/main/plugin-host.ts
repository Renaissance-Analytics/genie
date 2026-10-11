import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bridgeAccess, installDecision, parseManifest, verifyPluginSignature, type AccessDecision, type AccessRequest, type PluginManifest } from '../core/plugins.js';

/**
 * THE PLUGIN HOST (§6.7). Scans a plugins directory: every folder with a `genie-plugin.json` is listed
 * with its state — enabled, disabled, refused (unsigned without developer mode), invalid (a manifest
 * Genie cannot vouch for) — and the reason, so nothing is silently dropped. Enable/disable is persisted
 * beside the plugins. The bridge asks `guard(id)` for a checker bound to the plugin's DECLARED
 * capabilities; an unknown, refused, invalid or disabled plugin has no guard, so it can do nothing.
 */

import type { PluginTool } from '../core/plugins.js';

export type PluginState = 'enabled' | 'disabled' | 'refused' | 'invalid';

export interface PluginEntry {
    readonly id: string;
    readonly folder: string;
    readonly name: string;
    readonly version: string | null;
    readonly state: PluginState;
    /** `signed by <keyId>` or `UNSIGNED — developer mode`; `null` when not installable. */
    readonly label: string | null;
    /** Why refused or invalid; `null` otherwise. */
    readonly reason: string | null;
}

interface Loaded extends PluginEntry {
    readonly manifest: PluginManifest | null;
}

export class PluginHost {
    readonly #entries: Loaded[];
    readonly #dir: string;
    readonly #stateFile: string;
    #disabled: Set<string>;

    private constructor(entries: Loaded[], dir: string, stateFile: string, disabled: Set<string>) {
        this.#entries = entries;
        this.#dir = dir;
        this.#stateFile = stateFile;
        this.#disabled = disabled;
    }

    static async open(input: { dir: string; keys: Readonly<Record<string, string>>; developerMode: boolean }): Promise<PluginHost> {
        const stateFile = join(input.dir, 'plugins-state.json');
        let disabled = new Set<string>();
        try {
            const parsed: unknown = JSON.parse(await readFile(stateFile, 'utf8'));
            if (Array.isArray(parsed)) disabled = new Set(parsed.filter((x): x is string => typeof x === 'string'));
        } catch { /* no state yet */ }

        let folders: string[] = [];
        try {
            folders = (await readdir(input.dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
        } catch { /* a missing plugins directory means no plugins — not an error */ }

        const entries: Loaded[] = [];
        for (const folder of folders) {
            let text: string;
            try {
                text = await readFile(join(input.dir, folder, 'genie-plugin.json'), 'utf8');
            } catch {
                continue; // a folder without a manifest is not a plugin
            }
            let raw: unknown;
            try { raw = JSON.parse(text); } catch { raw = undefined; }
            const parsed = raw === undefined ? { ok: false as const, reason: 'genie-plugin.json is not valid JSON' } : parseManifest(raw);
            if (!parsed.ok) {
                entries.push({ id: `(${folder})`, folder, name: folder, version: null, state: 'invalid', label: null, reason: parsed.reason, manifest: null });
                continue;
            }
            let signature: string | null = null;
            try { signature = await readFile(join(input.dir, folder, 'genie-plugin.sig'), 'utf8'); } catch { signature = null; }
            const decision = installDecision(verifyPluginSignature({ bytes: Buffer.from(text), signature, keyId: parsed.manifest.publisher.keyId }, input.keys), { developerMode: input.developerMode });
            if (!decision.install) {
                entries.push({ id: parsed.manifest.id, folder, name: parsed.manifest.name, version: parsed.manifest.version, state: 'refused', label: null, reason: decision.reason, manifest: parsed.manifest });
                continue;
            }
            entries.push({ id: parsed.manifest.id, folder, name: parsed.manifest.name, version: parsed.manifest.version, state: disabled.has(parsed.manifest.id) ? 'disabled' : 'enabled', label: decision.label, reason: null, manifest: parsed.manifest });
        }
        // Installable first, then refused, then invalid — the person reads what works before what does not.
        const rank: Record<PluginState, number> = { enabled: 0, disabled: 0, refused: 1, invalid: 2 };
        entries.sort((a, b) => rank[a.state] - rank[b.state]);
        return new PluginHost(entries, input.dir, stateFile, disabled);
    }

    /** The MCP tools of ENABLED plugins (§6.7), each with its folder and manifest — what the MCP surface offers agents. */
    tools(): readonly { pluginId: string; dir: string; manifest: NonNullable<Loaded['manifest']>; tool: PluginTool }[] {
        return this.#entries.flatMap((e) =>
            e.state === 'enabled' && e.manifest ? e.manifest.mcpTools.map((tool) => ({ pluginId: e.id, dir: join(this.#dir, e.folder), manifest: e.manifest!, tool })) : [],
        );
    }

    /** The panels ENABLED plugins contribute (§6.7), each with its plugin's id and name — what the Workspace surface offers as `+plugin`. */
    panels(): readonly { pluginId: string; pluginName: string; id: string; title: string; fancyComponent: { export: string }; props: Readonly<Record<string, unknown>> }[] {
        return this.#entries.flatMap((e) =>
            e.state === 'enabled' && e.manifest ? e.manifest.panels.map((p) => ({ pluginId: e.id, pluginName: e.name, id: p.id, title: p.title, fancyComponent: { export: p.fancyComponent.export }, props: p.props })) : [],
        );
    }

    list(): readonly PluginEntry[] {
        return this.#entries.map(({ manifest: _m, ...entry }) => entry);
    }

    /** The bridge's checker for an ENABLED plugin; `null` for anything else, so nothing undeclared can even be asked. */
    guard(pluginId: string): ((request: AccessRequest) => AccessDecision) | null {
        const entry = this.#entries.find((e) => e.id === pluginId);
        if (!entry || !entry.manifest || entry.state !== 'enabled') return null;
        const manifest = entry.manifest;
        return (request) => bridgeAccess(manifest, request);
    }

    /** Persisted. `false` for a plugin that is not installable (refused or invalid) or unknown. */
    async setEnabled(pluginId: string, enabled: boolean): Promise<boolean> {
        const index = this.#entries.findIndex((e) => e.id === pluginId);
        const entry = this.#entries[index];
        if (!entry || !entry.manifest || entry.state === 'refused' || entry.state === 'invalid') return false;
        if (enabled) this.#disabled.delete(pluginId); else this.#disabled.add(pluginId);
        this.#entries[index] = { ...entry, state: enabled ? 'enabled' : 'disabled' };
        await mkdir(dirname(this.#stateFile), { recursive: true });
        const tmp = `${this.#stateFile}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify([...this.#disabled]), 'utf8');
        await rename(tmp, this.#stateFile);
        return true;
    }
}
