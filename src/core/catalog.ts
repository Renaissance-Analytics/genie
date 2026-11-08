/**
 * THE CATALOG (ADF A1, Tynn #445; spec .ai/plans/specs/adf-sdk.md) — pure. Every element Genie's features are made of
 * (a tool, a panel, an editor, a recipe, a flow node…) is ONE definition envelope, whoever contributes it: a builtin's
 * compiled declaration, a plugin's signed manifest and a GApp's manifest all normalize into it and pass the SAME
 * validator. A package registers ATOMICALLY with a revision: every contribution or none, so a failed one never leaves
 * half a package offered.
 *
 * The owner's approved decisions (q_f0804e19) this encodes:
 *  1. kinds are what a plugin or GApp can contribute; system ports stay internal and are not kinds;
 *  3. Genie 1's never-run families (flyouts, modals, wizards, workstation and workspace-settings pages) are accepted as
 *     RESERVED: they validate and register, and nothing runs them yet;
 *  4. network egress is an allow-list that defaults to none.
 *
 * A definition is metadata: it crosses the wire to clients, so it is plain JSON (no functions), and what is registered
 * is frozen. The handler and adapter it names are linked by id, never carried.
 */
import { VETTED_FANCY_EDITORS } from './plugin-editors.js';
import { VETTED_FANCY_EXPORTS } from './plugin-panels.js';

/** The envelope's own version; a client that reads a newer one says it needs a newer Genie. */
export const CATALOG_SCHEMA_VERSION = 1;

export const ELEMENT_KINDS = ['tool', 'panel', 'editor', 'recipe', 'flow-node', 'page', 'overlay', 'provider', 'service-engine'] as const;
/** Declared by Genie 1, never run there: accepted and documented, executable one story each later (decision 3). */
export const RESERVED_KINDS = ['flyout', 'modal', 'wizard', 'workstation-page', 'workspace-settings-page'] as const;
export const ELEMENT_SOURCES = ['builtin', 'plugin', 'gapp'] as const;
export const ELEMENT_SCOPES = ['workspace', 'workstation'] as const;
/**
 * WHERE IT RUNS (the owner's ruling q_d71981d6: "ADF and the host split are one design"): on the host, in a client (a
 * window, or another machine's), or BOTH — and then its `reach.link` says how its halves talk.
 */
export const ELEMENT_SIDES = ['host', 'client', 'both'] as const;
/** Who may reach it from another machine: anyone the host lets in, only its owner, or only this machine's own window. */
export const ELEMENT_REMOTE = ['allowed', 'owner', 'local'] as const;

export type ElementKind = (typeof ELEMENT_KINDS)[number];
export type ReservedKind = (typeof RESERVED_KINDS)[number];
export type CatalogKind = ElementKind | ReservedKind;
export type ElementSource = (typeof ELEMENT_SOURCES)[number];

export interface ElementDefinition {
    /** Fully qualified and unique in the catalog, like `ai.genie.spreadsheet.createWorkbook`. */
    readonly id: string;
    readonly kind: CatalogKind;
    readonly version: string;
    readonly packageId: string;
    readonly source: ElementSource;
    readonly docs: { readonly name: string; readonly description: string; readonly guide?: string };
    readonly reach: {
        readonly scopes: readonly (typeof ELEMENT_SCOPES)[number][];
        readonly side: (typeof ELEMENT_SIDES)[number];
        readonly requiresWindow: boolean;
        readonly remote: (typeof ELEMENT_REMOTE)[number];
        /**
         * How its two halves talk, when it runs on BOTH sides: the host methods its client side calls, the host events it
         * follows. The only channel between them. Absent for one side alone.
         */
        readonly link?: { readonly calls: readonly string[]; readonly events: readonly string[] };
    };
    /** What it asks for. Registration is not a grant: the host decides at install and at each call. */
    readonly permissions: { readonly capabilities: readonly string[]; readonly network: readonly string[] };
    /** The kind's own fields (a tool's input schema, an editor's extensions…), checked per kind below. */
    readonly payload: Readonly<Record<string, unknown>>;
}

export interface CatalogPackage {
    readonly id: string;
    readonly version: string;
    readonly source: ElementSource;
    readonly contributions: readonly ElementDefinition[];
}

export type DefinitionCheck = { ok: true; definition: ElementDefinition } | { ok: false; problems: string[] };
export type PackageCheck = { ok: true; pkg: CatalogPackage } | { ok: false; problems: string[] };
export type CatalogChange = { ok: true; revision: number } | { ok: false; problems: string[] };

