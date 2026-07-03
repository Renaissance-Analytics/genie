import { describe, expect, it } from 'vitest';
import { issueWatchGate, type IwGateInput } from '../issuewatch';

/**
 * The Issue Watch GitHub-auth GATE decision (pure — no DOM, so it runs in the
 * node harness). This is the fix for the remote-window bug: a REMOTE (Work-Mode
 * host) window must derive "connected / dead-session / missing capabilities"
 * from the HOST's status, and NEVER offer the client's device-flow reconnect;
 * a LOCAL window must behave byte-for-byte as before (client status + the
 * client's own capabilities, device-flow reconnect).
 */

// A connected host status with no read error and no missing capabilities.
const okStatus: IwGateInput['status'] = {
    connected: true,
    needsReauth: false,
    error: null,
    missingCapabilities: [],
};
// The CLIENT's caps: in these tests the client is UNAUTHED (the exact bug —
// a host window read the client's empty GitHub and showed a false gate).
const clientUnauthed: IwGateInput['localCaps'] = { connected: false, missing: [] };

describe('issueWatchGate — remote (host) window', () => {
    it('host connected & authed → the feed, NOT a reconnect banner (the bug)', () => {
        // Even though the CLIENT is unauthed, the host is authed → show the feed.
        expect(
            issueWatchGate({ remote: true, status: okStatus, localCaps: clientUnauthed }),
        ).toEqual({ view: 'feed', gatedCaps: [] });
    });

    it('gates on the HOST\'s missing capabilities, ignoring the client\'s caps', () => {
        const gate = issueWatchGate({
            remote: true,
            status: { ...okStatus, missingCapabilities: ['issue-watch.dependabot'] },
            // Client would gate a DIFFERENT set — it must be ignored in remote.
            localCaps: { connected: true, missing: ['issue-watch.issues'] },
        });
        expect(gate).toEqual({ view: 'feed', gatedCaps: ['issue-watch.dependabot'] });
    });

    it('host dead session → reconnect scoped to the HOST (no local device flow)', () => {
        expect(
            issueWatchGate({
                remote: true,
                status: { ...okStatus, needsReauth: true },
                localCaps: clientUnauthed,
            }),
        ).toEqual({ view: 'reconnect', scope: 'host' });
    });

    it('a live 401 from the host also routes to the host reconnect notice', () => {
        expect(
            issueWatchGate({
                remote: true,
                status: { ...okStatus, error: 'unauthenticated' },
                localCaps: clientUnauthed,
            }),
        ).toEqual({ view: 'reconnect', scope: 'host' });
    });

    it('host genuinely disconnected → connect scoped to the HOST', () => {
        expect(
            issueWatchGate({
                remote: true,
                status: { connected: false, needsReauth: false, error: null, missingCapabilities: [] },
                localCaps: clientUnauthed,
            }),
        ).toEqual({ view: 'connect', scope: 'host' });
    });

    it('tolerates a host that omits missingCapabilities (older host) → gate inert', () => {
        const gate = issueWatchGate({
            remote: true,
            status: { connected: true, needsReauth: false, error: null },
            localCaps: clientUnauthed,
        });
        expect(gate).toEqual({ view: 'feed', gatedCaps: [] });
    });
});

describe('issueWatchGate — local window (unchanged behavior)', () => {
    it('dead session → the device-flow reconnect (scope local)', () => {
        expect(
            issueWatchGate({
                remote: false,
                status: { ...okStatus, needsReauth: true },
                localCaps: { connected: true, missing: [] },
            }),
        ).toEqual({ view: 'reconnect', scope: 'local' });
    });

    it('not connected → the connect-in-Settings copy (scope local)', () => {
        expect(
            issueWatchGate({
                remote: false,
                status: { connected: false, needsReauth: false, error: null, missingCapabilities: [] },
                localCaps: clientUnauthed,
            }),
        ).toEqual({ view: 'connect', scope: 'local' });
    });

    it('connected → the feed gated by the CLIENT\'s own capabilities, NOT the host status', () => {
        const gate = issueWatchGate({
            remote: false,
            // A host missingCapabilities value must be IGNORED in a local window.
            status: { ...okStatus, missingCapabilities: ['issue-watch.dependabot'] },
            localCaps: { connected: true, missing: ['issue-watch.pulls'] },
        });
        expect(gate).toEqual({ view: 'feed', gatedCaps: ['issue-watch.pulls'] });
    });

    it('connected but the client caps snapshot is not yet connected → gate inert', () => {
        const gate = issueWatchGate({
            remote: false,
            status: okStatus,
            localCaps: { connected: false, missing: ['issue-watch.issues'] },
        });
        expect(gate).toEqual({ view: 'feed', gatedCaps: [] });
    });
});
