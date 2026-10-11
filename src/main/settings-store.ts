import { join } from 'node:path';
import { SETTINGS, carryOverV1, type CarryOver, type SettingDef } from '../core/settings.js';
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
}

export type CarryOverResult = CarryOver & { alreadyDone?: true; noV1?: true };

const BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((s) => [s.key, s]));

export class SettingsStore {
    readonly file: string;
    #values: Record<string, Value>;
    #carriedOver: CarriedOver | null;
    readonly #now: () => string;
    readonly #listeners = new Set<(key: string, value: Value) => void>();

    private constructor(file: string, data: SettingsFile, now: () => string) {
        this.file = file;
        this.#values = { ...data.values };
        this.#carriedOver = data.carriedOver;
        this.#now = now;
    }

    static async open(userData: string, now: () => string = () => new Date().toISOString()): Promise<SettingsStore> {
        const file = join(runtimeDir(userData), 'settings.json');
        const raw = await readJson<Partial<SettingsFile> & Record<string, unknown>>(file, { values: {}, carriedOver: null });
        // The file holds the user's values at the top level; the carry-over record rides beside them
        // under a key no setting may use.
        const { __carriedOver, ...values } = raw as Record<string, unknown> & { __carriedOver?: CarriedOver | null };
        const clean: Record<string, Value> = {};
        for (const [k, v] of Object.entries(values)) {
            if (BY_KEY.has(k) && (typeof v === 'boolean' || typeof v === 'string')) clean[k] = v;
        }
        return new SettingsStore(file, { values: clean, carriedOver: __carriedOver ?? null }, now);
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

    async reset(key: string): Promise<void> {
        const def = BY_KEY.get(key);
        if (!def) throw new Error(`${key} is not a setting Genie knows`);
        if (!(key in this.#values)) return;
        delete this.#values[key];
        await this.#flush();
        for (const l of this.#listeners) l(key, def.default);
    }

    onChange(listener: (key: string, value: Value) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    carriedOver(): CarriedOver | null {
        return this.#carriedOver;
    }

    /** Once. A `null` v1 (no database) is recorded as done with nothing to carry. */
    async carryOverFromV1(v1: Readonly<Record<string, string>> | null): Promise<CarryOverResult> {
        if (this.#carriedOver) return { applied: {}, dropped: [], alreadyDone: true };
        if (v1 === null) {
            this.#carriedOver = { at: this.#now(), applied: 0, dropped: [] };
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
        this.#carriedOver = { at: this.#now(), applied: Object.keys(result.applied).length, dropped: result.dropped };
        await this.#flush();
        for (const [key, value] of Object.entries(applied)) for (const l of this.#listeners) l(key, value);
        return { applied: result.applied, dropped: result.dropped };
    }

    async #flush(): Promise<void> {
        const out: Record<string, unknown> = { ...this.#values };
        if (this.#carriedOver) out.__carriedOver = this.#carriedOver;
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