const ENVELOPE_KEYS = new Set(['id', 'kind', 'version', 'packageId', 'source', 'docs', 'reach', 'permissions', 'payload']);
const DOCS_KEYS = new Set(['name', 'description', 'guide']);
const REACH_KEYS = new Set(['scopes', 'side', 'requiresWindow', 'remote', 'link']);
const LINK_KEYS = new Set(['calls', 'events']);
const PERMISSION_KEYS = new Set(['capabilities', 'network']);
const PACKAGE_KEYS = new Set(['id', 'version', 'source', 'contributions']);
/**
 * A dotted name: `ai.genie.spreadsheet.createWorkbook`, or a bare one like `imDone` for a builtin tool. Each part holds
 * what an MCP tool name may (letters, digits, `_`, `-`), so a plugin tool like `run_lint` keeps its name.
 */
const ELEMENT_ID = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;
const PACKAGE_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const EXTENSION = /^\.[A-Za-z0-9]+$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/** Plain JSON only: a function, a symbol, a class instance or a cycle is not metadata. */
function jsonProblem(v: unknown, path: string, seen: Set<object> = new Set()): string | null {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? null : `${path} must be a finite number`;
    if (typeof v !== 'object') return `${path} must be plain JSON (found a ${typeof v})`;
    if (seen.has(v)) return `${path} refers to itself`;
    seen.add(v);
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) { const p = jsonProblem(v[i], `${path}[${i}]`, seen); if (p) return p; }
    } else {
        const proto = Object.getPrototypeOf(v) as unknown;
        if (proto !== Object.prototype && proto !== null) return `${path} must be a plain object`;
        for (const [k, x] of Object.entries(v)) { const p = jsonProblem(x, `${path}.${k}`, seen); if (p) return p; }
    }
    seen.delete(v);
    return null;
}

function unknownKeys(raw: Record<string, unknown>, known: Set<string>, where: string): string[] {
    return Object.keys(raw).filter((k) => !known.has(k)).map((k) => `${where}: unknown key "${k}"; an element declares only what the envelope names`);
}

/** The kind's payload, by kind. A reserved kind and the kinds with no fixed fields yet need only an object. */
function payloadProblems(kind: CatalogKind, payload: Record<string, unknown>): string[] {
    const out: string[] = [];
    switch (kind) {
        case 'tool':
            if (typeof payload.handler !== 'string' || payload.handler.length === 0) out.push('payload.handler must name the host handler that runs the tool');
            if (!isRecord(payload.inputSchema) || payload.inputSchema.type !== 'object') out.push('payload.inputSchema must be a JSON Schema with type "object"');
            if (payload.outputSchema !== undefined && !isRecord(payload.outputSchema)) out.push('payload.outputSchema must be a JSON Schema object');
            break;
        case 'editor':
            if (!isStringList(payload.extensions) || payload.extensions.length === 0) out.push('payload.extensions must claim at least one extension, like ".md"');
            else if (!payload.extensions.every((x) => EXTENSION.test(x))) out.push('payload.extensions: a dot, then letters or digits, like ".md"');
            if (!oneOf(VETTED_FANCY_EDITORS, payload.fancyEditor)) out.push(`payload.fancyEditor "${String(payload.fancyEditor)}" is not a vetted Fancy editor (one of ${VETTED_FANCY_EDITORS.join(', ')})`);
            break;
        case 'panel':
            if (!oneOf(VETTED_FANCY_EXPORTS, payload.fancyComponent)) out.push(`payload.fancyComponent "${String(payload.fancyComponent)}" is not a vetted Fancy component (one of ${VETTED_FANCY_EXPORTS.join(', ')})`);
            if (payload.props !== undefined && !isRecord(payload.props)) out.push('payload.props must be an object');
            break;
        case 'flow-node':
            if (typeof payload.executor !== 'string' || payload.executor.length === 0) out.push('payload.executor must name what runs the node');
            for (const port of ['inputs', 'outputs'] as const) if (payload[port] !== undefined && !isStringList(payload[port])) out.push(`payload.${port} must be a list of port names`);
            break;
        case 'recipe':
            if (!Array.isArray(payload.steps) || payload.steps.length === 0 || !payload.steps.every(isRecord)) out.push('payload.steps must be a non-empty list of steps');
            break;
        default:
            break;
    }
    return out;
}

