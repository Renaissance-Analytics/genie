import { join } from 'node:path';
import { SETTINGS, carryOverV1, migrateLegacyValue, type CarryOver, type SettingDef } from '../core/settings.js';
import { runtimeDir } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * THE SETTINGS STORE (§6.9) — values for the registry, durable and typed.
 *
 * Only values the user set are written. A default is never persisted, so a changed default in a
 * later Genie reaches every install that never touched that setting — the opposite of v1, where
 * a default copied into the file on first run was frozen there for the life of the install.
 *
 * The v1 carry-over runs ONCE. It is recorded with what was applied and what was dropped and why,
 * and a user's explicit value set before the carry-over wins over v1's.
 */

type Value = boolean | string;

interface SettingsFile {
    readonly values: Record<string, Value>;
    readonly carriedOver: CarriedOver | null;
}

export interface CarriedOver {
    readonly at: string;
    readonly applied: number;
    readonly dropped: Array<{ key: string; reason: string }>;
    /**
     * Whether a v1 database was actually read. A record made WITHOUT one is provisional: the first
     * release looked for v1's database in a directory v1 never wrote, recorded "done, nothing to
     * carry", and would have blocked the real carry-over forever. Absent in records written before
     * this field existed; such a record with nothing applied and nothing dropped is treated as
     * provisional too, because that is exactly the record that wrong path produced.
     */
    readonly sawV1?: boolean;
}

export type CarryOverResult = CarryOver & { alreadyDone?: true; noV1?: true };

const BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((s) => [s.key, s]));

/** Settings that held a secret and no longer exist: removed from settings.json on open. */
const RETIRED_SECRETS: readonly string[] = ['tynn_token'];

export class SettingsStore {
    readonly file: string;
    #values: Record<string, Value>;
    /** Per-workspace overrides for `scope: 'workspace'` keys (§6.1), by workspace id. */
    #workspaces: Record<string, Record<string, Value>>;
    #carriedOver: CarriedOver | null;
    readonly #now: () => string;
    readonly #listeners = new Set<(key: string, value: Value, workspaceId?: string) => void>();

    private constructor(file: string, data: SettingsFile, now: () => string, workspaces: Record<string, Record<string, Value>>) {
        this.file = file;
        this.#values = { ...data.values };
        this.#workspaces = workspaces;
        this.#carriedOver = data.carriedOver;
        this.#now = now;
    }

    static async open(userData: string, now: () => string = () => new Date().toISOString()): Promise<SettingsStore> {
        const file = join(runtimeDir(userData), 'settings.json');
        const raw = await readJson<Partial<SettingsFile> & Record<string, unknown>>(file, { values: {}, carriedOver: null });
        // The file holds the user's values at the top level; the carry-over record rides beside them
        // under a key no setting may use.
        const { __carriedOver, __workspaces, ...values } = raw as Record<string, unknown> & { __carriedOver?: CarriedOver | null; __workspaces?: unknown };
        // Workspace overrides: only workspace-scoped keys with well-typed values survive the read.
        const workspaces: Record<string, Record<string, Value>> = {};
        if (typeof __workspaces === 'object' && __workspaces !== null) {
            for (const [wid, vals] of Object.entries(__workspaces as Record<string, unknown>)) {
                if (typeof vals !== 'object' || vals === null) continue;
                const kept: Record<string, Value> = {};
                for (const [k, v] of Object.entries(vals as Record<string, unknown>)) {
                    if (BY_KEY.get(k)?.scope === 'workspace' && (typeof v === 'boolean' || typeof v === 'string')) kept[k] = v;
                }
                if (Object.keys(kept).length > 0) workspaces[wid] = kept;
            }
        }
        const clean: Record<string, Value> = {};
        for (const [k, v] of Object.entries(values)) {
            // A renamed value (a stored `update_channel: beta`) is read as its new name, not kept as an option that no longer exists.
            if (BY_KEY.has(k) && (typeof v === 'boolean' || typeof v === 'string')) clean[k] = migrateLegacyValue(k, v);
        }
        const store = new SettingsStore(file, { values: clean, carriedOver: __carriedOver ?? null }, now, workspaces);
        // A RETIRED SECRET is wiped from the file, not just left unread: Genie 2 once kept a pasted Tynn token here in
        // plain text, and sign-in now keeps its key encrypted (main/tynn-account.ts). Only when one is present — a file
        // without one is not rewritten.
        if (RETIRED_SECRETS.some((k) => k in values)) await store.#flush();
        return store;
    }

    get(key: string): Value {
        const def = BY_KEY.get(key);
        if (!def) throw new Error(`${key} is not a setting Genie knows`);
        return this.#values[key] ?? def.default;
    }

