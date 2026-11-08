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

export const ELEMENT_KINDS = ['tool', 'panel', 'editor', 'recipe', 'flow-node', 'host-service', 'page', 'overlay', 'provider', 'service-engine'] as const;
/** Declared by Genie 1, never run there: accepted and documented, executable one story each later (decision 3). */
export const RESERVED_KINDS = ['flyout', 'modal', 'wizard', 'workstation-page', 'workspace-settings-page'] as const;
export const ELEMENT_SOURCES = ['builtin', 'plugin', 'gapp'] as const;
export const ELEMENT_SCOPES = ['workspace', 'workstation'] as const;
/**
 * WHERE IT RUNS (the owner's ruling q_d71981d6: "ADF and the host split are one design"): on the host, in a client (a
 * window, or another machine's), or BOTH — and then its `reach.link` says how its halves talk.
 */
export const ELEMENT_SIDES = ['host', 'client', 'both'] as const;
export type ElementSide = (typeof ELEMENT_SIDES)[number];
/** Who may reach it from another machine: anyone the host lets in, only its owner, or only this machine's own window. */
export const ELEMENT_REMOTE = ['allowed', 'owner', 'local'] as const;

export type ElementKind = (typeof ELEMENT_KINDS)[number];
export type ReservedKind = (typeof RESERVED_KINDS)[number];
export type CatalogKind = ElementKind | ReservedKind;
export type ElementSource = (typeof ELEMENT_SOURCES)[number];

/**
 * THE SCHEMAS (ADF B7, Tynn #457): one table, plain data, that the validator below READS and `npm run docs:sdk` writes
 * docs/sdk/ from (src/core/sdk-docs.ts). A field added, removed or changed here changes what the host accepts AND what
 * the SDK's docs say; test/adf-b7-sdk-docs.test.ts fails CI when the checked-in docs were not regenerated.
 */

/** How a payload field is checked. Each rule's refusal names the field. */
export const FIELD_RULES = ['nonEmptyString', 'string', 'boolean', 'object', 'objectSchema', 'stringList', 'extensions', 'vettedEditor', 'vettedComponent', 'process', 'steps'] as const;
export type FieldRule = (typeof FIELD_RULES)[number];

export interface FieldSpec {
    readonly name: string;
    /** As the docs say it. */
    readonly type: string;
    readonly required: boolean;
    /** What a missing optional field means. */
    readonly default?: unknown;
    readonly description: string;
    readonly rule: FieldRule;
    /** The refusal, when the rule's own words are not the clearest for this field. */
    readonly problem?: string;
}

export interface KindSpec {
    readonly kind: CatalogKind;
    /** `reserved`: accepted and registered; nothing runs it yet (decision 3). */
    readonly status: 'active' | 'reserved';
    /**
     * The sides a definition of this family may run on (the owner's rulings, 2026-11-08 and q_d71981d6: the ADF models
     * the client/host relationship). genie-host runs a tool; an editor is drawn by a client and reads and writes its file
     * on the host, so it is both; a panel is a client's, or both when it works on the host's data. Enforced against
     * `reach.side`. `null`: each definition says its own side.
     */
    readonly sides: readonly ElementSide[] | null;
    readonly summary: string;
    readonly fields: readonly FieldSpec[];
    /** A payload that validates, shown in the docs (and checked: test/adf-b7-sdk-docs.test.ts). */
    readonly example: Readonly<Record<string, unknown>>;
}

export interface EnvelopeField {
    /** Dotted for a field inside an object (`docs.name`). */
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
    readonly default?: unknown;
    readonly description: string;
}

const RESERVED_SUMMARY = 'Reserved: accepted and registered, so a package that declares one loads, and nothing runs it yet. A later Genie release makes it run and adds its fields here.';

