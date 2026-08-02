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
            'custom',
        ]);
    });

    it('gives every engine an image, a primary port and a default version', () => {
        for (const engine of SERVICE_ENGINES) {
            if (engine === 'custom') continue;
            const spec = engineSpecFor(engine);
            expect(spec.versions.length).toBeGreaterThan(0);
            expect(spec.image(DEFAULT_VERSIONS[engine])).toMatch(/\S/);
            expect(spec.ports.some((p) => p.primary)).toBe(true);
        }
    });

    it('pins an image by MAJOR version — pg15 and pg16 are different images', () => {
        const postgres = engineSpecFor('postgres');
        expect(postgres.image('16')).not.toBe(postgres.image('15'));
        expect(postgres.image('16')).toContain('16');
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
        // The owner's decision for these three is a per-workspace NAMESPACE, not
        // a per-workspace credential — asserted so it cannot drift silently.
        expect(engineSpecFor('meilisearch').provision).toBe('namespace');
        expect(engineSpecFor('minio').provision).toBe('namespace');
        expect(engineSpecFor('mailpit').provision).toBe('namespace');
    });

    it('forces the generic escape hatch to be DEDICATED', () => {
        // A caller-supplied image has no multi-tenant story, so it cannot be
        // shared between workspaces.
        expect(engineSpecFor('custom').alwaysDedicated).toBe(true);
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
