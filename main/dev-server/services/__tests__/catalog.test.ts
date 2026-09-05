import { describe, expect, it } from 'vitest';
import {
    DEFAULT_VERSIONS,
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
        expect(ref('postgres')).toBe('pgvector/pgvector:pg17');
        expect(ref('mysql')).toBe('mysql:8.4');
        expect(ref('redis')).toBe('redis:7-alpine');
        expect(ref('meilisearch')).toBe('getmeili/meilisearch:v1');
        expect(ref('minio')).toBe('minio/minio:latest');
        expect(ref('mailpit')).toBe('axllent/mailpit:v1.30');
    });

    it('serves postgres from a pgvector image so `CREATE EXTENSION vector` is available', () => {
        // The stock `postgres` image does not carry pgvector; pgvector/pgvector is
        // stock postgres of the same major PLUS the `vector` extension (and the
        // standard contrib set), so a workspace can enable pgvector on its DB.
        const postgres = engineSpecFor('postgres');
        for (const v of postgres.versions) {
            expect(postgres.image(v)).toBe(`pgvector/pgvector:pg${v}`);
        }
        expect(postgres.image('17')).toContain('pgvector');
    });

    it('does not prefix `latest` with a `v` — that is a tag nobody publishes', () => {
        // The engines whose upstream has no stable major to pin offer `latest`.
        // A naive `v${version}` template would turn it into `vlatest`.
        expect(engineSpecFor('mailpit').image('latest')).toBe('axllent/mailpit:latest');
        expect(engineSpecFor('minio').image('latest')).toBe('minio/minio:latest');
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
