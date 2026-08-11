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

/**
 * A DECLARED plugin PANEL contribution — a workspace panel (like the editor and
 * terminals) that mounts a vetted, Genie-bundled Fancy component. Mirror of
 * {@link PluginEditorMapping}: the plugin DECLARES which first-party Fancy
 * component to render (package@version + export) and never ships panel UI code
 * (owner security rule). The renderer resolves the declared `export` through a
 * COMPILE-TIME adapter registry — it cannot dynamically import an arbitrary
 * package — so an unknown export mounts an inert placeholder rather than running
 * plugin code. Contributing panels requires the grantable `ui.panel` Genie-API
 * permission ({@link PANEL_CAPABILITY}).
 */
export interface PluginPanelContribution {
    id: string;
    title: string;
    /** An icon from Genie's vetted catalog (optional). */
    icon?: string;
    /**
     * The first-party Fancy component this panel renders — a package@version +
     * export. Genie resolves the export through a vetted compile-time registry;
     * the plugin NEVER ships panel bundle code (mirror of `editors[].fancyEditor`).
     */
    fancyComponent: { package: string; version: string; export: string };
    /** Where the panel prefers to open (advisory; the host decides). */
    placement?: 'grid' | 'workspace';
}

/** The Genie-API permission key a panel-contributing plugin must declare + hold. */
export const PANEL_CAPABILITY = 'ui.panel';

/**
 * A DECLARED recipe a plugin contributes to the WizardModal launcher. Because a
 * manifest is JSON, plugin recipes are the SERIALIZABLE subset of the Recipe API
 * — form / choice / terminal / browser(url string). The function-valued step
 * types (`task`) and function fields (browser `check`, url-as-function,
 * `onComplete`) are reserved for FIRST-PARTY in-code recipes, never a JSON
 * manifest. Contributing recipes requires the grantable `recipes` Genie-API
 * permission ({@link RECIPE_CAPABILITY}).
 */
export interface PluginRecipeField {
    key: string;
    label: string;
    type?: 'text' | 'password' | 'number' | 'select';
    placeholder?: string;
    description?: string;
    required?: boolean;
    options?: Array<{ value: string; label: string; description?: string }>;
    defaultValue?: string;
}

export type PluginRecipeStep =
    | { type: 'form'; id: string; title: string; fields: PluginRecipeField[] }
    | {
          type: 'choice';
          id: string;
          title: string;
          options: Array<{ value: string; label: string; description?: string }>;
          multi?: boolean;
      }
    | {
          type: 'terminal';
          id: string;
          title: string;
          command: string;
          args?: string[];
          cwd?: string;
          until?: { pattern?: string; exit?: number };
          capture?: string;
      }
    | { type: 'browser'; id: string; title: string; url: string; pollMs?: number };

export interface PluginRecipeManifest {
    id: string;
    title: string;
    steps: PluginRecipeStep[];
}

/** The Genie-API permission key a recipe-contributing plugin must declare + hold. */
export const RECIPE_CAPABILITY = 'recipes';

/** The serializable step types a plugin manifest may declare. */
const PLUGIN_RECIPE_STEP_TYPES = ['form', 'choice', 'terminal', 'browser'] as const;

/** A DECLARED first-party Fancy component: a package@version + export (provenance
 *  + the renderer's compile-time adapter-registry key). Shared by every vetted-
 *  Fancy surface (panels, and the reserved flyouts/modals/pages). */
export interface FancyComponentRef {
    package: string;
    version: string;
    export: string;
}

/** Reserved: a host-rendered side sheet mounting a vetted Fancy component (Phase 2). */
export interface PluginFlyoutContribution {
    id: string;
    title: string;
    icon?: string;
    fancyComponent: FancyComponentRef;
}

/** Reserved: a modal mounting a vetted Fancy component (Phase 3). */
export interface PluginModalContribution {
    id: string;
    title: string;
    icon?: string;
    fancyComponent: FancyComponentRef;
}

/** Reserved: a fixed host-owned page mounting a vetted Fancy component (Phase 5). */
export interface PluginPageContribution {
    fancyComponent: FancyComponentRef;
}

