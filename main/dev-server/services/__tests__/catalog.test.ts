import { describe, expect, it } from 'vitest';
import {
    DEFAULT_VERSIONS,
    GENIE_POSTGRES_IMAGE,
    GENIE_POSTGRES_IMAGE_MAJOR,
    SERVICE_ENGINES,
    engineKeyFor,
    engineSpecFor,
    isServiceEngine,
    parseEngineKey,
    resolveEngineVersion,
    workspaceDnsName,
    workspaceSqlIdentifier,
} from '../catalog';

/**
 * The typed service CATALOG (Tynn #234, P3).
 *
 * What is being asserted is the owner's service model expressed as data: an
 * engine is identified by (engine, MAJOR VERSION), because that pair — not the
 * workspace — is what a shared container is keyed by. Everything else in the
 * phase reads that key.
 */

describe('the catalog', () => {
    it('covers the typed engines the owner named, plus the generic escape hatch', () => {
        expect([...SERVICE_ENGINES]).toEqual([
            'postgres',
            'mysql',
            'redis',
            'meilisearch',
            'minio',
            'mailpit',
            'websockets',
            'custom',
        ]);
    });

    it("no longer answers to 'reverb' — the bundled server is Sockudo, not Reverb", () => {
        // The engine key is Genie's own vocabulary and it named the wrong product.
        // The Laravel-facing REVERB_* env names are a separate thing and are kept
        // (see env-wiring) — this is only about what Genie calls the engine.
        expect(isServiceEngine('reverb')).toBe(false);
        expect(isServiceEngine('websockets')).toBe(true);
        // Positive control: a name that never existed is also false, so the
        // assertion above is not passing because the guard rejects everything.
        expect(isServiceEngine('not-an-engine')).toBe(false);
    });

    it('models WebSockets as a bundled Host-native, namespace-isolated Sockudo engine', () => {
        const ws = engineSpecFor('websockets');
        // Namespace isolation (shared master, per-workspace app) — NOT a
        // per-workspace credential engine, exactly like MinIO/Meilisearch.
        expect(ws.provision).toBe('namespace');
        expect(ws.runtime).toBe('host');
        expect(ws.distribution).toEqual({ project: 'sockudo/sockudo', version: '4.7.0' });
        // Stateless — no data volume to persist.
        expect(ws.volumes).toEqual([]);
        expect(ws.image('1')).toBe('');
        expect(ws.ports).toEqual([
            { name: 'websocket', container: 6001, kind: 'http', primary: true },
        ]);
    });

    it('gives container engines an image and every engine a primary port and default version', () => {
        for (const engine of SERVICE_ENGINES) {
            if (engine === 'custom') continue;
            const spec = engineSpecFor(engine);
            expect(spec.versions.length).toBeGreaterThan(0);
            if (spec.runtime === 'container') expect(spec.image?.(DEFAULT_VERSIONS[engine])).toMatch(/\S/);
            expect(spec.ports.some((p) => p.primary)).toBe(true);
        }
    });

    it('pins an image by MAJOR version — pg15 and pg16 are different images', () => {
        const postgres = engineSpecFor('postgres');
        expect(postgres.image('16')).not.toBe(postgres.image('15'));
        expect(postgres.image('16')).toContain('16');
    });

    it('builds the EXACT published tag for every default version', () => {
        // Pinned literally, and here is why. `mailpit` originally declared
        // version `1` and built `axllent/mailpit:v1` — a tag Mailpit does not
        // publish (it ships `v<major>.<minor>` and `latest`, never a bare
        // major). Every unit test passed; the image 404'd at the registry, and
        // the P4 live smoke caught it on its first run.
        //
        // A test cannot ask Docker Hub what exists, so it does the next best
        // thing: it makes the ref a DELIBERATE value rather than a side effect
        // of a template, so changing one is a decision somebody made on purpose
        // and checked. Each of these was pulled successfully against real Docker.
        const ref = (engine: Parameters<typeof engineSpecFor>[0]) =>
            engineSpecFor(engine).image(DEFAULT_VERSIONS[engine]);
        expect(ref('postgres')).toBe('ghcr.io/renaissance-analytics/genie-postgres:pg17-1');
        expect(ref('mysql')).toBe('mysql:8.4');
        expect(ref('redis')).toBe('redis:7-alpine');
        expect(ref('meilisearch')).toBe('getmeili/meilisearch:v1');
        // QUAY for MinIO. Docker Hub's `minio/minio` answers every anonymous
        // pull with 401 — measured against the registry API on 2026-09-11, for
        // `latest` and for a dated RELEASE tag, while `library/redis:7-alpine`
        // returned 200 from the same probe. The registry is part of the ref, and
        // getting it wrong breaks provisioning on every user's machine.
        expect(ref('minio')).toBe('quay.io/minio/minio:latest');
        expect(ref('mailpit')).toBe('axllent/mailpit:v1.30');
    });

    it('serves postgres from the GENIE image, the only one carrying vector AND postgis', () => {
        // No stock image carries both: pgvector/pgvector has no PostGIS,
        // postgis/postgis has no pgvector, so a workspace wanting both had no
        // image at all — and `postgis` was whitelisted and advertised anyway.
        // `postgres-image/Dockerfile` is the image; this is what points at it.
        const postgres = engineSpecFor('postgres');
        for (const v of postgres.versions) {
            expect(postgres.image(v)).toBe(`${GENIE_POSTGRES_IMAGE}:pg${v}-${GENIE_POSTGRES_IMAGE_MAJOR}`);
        }
        // Never `:latest`, and never a bare major: the tag names the Postgres
        // major AND the image major, so a workspace's engine cannot change
        // under it on a restart.
        expect(postgres.image('17')).toBe('ghcr.io/renaissance-analytics/genie-postgres:pg17-1');
    });

    it('does not prefix `latest` with a `v` — that is a tag nobody publishes', () => {
        // The engines whose upstream has no stable major to pin offer `latest`.
        // A naive `v${version}` template would turn it into `vlatest`.
        expect(engineSpecFor('mailpit').image('latest')).toBe('axllent/mailpit:latest');
        expect(engineSpecFor('minio').image('latest')).toBe('quay.io/minio/minio:latest');
    });

    it('names a REGISTRY for images Docker Hub will not serve anonymously', () => {
        // Genie pulls as an anonymous client on a user's machine. `minio/minio`
        // on Hub returns "pull access denied … repository does not exist or may
        // require 'docker login'" for every tag, so a bare `minio/minio:…` ref
        // fails for every user — which is how genie#636 surfaced, as four
        // unrelated CI assertions rather than as a registry error.
        //
        // Pinned as a NEGATIVE as well as a positive: shortening it back to the
        // Docker Hub form is the plausible future edit, and it reads like a
        // tidy-up.
        const minio = engineSpecFor('minio').image('latest');
        expect(minio).toContain('quay.io/');
        expect(minio.startsWith('minio/')).toBe(false);
    });

    it('keys an engine by (engine, version) — that pair IS the sharing unit', () => {
        expect(engineKeyFor('postgres', '16')).toBe('postgres-16');
        expect(engineKeyFor('postgres', '16')).not.toBe(engineKeyFor('postgres', '15'));
        expect(parseEngineKey('postgres-16')).toEqual({ engine: 'postgres', version: '16' });
        expect(parseEngineKey('nonsense')).toBeNull();
    });

    it('round-trips a version with a dot (mysql 8.4)', () => {
        const key = engineKeyFor('mysql', '8.4');
        expect(parseEngineKey(key)).toEqual({ engine: 'mysql', version: '8.4' });
    });

    it('falls back to the default version for an unknown one', () => {
        expect(resolveEngineVersion('postgres', undefined)).toBe(DEFAULT_VERSIONS.postgres);
        expect(resolveEngineVersion('postgres', '16')).toBe('16');
        // Not in the known list: refused rather than silently pulled, because an
        // arbitrary tag is an arbitrary image to run.
        expect(resolveEngineVersion('postgres', 'latest; rm -rf /')).toBeNull();
    });

    it('states a PROVISIONING strategy per engine — that is the isolation story', () => {
        expect(engineSpecFor('postgres').provision).toBe('sql-database-role');
        expect(engineSpecFor('mysql').provision).toBe('sql-database-role');
        expect(engineSpecFor('redis').provision).toBe('redis-acl');
        // MinIO carves a real slice: an IAM user per workspace, admitted by
        // policy to its own bucket. It was NAMESPACE-isolated until Tynn #250
        // step 4, which meant handing every workspace the ROOT credential.
        expect(engineSpecFor('minio').provision).toBe('s3-scoped-user');
        // These two genuinely are a per-workspace NAMESPACE and not a
        // per-workspace credential — asserted so it cannot drift silently, and
        // so the claim in `summary` stays true.
        expect(engineSpecFor('meilisearch').provision).toBe('namespace');
        expect(engineSpecFor('mailpit').provision).toBe('namespace');
    });

    /**
     * MAILPIT'S NAMESPACE DEPENDS ON A DEFAULT (genie#552).
     *
     * The workspace tag is carried by a plus address in the From, and Mailpit
     * applies it only because auto-tagging from plus addresses is ON BY DEFAULT.
     * `MP_TAGS_DISABLE=plus-addresses` would switch it off silently: the env
     * would still be injected, `env-wiring.test.ts` would still be green, and
     * every workspace's mail would land untagged in the shared inbox.
     *
     * So the thing worth asserting is the ABSENCE — see the note in
     * `env-wiring.ts`. This test is not vacuous: adding
     * `MP_TAGS_DISABLE: 'plus-addresses'` to Mailpit's `adminEnv` turns it red.
     */
    it('never disables the Mailpit auto-tagging the workspace namespace rides on', () => {
        const env = engineSpecFor('mailpit').adminEnv?.('unused') ?? {};
        // Positive control for the accessor itself: an empty object would pass
        // the assertion below while proving nothing.
        expect(env.MP_DATABASE).toBe('/data/mailpit.db');
        expect(env.MP_TAGS_DISABLE).toBeUndefined();
    });

    it('forces the generic escape hatch to be DEDICATED', () => {
        // A caller-supplied image has no multi-tenant story, so it cannot be
        // shared between workspaces.
        expect(engineSpecFor('custom').alwaysDedicated).toBe(true);
        expect(engineSpecFor('redis').alwaysDedicated).toBe(true);
        expect(engineSpecFor('postgres').alwaysDedicated).toBeFalsy();
    });

    it('bootstraps the admin credential through env, never a baked image', () => {
        const env = engineSpecFor('postgres').adminEnv?.('s3cret') ?? {};
        expect(env.POSTGRES_PASSWORD).toBe('s3cret');
    });

    it('gives redis its password on the command line — the image takes no env', () => {
        expect(engineSpecFor('redis').command?.('s3cret')).toContain('--requirepass');
        expect(engineSpecFor('redis').command?.('s3cret')).toContain('s3cret');
    });

    it('knows how to ASK an engine whether it is ready, from inside', () => {
        expect(engineSpecFor('postgres').readyExec?.('pw')).toContain('pg_isready');
        expect(engineSpecFor('redis').readyExec?.('pw')).toContain('ping');
    });
});

