import { describe, it, expect } from 'vitest';
import { parseTailscaleStatus } from '../index';

describe('parseTailscaleStatus', () => {
    it('maps a running tailnet with self + peers (IPv4 from TailscaleIPs)', () => {
        const json = JSON.stringify({
            BackendState: 'Running',
            Self: {
                TailscaleIPs: ['100.101.102.103', 'fd7a:abc::1'],
                HostName: 'my-desktop',
                Online: true,
                DNSName: 'my-desktop.tail1234.ts.net.',
            },
            Peer: {
                key1: {
                    TailscaleIPs: ['100.64.0.5'],
                    HostName: 'work-laptop',
                    Online: true,
                    OS: 'windows',
                    DNSName: 'work-laptop.tail1234.ts.net.',
                },
                key2: { TailscaleIPs: ['100.64.0.6'], HostName: 'phone', Online: false, OS: 'iOS' },
            },
        });
        const s = parseTailscaleStatus(json);
        expect(s.running).toBe(true);
        expect(s.self).toEqual({
            ip: '100.101.102.103',
            hostname: 'my-desktop',
            online: true,
            // Trailing dot stripped — this is the HTTPS dial address as-is.
            dnsName: 'my-desktop.tail1234.ts.net',
        });
        expect(s.peers).toHaveLength(2);
        expect(s.peers[0]).toEqual({
            hostname: 'work-laptop',
            ip: '100.64.0.5',
            online: true,
            os: 'windows',
            dnsName: 'work-laptop.tail1234.ts.net',
        });
        // A peer with no DNSName (MagicDNS off / old client) maps to null.
        expect(s.peers.find((p) => p.hostname === 'phone')?.dnsName).toBeNull();
        expect(s.peers.find((p) => p.hostname === 'phone')?.online).toBe(false);
    });

    it('reports not-running + surfaces the auth URL for a NeedsLogin backend', () => {
        const s = parseTailscaleStatus(
            JSON.stringify({
                BackendState: 'NeedsLogin',
                AuthURL: 'https://login.tailscale.com/a/abc',
                Self: null,
                Peer: {},
            }),
        );
        expect(s.running).toBe(false);
        expect(s.authUrl).toBe('https://login.tailscale.com/a/abc');
        expect(s.peers).toEqual([]);
        expect(s.self).toBeNull();
    });

    it('returns a safe empty result for malformed JSON (never throws)', () => {
        expect(parseTailscaleStatus('not json')).toEqual({ running: false, self: null, peers: [] });
    });

    it('picks the IPv4 even when IPv6 is listed first', () => {
        const s = parseTailscaleStatus(
            JSON.stringify({
                BackendState: 'Running',
                Self: { TailscaleIPs: ['fd7a:abc::1', '100.90.80.70'], HostName: 'h', Online: true },
                Peer: {},
            }),
        );
        expect(s.self?.ip).toBe('100.90.80.70');
    });
});
