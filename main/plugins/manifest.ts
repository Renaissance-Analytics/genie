/**
 * Genie plugin + marketplace manifest schema + strict validators.
 *
 * PURE (no I/O, no Electron) so the parse/validate rules are unit-testable and
 * shared by both the desktop shell and a headless host. Two manifest kinds:
 *
 *   - `genie-plugin.json`      — one installable plugin (this file's PluginManifest)
 *   - `genie-marketplace.json` — a git repo that INDEXES many plugins (MarketplaceManifest)
 *
 * The shapes follow the design doc (`.ai/_discovery/genie-plugin-system.md` §3.1)
 * AS AMENDED BY §12:
 *   - §12.1 tools carry a per-tool `process` ('worker' default | 'subprocess'),
 *     and capabilities are declared granularly (each fs scope / network host /
 *     Genie API is an independent grant the user can toggle).
 *   - §12.2 editors DECLARE a first-party Fancy editor mapping (package@version +
 *     export) — a plugin never ships editor UI code. This models the declared
 *     mapping only; wiring the editor is Phase 2.
 *   - §12.3 the manifest is SIGNING-READY: optional `integrity` + `publisher.keyId`
 *     ride here so integrity pins can be enforced later without a schema change.
 *
 * Validation is deliberately STRICT with clear, itemised errors — a bad manifest
 * must be rejected loudly at install, never half-loaded.
 */

export const PLUGIN_MANIFEST_FILENAME = 'genie-plugin.json';
export const MARKETPLACE_MANIFEST_FILENAME = 'genie-marketplace.json';

/** How a tool's code is isolated (§12.1). Worker is the secure default. */
export type PluginToolProcess = 'worker' | 'subprocess';

/** A JSON-Schema-ish object schema for a tool's arguments (must be type:object). */
export interface JsonSchemaObject {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
}

/** Publisher/provenance block — `keyId` is the signing key ref (Phase 3). */
export interface PluginPublisher {
    name: string;
    url?: string;
    keyId?: string;
}

/** One MCP tool the plugin contributes to Genie's agent-facing surface. */
export interface PluginMcpTool {
    /** Bare tool slug; namespaced at runtime → `${namespace}.${name}`. */
    name: string;
    description: string;
    /** JSON Schema for the arguments (object schema). */
    inputSchema: JsonSchemaObject;
    /** Which entry module exports the handler (a key in `entry`). Default 'tools'. */
    run?: string;
    /** Isolation for THIS tool (§12.1). Default 'worker'. */
    process?: PluginToolProcess;
    /** Route each call through install/per-call consent (§5.4). Default false. */
    gated?: boolean;
}

/** A DECLARED first-party Fancy editor mapping for a file type (§12.2). */
export interface PluginEditorMapping {
    id: string;
    title: string;
    /** File extensions this editor claims at install (e.g. ['.pptx', '.odp']). */
    extensions: string[];
    /**
     * The first-party Fancy editor to load — a package@version + export. Genie
     * loads it from a vetted, integrity-pinned Fancy source; the plugin NEVER
     * ships editor bundle code (§12.2).
     */
    fancyEditor: { package: string; version: string; export: string };
    /** UI contributions (e.g. the Present button). Phase 2 wires these. */
    toolbarActions?: Array<{
        id: string;
        title: string;
        icon?: string;
        mode?: string;
    }>;
}

/** Granular declared capabilities. Each entry is an independent grant (§12.1). */
export interface PluginCapabilities {
    /** Filesystem: a named scope + an extension allow-list (guard-resolved). */
    fs?: { scope: 'workspace' | 'none'; extensions?: string[] };
    /** Network: an allow-list of hosts. Empty/absent = no network (fail-closed). */
    network?: { hosts: string[] };
    /** The explicit list of Genie APIs the plugin may call. */
    genieApi?: string[];
}

