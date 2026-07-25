import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow } from 'electron';
import {
    bindWindowToConnection,
    broadcastLocal,
    isRemoteBoundWindow,
    unbindWindow,
    PASSTHROUGH_EVENTS,
} from '../index';

afterEach(() => vi.restoreAllMocks());

/** A fake window with a spyable webContents.send, matching what broadcastLocal
 *  iterates over (BrowserWindow.getAllWindows() → w.webContents.{isDestroyed,id,send}). */
function fakeWindow(id: number, destroyed = false) {
    return {
        webContents: { id, send: vi.fn(), isDestroyed: () => destroyed },
    };
}

describe('isRemoteBoundWindow', () => {
    it('is true only while a window is bound to a host connection', () => {
        expect(isRemoteBoundWindow(4242)).toBe(false);
        bindWindowToConnection(4242, '100.1.2.3:51718');
        expect(isRemoteBoundWindow(4242)).toBe(true);
        unbindWindow(4242);
        expect(isRemoteBoundWindow(4242)).toBe(false);
    });
});

describe('broadcastLocal', () => {
    it('sends to every window EXCEPT remote-bound (host) windows', () => {
        const local1 = fakeWindow(101);
        const host = fakeWindow(102);
        const local2 = fakeWindow(103);
        vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([
            local1,
            host,
            local2,
        ] as unknown as Electron.BrowserWindow[]);

        bindWindowToConnection(102, 'host-a:51718');
        try {
            broadcastLocal('workspace:open', { workspaceId: 'p1' });

            // Local windows receive the local-machine event…
            expect(local1.webContents.send).toHaveBeenCalledWith('workspace:open', {
                workspaceId: 'p1',
            });
            expect(local2.webContents.send).toHaveBeenCalledWith('workspace:open', {
                workspaceId: 'p1',
            });
            // …the host window does NOT (its UI reflects the host, fed by emitToConn).
            expect(host.webContents.send).not.toHaveBeenCalled();
        } finally {
            unbindWindow(102);
        }
    });

    it('skips destroyed windows', () => {
        const live = fakeWindow(201);
        const dead = fakeWindow(202, true);
        vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([
            live,
            dead,
        ] as unknown as Electron.BrowserWindow[]);

        broadcastLocal('workspaces:changed');
        expect(live.webContents.send).toHaveBeenCalledWith('workspaces:changed', undefined);
        expect(dead.webContents.send).not.toHaveBeenCalled();
    });
});

// A host-bound window (including the client→localHost model) only sees the host's
// live state for the events explicitly re-emitted from /ws/events. Every host push
// that drives a top-bar BADGE must be in the set, or that badge silently never
// updates on a host window — which is exactly what happened to the PendingQuestions
// count (genie #60): `questions:changed` was missing while every sibling badge event
// was present, so the flyout (fetch-on-open) worked but the header count stayed 0.
describe('PASSTHROUGH_EVENTS — every host→client badge event passes through (genie #60)', () => {
    it('includes questions:changed alongside the other live-badge host events', () => {
        // The AgentInbox + IssueWatch badges work because THESE pass through.
        expect(PASSTHROUGH_EVENTS.has('agentinbox:message')).toBe(true);
        expect(PASSTHROUGH_EVENTS.has('issue-watch:update')).toBe(true);
        // The PendingQuestions badge needs the same treatment — this was the bug.
        expect(PASSTHROUGH_EVENTS.has('questions:changed')).toBe(true);
    });
});
