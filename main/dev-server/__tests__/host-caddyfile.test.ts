import { describe, expect, it } from 'vitest';
import { buildHostCaddyfile, HOST_CADDY_HTTPS_PORT } from '../host-caddyfile';

/**
 * The HOST reverse-proxy config for host-native `.gen` sites (story #238, task
 * #673). Unlike the sandbox Caddy (in-container, :8443, `tls internal`, dialled
 * by the in-app carrier), this Caddy runs on the HOST, owns :443, and serves a
 * leaf from the Genie local CA — because the machine's REAL browser must trust
 * it. Pure string builder ⇒ deterministically testable.
 */
const TLS = { certPath: '/genie/ca/gen.crt', keyPath: '/genie/ca/gen.key' };

describe('buildHostCaddyfile', () => {
    it('serves each site on :443 with the Genie CA leaf, proxied to its HOST loopback port', () => {
        const cf = buildHostCaddyfile(
            [
                { host: 'moic.gen', port: 8080 },
                { host: 'app.gen', port: 5173 },
            ],
            TLS,
        );
        expect(HOST_CADDY_HTTPS_PORT).toBe(443);
        expect(cf).toContain(`moic.gen:${HOST_CADDY_HTTPS_PORT} {`);
        expect(cf).toContain(`app.gen:${HOST_CADDY_HTTPS_PORT} {`);
        // Real-browser trust ⇒ the Genie CA leaf, NOT Caddy's internal issuer.
        expect(cf).toContain('tls "/genie/ca/gen.crt" "/genie/ca/gen.key"');
        expect(cf).not.toContain('tls internal');
        expect(cf).toContain('reverse_proxy 127.0.0.1:8080');
        expect(cf).toContain('reverse_proxy 127.0.0.1:5173');
    });

    it('redirects plain http → https so a bare <name>.gen typed in the browser lands on TLS', () => {
        const cf = buildHostCaddyfile([{ host: 'moic.gen', port: 8080 }], TLS);
        expect(cf).toContain('http://moic.gen:80');
        expect(cf).toContain('redir https://moic.gen{uri}');
    });

    it('carries the beta.236 https-forcing — body replace + Location rewrite — per site', () => {
        const cf = buildHostCaddyfile([{ host: 'app.gen', port: 4000 }], TLS);
        expect(cf).toContain('replace {');
        expect(cf).toContain('stream');
        expect(cf).toContain('"http://app.gen" "https://app.gen"');
        expect(cf).toContain('header_up -Accept-Encoding');
        expect(cf).toContain('header_down Location "^http:" "https:"');
    });

    it('rewrites the upstream Host when a site pins one', () => {
        const cf = buildHostCaddyfile([{ host: 'web.gen', port: 5173, upstreamHost: 'localhost' }], TLS);
        expect(cf).toContain('header_up Host localhost');
        expect(cf).toContain('reverse_proxy 127.0.0.1:5173 {');
    });

    it('is deterministic/sorted so an unchanged set is a no-op reload', () => {
        const a = buildHostCaddyfile(
            [
                { host: 'b.gen', port: 2 },
                { host: 'a.gen', port: 1 },
            ],
            TLS,
        );
        const b = buildHostCaddyfile(
            [
                { host: 'a.gen', port: 1 },
                { host: 'b.gen', port: 2 },
            ],
            TLS,
        );
        expect(a).toBe(b);
    });

    it('normalises Windows cert paths to forward slashes and quotes them', () => {
        const cf = buildHostCaddyfile([{ host: 'x.gen', port: 3000 }], {
            certPath: 'C:\\ProgramData\\Genie\\ca\\gen.crt',
            keyPath: 'C:\\ProgramData\\Genie\\ca\\gen.key',
        });
        expect(cf).toContain('tls "C:/ProgramData/Genie/ca/gen.crt" "C:/ProgramData/Genie/ca/gen.key"');
    });

    it('produces a valid empty config with no sites', () => {
        const cf = buildHostCaddyfile([], TLS);
        expect(cf).not.toContain('reverse_proxy');
        expect(typeof cf).toBe('string');
    });

    it('tolerates empty TLS paths when there are no sites (nothing references a cert)', () => {
        // The reconcile engine writes an empty config before any leaf exists, so a
        // site-less config must not demand a cert it has no vhost to use.
        expect(() => buildHostCaddyfile([], { certPath: '', keyPath: '' })).not.toThrow();
    });

    it('REFUSES a bad host/port, an injectable upstream host, or an injectable cert path', () => {
        expect(() => buildHostCaddyfile([{ host: 'ok.gen', port: 0 }], TLS)).toThrow();
        expect(() => buildHostCaddyfile([{ host: 'ok.gen', port: 70000 }], TLS)).toThrow();
        expect(() => buildHostCaddyfile([{ host: 'bad host {', port: 3000 }], TLS)).toThrow();
        expect(() => buildHostCaddyfile([{ host: 'ok.gen', port: 3000, upstreamHost: 'bad {' }], TLS)).toThrow();
        expect(() =>
            buildHostCaddyfile([{ host: 'ok.gen', port: 3000 }], { certPath: 'a"\nevil', keyPath: 'k' }),
        ).toThrow();
    });
});