    async set(key: string, value: unknown): Promise<void> {
        const def = BY_KEY.get(key);
        if (!def) throw new Error(`${key} is not a setting Genie knows`);
        const checked = check(def, value);
        if (this.#values[key] === checked) return;
        this.#values[key] = checked;
        await this.#flush();
        for (const l of this.#listeners) l(key, checked);
    }

    /** Override a workspace-scoped setting for ONE workspace (§6.1). A workstation setting is refused, never written globally by accident. */
    async setFor(workspaceId: string, key: string, value: unknown): Promise<void> {
        const def = BY_KEY.get(key);
        if (!def) throw new Error(`${key} is not a setting Genie knows`);
        if (def.scope !== 'workspace') throw new Error(`${key} is a workstation setting, not a workspace one`);
        const checked = check(def, value);
        const current = this.#workspaces[workspaceId] ?? {};
        if (current[key] === checked) return;
        this.#workspaces = { ...this.#workspaces, [workspaceId]: { ...current, [key]: checked } };
        await this.#flush();
        for (const l of this.#listeners) l(key, checked, workspaceId);
    }

    async resetFor(workspaceId: string, key: string): Promise<void> {
        const def = BY_KEY.get(key);
        if (!def) throw new Error(`${key} is not a setting Genie knows`);
        const current = this.#workspaces[workspaceId];
        if (!current || !(key in current)) return;
        const { [key]: _dropped, ...rest } = current;
        const next = { ...this.#workspaces };
        if (Object.keys(rest).length > 0) next[workspaceId] = rest; else delete next[workspaceId];
        this.#workspaces = next;
        await this.#flush();
        for (const l of this.#listeners) l(key, this.#values[key] ?? def.default, workspaceId);
    }

    /** The overrides this workspace holds — what the surface marks as "overriding the workstation value". */
    workspaceValues(workspaceId: string): Record<string, Value> {
        return { ...(this.#workspaces[workspaceId] ?? {}) };
    }

    /** The effective view for one workspace: its override, else the workstation value, else the default. */
    snapshotFor(workspaceId: string): Record<string, Value> {
        return { ...this.snapshot(), ...(this.#workspaces[workspaceId] ?? {}) };
    }

    async reset(key: string): Promise<void> {
        const def = BY_KEY.get(key);
        if (!def) throw new Error(`${key} is not a setting Genie knows`);
        if (!(key in this.#values)) return;
        delete this.#values[key];
        await this.#flush();
        for (const l of this.#listeners) l(key, def.default);
    }

    onChange(listener: (key: string, value: Value, workspaceId?: string) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Every registry setting with its effective value — the user's or the default. */
    snapshot(): Record<string, Value> {
        const out: Record<string, Value> = {};
        for (const def of SETTINGS) out[def.key] = this.#values[def.key] ?? def.default;
        return out;
    }

    carriedOver(): CarriedOver | null {
        return this.#carriedOver;
    }

    /**
     * Once v1 has been SEEN. A carry-over that saw v1 is done for good; one recorded with no v1
     * database (`null`) is provisional and runs again the first time a v1 database is there.
     */
    async carryOverFromV1(v1: Readonly<Record<string, string>> | null): Promise<CarryOverResult> {
        const prior = this.#carriedOver;
        const provisional = prior !== null && prior.sawV1 !== true && prior.applied === 0 && prior.dropped.length === 0;
        if (prior && !(provisional && v1 !== null)) return { applied: {}, dropped: [], alreadyDone: true };
        if (v1 === null) {
            this.#carriedOver = { at: this.#now(), applied: 0, dropped: [], sawV1: false };
            await this.#flush();
            return { applied: {}, dropped: [], noV1: true };
        }
        const result = carryOverV1(v1);
        const applied: Record<string, Value> = {};
        for (const [key, value] of Object.entries(result.applied)) {
            // An explicit value already set by the user wins over v1's.
            if (key in this.#values) continue;
            this.#values[key] = value;
            applied[key] = value;
        }
        this.#carriedOver = { at: this.#now(), applied: Object.keys(result.applied).length, dropped: result.dropped, sawV1: true };
        await this.#flush();
        for (const [key, value] of Object.entries(applied)) for (const l of this.#listeners) l(key, value);
        return { applied: result.applied, dropped: result.dropped };
    }

    async #flush(): Promise<void> {
        const out: Record<string, unknown> = { ...this.#values };
        if (this.#carriedOver) out.__carriedOver = this.#carriedOver;
        // Only what the user set is written: no overrides, no key — a default-shaped file stays default-shaped.
        if (Object.keys(this.#workspaces).length > 0) out.__workspaces = this.#workspaces;
        await writeJsonAtomic(this.file, out);
    }
}

function check(def: SettingDef, value: unknown): Value {
    if (def.type === 'boolean') {
        if (typeof value !== 'boolean') throw new Error(`${def.key} takes a boolean; got ${JSON.stringify(value)}`);
        return value;
    }
    if (typeof value !== 'string') throw new Error(`${def.key} takes a string; got ${JSON.stringify(value)}`);
    if (def.type === 'enum' && !def.options.includes(value)) {
        throw new Error(`${def.key} takes one of ${def.options.join(' | ')}; got ${JSON.stringify(value)}`);
    }
    return value;
}