export interface PluginManifest {
    /** Reverse-DNS, globally unique (e.g. com.particle-academy.presentation). */
    id: string;
    /** Tool namespace slug ([a-z0-9-]) — tools list as `${namespace}.${tool}`. */
    namespace: string;
    name: string;
    /** Semver. */
    version: string;
    description?: string;
    publisher?: PluginPublisher;
    /** Min Genie API version (semver range). */
    engines?: { genie?: string };
    /** Named entry modules (relative paths), keyed by a tool's `run`. */
    entry?: { tools?: string };
    mcpTools?: PluginMcpTool[];
    editors?: PluginEditorMapping[];
    capabilities?: PluginCapabilities;
    /** npm deps the plugin needs (audited/pinned downstream). */
    dependencies?: Record<string, string>;
    /** Signing-ready: integrity hash of the bundle (set by install/registry). */
    integrity?: string;
}

/** One member plugin listed by a marketplace index. */
export interface MarketplacePluginEntry {
    /** Reverse-DNS id; must match the plugin's own manifest id when installed. */
    id: string;
    name: string;
    description?: string;
    /** Git URL when the plugin lives in its OWN repo. */
    repo?: string;
    /** Subdirectory within the marketplace repo when `repo` is omitted. */
    path?: string;
    /** Pinned git ref (signing-ready). */
    ref?: string;
}

export interface MarketplaceManifest {
    /** Reverse-DNS, globally unique. */
    id: string;
    name: string;
    description?: string;
    publisher?: PluginPublisher;
    plugins: MarketplacePluginEntry[];
}

export type ValidationResult<T> =
    | { ok: true; manifest: T }
    | { ok: false; errors: string[] };

// --- validation helpers ------------------------------------------------------

