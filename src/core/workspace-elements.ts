import { AGENT_NAME } from './agent-adoption.js';
import type { IssueWatchSetting } from './issue-watch.js';
import type { ServiceInstance } from './services.js';
import { SETTINGS } from './settings.js';
import type { LiveModel } from './workspace-save.js';

/**
 * SERVICES, WORKSPACE SETTINGS AND ISSUEWATCH AS WHAT A REPO KEEPS OF THEM (Tynn #756, PR3), against shared-schemas v0.5.0.
 *
 * Only the DECLARATION is saved: which engines the workspace uses (engine, variant, major, scope, whether on), the few
 * workspace settings that are portable, and how each agent hears IssueWatch. Never a credential, a published port, a
 * container, a volume, a password, a capability grant or a safety setting: those are made, or chosen, on each machine. A
 * fresh clone's restore plan says what to attach and what to create; it creates engines with new credentials and never copies
 * any (the data of a dedicated database does not travel).
 */

export interface ServiceDeclaration {
    readonly engine: string;
    readonly variant?: string;
    readonly version?: string;
    readonly scope?: 'shared' | 'dedicated';
    readonly active?: boolean;
    readonly detached?: boolean;
    readonly name?: string;
    readonly image?: string;
    readonly internalPort?: number;
    readonly kind?: string;
    readonly envKeys?: readonly string[];
}

/** Something left out of a save, and why: shown, never silent. */
export interface Exclusion {
    readonly field: string;
    readonly reason: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A path that stays inside the workspace: not a drive, not rooted, not climbing out. The schema's own pattern, in code. */
const staysInside = (p: string): boolean => p !== '' && !/^[A-Za-z]:/.test(p) && !/^[\\/]/.test(p) && !p.split(/[\\/]/).includes('..');

/** Whether the workspace uses this engine: its own dedicated one, or a shared one it has a slice in. */
const usedBy = (i: ServiceInstance, workspaceId: string): boolean =>
    i.scope.kind === 'dedicated' ? i.scope.workspaceId === workspaceId : i.slices !== undefined && workspaceId in i.slices;

const idOf = (d: ServiceDeclaration): string => [d.engine, d.variant, d.name ?? d.version].filter((p): p is string => typeof p === 'string' && p !== '').join(':');

/** The engines this workspace uses, as the schema's `services` entries, in a stable order (a save is never a reorder). */
export function servicesDeclaration(instances: readonly ServiceInstance[], workspaceId: string): { value: ServiceDeclaration[]; excluded: Exclusion[] } {
    const value: ServiceDeclaration[] = [];
    const excluded: Exclusion[] = [];
    for (const i of instances) {
        if (!usedBy(i, workspaceId)) continue;
        const shared = i.scope.kind === 'shared';
        const active = shared ? i.slices?.[workspaceId]?.active ?? i.active : i.active;
        const scope = shared ? 'shared' as const : 'dedicated' as const;
        if (i.engine === 'custom') {
            if (!nonEmpty(i.image) || !Number.isInteger(i.internalPort)) {
                excluded.push({ field: `services/custom:${i.version}`, reason: 'its image and the port inside its container are not known, so a clone could not recreate it' });
                continue;
            }
            const envKeys = Object.keys(i.env ?? {}).sort();
            value.push({ engine: 'custom', name: i.version, image: i.image, internalPort: i.internalPort as number, kind: i.kind ?? 'custom', scope, active, ...(envKeys.length > 0 ? { envKeys } : {}) });
            continue;
        }
        value.push({
            engine: i.engine,
            ...(i.variant ? { variant: i.variant } : {}),
            version: i.version,
            scope,
            active,
            ...(shared && (i.detached ?? []).includes(workspaceId) ? { detached: true } : {}),
        });
    }
    value.sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
    return { value, excluded };
}

export interface ServiceRestoreAction {
    readonly declaration: ServiceDeclaration;
    /** present: already used here. attach: a shared engine on this machine, joined. create: made new, with its own credentials. */
    readonly action: 'present' | 'attach' | 'create';
    readonly scope: 'shared' | 'dedicated';
    readonly instanceId?: string;
}

const DECLARED_KEYS: ReadonlySet<string> = new Set(['engine', 'variant', 'version', 'scope', 'active', 'detached', 'name', 'image', 'internalPort', 'kind', 'envKeys']);

/** One declaration as the schema allows it, or why not. Anything the schema does not name (a password, a port) refuses the entry. */
function declarationOf(raw: unknown): ServiceDeclaration | string {
    if (!isRecord(raw)) return 'an engine is an object';
    const stray = Object.keys(raw).find((k) => !DECLARED_KEYS.has(k));
    if (stray !== undefined) return `${stray} is not saved with an engine; it is made on each machine`;
    if (!nonEmpty(raw.engine)) return 'an engine needs a name';
    for (const k of ['variant', 'version', 'name', 'image', 'kind'] as const) if (raw[k] !== undefined && !nonEmpty(raw[k])) return `${k} is text`;
    if (raw.scope !== undefined && raw.scope !== 'shared' && raw.scope !== 'dedicated') return 'scope is shared or dedicated';
    for (const k of ['active', 'detached'] as const) if (raw[k] !== undefined && typeof raw[k] !== 'boolean') return `${k} is true or false`;
    if (raw.internalPort !== undefined && !(Number.isInteger(raw.internalPort) && (raw.internalPort as number) >= 1 && (raw.internalPort as number) <= 65535)) return 'internalPort is a port';
    if (raw.envKeys !== undefined && !(Array.isArray(raw.envKeys) && raw.envKeys.every((k) => typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)))) return 'envKeys is a list of names';
    if (raw.engine === 'custom' && !(nonEmpty(raw.name) && nonEmpty(raw.image) && raw.internalPort !== undefined && nonEmpty(raw.kind))) return 'a custom engine needs a name, an image, the port inside it and a kind';
    return { ...raw } as unknown as ServiceDeclaration;
}