/** ONE validator for every kind and every source. The definition it answers is normalized (defaults filled) and frozen. */
export function validateDefinition(raw: unknown): DefinitionCheck {
    if (!isRecord(raw)) return { ok: false, problems: ['a definition must be an object'] };
    const where = typeof raw.id === 'string' ? `"${raw.id}"` : 'a definition';
    const problems: string[] = [...unknownKeys(raw, ENVELOPE_KEYS, where)];
    const say = (p: string) => problems.push(`${where}: ${p}`);
    const json = jsonProblem(raw, 'definition');
    if (json) say(json);

    if (typeof raw.id !== 'string' || !ELEMENT_ID.test(raw.id)) say('id must be a dotted name, like ai.genie.spreadsheet.createWorkbook');
    const kindKnown = oneOf(ELEMENT_KINDS, raw.kind) || oneOf(RESERVED_KINDS, raw.kind);
    if (!kindKnown) say(`kind "${String(raw.kind)}" is not one of ${[...ELEMENT_KINDS, ...RESERVED_KINDS].join(', ')}`);
    if (typeof raw.version !== 'string' || !SEMVER.test(raw.version)) say('version must be semver, like 1.2.0');
    if (typeof raw.packageId !== 'string' || !PACKAGE_ID.test(raw.packageId)) say('packageId must be reverse-DNS, like com.example.plugin');
    if (!oneOf(ELEMENT_SOURCES, raw.source)) say(`source must be one of ${ELEMENT_SOURCES.join(', ')}`);

    if (!isRecord(raw.docs)) say('docs must be an object with a name and a description');
    else {
        problems.push(...unknownKeys(raw.docs, DOCS_KEYS, `${where} docs`));
        if (typeof raw.docs.name !== 'string' || raw.docs.name.trim() === '') say('docs.name must be a non-empty string');
        if (typeof raw.docs.description !== 'string' || raw.docs.description.trim() === '') say('docs.description must be a non-empty string');
        if (raw.docs.guide !== undefined && typeof raw.docs.guide !== 'string') say('docs.guide must be a string');
    }

    if (!isRecord(raw.reach)) say('reach must say its scopes, side, requiresWindow and remote');
    else {
        problems.push(...unknownKeys(raw.reach, REACH_KEYS, `${where} reach`));
        const r = raw.reach;
        if (!Array.isArray(r.scopes) || r.scopes.length === 0 || !r.scopes.every((s) => oneOf(ELEMENT_SCOPES, s))) say(`reach.scopes must list one or more of ${ELEMENT_SCOPES.join(', ')}`);
        if (!oneOf(ELEMENT_SIDES, r.side)) say(`reach.side must be one of ${ELEMENT_SIDES.join(', ')}`);
        if (typeof r.requiresWindow !== 'boolean') say('reach.requiresWindow must be true or false');
        if (!oneOf(ELEMENT_REMOTE, r.remote)) say(`reach.remote must be one of ${ELEMENT_REMOTE.join(', ')}`);
        if (r.side === 'both') {
            if (!isRecord(r.link)) say('reach.link must say how its two sides talk when it runs on both: { calls: [host methods], events: [host events] }');
            else {
                problems.push(...unknownKeys(r.link, LINK_KEYS, `${where} reach.link`));
                if (!isStringList(r.link.calls) || !isStringList(r.link.events)) say('reach.link.calls and reach.link.events must be lists of names');
                else if (r.link.calls.length + r.link.events.length === 0) say('reach.link must name at least one call or event: an element on both sides talks across');
            }
        } else if (r.link !== undefined) say('reach.link is for an element on both sides; one side alone has no link');
    }

    if (!isRecord(raw.permissions)) say('permissions must be an object (capabilities: [] for none)');
    else {
        problems.push(...unknownKeys(raw.permissions, PERMISSION_KEYS, `${where} permissions`));
        if (!isStringList(raw.permissions.capabilities)) say('permissions.capabilities must be a list of names');
        if (raw.permissions.network !== undefined && !isStringList(raw.permissions.network)) say('permissions.network must be an allow-list of hosts; [] or absent for none');
    }

    if (!isRecord(raw.payload)) say('payload must be an object');
    else if (kindKnown) for (const p of payloadProblems(raw.kind as CatalogKind, raw.payload)) say(p);

    if (problems.length > 0) return { ok: false, problems };
    const permissions = raw.permissions as Record<string, unknown>;
    const definition: ElementDefinition = {
        ...(raw as unknown as ElementDefinition),
        permissions: { capabilities: permissions.capabilities as string[], network: (permissions.network as string[] | undefined) ?? [] },
    };
    return { ok: true, definition: deepFreeze(structuredClone(definition)) };
}

