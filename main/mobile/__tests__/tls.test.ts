import { describe, expect, it } from 'vitest';
import { buildMobileUrl, normalizeDnsName, shouldRenew } from '../tls';

/**
 * Pure helpers of the Tailscale-TLS layer. The CLI-invoking bits (magicDnsName /
 * ensureCert) need a real tailnet + the HTTPS-cert capability, so they're
 * manual-verify-only; these cover the transport→URL selection, DNS normalisation,
 * and the renewal decision.
 */

describe('buildMobileUrl (transport → phone URL)', () => {
    it('uses https + the MagicDNS name when secure (a cert can’t cover a raw IP)', () => {
        expect(
            buildMobileUrl({ secure: true, dnsName: 'alphar.tail1e6127.ts.net', ip: '100.1.2.3', port: 51718 }),
        ).toBe('https://alphar.tail1e6127.ts.net:51718/m/');
    });

    it('uses http + the tailnet IP when not secure', () => {
        expect(
            buildMobileUrl({ secure: false, dnsName: 'alphar.tail1e6127.ts.net', ip: '100.1.2.3', port: 51718 }),
        ).toBe('http://100.1.2.3:51718/m/');
    });

    it('falls back to http when secure but there is no MagicDNS name', () => {
        expect(
            buildMobileUrl({ secure: true, dnsName: null, ip: '100.1.2.3', port: 51718 }),
        ).toBe('http://100.1.2.3:51718/m/');
    });

    it('is null when there is nothing to bind to', () => {
        expect(buildMobileUrl({ secure: false, dnsName: null, ip: null, port: 51718 })).toBeNull();
        expect(buildMobileUrl({ secure: true, dnsName: 'x.ts.net', ip: '100.1.2.3', port: null })).toBeNull();
    });
});

describe('normalizeDnsName', () => {
    it('strips the trailing FQDN dot', () => {
        expect(normalizeDnsName('alphar.tail1e6127.ts.net.')).toBe('alphar.tail1e6127.ts.net');
    });
    it('passes a clean name through and trims whitespace', () => {
        expect(normalizeDnsName('  host.ts.net  ')).toBe('host.ts.net');
    });
    it('returns null for empty / missing input', () => {
        expect(normalizeDnsName('')).toBeNull();
        expect(normalizeDnsName('   ')).toBeNull();
        expect(normalizeDnsName(null)).toBeNull();
        expect(normalizeDnsName(undefined)).toBeNull();
    });
});

describe('shouldRenew', () => {
    const now = new Date('2026-07-02T00:00:00Z');
    it('renews when already expired', () => {
        expect(shouldRenew(new Date('2026-06-01T00:00:00Z'), now)).toBe(true);
    });
    it('renews when within the (default 30-day) threshold of expiry', () => {
        expect(shouldRenew(new Date('2026-07-20T00:00:00Z'), now)).toBe(true); // ~18 days
    });
    it('does NOT renew when comfortably far from expiry', () => {
        expect(shouldRenew(new Date('2026-09-01T00:00:00Z'), now)).toBe(false); // ~2 months
    });
    it('renews when the expiry is unknown (null / NaN)', () => {
        expect(shouldRenew(null, now)).toBe(true);
        expect(shouldRenew(new Date('not-a-date'), now)).toBe(true);
    });
});
