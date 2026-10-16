import { describe, expect, it } from 'vitest';
import { parseTailscaleStatus, remoteListenAddress } from '../src/core/tailscale.js';

/**
 * WHERE THE HOST LISTENS (§6.8) — the remote socket binds to this machine's Tailscale address and is
 * advertised by its MagicDNS name, so a phone on the tailnet reaches it and nothing on the LAN or the
 * internet does. `tailscale status --json` is parsed defensively: no Tailscale, or Tailscale down,
 * means NO address — the host does not fall back to 0.0.0.0, ever.
 */

const status = JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'alphar.tailnet.invalid.', TailscaleIPs: ['100.64.0.7', 'fd7a:115c:a1e0::7'] },
});

describe('parseTailscaleStatus', () => {
    it('reads the IPv4 and the MagicDNS name (trailing dot dropped) when the backend runs', () => {
        expect(parseTailscaleStatus(status)).toEqual({ ok: true, ip: '100.64.0.7', dnsName: 'alphar.tailnet.invalid' });
    });

    it('a stopped backend, a missing IPv4, or garbage is a reason — never an address', () => {
        expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Stopped', Self: {} }))).toEqual({ ok: false, reason: 'Tailscale is not running (BackendState Stopped)' });
        expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'x.', TailscaleIPs: ['fd7a::1'] } }))).toEqual({ ok: false, reason: 'Tailscale reports no IPv4 address for this machine' });
        expect(parseTailscaleStatus('nope')).toEqual({ ok: false, reason: 'tailscale status did not answer JSON' });
    });
});

describe('remoteListenAddress', () => {
    it('binds to the Tailscale IPv4 and advertises the MagicDNS name with the port and path, over ws (the tailnet is the encryption)', () => {
        expect(remoteListenAddress({ ok: true, ip: '100.64.0.7', dnsName: 'alphar.tailnet.invalid' }, 7421)).toEqual({ bind: '100.64.0.7', url: 'ws://alphar.tailnet.invalid:7421/genie' });
    });

    it('without Tailscale there is nothing to bind and nothing to advertise', () => {
        expect(remoteListenAddress({ ok: false, reason: 'Tailscale is not running (BackendState Stopped)' }, 7421)).toBeNull();
    });
});