const matches = (d: ServiceDeclaration, i: ServiceInstance): boolean => {
    if (i.engine !== d.engine) return false;
    if (d.engine === 'custom') return i.version === d.name;
    return (i.variant ?? undefined) === (d.variant ?? undefined) && (d.version === undefined || i.version === d.version);
};

/**
 * What opening a fresh clone does about its declared engines, against the engines this machine already has. It plans only: it
 * starts nothing and copies no credential. A declaration the schema would refuse is refused with its place; the rest go on.
 */
export function servicesRestorePlan(declared: unknown, instances: readonly ServiceInstance[], workspaceId: string): { actions: ServiceRestoreAction[]; refused: { index: number; reason: string }[] } {
    if (!Array.isArray(declared)) return { actions: [], refused: [{ index: -1, reason: 'services is a list of engines' }] };
    const actions: ServiceRestoreAction[] = [];
    const refused: { index: number; reason: string }[] = [];
    declared.forEach((raw, index) => {
        const declaration = declarationOf(raw);
        if (typeof declaration === 'string') { refused.push({ index, reason: declaration }); return; }
        const scope = declaration.scope ?? 'shared';
        const candidates = instances.filter((i) => matches(declaration, i));
        const mine = candidates.find((i) => (scope === 'dedicated' ? i.scope.kind === 'dedicated' && i.scope.workspaceId === workspaceId : i.scope.kind === 'shared' && i.slices !== undefined && workspaceId in i.slices));
        if (mine) { actions.push({ declaration, action: 'present', scope, instanceId: mine.id }); return; }
        const shared = scope === 'shared' ? candidates.find((i) => i.scope.kind === 'shared') : undefined;
        if (shared) { actions.push({ declaration, action: 'attach', scope, instanceId: shared.id }); return; }
        actions.push({ declaration, action: 'create', scope });
    });
    return { actions, refused };
}

export interface WorkspaceSettingsInput {
    /** The workspace's own overrides, as the settings store keeps them. */
    readonly overrides: Readonly<Record<string, boolean | string>>;
    /** Its default agent, by NAME. */
    readonly defaultAgent: string | null;
    readonly envFile: string | null;
    readonly mcpOff: readonly string[];
}

/** The workspace settings that travel, with the setting each is, and the values Genie offers for it. */
const PORTABLE = [
    { key: 'agentCap', setting: 'agent_cap' },
    { key: 'limitTerminals', setting: 'limit_terminals' },
    { key: 'limitProcesses', setting: 'limit_processes' },
] as const;

/** Settings that loosen safety or open a door: chosen on each machine, never read from a repo. */
const SAFETY_SETTINGS: readonly string[] = ['approval_gates', 'app_inbox', 'playwright_server'];

const optionsOf = (setting: string): readonly string[] => {
    const def = SETTINGS.find((s) => s.key === setting);
    return def && 'options' in def && Array.isArray(def.options) ? (def.options as readonly string[]) : [];
};

