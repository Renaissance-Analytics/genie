import { afterEach, describe, expect, it } from 'vitest';
import { setLocked, isLocked, _resetAuditForTest } from '../audit';
import { setEventSockets } from '../bus';

/**
 * The host kill-switch is the single source of truth for remote WRITE control.
 * Toggling it must PUSH a control:changed frame to every live /ws/events client
 * (the phone dashboard AND any Work Mode remote), so a control handoff propagates
 * immediately instead of the remote silently having its keystrokes dropped.
 */

function fakeSocket() {
    const sent: string[] = [];
    return { readyState: 1, send: (m: string) => sent.push(m), sent };
}

afterEach(() => {
    _resetAuditForTest();
    setEventSockets(null);
});

describe('setLocked broadcasts control:changed', () => {
    it('emits the new locked state to /ws/events on every toggle', () => {
        const ws = fakeSocket();
        setEventSockets(new Set([ws]) as unknown as Set<never>);

        setLocked(true);
        expect(isLocked()).toBe(true);
        expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({
            type: 'control:changed',
            payload: { locked: true },
        });

        setLocked(false);
        expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({
            type: 'control:changed',
            payload: { locked: false },
        });
    });

    it('does not re-emit when the state is unchanged (idempotent)', () => {
        const ws = fakeSocket();
        setEventSockets(new Set([ws]) as unknown as Set<never>);

        setLocked(true);
        const n = ws.sent.length;
        setLocked(true);
        expect(ws.sent.length).toBe(n);
    });
});