describe('per-workspace namespace identifiers', () => {
    it('derives a SQL identifier that is stable and legal', () => {
        const name = workspaceSqlIdentifier('Acme Corp/2');
        expect(name).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
        expect(workspaceSqlIdentifier('Acme Corp/2')).toBe(name);
    });

    it('never collides two workspaces that sanitize to the same text', () => {
        // The exact trap `workspaceSlugFor` exists for: `Acme Corp` and
        // `acme/corp` both reduce to `acme-corp`, and two workspaces sharing one
        // database name would each see the other's data.
        expect(workspaceSqlIdentifier('Acme Corp')).not.toBe(workspaceSqlIdentifier('acme/corp'));
    });

    it('derives a DNS-safe name for the engines that demand one (S3 buckets)', () => {
        const bucket = workspaceDnsName('Acme Corp');
        expect(bucket).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
        expect(bucket).not.toContain('_');
    });

    it('refuses to produce an identifier for an empty workspace id', () => {
        expect(() => workspaceSqlIdentifier('')).toThrow();
    });
});

describe('engine types are guarded', () => {
    it('recognises only catalog engines', () => {
        expect(isServiceEngine('postgres')).toBe(true);
        expect(isServiceEngine('mongodb')).toBe(false);
        expect(isServiceEngine(undefined)).toBe(false);
    });
});
