import { describe, it, expect } from 'vitest';
import {
    compareBridgeVersion,
    linkStateForVersions,
    computeHostBuildBehind,
    linkStateForPing,
    nextReconnectDelayMs,
    limboExpired,
    decideOnDisconnect,
} from '../link-state';

describe('compareBridgeVersion', () => {
    it('match / host-behind / client-behind', () => {
        expect(compareBridgeVersion(2, 2)).toBe('match');
        expect(compareBridgeVersion(2, 1)).toBe('host-behind'); // host older
        expect(compareBridgeVersion(1, 2)).toBe('client-behind'); // host newer
    });
});

describe('linkStateForVersions', () => {
    it('connected when equal', () => {
        expect(linkStateForVersions(3, 3)).toEqual({ phase: 'connected' });
    });
    it('mismatch carries direction + both versions (host behind → upgrade host)', () => {
        expect(linkStateForVersions(2, 1)).toEqual({
            phase: 'mismatch',
            direction: 'host-behind',
            hostVersion: 1,
            localVersion: 2,
        });
    });
    it('mismatch the other way → update this Genie', () => {
        expect(linkStateForVersions(1, 2)).toMatchObject({ phase: 'mismatch', direction: 'client-behind' });
    });
});

describe('computeHostBuildBehind (soft release-version nudge)', () => {
    it('nudges when the host build is older than the client', () => {
        expect(computeHostBuildBehind('0.7.0-beta.98', '0.7.0-beta.80')).toEqual({
            hostVersion: '0.7.0-beta.80',
            localVersion: '0.7.0-beta.98',
        });
    });
    it('no nudge when host is same or newer', () => {
        expect(computeHostBuildBehind('0.7.0-beta.98', '0.7.0-beta.98')).toBeUndefined();
        expect(computeHostBuildBehind('0.7.0-beta.80', '0.7.0-beta.98')).toBeUndefined();
    });
    it('no nudge when either version is unknown (never nag on an unknown build)', () => {
        expect(computeHostBuildBehind('0.7.0-beta.98', undefined)).toBeUndefined();
        expect(computeHostBuildBehind(undefined, '0.7.0-beta.80')).toBeUndefined();
    });
});

describe('linkStateForPing (protocol handshake + soft nudge)', () => {
    it('connected + nudge when protocol matches but host build is older', () => {
        expect(
            linkStateForPing(1, '0.7.0-beta.98', { protocolVersion: 1, appVersion: '0.7.0-beta.80' }),
        ).toEqual({
            phase: 'connected',
            hostBuildBehind: { hostVersion: '0.7.0-beta.80', localVersion: '0.7.0-beta.98' },
        });
    });
    it('connected with no nudge when versions match', () => {
        expect(
            linkStateForPing(1, '0.7.0-beta.98', { protocolVersion: 1, appVersion: '0.7.0-beta.98' }),
        ).toEqual({ phase: 'connected' });
    });
    it('a hard protocol mismatch takes precedence — no soft nudge decoration', () => {
        expect(
            linkStateForPing(1, '0.7.0-beta.98', { protocolVersion: 0, appVersion: '0.7.0-beta.80' }),
        ).toEqual({ phase: 'mismatch', direction: 'host-behind', hostVersion: 0, localVersion: 1 });
    });
    it('missing appVersion (host predates version reporting) → connected + unknown-older nudge', () => {
        expect(linkStateForPing(1, '0.7.0-beta.98', { protocolVersion: 1, appVersion: null })).toEqual({
            phase: 'connected',
            hostBuildBehind: { hostVersion: null, localVersion: '0.7.0-beta.98' },
        });
    });
    it('no local version → no nudge even if host omits appVersion', () => {
        expect(linkStateForPing(1, undefined, { protocolVersion: 1, appVersion: null })).toEqual({
            phase: 'connected',
        });
    });
});

describe('nextReconnectDelayMs', () => {
    it('ramps 2s → 3s → 5s and caps', () => {
        expect(nextReconnectDelayMs(0)).toBe(2000);
        expect(nextReconnectDelayMs(1)).toBe(3000);
        expect(nextReconnectDelayMs(2)).toBe(5000);
        expect(nextReconnectDelayMs(9)).toBe(5000);
        expect(nextReconnectDelayMs(-1)).toBe(2000);
    });
});

describe('limboExpired', () => {
    it('expires only once the timeout has fully elapsed', () => {
        expect(limboExpired(1000, 1000 + 119_000, 120_000)).toBe(false);
        expect(limboExpired(1000, 1000 + 120_000, 120_000)).toBe(true);
    });
});

describe('decideOnDisconnect', () => {
    it('ignores a deliberate teardown', () => {
        expect(decideOnDisconnect({ deliberate: true, everConnected: true, upgrading: false })).toBe('ignore');
    });
    it('a healthy connection dropping → limbo (overlay + reconnect, keep the window)', () => {
        expect(decideOnDisconnect({ deliberate: false, everConnected: true, upgrading: false })).toBe('limbo');
    });
    it('an upgrade in flight → limbo even before the first healthy open', () => {
        expect(decideOnDisconnect({ deliberate: false, everConnected: false, upgrading: true })).toBe('limbo');
    });
    it('never healthy + not upgrading → the legacy give-up path', () => {
        expect(decideOnDisconnect({ deliberate: false, everConnected: false, upgrading: false })).toBe(
            'retry-then-teardown',
        );
    });
});
