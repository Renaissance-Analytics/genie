import { describe, expect, it } from 'vitest';
import { detectTailnetIp, isCgnatIp, type NetIface } from '../tailnet';

/**
 * Tailnet detection is the security chokepoint — the server binds ONLY what this
 * returns, and null means "don't start". Pure (injected interfaces), so we drive
 * every branch directly: a tailscale-named adapter, a CGNAT IP on an oddly-named
 * one, internal/non-CGNAT exclusion, and the fail-closed null.
 */

function ifaces(map: Record<string, NetIface[]>): NodeJS.Dict<NetIface[]> {
    return map;
}

const v4 = (address: string, internal = false): NetIface => ({
    address,
    family: 'IPv4',
    internal,
});

describe('isCgnatIp', () => {
    it('accepts the 100.64.0.0/10 block', () => {
        expect(isCgnatIp('100.64.0.1')).toBe(true);
        expect(isCgnatIp('100.100.50.7')).toBe(true);
        expect(isCgnatIp('100.127.255.255')).toBe(true);
    });
    it('rejects addresses outside the block', () => {
        expect(isCgnatIp('100.63.255.255')).toBe(false); // just below
        expect(isCgnatIp('100.128.0.0')).toBe(false); // just above
        expect(isCgnatIp('10.0.0.5')).toBe(false); // private LAN
        expect(isCgnatIp('192.168.1.4')).toBe(false);
        expect(isCgnatIp('127.0.0.1')).toBe(false);
        expect(isCgnatIp('not-an-ip')).toBe(false);
    });
});

describe('detectTailnetIp', () => {
    it('returns the IPv4 of a tailscale-named interface in the CGNAT range', () => {
        const ip = detectTailnetIp(
            ifaces({
                Ethernet: [v4('192.168.1.20')],
                Tailscale: [v4('100.101.102.103')],
            }),
        );
        expect(ip).toBe('100.101.102.103');
    });

    it('falls back to ANY CGNAT IPv4 when the interface name does not match', () => {
        // A renamed/uncommon tailnet adapter — name miss, but the CGNAT IP wins.
        const ip = detectTailnetIp(
            ifaces({
                utun5: [v4('100.71.0.9')],
                en0: [v4('10.0.0.2')],
            }),
        );
        expect(ip).toBe('100.71.0.9');
    });

    it('ignores a tailscale-named interface whose IP is NOT CGNAT', () => {
        const ip = detectTailnetIp(
            ifaces({
                Tailscale: [v4('169.254.1.1')], // link-local, not CGNAT
                Ethernet: [v4('192.168.1.9')],
            }),
        );
        expect(ip).toBeNull();
    });

    it('ignores internal addresses', () => {
        const ip = detectTailnetIp(
            ifaces({
                lo: [v4('100.64.0.1', true)], // internal — skipped
            }),
        );
        expect(ip).toBeNull();
    });

    it('returns null when no tailnet is present (FAIL CLOSED)', () => {
        const ip = detectTailnetIp(
            ifaces({
                Ethernet: [v4('192.168.1.10')],
                'Wi-Fi': [v4('10.0.0.5')],
            }),
        );
        expect(ip).toBeNull();
    });

    it('returns null for an empty interface set', () => {
        expect(detectTailnetIp(ifaces({}))).toBeNull();
    });

    it('handles numeric family (older Node) for the CGNAT match', () => {
        const ip = detectTailnetIp(
            ifaces({
                tailscale0: [{ address: '100.90.1.2', family: 4, internal: false }],
            }),
        );
        expect(ip).toBe('100.90.1.2');
    });
});
