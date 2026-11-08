import type { ElementDefinition } from './catalog.js';

/**
 * THE CATALOG ACROSS A CONNECTION (ADF A4, Tynn #448; spec .ai/plans/specs/adf-sdk.md) — pure. The host's catalog is
 * revisioned: a window starts from a SNAPSHOT (`catalog.snapshot`), then follows CHANGES (`catalog.changed`), each saying
 * the revision it applies to (`base`) and the one it makes. A change whose base is not the revision a replica holds means
 * it missed one: it asks for the snapshot again rather than guess. What crosses is metadata only (catalog.ts).
 */

export interface CatalogSnapshot {
    readonly revision: number;
    readonly definitions: readonly ElementDefinition[];
}

export interface CatalogChange {
    /** The revision this change applies to. */
    readonly base: number;
    /** The revision it makes. */
    readonly revision: number;
    /** Added or replaced, whole, by id. */
    readonly upsert: readonly ElementDefinition[];
    /** Gone, by id. */
    readonly remove: readonly string[];
}

/** What changed from one list of definitions to the next: upserts (new or different) and removals, by id. */
export function diffCatalog(before: readonly ElementDefinition[], after: readonly ElementDefinition[]): { upsert: ElementDefinition[]; remove: string[] } {
    const old = new Map(before.map((d) => [d.id, JSON.stringify(d)]));
    const next = new Set(after.map((d) => d.id));
    return {
        upsert: after.filter((d) => old.get(d.id) !== JSON.stringify(d)),
        remove: before.filter((d) => !next.has(d.id)).map((d) => d.id),
    };
}

/** A window's copy of the host's catalog, at a revision. */
export class CatalogReplica {
    #revision = -1;
    #defs = new Map<string, ElementDefinition>();
    /** Every alias, to its definition's id. */
    #aliases = new Map<string, string>();
    readonly #snapshot: () => Promise<CatalogSnapshot>;

    constructor(snapshot: () => Promise<CatalogSnapshot>) {
        this.#snapshot = snapshot;
    }

    /** `-1` until the first snapshot. */
    get revision(): number { return this.#revision; }

    rebase(snapshot: CatalogSnapshot): void {
        this.#revision = snapshot.revision;
        this.#defs = new Map(snapshot.definitions.map((d) => [d.id, d]));
        this.#reindex();
    }

    /** A change from the revision held is applied; from any other, the snapshot is asked for again. */
    async apply(change: CatalogChange): Promise<void> {
        if (change.revision <= this.#revision) return; // already have it (a snapshot taken after it was made)
        if (change.base !== this.#revision) {
            this.rebase(await this.#snapshot());
            return;
        }
        for (const id of change.remove) this.#defs.delete(id);
        for (const d of change.upsert) this.#defs.set(d.id, d);
        this.#revision = change.revision;
        this.#reindex();
    }

    list(kind?: ElementDefinition['kind']): ElementDefinition[] {
        const all = [...this.#defs.values()];
        return kind === undefined ? all : all.filter((d) => d.kind === kind);
    }

    /** By id or alias; `null` when this replica holds nothing by that name. */
    get(name: string): ElementDefinition | null {
        return this.#defs.get(name) ?? this.#defs.get(this.#aliases.get(name) ?? '') ?? null;
    }

    #reindex(): void {
        this.#aliases = new Map([...this.#defs.values()].flatMap((d) => d.aliases.map((a) => [a, d.id] as const)));
    }
}

/** The compiled adapters THIS window carries (VETTED_FANCY_EDITORS, VETTED_FANCY_EXPORTS for this build). */
export interface WindowAdapters {
    readonly editors: readonly string[];
    readonly panels: readonly string[];
}

/**
 * Which compiled adapter opens this element in THIS window. An element that names one this window does not carry (a
 * newer Genie's) is said, with its name: "needs a newer Genie" — never a blank pane. A kind a window does not open (a
 * tool) is not something to open here.
 */
export function adapterFor(def: ElementDefinition, has: WindowAdapters): { ok: true; adapter: string } | { ok: false; reason: string } {
    const name = def.docs.name;
    if (def.kind === 'editor' || def.kind === 'panel') {
        const adapter = def.kind === 'editor' ? def.payload.fancyEditor : def.payload.fancyComponent;
        const carried = def.kind === 'editor' ? has.editors : has.panels;
        if (typeof adapter === 'string' && carried.includes(adapter)) return { ok: true, adapter };
        return { ok: false, reason: `${name} needs a newer Genie: this window does not have its ${def.kind} (${String(adapter)}).` };
    }
    return { ok: false, reason: `${name} is a ${def.kind}; a window does not open it.` };
}