/** The allow-listed workspace settings as the schema's `workspace` object (null when none is set), and what was left out. */
export function workspaceSettingsDeclaration(input: WorkspaceSettingsInput): { value: Record<string, unknown> | null; excluded: Exclusion[] } {
    const value: Record<string, unknown> = {};
    const excluded: Exclusion[] = [];
    for (const key of SAFETY_SETTINGS) {
        if (key in input.overrides) excluded.push({ field: key, reason: 'a safety setting: it is chosen on each machine and never saved to a repo' });
    }
    for (const { key, setting } of PORTABLE) {
        const raw = input.overrides[setting];
        if (raw === undefined) continue;
        if (typeof raw === 'string' && optionsOf(setting).includes(raw)) value[key] = Number(raw);
        else excluded.push({ field: setting, reason: `${String(raw)} is not a value Genie offers` });
    }
    if (input.defaultAgent !== null) {
        if (AGENT_NAME.test(input.defaultAgent)) value.defaultAgent = input.defaultAgent;
        else excluded.push({ field: 'defaultAgent', reason: `${input.defaultAgent} is not an agent name` });
    }
    if (input.envFile !== null) {
        if (staysInside(input.envFile)) value.envFile = input.envFile;
        else excluded.push({ field: 'envFile', reason: 'the env file must be a name inside each site’s folder, not a path on this machine' });
    }
    if (input.mcpOff.length > 0) value.mcpOff = [...input.mcpOff];
    return { value: Object.keys(value).length > 0 ? value : null, excluded };
}

/**
 * What a fresh clone applies from a `workspace` object: only the allow-list, each value checked the way Genie offers it. Every
 * other key (an approval gate, the app inbox, a path, an id, a capability grant) is IGNORED and named, so a hand-edited file
 * cannot loosen a safety setting on whoever opens the clone.
 */
export function workspaceSettingsRestore(declared: unknown): { settings: Record<string, string>; defaultAgent: string | null; envFile: string | null; mcpOff: string[] | null; ignored: string[] } {
    const out = { settings: {} as Record<string, string>, defaultAgent: null as string | null, envFile: null as string | null, mcpOff: null as string[] | null, ignored: [] as string[] };
    if (!isRecord(declared)) return out;
    for (const [key, value] of Object.entries(declared)) {
        const portable = PORTABLE.find((p) => p.key === key);
        if (portable) {
            if (Number.isInteger(value) && optionsOf(portable.setting).includes(String(value))) out.settings[portable.setting] = String(value);
            else out.ignored.push(key);
        } else if (key === 'defaultAgent') {
            if (typeof value === 'string' && AGENT_NAME.test(value)) out.defaultAgent = value; else out.ignored.push(key);
        } else if (key === 'envFile') {
            if (typeof value === 'string' && staysInside(value)) out.envFile = value; else out.ignored.push(key);
        } else if (key === 'mcpOff') {
            if (Array.isArray(value) && value.every(nonEmpty)) out.mcpOff = [...value]; else out.ignored.push(key);
        } else out.ignored.push(key);
    }
    return out;
}

/** What the workspace holds that a save declares. */
export interface ElementSources {
    readonly services: readonly ServiceInstance[];
    readonly workspace: WorkspaceSettingsInput;
    /** Each of the workspace's agents and how it hears IssueWatch (`null` = never chosen). */
    readonly agents: readonly { readonly name: string; readonly issueWatch: IssueWatchSetting | null }[];
}

/**
 * The live model with these declarations in its manifest: `services` and `workspace` set (or taken out when nothing is left
 * to declare, so clearing a setting is a saved change), and each agent's `issueWatch` set on its own config entry (an agent
 * with no config entry has no purpose to declare and is skipped). Every other key keeps its place.
 */
export function withElements(model: LiveModel, sources: ElementSources, workspaceId: string): { model: LiveModel; excluded: Exclusion[] } {
    const manifest: Record<string, unknown> = { ...model.manifest };
    const services = servicesDeclaration(sources.services, workspaceId);
    const settings = workspaceSettingsDeclaration(sources.workspace);
    if (services.value.length > 0) manifest.services = services.value; else delete manifest.services;
    if (settings.value !== null) manifest.workspace = settings.value; else delete manifest.workspace;
    if (isRecord(manifest.agents)) {
        const agents: Record<string, unknown> = { ...manifest.agents };
        for (const a of sources.agents) {
            const entry = agents[a.name];
            if (!isRecord(entry)) continue;
            if (a.issueWatch !== null) {
                agents[a.name] = { ...entry, issueWatch: { delivery: a.issueWatch.delivery, kinds: [...a.issueWatch.kinds] } };
            } else {
                const { issueWatch: _gone, ...rest } = entry;
                agents[a.name] = rest;
            }
        }
        manifest.agents = agents;
    }
    return { model: { ...model, manifest }, excluded: [...services.excluded, ...settings.excluded] };
}