export const KIND_SPECS: readonly KindSpec[] = [
    {
        kind: 'tool', status: 'active', sides: ['host'],
        summary: 'An MCP tool agents call. The host runs it with the handler the payload names; it appears in every agent\'s tool list under its id.',
        fields: [
            { name: 'handler', type: 'string', required: true, description: 'The host handler that runs the tool.', rule: 'nonEmptyString', problem: 'payload.handler must name the host handler that runs the tool' },
            { name: 'inputSchema', type: 'JSON Schema, `type: "object"`', required: true, description: 'The tool\'s arguments.', rule: 'objectSchema', problem: 'payload.inputSchema must be a JSON Schema with type "object"' },
            { name: 'outputSchema', type: 'JSON Schema object', required: false, description: 'What the tool answers, when it declares it.', rule: 'object', problem: 'payload.outputSchema must be a JSON Schema object' },
            { name: 'annotations', type: 'object', required: false, description: 'MCP tool annotations (read-only, destructive…) passed to agents as declared.', rule: 'object' },
            { name: 'process', type: '`"worker"` or `"subprocess"`', required: false, default: 'worker', description: 'A plugin tool: where its handler runs, isolated from Genie.', rule: 'process' },
            { name: 'gated', type: 'boolean', required: false, default: false, description: 'Each call waits for the person\'s approval first.', rule: 'boolean' },
        ],
        example: { handler: 'com.example.notes.append', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, process: 'worker', gated: false },
    },
    {
        kind: 'panel', status: 'active', sides: ['client', 'both'],
        summary: 'A panel in the workspace grid. It mounts one vetted Fancy component, drawn by Genie\'s own compiled adapter: a package ships no UI code.',
        fields: [
            { name: 'fancyComponent', type: `one of ${VETTED_FANCY_EXPORTS.join(', ')}`, required: true, description: 'The vetted Fancy component the panel mounts.', rule: 'vettedComponent' },
            { name: 'title', type: 'string', required: false, description: 'The panel\'s title.', rule: 'string' },
            { name: 'props', type: 'object', required: false, default: {}, description: 'The component\'s props, as plain JSON.', rule: 'object', problem: 'payload.props must be an object' },
        ],
        example: { title: 'Notes', fancyComponent: 'ContentRenderer', props: {} },
    },
    {
        kind: 'editor', status: 'active', sides: ['both'],
        summary: 'Opens files of the extensions it claims in one vetted Fancy editor. Genie\'s own editor wins a claim by default; another is offered in Open with.',
        fields: [
            { name: 'extensions', type: 'list of extensions, like `".md"`', required: true, description: 'The file types it opens: a dot, then letters or digits.', rule: 'extensions' },
            { name: 'fancyEditor', type: `one of ${VETTED_FANCY_EDITORS.join(', ')}`, required: true, description: 'The vetted Fancy editor that opens them.', rule: 'vettedEditor' },
            { name: 'title', type: 'string', required: false, description: 'The editor\'s name in Open with.', rule: 'string' },
        ],
        example: { title: 'Notes', extensions: ['.md'], fancyEditor: 'Editor' },
    },
    {
        kind: 'recipe', status: 'active', sides: null,
        summary: 'A guided sequence of steps the person walks through.',
        fields: [
            { name: 'steps', type: 'non-empty list of step objects', required: true, description: 'The steps, in order.', rule: 'steps', problem: 'payload.steps must be a non-empty list of steps' },
        ],
        example: { steps: [{ tool: 'com.example.notes.append' }] },
    },
    {
        kind: 'flow-node', status: 'active', sides: null,
        summary: 'A node in the Flows palette. The executor the payload names runs it.',
        fields: [
            { name: 'executor', type: 'string', required: true, description: 'What runs the node.', rule: 'nonEmptyString', problem: 'payload.executor must name what runs the node' },
            { name: 'inputs', type: 'list of port names', required: false, default: [], description: 'Its input ports.', rule: 'stringList', problem: 'payload.inputs must be a list of port names' },
            { name: 'outputs', type: 'list of port names', required: false, default: [], description: 'Its output ports.', rule: 'stringList', problem: 'payload.outputs must be a list of port names' },
        ],
        example: { executor: 'com.example.notes.append', inputs: ['text'], outputs: ['path'] },
    },
    {
        kind: 'host-service', status: 'active', sides: ['host', 'both'],
        summary: 'A service genie-host runs and keeps running with no window open (remote access, a relay). On both sides it has a client part, and its reach.link says how the two talk.',
        fields: [
            { name: 'start', type: 'string', required: true, description: 'The host handler that starts it.', rule: 'nonEmptyString', problem: 'payload.start must name the host handler that starts it' },
            { name: 'stop', type: 'string', required: true, description: 'The host handler that stops it.', rule: 'nonEmptyString', problem: 'payload.stop must name the host handler that stops it' },
            { name: 'health', type: 'string', required: true, description: 'The host handler that answers whether it is healthy, and why not.', rule: 'nonEmptyString', problem: 'payload.health must name the host handler that answers its health' },
            { name: 'settingsSection', type: 'string', required: true, description: 'The settings section it owns: its switches live there and nowhere else.', rule: 'nonEmptyString', problem: 'payload.settingsSection must name the settings section it owns' },
        ],
        example: { start: 'com.example.relay.start', stop: 'com.example.relay.stop', health: 'com.example.relay.health', settingsSection: 'relay' },
    },
    ...(['page', 'overlay', 'provider', 'service-engine'] as const).map((kind): KindSpec => ({
        kind, status: 'active', sides: null,
        summary: 'A family a package may contribute. It has no fixed payload fields yet: its payload is any JSON object, and the Genie release that runs it adds them here.',
        fields: [],
        example: {},
    })),
    ...RESERVED_KINDS.map((kind): KindSpec => ({ kind, status: 'reserved', sides: null, summary: RESERVED_SUMMARY, fields: [], example: {} })),
];

