import { describe, expect, it } from 'vitest';
import { buildCaddyfile, CADDY_HTTPS_PORT } from '../caddyfile';

/**
 * The per-workspace Caddy proxy config. Caddy runs INSIDE the workspace sandbox,
 * publishes ONE stable port, and for each enabled site TLS-terminates `<name>.gen`
 * (forcing https) and reverse-proxies to the app's plain-http localhost port. This
 * is what masks the app ports and forces https — the two things the model needs.
 * Pure string builder ⇒ deterministically testable.
 */
describe('buildCaddyfile', () => {
    it('serves each site on the shared https port, TLS-terminated, proxied to its localhost port', () => {
        const cf = buildCaddyfile([
            { host: 'moic-suite.acme.gen', port: 5173 },
            { host: 'api.acme.gen', port: 8000 },
        ]);
        // One vhost block per site, bound to the shared https listener.
        expect(cf).toContain(`moic-suite.acme.gen:${CADDY_HTTPS_PORT} {`);
        expect(cf).toContain(`api.acme.gen:${CADDY_HTTPS_PORT} {`);
        // TLS is terminated at Caddy (forces https); the carrier ignores the leaf,
        // so Caddy's internal issuer is fine.
        expect(cf).toContain('tls internal');
        // The app is reached over plain http on loopback inside the sandbox.
        expect(cf).toContain('reverse_proxy 127.0.0.1:5173');
        expect(cf).toContain('reverse_proxy 127.0.0.1:8000');
    });

    it('never emits a bare http (port 80) listener — https only', () => {
        const cf = buildCaddyfile([{ host: 'x.acme.gen', port: 3000 }]);
        expect(cf).not.toMatch(/http:\/\//);
        expect(cf).not.toMatch(/:80\b/);
    });

    it('is stable/deterministic for the same sites (so a no-op reload is a no-op)', () => {
        const a = buildCaddyfile([
            { host: 'b.acme.gen', port: 2 },
            { host: 'a.acme.gen', port: 1 },
        ]);
        const b = buildCaddyfile([
            { host: 'a.acme.gen', port: 1 },
            { host: 'b.acme.gen', port: 2 },
        ]);
        expect(a).toBe(b); // sorted, order-independent
    });

    it('produces a valid empty config when there are no sites', () => {
        const cf = buildCaddyfile([]);
        expect(cf).not.toContain('reverse_proxy');
        expect(typeof cf).toBe('string');
    });

    it('REFUSES a bad host or port rather than emit an injectable/again-broken config', () => {
        expect(() => buildCaddyfile([{ host: 'ok.gen', port: 0 }])).toThrow();
        expect(() => buildCaddyfile([{ host: 'ok.gen', port: 70000 }])).toThrow();
        expect(() => buildCaddyfile([{ host: 'bad host {', port: 3000 }])).toThrow();
        expect(() => buildCaddyfile([{ host: '', port: 3000 }])).toThrow();
    });
});
