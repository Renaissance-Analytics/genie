import { describe, expect, it } from 'vitest';
import { parseBase } from '../site-carrier';

/**
 * The site carrier must honour the HTTPS scheme.
 *
 * THE BUG: `parseBase` returned only `{ host, port }` and threw the protocol
 * away, so `createTailnetSiteCarrier` dialled `http.request` unconditionally.
 * `hostHttpBase` yields `https://<dnsName>:<port>` for a host with a real
 * (Tailscale-issued) certificate — so serving a `.gen` site from a TLS host
 * dialled PLAIN HTTP at the TLS port. That is a protocol downgrade and a broken
 * connection at the same time, and it silently applied to every remote site
 * request.
 *
 * These pin the decision that was wrong. Everything user-facing is already
 * HTTPS (the browser origin is always `https://<name>.gen`, terminated by the
 * session CA); this is about the leg BEHIND it staying encrypted too.
 */
describe('parseBase — the scheme is load-bearing', () => {
    it('marks an https base as TLS and defaults to 443', () => {
        expect(parseBase('https://host.ts.net')).toEqual({
            host: 'host.ts.net',
            port: 443,
            tls: true,
        });
    });

    it('keeps an explicit port on an https base', () => {
        expect(parseBase('https://host.ts.net:8765')).toEqual({
            host: 'host.ts.net',
            port: 8765,
            tls: true,
        });
    });

    it('marks an http base as NOT TLS and defaults to 80', () => {
        // The non-TLS path is legitimate — a host with no cert, reached over the
        // tailnet (WireGuard-encrypted at the transport layer).
        expect(parseBase('http://100.64.0.1:8765')).toEqual({
            host: '100.64.0.1',
            port: 8765,
            tls: false,
        });
        expect(parseBase('http://100.64.0.1')).toEqual({
            host: '100.64.0.1',
            port: 80,
            tls: false,
        });
    });

    it('never reports TLS for a non-https scheme', () => {
        // Guards the downgrade direction specifically: anything that is not
        // https must not be dialled as though it were secure.
        for (const base of ['http://a.b', 'http://a.b:443']) {
            expect(parseBase(base).tls, `${base} must not claim TLS`).toBe(false);
        }
    });
});