export const ENVELOPE_FIELDS: readonly EnvelopeField[] = [
    { name: 'id', type: 'dotted name', required: true, description: 'Unique in the catalog, like `ai.genie.spreadsheet.createWorkbook`. A tool is offered to agents under it.' },
    { name: 'kind', type: `one of ${[...ELEMENT_KINDS, ...RESERVED_KINDS].join(', ')}`, required: true, description: 'Its contribution family: what its payload holds.' },
    { name: 'version', type: 'semver', required: true, description: 'Its own version, like `1.2.0`.' },
    { name: 'packageId', type: 'reverse-DNS', required: true, description: 'The package that contributes it: every definition of a package registers together, or none does.' },
    { name: 'source', type: `one of ${ELEMENT_SOURCES.join(', ')}`, required: true, description: 'Who contributes it. An installed package never replaces one of Genie\'s own.' },
    { name: 'docs', type: 'object', required: true, description: 'What people and agents read about it.' },
    { name: 'docs.name', type: 'string', required: true, description: 'Its name.' },
    { name: 'docs.description', type: 'string', required: true, description: 'What it does.' },
    { name: 'docs.guide', type: 'string', required: false, description: 'How an agent should use it.' },
    { name: 'reach', type: 'object', required: true, description: 'Where it runs and who may reach it.' },
    { name: 'reach.scopes', type: `one or more of ${ELEMENT_SCOPES.join(', ')}`, required: true, description: 'Whether it acts in a workspace, on the workstation, or both.' },
    { name: 'reach.side', type: `one of ${ELEMENT_SIDES.join(', ')}`, required: true, description: 'Whether genie-host runs it, a client draws it, or it has a part on each side.' },
    { name: 'reach.link', type: 'object', required: false, description: 'How its two sides talk, required when `reach.side` is `both` and refused otherwise: the only channel between its halves.' },
    { name: 'reach.link.calls', type: 'list of host method names', required: true, description: 'The host methods its client side calls.' },
    { name: 'reach.link.events', type: 'list of host event names', required: true, description: 'The host events its client side follows. Calls and events together name at least one.' },
    { name: 'reach.requiresWindow', type: 'boolean', required: true, description: 'Whether it needs a Genie window open.' },
    { name: 'reach.remote', type: `one of ${ELEMENT_REMOTE.join(', ')}`, required: true, description: 'Who may reach it from another machine: anyone the host lets in, only its owner, or only this machine\'s own window.' },
    { name: 'permissions', type: 'object', required: true, description: 'What it asks for. Registering is not a grant: the host decides at install and at each call.' },
    { name: 'permissions.capabilities', type: 'list of names', required: true, description: 'The Genie capabilities it asks for; `[]` for none.' },
    { name: 'permissions.network', type: 'list of hosts', required: false, default: [], description: 'The hosts it may reach; none unless listed.' },
    { name: 'payload', type: 'object', required: true, description: 'Its family\'s own fields: see each family\'s page.' },
];

