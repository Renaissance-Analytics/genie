import { describe, expect, it } from 'vitest';
import { provisionSteps } from '../provision';
import { POSTGRES_EXTENSIONS, normalizePostgresExtensions } from '../extensions';

/**
 * Declared Postgres extensions, installed at PROVISION time (genie#526).
 *
 * ## What was promised and what was there
 *
 * `manageService`'s description named "an extension" as a reason to flip
 * `dedicated`. An agent did exactly that and got the same error on both sides:
 *
 *     ERROR: permission denied to create extension "vector"
 *     HINT:  Must be superuser to create this extension.
 *
 * Flipping changed the container and nothing about the privilege, because there
 * was no extension handling anywhere in `services/`. The only route that worked
 * was `docker exec … psql -U postgres -c "CREATE EXTENSION …"` — around Genie,
 * leaving state in a container Genie's model believes it owns.
 *
 * ## Why this belongs in provisioning rather than in a one-shot action
 *
 * Provisioning runs on EVERY acquire and is required to converge, so a declared
 * extension is reinstalled after an engine is recreated — the same reason the
 * Redis ACL branch lives here (its ACLs are in memory and vanish on restart). An
 * imperative `CREATE EXTENSION` alone would be lost by the next container
 * recreation, which is the late-truth problem this issue is about, one layer
 * down.
 *
 * It also settles `ready`: `runProvisionSteps` failing means `acquire` returns
 * `failed` and the service never becomes live, so a service that reports ready
 * HAS its declared extensions.
 *
 * ## Superuser stays with Genie
 *
 * The steps run as the engine admin the manager already holds
 * (`provision.ts` — "The engine's superuser, as the manager holds it"), inside
 * the workspace's OWN database. No privilege is granted to the workspace role
 * and no credential reaches an agent.
 */

const ADMIN = { user: 'postgres', password: 'aGVsbG8td29ybGQ' };
const SLICE = {
    identifier: 'ws_prism_1a2b3c4d',
    dnsName: 'ws-prism-1a2b3c4d',
    password: 'c2VjcmV0LXBhc3N3b3Jk',
};

/** The `CREATE EXTENSION` steps out of a full provisioning plan. */
function extensionSteps(extensions: string[]) {
    return provisionSteps('postgres', ADMIN, SLICE, { extensions }).filter((s) =>
        s.argv.some((a) => a.includes('CREATE EXTENSION')),
    );
}

describe('declared postgres extensions become provisioning steps', () => {
    it('installs a whitelisted extension in the WORKSPACE database, as the admin', () => {
        const steps = extensionSteps(['vector']);
        expect(steps).toHaveLength(1);
        const sql = steps[0]!.argv.at(-1)!;

        // Idempotent: provisioning runs on every acquire.
        expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "vector"');

        // …in the workspace's own database, NOT `postgres`. Installing into the
        // maintenance database would put the extension where the workspace's app
        // never connects, and report success for it.
        const uri = steps[0]!.argv.find((a) => a.startsWith('postgresql://'))!;
        expect(uri).toContain(`/${SLICE.identifier}`);
        expect(uri).not.toMatch(/\/postgres$/);

        // …as the engine admin. This is the whole point: the credential stays
        // with the manager and the workspace role gains nothing.
        expect(uri).toContain(`${ADMIN.user}:${ADMIN.password}@`);
    });

    it('runs AFTER the database exists, or it would have nothing to install into', () => {
        const all = provisionSteps('postgres', ADMIN, SLICE, { extensions: ['vector'] });
        const labels = all.map((s) => s.label);
        expect(labels).toContain('database');
        const dbAt = labels.indexOf('database');
        const extAt = all.findIndex((s) => s.argv.some((a) => a.includes('CREATE EXTENSION')));
        expect(extAt).toBeGreaterThan(dbAt);
    });

    it('declares nothing when the service declares nothing — the common path is untouched', () => {
        const before = provisionSteps('postgres', ADMIN, SLICE, {});
        expect(before.some((s) => s.argv.some((a) => a.includes('CREATE EXTENSION')))).toBe(false);
        expect(before.map((s) => s.label)).toEqual(['role', 'database', 'grants']);
    });

    it('installs several, in the order asked, one step each so a failure names one', () => {
        const steps = extensionSteps(['vector', 'pg_trgm']);
        expect(steps).toHaveLength(2);
        expect(steps[0]!.argv.at(-1)).toContain('"vector"');
        expect(steps[1]!.argv.at(-1)).toContain('"pg_trgm"');
        // The label carries the name, so `provisioning the … failed` says which.
        expect(steps[0]!.label).toContain('vector');
    });
});

describe('the whitelist is a whitelist', () => {
    it('REFUSES an extension that is not on the list — with a whitelisted one accepted beside it', () => {
        // The positive control is in the SAME test on purpose: "it refuses" is
        // satisfied by a validator that refuses everything.
        const bad = normalizePostgresExtensions(['plpython3u']);
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.error).toContain('plpython3u');

        const good = normalizePostgresExtensions(['vector']);
        expect(good.ok).toBe(true);
        if (good.ok) expect(good.extensions).toEqual(['vector']);
    });

    it('REFUSES the extensions that reach outside the workspace database', () => {
        // Each of these is a real escape rather than a data type: untrusted
        // procedural languages execute arbitrary code as the postgres OS user,
        // and the fdw/dblink family opens connections and reads server files.
        for (const name of ['plpythonu', 'plperlu', 'dblink', 'postgres_fdw', 'file_fdw', 'adminpack']) {
            const result = normalizePostgresExtensions([name]);
            expect(result.ok, `${name} must be refused`).toBe(false);
        }
        // Positive control, same test: the list is not simply empty.
        expect(normalizePostgresExtensions(['pgcrypto']).ok).toBe(true);
    });

    it('REFUSES anything that is not a bare identifier, whatever the list says', () => {
        // Defence in depth. The name becomes a quoted SQL identifier, so a quote
        // or a semicolon must never reach it even if the whitelist were edited
        // carelessly one day.
        for (const name of ['vector"; DROP DATABASE x --', 'vec tor', '', 'a'.repeat(100)]) {
            expect(normalizePostgresExtensions([name]).ok, `${name} must be refused`).toBe(false);
        }
    });

    it('is case-insensitive and de-duplicates, because a declaration is a set', () => {
        const result = normalizePostgresExtensions(['VECTOR', 'vector', 'pg_trgm']);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.extensions).toEqual(['vector', 'pg_trgm']);
    });

    it('accepts an absent declaration as "none", not as an error', () => {
        const result = normalizePostgresExtensions(undefined);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.extensions).toEqual([]);
    });

    it('names the allowed set in the refusal, so a caller can fix it in one go', () => {
        const result = normalizePostgresExtensions(['nope']);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            for (const allowed of ['vector', 'pg_trgm', 'uuid-ossp']) {
                expect(result.error).toContain(allowed);
            }
        }
    });

    it('the list holds the ones the issue named', () => {
        // `vector` is the driver; the rest are what the report expected to cover
        // "nearly every request".
        for (const name of ['vector', 'postgis', 'uuid-ossp', 'pg_trgm']) {
            expect(POSTGRES_EXTENSIONS).toContain(name);
        }
    });
});
