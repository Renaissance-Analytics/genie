import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    contentTypeFor,
    createStaticRuntime,
    isInside,
    resolveStaticFile,
    spaFallback,
} from '../static';
import type { BoundServer, HostedSite, HttpListener, ListenOptions } from '../types';

/**
 * `resolveStaticFile` is the only place in the hosting runtime where a URL
 * becomes a filesystem path, so it is where directory traversal has to stop. A
 * hosted site runs with Genie's own privileges over a repo that contains `.env`
 * files and often the user's whole home directory one hop up — a traversal here
 * is credential disclosure, not a 404.
 *
 * The lifecycle tests drive an injected listener, so nothing here binds a port.
 */

const ROOT = path.resolve('C:/repos/fancy/dist');

describe('resolveStaticFile', () => {
    it('resolves a normal asset under the root', () => {
        const r = resolveStaticFile(ROOT, '/assets/app-abc123.js');
        expect(r?.filePath).toBe(path.join(ROOT, 'assets', 'app-abc123.js'));
        expect(r?.fallback).toBe(false);
    });

    it('serves index.html for the root and for directory paths', () => {
        expect(resolveStaticFile(ROOT, '/')?.filePath).toBe(path.join(ROOT, 'index.html'));
        expect(resolveStaticFile(ROOT, '/docs/')?.filePath).toBe(
            path.join(ROOT, 'docs', 'index.html'),
        );
    });

    it('ignores the query string and fragment', () => {
        expect(resolveStaticFile(ROOT, '/app.js?v=2#x')?.filePath).toBe(
            path.join(ROOT, 'app.js'),
        );
    });

    it('refuses a plain parent-directory escape', () => {
        expect(resolveStaticFile(ROOT, '/../.env')).toBeNull();
        expect(resolveStaticFile(ROOT, '/../../../../Users/me/.ssh/id_rsa')).toBeNull();
    });

    it('refuses a percent-encoded escape', () => {
        // %2e%2e%2f decodes to ../ — decoding BEFORE the containment check is
        // the whole point; checking the raw string would let this through.
        expect(resolveStaticFile(ROOT, '/%2e%2e/%2e%2e/.env')).toBeNull();
        expect(resolveStaticFile(ROOT, '/%2e%2e%2f.env')).toBeNull();
    });

    it('refuses a backslash escape (a separator on Windows)', () => {
        expect(resolveStaticFile(ROOT, '/..\\..\\.env')).toBeNull();
        expect(resolveStaticFile(ROOT, '/%5c..%5c.env')).toBeNull();
    });

    it('refuses a malformed percent escape rather than serving the raw bytes', () => {
        expect(resolveStaticFile(ROOT, '/%E0%A4%A')).toBeNull();
    });

    it('allows an inner path that merely mentions ..', () => {
        expect(resolveStaticFile(ROOT, '/assets/a..b.js')?.filePath).toBe(
            path.join(ROOT, 'assets', 'a..b.js'),
        );
    });
});

describe('isInside', () => {
    it('is not fooled by a sibling directory sharing a prefix', () => {
        expect(isInside('/srv/app', '/srv/app-evil/secret')).toBe(false);
        expect(isInside('/srv/app', '/srv/app/ok')).toBe(true);
        expect(isInside('/srv/app', '/srv/app')).toBe(true);
    });
});

describe('spaFallback', () => {
    it('points at the shell and marks itself as a fallback', () => {
        const r = spaFallback(ROOT);
        expect(r.filePath).toBe(path.join(ROOT, 'index.html'));
        expect(r.fallback).toBe(true);
    });
});

describe('contentTypeFor', () => {
    it('serves JS as a script type', () => {
        // `text/plain` here is not cosmetic: browsers refuse a module script
        // with a non-JS MIME type, so the whole app fails to boot.
        expect(contentTypeFor('/x/app-abc.js')).toBe('text/javascript; charset=utf-8');
        expect(contentTypeFor('/x/app.mjs')).toBe('text/javascript; charset=utf-8');
    });

    it('covers the types a built frontend actually emits', () => {
        expect(contentTypeFor('a.css')).toBe('text/css; charset=utf-8');
        expect(contentTypeFor('a.woff2')).toBe('font/woff2');
        expect(contentTypeFor('a.wasm')).toBe('application/wasm');
        expect(contentTypeFor('a.svg')).toBe('image/svg+xml');
    });

    it('falls back to a safe binary type for the unknown', () => {
        expect(contentTypeFor('a.weird')).toBe('application/octet-stream');
    });
});

