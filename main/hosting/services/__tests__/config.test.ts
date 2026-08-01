import { describe, expect, it } from 'vitest';
import {
    generatePassword,
    parseWorkspaceServices,
    preferredServicePort,
    resolveServiceInstance,
    sanitizeServicePatch,
    serviceDataDir,
    serviceIdFor,
    servicePort,
    withCredentials,
    SERVICE_PORTS,
} from '../config';
import { HOSTED_PORT_MAX, HOSTED_PORT_MIN } from '../../ports';
import type { ServiceConfig } from '../config';

/**
 * The contract these defend: two workspaces' services are genuinely separate,
 * and nothing a renderer sends can talk one workspace into another's data.
 *
 * Isolation here is not a runtime check that can be forgotten — it is derived.
 * The data directory, the port and the credential all come from the service id,
 * which comes from (workspace, kind). So these tests are mostly about the
 * derivation being collision-free, stable across restarts, and out of reach of
 * an untrusted patch.
 */

describe('serviceIdFor', () => {
    it('is stable for a workspace and kind', () => {
        expect(serviceIdFor('w1', 'postgres')).toBe(serviceIdFor('w1', 'postgres'));
    });

    it('separates workspaces and kinds', () => {
        const ids = new Set([
            serviceIdFor('w1', 'postgres'),
            serviceIdFor('w2', 'postgres'),
            serviceIdFor('w1', 'redis'),
            serviceIdFor('w2', 'redis'),
        ]);
        expect(ids.size).toBe(4);
    });

    it('cannot be forged by a workspace id containing a separator', () => {
        // A concatenated id would let workspace "redis w1" collide with
        // workspace "w1"'s redis. Hashing is what makes that impossible.
        expect(serviceIdFor('redis w1', 'postgres')).not.toBe(serviceIdFor('w1', 'redis'));
    });
});

describe('servicePort', () => {
    it('is stable — the endpoint in a generated .env must survive a restart', () => {
        const id = serviceIdFor('w1', 'postgres');
        expect(servicePort(id)).toBe(servicePort(id));
        expect(preferredServicePort(id)).toBe(servicePort(id));
    });

    it('stays inside the service band for any id', () => {
        for (const w of ['a', 'b', 'workspace-with-a-long-name', '🐘']) {
            for (const kind of ['postgres', 'redis'] as const) {
                const port = servicePort(serviceIdFor(w, kind));
                expect(port).toBeGreaterThanOrEqual(SERVICE_PORTS.min);
                expect(port).toBeLessThanOrEqual(SERVICE_PORTS.max);
            }
        }
    });

    it('never lands in the SITES band', () => {
        // A service that took a site's port would break the site's stable
        // origin, which is the whole promise of the hosting runtime.
        expect(SERVICE_PORTS.min).toBeGreaterThan(HOSTED_PORT_MAX);
        for (let i = 0; i < 300; i += 1) {
            const port = servicePort(serviceIdFor(`w${i}`, 'postgres'));
            expect(port < HOSTED_PORT_MIN || port > HOSTED_PORT_MAX).toBe(true);
        }
    });

    it('falls forward deterministically when its slot is taken', () => {
        const id = serviceIdFor('w1', 'postgres');
        const wanted = preferredServicePort(id);
        const taken = new Set([wanted]);
        expect(servicePort(id, taken)).toBe(wanted + 1);
        expect(servicePort(id, taken)).toBe(wanted + 1);
    });

    it('gives two workspaces different ports even under collision', () => {
        const a = serviceIdFor('w1', 'postgres');
        const b = serviceIdFor('w2', 'postgres');
        const portA = servicePort(a);
        const portB = servicePort(b, new Set([portA]));
        expect(portB).not.toBe(portA);
    });
});

describe('serviceDataDir', () => {
    it('gives every instance a private directory under userData', () => {
        const a = serviceDataDir('/base', serviceIdFor('w1', 'postgres'));
        const b = serviceDataDir('/base', serviceIdFor('w2', 'postgres'));
        expect(a).not.toBe(b);
        expect(a.replace(/\\/g, '/')).toContain('/base/hosting/services/');
    });
});

describe('generatePassword', () => {
    it('is random, not derived', () => {
        expect(generatePassword()).not.toBe(generatePassword());
    });

    it('needs no quoting in a .env, a URL or a command line', () => {
        for (let i = 0; i < 50; i += 1) {
            expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]+$/);
        }
    });
});