/**
 * The unified `contributes {}` block (design §3): every surface kind a plugin
 * contributes, in ONE place, instead of unrelated growing top-level arrays. The
 * four ACTIVE kinds (mcpTools / editors / recipes / panels) are validated with the
 * same rules as their legacy top-level forms; the RESERVED kinds
 * (flyouts / modals / wizards / workstationPage / workspaceSettingsPage) are
 * accepted with a light structural gate — their per-item schema lands in each
 * surface's own phase. A manifest declares surfaces EITHER here OR at the top
 * level (legacy), never both.
 */
export interface PluginContributes {
    mcpTools?: PluginMcpTool[];
    editors?: PluginEditorMapping[];
    panels?: PluginPanelContribution[];
    recipes?: PluginRecipeManifest[];
    /** Reserved (Phase 2). */
    flyouts?: PluginFlyoutContribution[];
    /** Reserved (Phase 3). */
    modals?: PluginModalContribution[];
    /** Reserved (Phase 4) — the same shape as recipes. */
    wizards?: PluginRecipeManifest[];
    /** Reserved (Phase 5). */
    workstationPage?: PluginPageContribution;
    /** Reserved (Phase 5). */
    workspaceSettingsPage?: PluginPageContribution;
}

/** The effective, normalized contributions of a manifest (contributes ∪ legacy). */
export interface ResolvedContributions {
    mcpTools: PluginMcpTool[];
    editors: PluginEditorMapping[];
    panels: PluginPanelContribution[];
    recipes: PluginRecipeManifest[];
    flyouts: PluginFlyoutContribution[];
    modals: PluginModalContribution[];
    wizards: PluginRecipeManifest[];
    workstationPage?: PluginPageContribution;
    workspaceSettingsPage?: PluginPageContribution;
}

/** The surface-array kinds that may appear EITHER as legacy top-level OR in `contributes`. */
const LEGACY_SURFACE_KEYS = ['mcpTools', 'editors', 'recipes', 'panels'] as const;

/**
 * The EFFECTIVE contributions of a manifest, normalizing the legacy top-level
 * arrays and the unified `contributes {}` block into one shape. `contributes` and
 * the legacy arrays are mutually exclusive (enforced at validation), so a simple
 * "contributes value, else legacy value, else []" resolves correctly. Every
 * reader (registry / editor-routing / recipes / panels / side / manage) goes
 * through here so the two manifest forms behave identically.
 */