const REVERSE_DNS = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i;
const NAMESPACE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_SLUG = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
    return typeof v === 'string';
}
function nonEmpty(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate a parsed `genie-plugin.json`. Returns the typed manifest or a list of
 * every problem found (all collected, not first-fail, so an author sees the full
 * picture in one pass).
 */
export function validatePluginManifest(raw: unknown): ValidationResult<PluginManifest> {
    const errors: string[] = [];
    if (!isRecord(raw)) {
        return { ok: false, errors: ['manifest must be a JSON object'] };
    }

    if (!nonEmpty(raw.id)) errors.push('`id` is required (a non-empty string)');
    else if (!REVERSE_DNS.test(raw.id))
        errors.push('`id` must be reverse-DNS (e.g. com.example.my-plugin)');

    if (!nonEmpty(raw.namespace)) errors.push('`namespace` is required (a non-empty string)');
    else if (!NAMESPACE_SLUG.test(raw.namespace))
        errors.push('`namespace` must be a lowercase slug ([a-z0-9] with dashes)');

    if (!nonEmpty(raw.name)) errors.push('`name` is required (a non-empty string)');

    if (!nonEmpty(raw.version)) errors.push('`version` is required (a non-empty string)');
    else if (!SEMVER.test(raw.version)) errors.push('`version` must be semver (e.g. 1.0.0)');

    if (raw.description !== undefined && !isStr(raw.description))
        errors.push('`description` must be a string when present');

    if (raw.publisher !== undefined) {
        if (!isRecord(raw.publisher)) errors.push('`publisher` must be an object when present');
        else {
            if (!nonEmpty(raw.publisher.name)) errors.push('`publisher.name` is required when `publisher` is present');
            if (raw.publisher.url !== undefined && !isStr(raw.publisher.url))
                errors.push('`publisher.url` must be a string when present');
            if (raw.publisher.keyId !== undefined && !isStr(raw.publisher.keyId))
                errors.push('`publisher.keyId` must be a string when present');
        }
    }

    if (raw.engines !== undefined) {
        if (!isRecord(raw.engines)) errors.push('`engines` must be an object when present');
        else if (raw.engines.genie !== undefined && !isStr(raw.engines.genie))
            errors.push('`engines.genie` must be a string when present');
    }

    if (raw.entry !== undefined) {
        if (!isRecord(raw.entry)) errors.push('`entry` must be an object when present');
        else if (raw.entry.tools !== undefined && !nonEmpty(raw.entry.tools))
            errors.push('`entry.tools` must be a non-empty string when present');
    }

    // mcpTools --------------------------------------------------------------
    const toolNames = new Set<string>();
    if (raw.mcpTools !== undefined) {
        if (!Array.isArray(raw.mcpTools)) {
            errors.push('`mcpTools` must be an array when present');
        } else {
            raw.mcpTools.forEach((t, i) => {
                const at = `mcpTools[${i}]`;
                if (!isRecord(t)) {
                    errors.push(`${at} must be an object`);
                    return;
                }
                if (!nonEmpty(t.name)) errors.push(`${at}.name is required`);
                else if (!TOOL_SLUG.test(t.name))
                    errors.push(`${at}.name must start with a letter and use [A-Za-z0-9_]`);
                else if (toolNames.has(t.name)) errors.push(`${at}.name "${t.name}" is duplicated`);
                else toolNames.add(t.name);

                if (!nonEmpty(t.description)) errors.push(`${at}.description is required`);

                if (!isRecord(t.inputSchema) || t.inputSchema.type !== 'object')
                    errors.push(`${at}.inputSchema is required and must be a JSON Schema with type:"object"`);

                if (t.run !== undefined && !nonEmpty(t.run))
                    errors.push(`${at}.run must be a non-empty string when present`);

                if (t.process !== undefined && t.process !== 'worker' && t.process !== 'subprocess')
                    errors.push(`${at}.process must be "worker" or "subprocess" when present`);

                if (t.gated !== undefined && typeof t.gated !== 'boolean')
                    errors.push(`${at}.gated must be a boolean when present`);

                // A tool needs a resolvable entry module. Its `run` (default
                // 'tools') must map to an `entry` key.
                const runKey = nonEmpty(t.run) ? t.run : 'tools';
                const entry = isRecord(raw.entry) ? raw.entry : undefined;
                if (!entry || !nonEmpty(entry[runKey]))
                    errors.push(`${at} needs entry.${runKey} pointing at its tools module`);
            });
        }
    }

    // editors ---------------------------------------------------------------
    if (raw.editors !== undefined) {
        if (!Array.isArray(raw.editors)) {
            errors.push('`editors` must be an array when present');
        } else {
            raw.editors.forEach((e, i) => {
                const at = `editors[${i}]`;
                if (!isRecord(e)) {
                    errors.push(`${at} must be an object`);
                    return;
                }
                if (!nonEmpty(e.id)) errors.push(`${at}.id is required`);
                if (!nonEmpty(e.title)) errors.push(`${at}.title is required`);
                if (
                    !Array.isArray(e.extensions) ||
                    e.extensions.length === 0 ||
                    !e.extensions.every((x) => nonEmpty(x) && (x as string).startsWith('.'))
                )
                    errors.push(`${at}.extensions must be a non-empty array of dot-prefixed extensions (e.g. ".pptx")`);
                // §12.2: DECLARED first-party Fancy editor, not a shipped bundle.
                if (!isRecord(e.fancyEditor)) {
                    errors.push(`${at}.fancyEditor is required (a first-party Fancy package@version + export — plugins never ship editor UI)`);
                } else {
                    if (!nonEmpty(e.fancyEditor.package)) errors.push(`${at}.fancyEditor.package is required`);
                    if (!nonEmpty(e.fancyEditor.version)) errors.push(`${at}.fancyEditor.version is required`);
                    if (!nonEmpty(e.fancyEditor.export)) errors.push(`${at}.fancyEditor.export is required`);
                }
            });
        }
    }

    // capabilities ----------------------------------------------------------
    if (raw.capabilities !== undefined) {
        if (!isRecord(raw.capabilities)) {
            errors.push('`capabilities` must be an object when present');
        } else {
            const caps = raw.capabilities;
            if (caps.fs !== undefined) {
                if (!isRecord(caps.fs)) errors.push('`capabilities.fs` must be an object when present');
                else {
                    if (caps.fs.scope !== 'workspace' && caps.fs.scope !== 'none')
                        errors.push('`capabilities.fs.scope` must be "workspace" or "none"');
                    if (
                        caps.fs.extensions !== undefined &&
                        (!Array.isArray(caps.fs.extensions) || !caps.fs.extensions.every(isStr))
                    )
                        errors.push('`capabilities.fs.extensions` must be a string array when present');
                }
            }
            if (caps.network !== undefined) {
                if (!isRecord(caps.network) || !Array.isArray(caps.network.hosts) || !caps.network.hosts.every(isStr))
                    errors.push('`capabilities.network.hosts` must be a string array');
            }
            if (caps.genieApi !== undefined && (!Array.isArray(caps.genieApi) || !caps.genieApi.every(isStr)))
                errors.push('`capabilities.genieApi` must be a string array when present');
        }
    }

    if (raw.dependencies !== undefined) {
        if (!isRecord(raw.dependencies) || !Object.values(raw.dependencies).every(isStr))
            errors.push('`dependencies` must be an object of string version specs when present');
    }

    if (raw.integrity !== undefined && !isStr(raw.integrity))
        errors.push('`integrity` must be a string when present');

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, manifest: raw as unknown as PluginManifest };
}