/** The envelope's keys, and each object's own, as the table names them: the validator refuses any other. */
const fieldsUnder = (prefix: string) => new Set(ENVELOPE_FIELDS.filter((f) => (prefix === '' ? !f.name.includes('.') : f.name.startsWith(`${prefix}.`))).map((f) => (prefix === '' ? f.name : f.name.slice(prefix.length + 1))));

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
        readonly side: ElementSide;
        readonly requiresWindow: boolean;
        readonly remote: (typeof ELEMENT_REMOTE)[number];
        /** How its two halves talk, when it runs on BOTH sides: the host methods its client calls, the host events it follows. */
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

const ENVELOPE_KEYS = fieldsUnder('');
const DOCS_KEYS = fieldsUnder('docs');
const REACH_KEYS = fieldsUnder('reach');
const PERMISSION_KEYS = fieldsUnder('permissions');
const LINK_KEYS = fieldsUnder('reach.link');
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

/** One field's refusal by its rule, naming the field; null when it holds. */
function fieldProblem(f: FieldSpec, v: unknown): string | null {
    const at = `payload.${f.name}`;
    const say = (fallback: string) => f.problem ?? fallback;
    switch (f.rule) {
        case 'nonEmptyString': return typeof v === 'string' && v.length > 0 ? null : say(`${at} must be a non-empty string`);
        case 'string': return typeof v === 'string' ? null : say(`${at} must be a string`);
        case 'boolean': return typeof v === 'boolean' ? null : say(`${at} must be true or false`);
        case 'object': return isRecord(v) ? null : say(`${at} must be an object`);
        case 'objectSchema': return isRecord(v) && v.type === 'object' ? null : say(`${at} must be a JSON Schema with type "object"`);
        case 'stringList': return isStringList(v) ? null : say(`${at} must be a list of names`);
        case 'process': return v === 'worker' || v === 'subprocess' ? null : say(`${at} must be "worker" or "subprocess"`);
        case 'steps': return Array.isArray(v) && v.length > 0 && v.every(isRecord) ? null : say(`${at} must be a non-empty list of steps`);
        case 'extensions':
            if (!isStringList(v) || v.length === 0) return `${at} must claim at least one extension, like ".md"`;
            return v.every((x) => EXTENSION.test(x)) ? null : `${at}: a dot, then letters or digits, like ".md"`;
        case 'vettedEditor': return oneOf(VETTED_FANCY_EDITORS, v) ? null : `${at} "${String(v)}" is not a vetted Fancy editor (one of ${VETTED_FANCY_EDITORS.join(', ')})`;
        case 'vettedComponent': return oneOf(VETTED_FANCY_EXPORTS, v) ? null : `${at} "${String(v)}" is not a vetted Fancy component (one of ${VETTED_FANCY_EXPORTS.join(', ')})`;
    }
}

/** The kind's payload, checked field by field against its schema (KIND_SPECS). A family with no fields needs only an object. */
function payloadProblems(kind: CatalogKind, payload: Record<string, unknown>): string[] {
    const spec = KIND_SPECS.find((k) => k.kind === kind);
    if (!spec) return [];
    const out: string[] = [];
    for (const f of spec.fields) {
        const v = payload[f.name];
        if (v === undefined && !f.required) continue;
        const problem = fieldProblem(f, v);
        if (problem) out.push(problem);
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
        else {
            const allowed = KIND_SPECS.find((k) => k.kind === raw.kind)?.sides ?? null;
            if (allowed !== null && !allowed.includes(r.side)) say(`reach.side must be ${allowed.map((s) => `"${s}"`).join(' or ')} for a ${String(raw.kind)}`);
        }
        if (r.side === 'both') {
            if (!isRecord(r.link)) say('reach.link must say how its two sides talk when it runs on both: { calls: [host methods], events: [host events] }');
            else {
                problems.push(...unknownKeys(r.link, LINK_KEYS, `${where} reach.link`));
                if (!isStringList(r.link.calls) || !isStringList(r.link.events)) say('reach.link.calls and reach.link.events must be lists of names');
                else if (r.link.calls.length + r.link.events.length === 0) say('reach.link must name at least one call or event: an element on both sides talks across');
            }
        } else if (r.link !== undefined) say('reach.link is for an element on both sides; one side alone has no link');
        if (typeof r.requiresWindow !== 'boolean') say('reach.requiresWindow must be true or false');
        if (!oneOf(ELEMENT_REMOTE, r.remote)) say(`reach.remote must be one of ${ELEMENT_REMOTE.join(', ')}`);
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