// --- lifecycle -------------------------------------------------------------

function fakeListener(): { listener: HttpListener; calls: ListenOptions[]; closed: number[] } {
    const calls: ListenOptions[] = [];
    const closed: number[] = [];
    const listener: HttpListener = {
        async listen(_handler, opts): Promise<BoundServer> {
            calls.push(opts);
            return {
                port: opts.port,
                close: async () => {
                    closed.push(opts.port);
                },
            };
        },
    };
    return { listener, calls, closed };
}

const SITE: HostedSite = {
    id: 'fancy-1',
    hostname: 'Fancy.Test',
    root: ROOT,
    kind: 'static',
};

describe('createStaticRuntime', () => {
    it('binds loopback only — a preview is never published to the LAN', async () => {
        const { listener, calls } = fakeListener();
        const runtime = createStaticRuntime({ listener });
        await runtime.start(SITE);
        expect(calls[0]?.host).toBe('127.0.0.1');
    });

    it('reports the same LocalTarget shape the FrankenPHP backend does', async () => {
        const { listener } = fakeListener();
        const runtime = createStaticRuntime({ listener });
        const status = await runtime.start(SITE);
        expect(status.state).toBe('running');
        expect(status.backend).toBe('static');
        expect(status.target).toEqual({
            scheme: 'http',
            hostname: 'fancy.test',
            port: expect.any(Number),
            loopback: '127.0.0.1',
        });
        expect(status.origin).toBe(`http://fancy.test:${status.target?.port}`);
    });

    it('serves https when TLS material is supplied', async () => {
        const { listener, calls } = fakeListener();
        const tls = { certPem: 'CERT', keyPem: 'KEY' };
        const runtime = createStaticRuntime({ listener, tls });
        const status = await runtime.start(SITE);
        expect(calls[0]?.tls).toBe(tls);
        expect(status.target?.scheme).toBe('https');
        expect(status.origin).toMatch(/^https:\/\/fancy\.test:/);
    });

    it('gives the same site the same port across restarts', async () => {
        const a = await createStaticRuntime({ listener: fakeListener().listener }).start(SITE);
        const b = await createStaticRuntime({ listener: fakeListener().listener }).start(SITE);
        expect(b.target?.port).toBe(a.target?.port);
    });

    it('gives two concurrent sites different ports', async () => {
        const runtime = createStaticRuntime({ listener: fakeListener().listener });
        const a = await runtime.start(SITE);
        const b = await runtime.start({ ...SITE, id: 'other-1', hostname: 'other.test' });
        expect(b.target?.port).not.toBe(a.target?.port);
    });

    it('reports failed — not a throw — when the port cannot be bound', async () => {
        const listener: HttpListener = {
            listen: () => Promise.reject(new Error('EADDRINUSE')),
        };
        const status = await createStaticRuntime({ listener }).start(SITE);
        expect(status.state).toBe('failed');
        expect(status.error).toContain('EADDRINUSE');
        expect(status.target).toBeNull();
    });

    it('is idempotent and closes the server on stop', async () => {
        const { listener, calls, closed } = fakeListener();
        const runtime = createStaticRuntime({ listener });
        const first = await runtime.start(SITE);
        await runtime.start(SITE);
        expect(calls).toHaveLength(1);
        await runtime.stop(SITE.id);
        expect(closed).toEqual([first.target?.port]);
        expect(runtime.status(SITE.id).state).toBe('stopped');
    });

    it('stopAll closes every site', async () => {
        const { listener, closed } = fakeListener();
        const runtime = createStaticRuntime({ listener });
        await runtime.start(SITE);
        await runtime.start({ ...SITE, id: 'other-1', hostname: 'other.test' });
        await runtime.stopAll();
        expect(closed).toHaveLength(2);
        expect(runtime.list()).toEqual([]);
    });
});