/** A package and every contribution, validated together: each must belong to the package, and appear once. */
export function validatePackage(raw: unknown): PackageCheck {
    if (!isRecord(raw)) return { ok: false, problems: ['a package must be an object'] };
    const problems: string[] = [...unknownKeys(raw, PACKAGE_KEYS, 'package')];
    if (typeof raw.id !== 'string' || !PACKAGE_ID.test(raw.id)) problems.push('package id must be reverse-DNS, like com.example.plugin');
    if (typeof raw.version !== 'string' || !SEMVER.test(raw.version)) problems.push('package version must be semver, like 1.2.0');
    if (!oneOf(ELEMENT_SOURCES, raw.source)) problems.push(`package source must be one of ${ELEMENT_SOURCES.join(', ')}`);
    if (!Array.isArray(raw.contributions)) return { ok: false, problems: [...problems, 'package contributions must be a list'] };
    const contributions: ElementDefinition[] = [];
    const names = new Map<string, string>();
    for (const c of raw.contributions) {
        const check = validateDefinition(c);
        if (!check.ok) { problems.push(...check.problems); continue; }
        const d = check.definition;
        if (d.packageId !== raw.id) problems.push(`"${d.id}": packageId "${d.packageId}" is not this package (${String(raw.id)})`);
        if (d.source !== raw.source) problems.push(`"${d.id}": source "${d.source}" is not this package's (${String(raw.source)})`);
        for (const name of [d.id]) {
            const first = names.get(name);
            if (first !== undefined) problems.push(`"${name}" is named twice in this package (by ${first} and ${d.id})`);
            else names.set(name, d.id);
        }
        contributions.push(d);
    }
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, pkg: Object.freeze({ id: raw.id as string, version: raw.version as string, source: raw.source as ElementSource, contributions: Object.freeze(contributions) }) };
}

/**
 * The registry. `revision` moves by one with every change that lands and never otherwise, so a client that holds
 * revision N knows exactly whether it is current. Registering a package that is already there REPLACES it whole.
 */
export class Catalog {
    #revision = 0;
    readonly #packages = new Map<string, CatalogPackage>();
    /** Every id, to the definition it names. */
    readonly #names = new Map<string, ElementDefinition>();

    get revision(): number { return this.#revision; }

    register(raw: unknown): CatalogChange {
        const check = validatePackage(raw);
        if (!check.ok) return check;
        const { pkg } = check;
        // Collisions are checked against every OTHER package; the package's own previous version is being replaced — by
        // the same source only: an installed plugin never replaces one of Genie's own (ADF A2, Tynn #446).
        const problems: string[] = [];
        const previous = this.#packages.get(pkg.id);
        if (previous && previous.source !== pkg.source) problems.push(`package ${pkg.id} is already registered as a ${previous.source} package; a ${pkg.source} package cannot replace it`);
        for (const d of pkg.contributions) {
            for (const name of [d.id]) {
                const holder = this.#names.get(name);
                if (holder && holder.packageId !== pkg.id) problems.push(`"${name}" is already registered by ${holder.id} of ${holder.packageId}`);
            }
        }
        if (problems.length > 0) return { ok: false, problems };
        this.#drop(pkg.id);
        this.#packages.set(pkg.id, pkg);
        for (const d of pkg.contributions) for (const name of [d.id]) this.#names.set(name, d);
        return { ok: true, revision: ++this.#revision };
    }

    unregister(packageId: string): CatalogChange {
        if (!this.#packages.has(packageId)) return { ok: false, problems: [`no package ${packageId} is registered`] };
        this.#drop(packageId);
        return { ok: true, revision: ++this.#revision };
    }

    /** By id; `null` when nothing has that name. */
    get(name: string): ElementDefinition | null {
        return this.#names.get(name) ?? null;
    }

    /** Every registered definition, optionally of one kind. */
    list(kind?: CatalogKind): ElementDefinition[] {
        const all = [...this.#packages.values()].flatMap((p) => p.contributions);
        return kind === undefined ? all : all.filter((d) => d.kind === kind);
    }

    packages(): CatalogPackage[] {
        return [...this.#packages.values()];
    }

    #drop(packageId: string): void {
        const old = this.#packages.get(packageId);
        if (!old) return;
        for (const d of old.contributions) for (const name of [d.id]) if (this.#names.get(name)?.packageId === packageId) this.#names.delete(name);
        this.#packages.delete(packageId);
    }
}

function deepFreeze<T>(v: T): T {
    if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
        Object.freeze(v);
        for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
    }
    return v;
}
