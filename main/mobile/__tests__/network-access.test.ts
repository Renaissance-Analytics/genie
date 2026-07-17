import { describe, expect, it } from 'vitest';
import {
    defaultNetworkAccess,
    resolveNetworkListeners,
    type NetworkInterfaces,
} from '../network-access';

const interfaces: NetworkInterfaces = {
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    Ethernet: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    Docker: [{ address: '172.18.0.1', family: 'IPv4', internal: false }],
    Tailscale: [{ address: '100.90.10.2', family: 'IPv4', internal: false }],
};

describe('remote network access', () => {
    it('keeps backward-compatible secure defaults without exposing LAN', () => {
        expect(defaultNetworkAccess()).toEqual({
            local: true,
            lan: false,
            tailscale: true,
            tynn: true,
        });
    });

    it('resolves only explicitly enabled listener classes', () => {
        expect(resolveNetworkListeners(
            { local: true, lan: false, tailscale: true, tynn: true },
            interfaces,
        )).toEqual([
            { network: 'local', ip: '127.0.0.1' },
            { network: 'tailscale', ip: '100.90.10.2' },
        ]);
    });

    it('includes physical RFC1918 LAN addresses but excludes container adapters', () => {
        expect(resolveNetworkListeners(
            { local: false, lan: true, tailscale: false, tynn: false },
            interfaces,
        )).toEqual([{ network: 'lan', ip: '192.168.1.20' }]);
    });

    it('never turns Tynn relay permission into a local socket bind', () => {
        expect(resolveNetworkListeners(
            { local: false, lan: false, tailscale: false, tynn: true },
            interfaces,
        )).toEqual([]);
    });
});
