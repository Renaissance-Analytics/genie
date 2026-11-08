import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bridgeAccess, parseManifest, UNVERIFIED_LABEL, type AccessDecision, type AccessRequest, type PluginCapabilities, type PluginManifest } from '../core/plugins.js';
import { checkPackage, currentDigest } from './plugin-package.js';
import { editorBytesAccess, type ClaimingEditor, type EditorBytesDecision } from '../core/plugin-editors.js';
import type { OfficialPlugin } from '../core/official-plugins.js';

/**
 * THE PLUGIN HOST (§6.7). Scans a plugins directory: every folder with a `genie-plugin.json` is listed
 * with its state — enabled, disabled, refused (unsigned without developer mode), invalid (a manifest
 * Genie cannot vouch for) — and the reason, so nothing is silently dropped. Enable/disable is persisted
 * beside the plugins. The bridge asks `guard(id)` for a checker bound to the plugin's DECLARED
 * capabilities; an unknown, refused, invalid or disabled plugin has no guard, so it can do nothing.
 */

import type { PluginTool } from '../core/plugins.js';

export type PluginState = 'enabled' | 'disabled' | 'refused' | 'invalid';

/** How an official plugin is labelled wherever it shows — where a folder plugin says who signed it. */
export const OFFICIAL_LABEL = 'official — ships with Genie';
const OFFICIAL_FOLDER = '(official)';

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
    /** ADF B5: running only because publisher checks are off. Absent for a refused or invalid entry. */
    readonly unverified?: boolean;
    /** The hosts its manifest declares. */
    readonly networkHosts?: readonly string[];
    /** May it reach them now: a signed package always; an Unverified one only once the person allowed it. */
    readonly networkAllowed?: boolean;
}

interface Loaded extends PluginEntry {
    readonly manifest: PluginManifest | null;
    /** ADF B4: the digest a SIGNED package was loaded with, re-checked before each run of its tools; null otherwise. */
    readonly digest?: string | null;
}

export class PluginHost {
    readonly #entries: Loaded[];
    readonly #dir: string;
    readonly #stateFile: string;
    #disabled: Set<string>;
    /** ADF B5: the Unverified packages the person allowed network, by id; kept beside the plugins. */
    readonly #networkFile: string;
    readonly #networkAllowed: Set<string>;

    private constructor(entries: Loaded[], dir: string, stateFile: string, disabled: Set<string>, networkFile: string, networkAllowed: Set<string>) {
        this.#entries = entries;
        this.#dir = dir;
        this.#stateFile = stateFile;
        this.#disabled = disabled;
        this.#networkFile = networkFile;
        this.#networkAllowed = networkAllowed;
    }

