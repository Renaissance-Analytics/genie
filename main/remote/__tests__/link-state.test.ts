import { describe, it, expect } from 'vitest';
import {
    compareBridgeVersion,
    linkStateForVersions,
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
