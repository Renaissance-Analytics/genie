import { describe, expect, it } from 'vitest';
import {
    buildUpstreamHeaders,
    passthroughResponseHeaders,
    rewriteResponseHeaders,
    PRESERVE_ORIGIN_HEADER,
    type ResolvedSite,
} from '../site-proxy';
import { proxyOriginForRequest } from '../server';

/**
 * Serve-local-sites Phase D — the HOST proxy's "preserve-origin" mode (design §4).
 * In Phase D the remote shim serves the site under its REAL `https://<name>.gen`
 * origin, so the host must SKIP its Phase-C http-downgrade response rewrites and
 * pass origin-bearing headers through — the shim does the single `.test`⇄`.gen`
 * map. We unit-test that seam (the wire path is exercised by the shim end-to-end
 * test + the Electron E2E gate).
 */
const SITE: ResolvedSite = {
    workspaceId: 'workspace-1',
    hostname: 'tynn.test',
    scheme: 'https',
    port: 443,
};

describe('host proxy preserve-origin mode', () => {
    it('uses the request listener origin instead of another active listener', () => {
        expect(proxyOriginForRequest({
            headers: { host: '127.0.0.1:51718' },
            socket: { encrypted: false, localAddress: '127.0.0.1', localPort: 51718 },
        })).toBe('http://127.0.0.1:51718');

        expect(proxyOriginForRequest({
            headers: { host: 'workstation.tailnet.ts.net:51718' },
            socket: { encrypted: true, localAddress: '100.90.10.2', localPort: 51718 },
        }, 'workstation.tailnet.ts.net')).toBe('https://workstation.tailnet.ts.net:51718');
    });

    it('buildUpstreamHeaders strips the preserve-origin control header (never leaks upstream)', () => {
        const out = buildUpstreamHeaders(
            { host: 'ignored', [PRESERVE_ORIGIN_HEADER]: '1', 'x-keep': 'yes' },
            'tynn.test',
        );
        expect(out[PRESERVE_ORIGIN_HEADER]).toBeUndefined();
        expect(out['host']).toBe('tynn.test'); // the crux — Host forced to the vhost
        expect(out['x-keep']).toBe('yes');
    });

    it('passthroughResponseHeaders keeps Location/HSTS/Secure verbatim (no downgrade)', () => {
        const out = passthroughResponseHeaders({
            location: 'https://tynn.test/next',
            'strict-transport-security': 'max-age=63072000',
            'set-cookie': ['sid=abc; Secure; Domain=tynn.test'],
            connection: 'keep-alive',
            'content-type': 'text/html',
        });
        // Origin-bearing headers pass through untouched — the SHIM maps .test→.gen.
        expect(out['location']).toBe('https://tynn.test/next');
        expect(out['strict-transport-security']).toBe('max-age=63072000');
        expect(out['set-cookie']).toEqual(['sid=abc; Secure; Domain=tynn.test']);
        expect(out['content-type']).toBe('text/html');
        // Hop-by-hop still stripped so Node re-frames the body.
        expect(out['connection']).toBeUndefined();
    });

    it('contrast: Phase-C rewriteResponseHeaders DOES downgrade (HSTS stripped, Location prefixed)', () => {
        const out = rewriteResponseHeaders(
            {
                location: 'https://tynn.test/next',
                'strict-transport-security': 'max-age=63072000',
            },
            SITE,
            'siteid',
            'http://127.0.0.1:51718',
        );
        // Phase-C behaviour (the non-preserve path) — proves preserve-origin is a
        // distinct, additive mode, not a change to the existing downgrade.
        expect(out['strict-transport-security']).toBeUndefined();
        expect(out['location']).toBe('http://127.0.0.1:51718/api/site/siteid/next');
    });
});