describe('sanitizeServicePatch', () => {
    it('keeps well-typed fields', () => {
        expect(sanitizeServicePatch({ enabled: true, kind: 'postgres', database: 'shop' })).toEqual({
            enabled: true,
            kind: 'postgres',
            database: 'shop',
        });
    });

    it('REFUSES a password from a patch', () => {
        // A renderer — or anything replaying an IPC message — must not be able
        // to pin a workspace's database credential to a value it chose.
        const out = sanitizeServicePatch({
            kind: 'postgres',
            password: 'attacker-chosen',
        } as Partial<ServiceConfig>);
        expect(out).not.toHaveProperty('password');
    });

    it('drops an unknown kind rather than inventing one', () => {
        expect(sanitizeServicePatch({ kind: 'mysql' } as never)).not.toHaveProperty('kind');
    });

    it('refuses a database name that is not a plain identifier', () => {
        for (const database of ['drop table', 'a"b', '1abc', '', 'x'.repeat(64), 'a;b']) {
            expect(sanitizeServicePatch({ database } as Partial<ServiceConfig>)).not.toHaveProperty(
                'database',
            );
        }
    });

    it('normalises case so one workspace cannot hold two spellings', () => {
        expect(sanitizeServicePatch({ database: 'MyApp' }).database).toBe('myapp');
    });

    it('survives junk', () => {
        expect(sanitizeServicePatch(null)).toEqual({});
        expect(sanitizeServicePatch({ enabled: 'yes' } as never)).toEqual({});
    });
});

describe('parseWorkspaceServices', () => {
    it('reads back what was stored, password included', () => {
        const stored = JSON.stringify({
            abc: { enabled: true, kind: 'postgres', password: 'p', database: 'genie' },
        });
        expect(parseWorkspaceServices(stored)).toEqual({
            abc: { enabled: true, kind: 'postgres', password: 'p', database: 'genie' },
        });
    });

    it('reads an unusable blob as "nothing configured"', () => {
        for (const raw of [null, undefined, '', 'not json', '[]', '"str"', '3']) {
            expect(parseWorkspaceServices(raw)).toEqual({});
        }
    });

    it('drops entries with no recognisable kind', () => {
        const stored = JSON.stringify({ a: { enabled: true }, b: { kind: 'redis', enabled: true } });
        expect(Object.keys(parseWorkspaceServices(stored))).toEqual(['b']);
    });
});

describe('withCredentials', () => {
    it('mints a password and a database for a new postgres', () => {
        const out = withCredentials({ enabled: true, kind: 'postgres' });
        expect(out.password).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(out.database).toBe('genie');
    });

    it('NEVER rotates an existing password', () => {
        // Rotating on write would invalidate the .env the user's app already
        // uses, and there is no way for them to notice except a failed boot.
        const first = withCredentials({ enabled: true, kind: 'postgres' });
        expect(withCredentials(first).password).toBe(first.password);
    });

    it('leaves a chosen database name alone', () => {
        expect(withCredentials({ enabled: true, kind: 'postgres', database: 'shop' }).database).toBe(
            'shop',
        );
    });

    it('gives redis no credentials — there are none to give', () => {
        const out = withCredentials({ enabled: true, kind: 'redis' });
        expect(out.password).toBeUndefined();
        expect(out.database).toBeUndefined();
    });
});

describe('resolveServiceInstance', () => {
    const config: ServiceConfig = {
        enabled: true,
        kind: 'postgres',
        password: 'p',
        database: 'genie',
    };

    it('produces a runnable instance with its own port and data dir', () => {
        const instance = resolveServiceInstance('w1', '/base', config);
        expect(instance).not.toBeNull();
        expect(instance!.kind).toBe('postgres');
        expect(instance!.engine).toBe('postgres');
        expect(instance!.user).toBe('genie');
        expect(instance!.database).toBe('genie');
        expect(instance!.port).toBe(servicePort(serviceIdFor('w1', 'postgres')));
    });

    it('refuses a postgres with no credential rather than opening one on trust', () => {
        expect(resolveServiceInstance('w1', '/base', { ...config, password: undefined })).toBeNull();
    });

    it('resolves redis without credentials', () => {
        const instance = resolveServiceInstance('w1', '/base', { enabled: true, kind: 'redis' });
        expect(instance).not.toBeNull();
        expect(instance!.engine).toBe('garnet');
        expect(instance!.password).toBeUndefined();
    });

    it('refuses junk', () => {
        expect(resolveServiceInstance('', '/base', config)).toBeNull();
        expect(resolveServiceInstance('w1', '', config)).toBeNull();
        expect(resolveServiceInstance('w1', '/base', { kind: 'mysql' } as never)).toBeNull();
    });

    it('honours the taken-port set so two instances never collide', () => {
        const first = resolveServiceInstance('w1', '/base', config)!;
        const second = resolveServiceInstance('w2', '/base', config, new Set([first.port]))!;
        expect(second.port).not.toBe(first.port);
    });
});