/**
 * Validate a parsed `genie-marketplace.json` — a repo indexing many plugins.
 * Members are installed INDIVIDUALLY; a single-plugin repo is just the
 * degenerate case (install it directly by URL, no marketplace needed).
 */
export function validateMarketplaceManifest(raw: unknown): ValidationResult<MarketplaceManifest> {
    const errors: string[] = [];
    if (!isRecord(raw)) {
        return { ok: false, errors: ['marketplace manifest must be a JSON object'] };
    }

    if (!nonEmpty(raw.id)) errors.push('`id` is required (a non-empty string)');
    else if (!REVERSE_DNS.test(raw.id)) errors.push('`id` must be reverse-DNS (e.g. com.example.marketplace)');

    if (!nonEmpty(raw.name)) errors.push('`name` is required (a non-empty string)');

    if (raw.description !== undefined && !isStr(raw.description))
        errors.push('`description` must be a string when present');

    if (raw.publisher !== undefined) {
        if (!isRecord(raw.publisher)) errors.push('`publisher` must be an object when present');
        else if (!nonEmpty(raw.publisher.name)) errors.push('`publisher.name` is required when `publisher` is present');
    }

    const ids = new Set<string>();
    if (!Array.isArray(raw.plugins)) {
        errors.push('`plugins` is required and must be an array of member entries');
    } else {
        raw.plugins.forEach((p, i) => {
            const at = `plugins[${i}]`;
            if (!isRecord(p)) {
                errors.push(`${at} must be an object`);
                return;
            }
            if (!nonEmpty(p.id)) errors.push(`${at}.id is required`);
            else if (!REVERSE_DNS.test(p.id)) errors.push(`${at}.id must be reverse-DNS`);
            else if (ids.has(p.id)) errors.push(`${at}.id "${p.id}" is duplicated`);
            else ids.add(p.id);

            if (!nonEmpty(p.name)) errors.push(`${at}.name is required`);
            if (p.description !== undefined && !isStr(p.description))
                errors.push(`${at}.description must be a string when present`);
            // A member must be locatable: its own repo URL, or a path within the
            // marketplace repo. Neither → it can't be fetched.
            if (!nonEmpty(p.repo) && !nonEmpty(p.path))
                errors.push(`${at} must set either \`repo\` (its own git URL) or \`path\` (a subdir of the marketplace repo)`);
            if (p.repo !== undefined && !isStr(p.repo)) errors.push(`${at}.repo must be a string when present`);
            if (p.path !== undefined && !isStr(p.path)) errors.push(`${at}.path must be a string when present`);
            if (p.ref !== undefined && !isStr(p.ref)) errors.push(`${at}.ref must be a string when present`);
        });
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, manifest: raw as unknown as MarketplaceManifest };
}

/** The runtime-namespaced name for a plugin tool: `${namespace}.${tool}`. */
export function namespacedToolName(namespace: string, tool: string): string {
    return `${namespace}.${tool}`;
}
