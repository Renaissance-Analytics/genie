import { describe, expect, it } from 'vitest';
import { isRemoteHost, shouldShowRemoteIndicator } from '../remote-host';

/**
 * genie #63 rule 3 — "Local never renders as Remote."
 *
 * Phase 1 makes the local Host always-on, so EVERY client is now host-backed:
 * "am I talking to a Host?" stops being a signal for anything user-facing. The
 * loud red "● REMOTE — <host>" badge must key off a GENUINELY remote host — a
 * host reached at a non-loopback address — not off the mere existence of a host
 * connection. Phase 2 routes the local Client at 127.0.0.1 through this very
 * same connection shape, so without the loopback guard the local desktop would
 * light up as REMOTE the moment that lands.
 */
describe('isRemoteHost (genie #63 rule 3)', () => {
    it('is FALSE for a loopback Host — Client → localHost is still local', () => {
        expect(isRemoteHost({ ip: '127.0.0.1', port: 8321, hostname: 'this-pc' })).toBe(false);
        expect(isRemoteHost({ ip: '127.0.1.5', port: 8321, hostname: 'this-pc' })).toBe(false);
        expect(isRemoteHost({ ip: '::1', port: 8321, hostname: 'this-pc' })).toBe(false);
        expect(isRemoteHost({ ip: '[::1]', port: 8321, hostname: 'this-pc' })).toBe(false);
        expect(isRemoteHost({ ip: 'localhost', port: 8321, hostname: 'this-pc' })).toBe(false);
        expect(isRemoteHost({ ip: '0.0.0.0', port: 8321, hostname: 'this-pc' })).toBe(false);
    });

    it('is TRUE for a genuinely remote host (tailnet / LAN / MagicDNS)', () => {
        expect(isRemoteHost({ ip: '100.94.12.7', port: 8321, hostname: 'workstation' })).toBe(true);
        expect(isRemoteHost({ ip: '192.168.1.40', port: 8321, hostname: 'nuc' })).toBe(true);
        expect(
            isRemoteHost({ ip: 'fcee07.geniecloud.link', port: 443, hostname: 'cloud' }),
        ).toBe(true);
    });

    it('is FALSE when there is no host at all', () => {
        expect(isRemoteHost(null)).toBe(false);
    });
});

describe('shouldShowRemoteIndicator', () => {
    const remote = { ip: '100.94.12.7', port: 8321, hostname: 'workstation' };
    const local = { ip: '127.0.0.1', port: 8321, hostname: 'this-pc' };

    it('shows for a connected REMOTE host', () => {
        expect(shouldShowRemoteIndicator({ connected: true, host: remote })).toBe(true);
    });

    it('never shows for a connected LOCALHOST host (the always-on local Host)', () => {
        expect(shouldShowRemoteIndicator({ connected: true, host: local })).toBe(false);
    });

    it('never shows when disconnected or hostless', () => {
        expect(shouldShowRemoteIndicator(null)).toBe(false);
        expect(shouldShowRemoteIndicator({ connected: false, host: remote })).toBe(false);
        expect(shouldShowRemoteIndicator({ connected: true, host: null })).toBe(false);
    });
});
