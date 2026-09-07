/**
 * Which Postgres extensions a workspace may declare, and why each one is on the
 * list (genie#526).
 *
 * ## The problem this closes
 *
 * `manageService` named "an extension" as a reason to flip `dedicated`. Nothing
 * implemented it, so an agent that followed the description got
 * `permission denied to create extension "vector"` on shared AND dedicated
 * alike, and the only route that worked was `docker exec … psql -U postgres`.
 * That is worse than a missing feature: it leaves state in a container Genie's
 * model believes it owns, and it teaches an agent that `docker exec` is how
 * service problems get solved.
 *
 * ## Why a WHITELIST and not a passthrough
 *
 * These statements run as the engine SUPERUSER, because that is the privilege
 * `CREATE EXTENSION` requires and the whole point is that Genie holds it instead
 * of handing it out. An arbitrary name from an agent would therefore be
 * superuser-level code execution wearing a convenience — several Postgres
 * extensions are not data types at all:
 *
 *   - `plpythonu`, `plperlu`, `plpython3u` — UNTRUSTED procedural languages.
 *     Their whole purpose is running arbitrary code as the postgres OS user,
 *     which is a container escape from the workspace's own database.
 *   - `dblink`, `postgres_fdw`, `file_fdw` — outbound connections and reads of
 *     server-side files. A workspace could reach another workspace's database
 *     with them, which is exactly the isolation `provision.ts` exists to build.
 *   - `adminpack` — writes files on the server.
 *
 * So the rule for membership is: a data type, an index method, or a function
 * library, that reaches nothing outside the database it is installed in and
 * needs no `shared_preload_libraries` (which would require a restart of an
 * engine other workspaces are using).
 *
 * ## Availability is a separate question from permission
 *
 * A name here means "Genie will try". Whether the IMAGE ships it is up to the
 * image — `postgis` in particular is not in the stock `postgres` image, and the
 * install will fail with Postgres's own "could not open extension control file",
 * which is a clear and correct answer. Refusing to list it would instead answer
 * a question nobody asked.
 */

/**
 * The extensions a workspace may declare.
 *
 * Each entry is here because it is a type/index/function library scoped to one
 * database:
 *
 *   - `vector`     pgvector. THE driver for this issue — the reporting workspace
 *                  was building a PgVectorStore. Ships in the postgres images
 *                  Genie pins (0.8.6 was reported available and uninstallable).
 *   - `postgis`    Geospatial types + indexes. Named in the report. Needs a
 *                  postgis image; see the note above about availability.
 *   - `uuid-ossp`  UUID generation. Contrib, and in almost every Laravel/Rails
 *                  schema that does not generate ids in the app.
 *   - `pg_trgm`    Trigram indexes for fuzzy text search. Contrib.
 *   - `citext`     Case-insensitive text — the ordinary way to store an email
 *                  address without a functional index everywhere. Contrib.
 *   - `hstore`     Key/value column type. Contrib.
 *   - `pgcrypto`   Hashing and encryption FUNCTIONS only; no file or network
 *                  reach. Contrib.
 *   - `unaccent`   A text-search dictionary. Contrib.
 *   - `btree_gin`  Index support so ordinary types can join a GIN index.
 *   - `btree_gist` The same for GiST — needed for exclusion constraints.
 *
 * Adding to this list is a deliberate act: read the rule in the header first,
 * and say in the commit why the new one cannot reach outside its database.
 */
export const POSTGRES_EXTENSIONS: readonly string[] = [
    'vector',
    'postgis',
    'uuid-ossp',
    'pg_trgm',
    'citext',
    'hstore',
    'pgcrypto',
    'unaccent',
    'btree_gin',
    'btree_gist',
];

/**
 * What an extension name may look like, INDEPENDENTLY of the whitelist.
 *
 * Defence in depth, and the same discipline as `provision.ts`'s identifier
 * guards: the name becomes a quoted SQL identifier run as superuser, so it must
 * come from a closed alphabet with no quote, backslash or semicolon in it —
 * whatever some future edit does to the list above.
 */
const EXTENSION_NAME = /^[a-z][a-z0-9_-]{0,62}$/;

export type NormalizedExtensions =
    | { ok: true; extensions: string[] }
    | { ok: false; error: string };

/**
 * PURE. Validate + canonicalise what a service declares.
 *
 * Absent is `[]` rather than an error: a service that declares nothing is the
 * ordinary case, not a mistake. Case is folded and duplicates collapse, because
 * a declaration is a SET — `['VECTOR','vector']` asks for one thing.
 *
 * The refusal names the whole allowed list, so a caller fixes its call in one
 * attempt instead of discovering the set one rejection at a time.
 */
export function normalizePostgresExtensions(
    input: readonly string[] | undefined,
): NormalizedExtensions {
    if (input === undefined) return { ok: true, extensions: [] };
    if (!Array.isArray(input)) {
        return { ok: false, error: '`extensions` must be a list of extension names.' };
    }
    const out: string[] = [];
    for (const raw of input) {
        if (typeof raw !== 'string') {
            return { ok: false, error: '`extensions` must be a list of extension names.' };
        }
        const name = raw.trim().toLowerCase();
        if (!EXTENSION_NAME.test(name) || !POSTGRES_EXTENSIONS.includes(name)) {
            return {
                ok: false,
                error:
                    `Genie will not install the Postgres extension ${JSON.stringify(raw)}. ` +
                    `Installing one runs as the engine superuser, so the set is fixed: ` +
                    `${POSTGRES_EXTENSIONS.join(', ')}.`,
            };
        }
        if (!out.includes(name)) out.push(name);
    }
    return { ok: true, extensions: out };
}

/**
 * The same check for ONE name, for a caller that has a single name to validate.
 * Shares the implementation so the two can never disagree.
 */
export function normalizePostgresExtension(
    name: string,
): { ok: true; extension: string } | { ok: false; error: string } {
    const result = normalizePostgresExtensions([name]);
    if (!result.ok) return result;
    return { ok: true, extension: result.extensions[0]! };
}