export function manifestContributions(m: PluginManifest): ResolvedContributions {
    const c = m.contributes;
    return {
        mcpTools: c?.mcpTools ?? m.mcpTools ?? [],
        editors: c?.editors ?? m.editors ?? [],
        recipes: c?.recipes ?? m.recipes ?? [],
        panels: c?.panels ?? m.panels ?? [],
        flyouts: c?.flyouts ?? [],
        modals: c?.modals ?? [],
        wizards: c?.wizards ?? [],
        workstationPage: c?.workstationPage,
        workspaceSettingsPage: c?.workspaceSettingsPage,
    };
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

/** Agent-facing operating guidance that accompanies MCP tools. */
export interface PluginAgentGuidance {
    /** Concise markdown operating guide, included in each contributed tool description. */
    guide: string;
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
    /**
     * The unified surface block (design §3) — the preferred way to declare every
     * contribution. Mutually exclusive with the legacy top-level `mcpTools` /
     * `editors` / `recipes` / `panels` arrays below (kept for back-compat with
     * older installed manifests). Read the EFFECTIVE set via
     * {@link manifestContributions}, never a raw field.
     */
    contributes?: PluginContributes;
    /** LEGACY (use `contributes.mcpTools`). Normalized by {@link manifestContributions}. */
    mcpTools?: PluginMcpTool[];
    /** Required when mcpTools are present: agents need a workflow, not bare verbs. */
    agent?: PluginAgentGuidance;
    /** LEGACY (use `contributes.editors`). */
    editors?: PluginEditorMapping[];
    /** LEGACY (use `contributes.panels`). */
    panels?: PluginPanelContribution[];
    /** LEGACY (use `contributes.recipes`). */
    recipes?: PluginRecipeManifest[];
    capabilities?: PluginCapabilities;
    /** npm deps the plugin needs (audited/pinned downstream). */
    dependencies?: Record<string, string>;
    /**
     * Integrity hash of the plugin's CODE files (`sha256-<hex>`, §12.3). Bound by
     * `signature` so tampering the code invalidates the signature.
     */
    integrity?: string;
    /**
     * Detached base64 Ed25519 signature over the canonical manifest with this
     * field removed (Phase 3, §5.5). Verified against the trusted publisher key
     * (`publisher.keyId`) at install/enable. Absent ⇒ the plugin is UNSIGNED.
     */
    signature?: string;
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
    /**
     * Detached base64 Ed25519 signature over the canonical index with this field
     * removed (Phase 3). An OFFICIAL marketplace must be signed by a trusted key.
     */
    signature?: string;
}

export type ValidationResult<T> =
    | { ok: true; manifest: T }
    | { ok: false; errors: string[] };

/** A member entry a marketplace index listed that Genie cannot use, and why. */
export interface RejectedMarketplaceEntry {
    /** Its coordinate in the index (`plugins[2]`) — what the author has to fix. */
    at: string;
    /** The declared id, when it has a usable one. */
    id: string | null;
    /** The declared display name, so the UI can say WHICH plugin is missing. */
    name: string | null;
    errors: string[];
}

/**
 * The result of reading a marketplace index: the index itself, its USABLE member
 * entries, and the ones that were rejected (never dropped silently).
 */
export type MarketplaceIndexParse =
    | {
          ok: true;
          /** The index EXACTLY as published — never filtered (see {@link parseMarketplaceIndex}). */
          manifest: MarketplaceManifest;
          accepted: MarketplacePluginEntry[];
          rejected: RejectedMarketplaceEntry[];
      }
    | { ok: false; errors: string[] };

// --- validation helpers ------------------------------------------------------

const REVERSE_DNS = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i;
const NAMESPACE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_SLUG = /^[a-zA-Z][a-zA-Z0-9_]*$/;
// Linear, semver-canonical: MAJOR.MINOR.PATCH, then an OPTIONAL `-prerelease`
// and an OPTIONAL `+build`. The previous `(?:[-+][0-9A-Za-z.-]+)*` form nested a
// `[-+]`-led group whose body ALSO matched `-`, so an attacker-supplied manifest
// `version` (e.g. `9.9.9+` then many `-`) backtracked exponentially (ReDoS,
// CodeQL high). Splitting into two independent optional groups removes the
// ambiguity and runs in linear time.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
    return typeof v === 'string';
}
function nonEmpty(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

/** A DECLARED first-party Fancy component (package@version + export). Shared by
 *  editors (`fancyEditor`) and panels/flyouts/modals/pages (`fancyComponent`). */
function validateFancyRef(fc: unknown, at: string, errors: string[]): void {
    if (!isRecord(fc)) {
        errors.push(`${at} is required (a first-party Fancy package@version + export — plugins never ship UI code)`);
        return;
    }
    if (!nonEmpty(fc.package)) errors.push(`${at}.package is required`);
    if (!nonEmpty(fc.version)) errors.push(`${at}.version is required`);
    if (!nonEmpty(fc.export)) errors.push(`${at}.export is required`);
}

/** Validate a surface array (`mcpTools` / `editors` / `panels` / `recipes`) at a
 *  given coordinate prefix. Same rules for the legacy top-level form and the
 *  `contributes.*` form — the prefix is the only difference. */
function validateMcpToolsField(value: unknown, prefix: string, entry: unknown, errors: string[]): void {
    if (!Array.isArray(value)) {
        errors.push(`\`${prefix}\` must be an array when present`);
        return;
    }
    const toolNames = new Set<string>();
    value.forEach((t, i) => {
        const at = `${prefix}[${i}]`;
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

        // A tool needs a resolvable entry module. Its `run` (default 'tools') must
        // map to an `entry` key.
        const runKey = nonEmpty(t.run) ? t.run : 'tools';
        const entryObj = isRecord(entry) ? entry : undefined;
        if (!entryObj || !nonEmpty(entryObj[runKey]))
            errors.push(`${at} needs entry.${runKey} pointing at its tools module`);
    });
}

function validateEditorsField(value: unknown, prefix: string, errors: string[]): void {
    if (!Array.isArray(value)) {
        errors.push(`\`${prefix}\` must be an array when present`);
        return;
    }
    value.forEach((e, i) => {
        const at = `${prefix}[${i}]`;
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
        validateFancyRef(e.fancyEditor, `${at}.fancyEditor`, errors);
    });
}

function validatePanelsField(value: unknown, prefix: string, errors: string[]): void {
    if (!Array.isArray(value)) {
        errors.push(`\`${prefix}\` must be an array when present`);
        return;
    }
    const panelIds = new Set<string>();
    value.forEach((p, i) => {
        const at = `${prefix}[${i}]`;
        if (!isRecord(p)) {
            errors.push(`${at} must be an object`);
            return;
        }
        if (!nonEmpty(p.id)) errors.push(`${at}.id is required`);
        else if (panelIds.has(p.id)) errors.push(`${at}.id "${p.id}" is duplicated`);
        else panelIds.add(p.id);
        if (!nonEmpty(p.title)) errors.push(`${at}.title is required`);
        if (p.icon !== undefined && !isStr(p.icon))
            errors.push(`${at}.icon must be a string when present`);
        if (p.placement !== undefined && p.placement !== 'grid' && p.placement !== 'workspace')
            errors.push(`${at}.placement must be "grid" or "workspace" when present`);
        validateFancyRef(p.fancyComponent, `${at}.fancyComponent`, errors);
    });
}

function validateRecipesField(value: unknown, prefix: string, errors: string[]): void {
    if (!Array.isArray(value)) {
        errors.push(`\`${prefix}\` must be an array when present`);
        return;
    }
    const recipeIds = new Set<string>();
    value.forEach((r, i) => {
        const at = `${prefix}[${i}]`;
        if (!isRecord(r)) {
            errors.push(`${at} must be an object`);
            return;
        }
        if (!nonEmpty(r.id)) errors.push(`${at}.id is required`);
        else if (recipeIds.has(r.id)) errors.push(`${at}.id "${r.id}" is duplicated`);
        else recipeIds.add(r.id);
        if (!nonEmpty(r.title)) errors.push(`${at}.title is required`);
        if (!Array.isArray(r.steps) || r.steps.length === 0) {
            errors.push(`${at}.steps must be a non-empty array`);
            return;
        }
        const stepIds = new Set<string>();
        r.steps.forEach((s, j) => {
            const sat = `${at}.steps[${j}]`;
            if (!isRecord(s)) {
                errors.push(`${sat} must be an object`);
                return;
            }
            if (!isStr(s.type) || !PLUGIN_RECIPE_STEP_TYPES.includes(s.type as never)) {
                errors.push(
                    `${sat}.type must be one of ${PLUGIN_RECIPE_STEP_TYPES.join(', ')} (a plugin manifest can only declare serializable steps — no "task")`,
                );
                return;
            }
            if (!nonEmpty(s.id)) errors.push(`${sat}.id is required`);
            else if (stepIds.has(s.id)) errors.push(`${sat}.id "${s.id}" is duplicated`);
            else stepIds.add(s.id);
            if (!nonEmpty(s.title)) errors.push(`${sat}.title is required`);
            if (s.type === 'form') {
                if (!Array.isArray(s.fields) || s.fields.length === 0)
                    errors.push(`${sat}.fields must be a non-empty array`);
                else
                    s.fields.forEach((f, k) => {
                        if (!isRecord(f) || !nonEmpty(f.key))
                            errors.push(`${sat}.fields[${k}].key is required`);
                        if (!isRecord(f) || !nonEmpty(f.label))
                            errors.push(`${sat}.fields[${k}].label is required`);
                    });
            } else if (s.type === 'choice') {
                if (!Array.isArray(s.options) || s.options.length === 0)
                    errors.push(`${sat}.options must be a non-empty array`);
            } else if (s.type === 'terminal') {
                if (!nonEmpty(s.command)) errors.push(`${sat}.command is required`);
            } else if (s.type === 'browser') {
                if (!nonEmpty(s.url)) errors.push(`${sat}.url is required (a string; plugin recipes cannot ship a URL function)`);
            }
        });
    });
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

    if (raw.agent !== undefined) {
        if (!isRecord(raw.agent)) {
            errors.push('`agent` must be an object when present');
        } else {
            if (!nonEmpty(raw.agent.guide))
                errors.push('`agent.guide` must be a non-empty string');
        }
    }

    // Surfaces — the unified `contributes {}` block, or the legacy top-level
    // arrays (mutually exclusive). Both forms use the SAME per-kind validators;
    // only the coordinate prefix differs. The cross-cutting capability + agent
    // rules below run on the EFFECTIVE set, so they hold for either form.
    const contributes = isRecord(raw.contributes) ? raw.contributes : undefined;
    if (raw.contributes !== undefined && !contributes) {
        errors.push('`contributes` must be an object when present');
    }
    if (contributes) {
        // A manifest declares surfaces in `contributes` OR at the top level — never
        // both. A legacy array alongside `contributes` is ambiguous → reject it.
        for (const key of LEGACY_SURFACE_KEYS) {
            if (raw[key] !== undefined)
                errors.push(
                    `\`${key}\` must be declared inside \`contributes\`, not at the top level, when \`contributes\` is present (declare surfaces in one place, not both)`,
                );
        }
        if (contributes.mcpTools !== undefined)
            validateMcpToolsField(contributes.mcpTools, 'contributes.mcpTools', raw.entry, errors);
        if (contributes.editors !== undefined)
            validateEditorsField(contributes.editors, 'contributes.editors', errors);
        if (contributes.panels !== undefined)
            validatePanelsField(contributes.panels, 'contributes.panels', errors);
        if (contributes.recipes !== undefined)
            validateRecipesField(contributes.recipes, 'contributes.recipes', errors);
        // Reserved kinds (flyouts / modals / wizards / pages): a light structural
        // gate only — the per-item schema lands in each surface's own phase.
        for (const k of ['flyouts', 'modals', 'wizards'] as const) {
            if (contributes[k] !== undefined && !Array.isArray(contributes[k]))
                errors.push(`\`contributes.${k}\` must be an array when present`);
        }
        for (const k of ['workstationPage', 'workspaceSettingsPage'] as const) {
            if (contributes[k] !== undefined && !isRecord(contributes[k]))
                errors.push(`\`contributes.${k}\` must be an object when present`);
        }
    } else {
        if (raw.mcpTools !== undefined)
            validateMcpToolsField(raw.mcpTools, 'mcpTools', raw.entry, errors);
        if (raw.editors !== undefined) validateEditorsField(raw.editors, 'editors', errors);
        if (raw.panels !== undefined) validatePanelsField(raw.panels, 'panels', errors);
        if (raw.recipes !== undefined) validateRecipesField(raw.recipes, 'recipes', errors);
    }

    // Cross-cutting rules on the EFFECTIVE surface arrays (contributes ∪ legacy).
    const effArray = (kind: (typeof LEGACY_SURFACE_KEYS)[number]): unknown[] => {
        const v = contributes ? contributes[kind] : raw[kind];
        return Array.isArray(v) ? v : [];
    };
    const caps = isRecord(raw.capabilities) ? raw.capabilities : undefined;
    const genieApi = caps && Array.isArray(caps.genieApi) ? caps.genieApi : [];

    if (effArray('mcpTools').length > 0) {
        const agent = isRecord(raw.agent) ? raw.agent : null;
        if (!agent || !nonEmpty(agent.guide))
            errors.push('`agent.guide` is required when `mcpTools` are present');
    }
    if (effArray('recipes').length > 0 && !genieApi.includes(RECIPE_CAPABILITY)) {
        errors.push(
            `\`capabilities.genieApi\` must include "${RECIPE_CAPABILITY}" when \`recipes\` are present (the user consents to it at enable-time)`,
        );
    }
    if (effArray('panels').length > 0 && !genieApi.includes(PANEL_CAPABILITY)) {
        errors.push(
            `\`capabilities.genieApi\` must include "${PANEL_CAPABILITY}" when \`panels\` are present (the user consents to it at enable-time)`,
        );
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

    if (raw.signature !== undefined && !isStr(raw.signature))
        errors.push('`signature` must be a string when present');

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, manifest: raw as unknown as PluginManifest };
}

/** Everything wrong with ONE member entry. Empty ⇒ the entry is installable. */
function marketplaceEntryErrors(p: unknown, at: string, seenIds: Set<string>): string[] {
    const errors: string[] = [];
    if (!isRecord(p)) return [`${at} must be an object`];

    if (!nonEmpty(p.id)) errors.push(`${at}.id is required`);
    else if (!REVERSE_DNS.test(p.id)) errors.push(`${at}.id must be reverse-DNS`);
    else if (seenIds.has(p.id)) errors.push(`${at}.id "${p.id}" is duplicated`);
    else seenIds.add(p.id);

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
    return errors;
}

/**
 * Read a parsed `genie-marketplace.json` — a repo indexing many plugins.
 *
 * An index is a DIRECTORY LISTING, so it is validated in two tiers. The index
 * ITSELF (id / name / publisher / `plugins` being an array) must be sound —
 * without that there is nothing to read. Individual member entries are then
 * PARTITIONED: usable ones are `accepted`, unusable ones are `rejected` with the
 * reason and their coordinate in the file. One malformed entry therefore never
 * hides its valid siblings — which is what used to freeze a whole marketplace at
 * whatever it listed when it was first added, so a newly published plugin could
 * never appear no matter how often you refreshed. Nothing is dropped silently:
 * callers surface `rejected` to the user.
 *
 * `manifest` is the index EXACTLY as published, members and all. A signature is
 * computed over those canonical bytes, so filtering entries out of it would
 * break verification — {@link accepted} is the filtered view, not `manifest`.
 */
export function parseMarketplaceIndex(raw: unknown): MarketplaceIndexParse {
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

    if (raw.signature !== undefined && !isStr(raw.signature))
        errors.push('`signature` must be a string when present');

    if (!Array.isArray(raw.plugins)) {
        errors.push('`plugins` is required and must be an array of member entries');
    }

    if (errors.length > 0) return { ok: false, errors };

    const seenIds = new Set<string>();
    const accepted: MarketplacePluginEntry[] = [];
    const rejected: RejectedMarketplaceEntry[] = [];
    for (const [i, p] of (raw.plugins as unknown[]).entries()) {
        const at = `plugins[${i}]`;
        const entryErrors = marketplaceEntryErrors(p, at, seenIds);
        if (entryErrors.length === 0) {
            accepted.push(p as MarketplacePluginEntry);
            continue;
        }
        const rec = isRecord(p) ? p : {};
        rejected.push({
            at,
            id: nonEmpty(rec.id) ? rec.id : null,
            name: nonEmpty(rec.name) ? rec.name : null,
            errors: entryErrors,
        });
    }

    return { ok: true, manifest: raw as unknown as MarketplaceManifest, accepted, rejected };
}

/**
 * STRICT read of a `genie-marketplace.json`: the index AND every member entry
 * must validate. Members are installed INDIVIDUALLY; a single-plugin repo is
 * just the degenerate case (install it directly by URL, no marketplace needed).
 *
 * Use {@link parseMarketplaceIndex} where a partly-usable index should still be
 * browsable; use this where all-or-nothing is the right contract.
 */
export function validateMarketplaceManifest(raw: unknown): ValidationResult<MarketplaceManifest> {
    const parsed = parseMarketplaceIndex(raw);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    if (parsed.rejected.length > 0) return { ok: false, errors: parsed.rejected.flatMap((r) => r.errors) };
    return { ok: true, manifest: parsed.manifest };
}

/** The runtime-namespaced name for a plugin tool: `${namespace}.${tool}`. */
export function namespacedToolName(namespace: string, tool: string): string {
    return `${namespace}.${tool}`;
}
