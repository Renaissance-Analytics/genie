import { describe, expect, it } from 'vitest';
import {
    devServiceIdFor,
    generateServicePassword,
    parseDevServices,
    sanitizeDevServicePatch,
    withServiceCredentials,
} from '../services-config';

/**
 * The persisted per-workspace SERVICE model (Tynn #234, P3).
 *
 * The sibling of `sites-config.ts`, and stored the same way: one JSON column on
 * `workspaces`, an opaque id per entry, every parse and sanitize PURE and in
 * this module so `db.ts` never interprets a blob it read.
 *
 * What is being proven is the two properties the shared model depends on:
 * the id is keyed by (workspace, engine, VERSION) so pg15 and pg16 coexist in
 * one workspace, and the credential is minted ONCE and then persists — a
 * password regenerated on read would lock the workspace out of its own database
 * on the next start.
 */

describe('identity', () => {
    it('keys a service by (workspace, engine, version)', () => {
        expect(devServiceIdFor('ws-1', 'postgres-16')).toBe(devServiceIdFor('ws-1', 'postgres-16'));
        expect(devServiceIdFor('ws-1', 'postgres-16')).not.toBe(
            devServiceIdFor('ws-2', 'postgres-16'),
        );
        // One workspace CAN hold both, which is why the version is in the key.
        expect(devServiceIdFor('ws-1', 'postgres-16')).not.toBe(
            devServiceIdFor('ws-1', 'postgres-15'),
        );
    });

    it('is an opaque fixed-width token', () => {
        expect(devServiceIdFor('ws-1', 'postgres-16')).toMatch(/^[0-9a-f]{16}$/);
    });
});

describe('sanitize', () => {
    it('keeps only well-typed, in-catalog fields', () => {
        const clean = sanitizeDevServicePatch({
            engine: 'postgres',
            version: '16',
            dedicated: true,
            enabled: true,
        });
        expect(clean).toMatchObject({
            engine: 'postgres',
            version: '16',
            dedicated: true,
            enabled: true,
        });
    });

    it('refuses an engine that is not in the catalog', () => {
        expect(sanitizeDevServicePatch({ engine: 'mongodb' as never }).engine).toBeUndefined();
    });

    it('refuses a version the catalog does not know — it becomes an image tag', () => {
        expect(
            sanitizeDevServicePatch({ engine: 'postgres', version: 'latest' }).version,
        ).toBeUndefined();
    });

    it('never accepts an inbound PASSWORD', () => {
        // Minted by `withServiceCredentials` and never travelling inbound, so a
        // renderer — or anything replaying an IPC message — cannot pin a
        // workspace's database credential to a value it chose.
        expect(
            sanitizeDevServicePatch({ engine: 'postgres', password: 'chosen' } as never).password,
        ).toBeUndefined();
    });

    it('accepts an image + port only for the custom escape hatch', () => {
        const custom = sanitizeDevServicePatch({
            engine: 'custom',
            image: 'ghcr.io/acme/thing:1',
            port: 9999,
        });
        expect(custom.image).toBe('ghcr.io/acme/thing:1');
        expect(custom.port).toBe(9999);
        // A typed engine's image comes from the catalog; letting a caller pin it
        // would run an arbitrary image under a name that says "postgres".
        expect(sanitizeDevServicePatch({ engine: 'postgres', image: 'evil:1' }).image).toBeUndefined();
    });

    it('refuses an image reference or env name that could not be a literal argv', () => {
        expect(sanitizeDevServicePatch({ engine: 'custom', image: 'a b;c' }).image).toBeUndefined();
        expect(
            sanitizeDevServicePatch({ engine: 'custom', env: { 'NOT=A NAME': 'x' } }).env,
        ).toEqual({});
    });

    it('forces the custom engine to be dedicated whatever the caller asked', () => {
        expect(sanitizeDevServicePatch({ engine: 'custom', dedicated: false }).dedicated).toBe(true);
    });
});

describe('credentials', () => {
    it('mints a password once and then leaves it alone', () => {
        const first = withServiceCredentials(
            { engine: 'postgres', version: '16', dedicated: false, enabled: true, password: '' },
            () => 'minted',
        );
        expect(first.password).toBe('minted');
        const second = withServiceCredentials(first, () => 'different');
        expect(second.password).toBe('minted');
    });

    it('generates a credential that is safe unquoted in a URL, a .env and an argv', () => {
        for (let i = 0; i < 20; i += 1) {
            expect(generateServicePassword()).toMatch(/^[A-Za-z0-9_-]{16,}$/);
        }
    });
});

describe('parse', () => {
    it('reads NULL, junk and corrupt JSON as "nothing configured"', () => {
        expect(parseDevServices(null)).toEqual({});
        expect(parseDevServices('{')).toEqual({});
        expect(parseDevServices('[]')).toEqual({});
    });

    it('drops a row whose engine or version no longer exists', () => {
        const raw = JSON.stringify({
            a: { engine: 'mongodb', version: '7', password: 'p', enabled: true },
            b: { engine: 'postgres', version: '99', password: 'p', enabled: true },
            c: { engine: 'postgres', version: '16', password: 'p', enabled: true },
        });
        expect(Object.keys(parseDevServices(raw))).toEqual(['c']);
    });

    it('carries the stored password back out — this is OUR blob, not a caller patch', () => {
        const raw = JSON.stringify({
            c: { engine: 'postgres', version: '16', password: 'stored', enabled: true },
        });
        expect(parseDevServices(raw).c.password).toBe('stored');
    });

    it('drops a row with no password: it could never be connected to', () => {
        const raw = JSON.stringify({ c: { engine: 'postgres', version: '16', enabled: true } });
        expect(parseDevServices(raw)).toEqual({});
    });
});
