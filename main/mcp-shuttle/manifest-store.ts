/**
 * THE PUBLISHED SURFACE — what the MCP shuttle serves, and why it outlives Genie.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §4.2.
 *
 * The shuttle answers `tools/list`, `prompts/list` and `resources/list` from the last
 * published manifest ALONE — never by asking Genie. While Genie is being replaced
 * there is nobody to ask, and a client that re-lists mid-swap must get the same
 * surface: not an empty list, and not an error that reads as "your tools are gone".
 *
 * Every publish is persisted, so a shuttle that restarts with no Genie attached still
 * serves the last known surface from disk.
 *
 * ## Absent is not empty
 *
 * With no manifest at all, the lists are reported as `null`, never `[]`. An empty
 * tool list tells an agent "this server has no tools" — the exact misreading genie#346
 * describes. `null` lets the listener answer with a named state instead. A manifest
 * that genuinely declares no tools is `[]`, and the two are tested against each other.
 *
 * ## list_changed only on a real change
 *
 * A routine swap republishes an identical surface under a new generation and a new
 * Genie version. Neither field is part of the comparison: emitting `list_changed` on
 * every restart would make every connected client re-fetch for nothing, which reads
 * as churn and is not. The comparison is also insensitive to key order, because two
 * builds can serialise the same schema differently.
 *
 * PURE apart from the injected read/write.
 */

export interface ShuttleTool {
    name: string;
    description?: string;
    inputSchema: unknown;
    [extra: string]: unknown;
}

export interface ShuttlePrompt {
    name: string;
    description?: string;
    [extra: string]: unknown;
}

export interface ShuttleResource {
    uri: string;
    name: string;
    [extra: string]: unknown;
}

export interface ShuttleManifest {
    genieVersion: string;
    /** Monotonic per Genie boot. Informational here: which publisher is live is
     *  decided by the publisher gate, not by comparing generations — a new Genie
     *  boot starts counting again. */
    generation: number;
    tools: ShuttleTool[];
    prompts: ShuttlePrompt[];
    resources: ShuttleResource[];
    [extra: string]: unknown;
}

export type ManifestList = 'tools' | 'prompts' | 'resources';

export interface PublishOutcome {
    accepted: boolean;
    /** Every list whose content changed, in a fixed order. Empty on no change. */
    changed: ManifestList[];
}

export interface ManifestPersistence {
    read(): string | null;
    write(body: string): void;
}

export interface ManifestStore {
    /** Load the last persisted manifest. A missing or corrupt one is "none". */
    boot(): void;
    publish(manifest: ShuttleManifest): PublishOutcome;
    tools(): ShuttleTool[] | null;
    prompts(): ShuttlePrompt[] | null;
    resources(): ShuttleResource[] | null;
}

const LISTS: ManifestList[] = ['tools', 'prompts', 'resources'];

/** JSON with object keys sorted at every depth, so key order cannot fake a change. */
function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
            : v,
    );
}

function isManifest(value: unknown): value is ShuttleManifest {
    if (!value || typeof value !== 'object') return false;
    const m = value as Record<string, unknown>;
    return (
        typeof m.genieVersion === 'string' &&
        Number.isInteger(m.generation) &&
        Array.isArray(m.tools) &&
        Array.isArray(m.prompts) &&
        Array.isArray(m.resources)
    );
}

export function createManifestStore(disk: ManifestPersistence): ManifestStore {
    let current: ShuttleManifest | null = null;

    return {
        boot() {
            let raw: string | null = null;
            try {
                raw = disk.read();
            } catch {
                raw = null;
            }
            if (!raw) return;
            try {
                const parsed: unknown = JSON.parse(raw);
                // A torn or hand-edited file is no manifest, not a crash.
                if (isManifest(parsed)) current = parsed;
            } catch {
                /* corrupt — serve nothing rather than take discovery down */
            }
        },

        publish(manifest) {
            if (!isManifest(manifest)) return { accepted: false, changed: [] };

            const previous = current;
            const changed = previous
                ? LISTS.filter((list) => canonical(previous[list]) !== canonical(manifest[list]))
                : // Nothing was being served, so every list is new to a client — but
                  // only the ones that actually carry something are worth announcing.
                  LISTS.filter((list) => manifest[list].length > 0);

            current = manifest;
            try {
                disk.write(JSON.stringify(manifest));
            } catch {
                // Serving the new surface still matters more than persisting it. The
                // cost of a failed write is only a staler cold boot.
            }
            return { accepted: true, changed };
        },

        tools: () => current?.tools ?? null,
        prompts: () => current?.prompts ?? null,
        resources: () => current?.resources ?? null,
    };
}