    /**
     * `official` = the plugins that ship IN Genie (core/official-plugins.ts): trusted by construction, so they need no
     * publisher key and no developer mode; listed first; a folder claiming one of their ids is refused, not admitted.
     */
    static async open(input: { dir: string; keys: Readonly<Record<string, string>>; publisherChecksOff: boolean; official?: readonly OfficialPlugin[] }): Promise<PluginHost> {
        const stateFile = join(input.dir, 'plugins-state.json');
        const readIds = async (file: string): Promise<Set<string>> => {
            try {
                const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
                if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'));
            } catch { /* nothing kept yet */ }
            return new Set();
        };
        const disabled = await readIds(stateFile);
        const networkFile = join(input.dir, 'plugins-network.json');
        const networkAllowed = await readIds(networkFile);

        let folders: string[] = [];
        try {
            folders = (await readdir(input.dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
        } catch { /* a missing plugins directory means no plugins — not an error */ }

        const entries: Loaded[] = [];
        const officialIds = new Set<string>();
        for (const o of input.official ?? []) {
            const parsed = parseManifest(o.manifest);
            // An official manifest that does not parse is Genie's own bug: listed invalid with the parser's words, never hidden.
            if (!parsed.ok) { entries.push({ id: `(official ${String(o.manifest.id)})`, folder: OFFICIAL_FOLDER, name: String(o.manifest.name), version: null, state: 'invalid', label: null, reason: parsed.reason, manifest: null }); continue; }
            officialIds.add(parsed.manifest.id);
            entries.push({ id: parsed.manifest.id, folder: OFFICIAL_FOLDER, name: parsed.manifest.name, version: parsed.manifest.version, state: disabled.has(parsed.manifest.id) ? 'disabled' : 'enabled', label: OFFICIAL_LABEL, reason: null, manifest: parsed.manifest, unverified: false, networkHosts: [...parsed.manifest.capabilities.network.hosts], networkAllowed: true });
        }
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
            if (officialIds.has(parsed.manifest.id)) {
                entries.push({ id: `(${folder})`, folder, name: parsed.manifest.name, version: parsed.manifest.version, state: 'invalid', label: null, reason: `${parsed.manifest.id} is an official plugin that ships with Genie; a folder cannot replace it`, manifest: null });
                continue;
            }
            // ADF B4: the signature covers EVERY file of the package (core/plugin-integrity.ts), not the manifest alone.
            const { decision, digest } = await checkPackage(join(input.dir, folder), { keyId: parsed.manifest.publisher.keyId, keys: input.keys, publisherChecksOff: input.publisherChecksOff });
            if (!decision.install) {
                entries.push({ id: parsed.manifest.id, folder, name: parsed.manifest.name, version: parsed.manifest.version, state: 'refused', label: null, reason: decision.reason, manifest: parsed.manifest });
                continue;
            }
            const unverified = decision.label === UNVERIFIED_LABEL;
            entries.push({
                id: parsed.manifest.id, folder, name: parsed.manifest.name, version: parsed.manifest.version, state: disabled.has(parsed.manifest.id) ? 'disabled' : 'enabled', label: decision.label, reason: null, manifest: parsed.manifest, digest,
                unverified, networkHosts: [...parsed.manifest.capabilities.network.hosts], networkAllowed: !unverified || networkAllowed.has(parsed.manifest.id),
            });
        }
        // Installable first, then refused, then invalid — the person reads what works before what does not.
        const rank: Record<PluginState, number> = { enabled: 0, disabled: 0, refused: 1, invalid: 2 };
        entries.sort((a, b) => rank[a.state] - rank[b.state]);
        return new PluginHost(entries, input.dir, stateFile, disabled, networkFile, networkAllowed);
    }

    /** The MCP tools of ENABLED plugins (§6.7), each with its folder and manifest — what the MCP surface offers agents. */
    tools(): readonly { pluginId: string; dir: string; manifest: NonNullable<Loaded['manifest']>; tool: PluginTool; official: boolean; verify: () => Promise<string | null> }[] {
        // `official`: Genie's own tool, run in-process (main/official-tools.ts) — there is no plugin folder to launch from.
        // `verify`: ADF B4, the package checked again before the run (null = run it; else why it is refused).
        return this.#entries.flatMap((e) =>
            e.state === 'enabled' && e.manifest ? e.manifest.mcpTools.map((tool) => ({ pluginId: e.id, dir: join(this.#dir, e.folder), manifest: this.#effective(e)!, tool, official: e.folder === OFFICIAL_FOLDER, verify: () => this.#verifyAtLoad(e.id) })) : [],
        );
    }

    /**
     * Before a signed package's code is loaded to run (ADF B4): its files must still be the ones signed. Changed, the
     * package is refused from now on, so nothing calls it again. An unsigned package (developer mode) and Genie's own
     * have no signed digest to hold to.
     */
    async #verifyAtLoad(pluginId: string): Promise<string | null> {
        const index = this.#entries.findIndex((e) => e.id === pluginId);
        const entry = this.#entries[index];
        if (!entry) return `${pluginId} is not a plugin Genie has`;
        if (entry.state !== 'enabled') return entry.reason ?? `${pluginId} is not enabled`;
        if (!entry.digest) return null;
        const now = await currentDigest(join(this.#dir, entry.folder));
        if (now.ok && now.digest === entry.digest) return null;
        const reason = `refused as tampered: ${now.ok ? 'a file changed, was added or was removed since the package was loaded, after it was signed' : now.reason}. A package changed after it was signed never runs, with publisher checks on or off.`;
        this.#entries[index] = { ...entry, state: 'refused', label: null, reason, digest: null };
        return reason;
    }

    /** The panels ENABLED plugins contribute (§6.7), each with its plugin's id and name — what the Workspace surface offers as `+plugin`. */
    panels(): readonly { pluginId: string; pluginName: string; id: string; title: string; fancyComponent: { export: string }; props: Readonly<Record<string, unknown>> }[] {
        return this.#entries.flatMap((e) =>
            e.state === 'enabled' && e.manifest ? e.manifest.panels.map((p) => ({ pluginId: e.id, pluginName: e.name, id: p.id, title: p.title, fancyComponent: { export: p.fancyComponent.export }, props: p.props })) : [],
        );
    }

    /** The editors ENABLED plugins declare, in list order (official first) — what the renderer routes files with. */
    editors(): readonly ClaimingEditor[] {
        return this.#entries.flatMap((e) => (e.state === 'enabled' && e.manifest ? (e.manifest.editors ?? []).map((ed) => ({ ...ed, pluginId: e.id, pluginName: e.name })) : []));
    }

    /** May this plugin's editor read and write this file's bytes? Only an ENABLED plugin, only its own claimed + declared types. */
    editorBytes(pluginId: string, path: string): EditorBytesDecision {
        const entry = this.#entries.find((e) => e.id === pluginId);
        if (!entry || !entry.manifest || entry.state !== 'enabled') return { allowed: false, reason: `${pluginId} is not an enabled plugin` };
        return editorBytesAccess(entry.manifest, path);
    }

    /** Every installable plugin's manifest, by id (refused and invalid ones have none to trust): what a window decides from. */
    manifests(): Readonly<Record<string, PluginManifest>> {
        return Object.fromEntries(this.#entries.filter((e) => e.manifest && (e.state === 'enabled' || e.state === 'disabled')).map((e) => [e.id, e.manifest!]));
    }

    list(): readonly PluginEntry[] {
        return this.#entries.map(({ manifest: _m, ...entry }) => entry);
    }

    /** The bridge's checker for an ENABLED plugin; `null` for anything else, so nothing undeclared can even be asked. */
    guard(pluginId: string): ((request: AccessRequest) => AccessDecision) | null {
        const entry = this.#entries.find((e) => e.id === pluginId);
        if (!entry || !entry.manifest || entry.state !== 'enabled') return null;
        const manifest = entry.manifest;
        // ADF B5: an Unverified package has no network until the person allows it, whatever it declares.
        const offline = entry.unverified === true && entry.networkAllowed !== true;
        return (request) => (request.kind === 'network' && offline
            ? { allowed: false, reason: `${manifest.id} is Unverified (publisher checks are off), so it has no network until you allow it for this package in Settings → Plugins` }
            : bridgeAccess(manifest, request));
    }

    /**
     * What an ENABLED plugin's tool may reach as it runs (its sandbox, plugin-runner.ts), read at the run: the declared
     * capabilities, with no network for an Unverified package the person has not allowed (ADF B5). Null: not enabled.
     */
    capabilities(pluginId: string): PluginCapabilities | null {
        const entry = this.#entries.find((e) => e.id === pluginId);
        if (!entry || entry.state !== 'enabled') return null;
        return this.#effective(entry)?.capabilities ?? null;
    }

    /** Allow or take back an Unverified package's network (ADF B5), kept. `false` for any package that is not Unverified. */
    async setNetworkAllowed(pluginId: string, allowed: boolean): Promise<boolean> {
        const index = this.#entries.findIndex((e) => e.id === pluginId);
        const entry = this.#entries[index];
        if (!entry || entry.unverified !== true || (entry.state !== 'enabled' && entry.state !== 'disabled')) return false;
        if (allowed) this.#networkAllowed.add(pluginId); else this.#networkAllowed.delete(pluginId);
        this.#entries[index] = { ...entry, networkAllowed: allowed };
        await mkdir(dirname(this.#networkFile), { recursive: true });
        const tmp = `${this.#networkFile}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify([...this.#networkAllowed]), 'utf8');
        await rename(tmp, this.#networkFile);
        return true;
    }

    /** The manifest a run and the catalog see: an Unverified package not allowed network declares no hosts. */
    #effective(entry: Loaded): PluginManifest | null {
        const m = entry.manifest;
        if (!m) return null;
        if (entry.unverified !== true || entry.networkAllowed === true) return m;
        return { ...m, capabilities: { ...m.capabilities, network: { hosts: [] } } };
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
