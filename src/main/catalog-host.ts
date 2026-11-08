import type { Catalog, CatalogKind, ElementDefinition } from '../core/catalog.js';
import { diffCatalog, type CatalogChange, type CatalogSnapshot } from '../core/catalog-sync.js';

/**
 * GENIE-HOST'S CATALOG, SERVED (ADF A4, Tynn #448). The host builds its catalog (Genie's own elements and every enabled
 * installed plugin's, main/genie-catalog.ts) and keeps its OWN revision: a rebuild that changes something moves it by one
 * and tells every window the difference (`catalog.changed`, from its base revision); one that changes nothing moves
 * nothing and says nothing. A window starts from `snapshot()` and asks `docs()` for one element.
 */
export class CatalogService {
    readonly #build: () => Catalog;
    #revision = 1;
    #defs: readonly ElementDefinition[];
    readonly #listeners = new Set<(change: CatalogChange) => void>();

    constructor(build: () => Catalog) {
        this.#build = build;
        this.#defs = build().list();
    }

    snapshot(): CatalogSnapshot {
        return { revision: this.#revision, definitions: this.#defs };
    }

    /** One element's definition (its docs, schemas and payload), by kind and id or alias; `null` when there is none. */
    docs(kind: CatalogKind, id: string): ElementDefinition | null {
        const d = this.#defs.find((x) => x.id === id || x.aliases.includes(id));
        return d && d.kind === kind ? d : null;
    }

    /** Build again (a plugin was enabled, disabled, installed or removed); tell the difference, if there is one. */
    rebuild(): void {
        const next = this.#build().list();
        const { upsert, remove } = diffCatalog(this.#defs, next);
        if (upsert.length === 0 && remove.length === 0) return;
        const change: CatalogChange = { base: this.#revision, revision: this.#revision + 1, upsert, remove };
        this.#defs = next;
        this.#revision = change.revision;
        for (const listener of [...this.#listeners]) listener(change);
    }

    onEvent(listener: (change: CatalogChange) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }
}
