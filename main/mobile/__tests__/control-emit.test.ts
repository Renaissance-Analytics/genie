import { afterEach, describe, expect, it } from 'vitest';
import {
    authorizeDrive,
    isLocked,
    joinControl,
    requestControl,
    setLocked,
    _resetBatonForTest,
    type BatonPrincipal,
    type ControlView,
} from '../baton';
import { recentAudit, _resetAuditForTest } from '../audit';
import { setEventSockets, setEventSocketPrincipal } from '../bus';
import type { WebSocket } from 'ws';

/**
 * The baton is the single source of truth for remote WRITE control, and every
 * transfer must PUSH control:changed to each live /ws/events client — otherwise a
 * client believes it can drive and has its keystrokes silently dropped.
 *
 * With several users connected the push is PER RECIPIENT: the holder is told it
 * can drive, everyone else is told they're view-only, in the same transfer.
 */

function fakeSocket() {
    const sent: string[] = [];
    return { readyState: 1, send: (m: string) => sent.push(m), sent };
}

/** The control views one socket received, oldest first. */
function views(ws: { sent: string[] }): ControlView[] {
    return ws.sent
        .map((s) => JSON.parse(s) as { type: string; payload: ControlView })
        .filter((m) => m.type === 'control:changed')
        .map((m) => m.payload);
}

const member = (id: string, emoji: string): BatonPrincipal => ({
    id,
    name: id,
    emoji,
    isOwner: false,
    since: 1,
});

afterEach(() => {
    _resetBatonForTest();
    _resetAuditForTest();
    setEventSockets(null);
    setEventSocketPrincipal(null);
});

describe('kill-switch compatibility (the desktop taking the baton)', () => {
    it('emits the new locked state to /ws/events on every toggle', () => {
        const ws = fakeSocket();
        setEventSockets(new Set([ws]) as unknown as Set<never>);

        setLocked(true);
        expect(isLocked()).toBe(true);
        expect(views(ws).at(-1)?.locked).toBe(true);
        expect(views(ws).at(-1)?.holder).toBe('desktop');

        setLocked(false);
        expect(isLocked()).toBe(false);
        expect(views(ws).at(-1)?.locked).toBe(false);
        expect(views(ws).at(-1)?.holder).toBeNull();
    });

    it('does not re-emit when the state is unchanged (idempotent)', () => {
        const ws = fakeSocket();
        setEventSockets(new Set([ws]) as unknown as Set<never>);

        setLocked(true);
        const n = ws.sent.length;
        setLocked(true);
        expect(ws.sent.length).toBe(n);
    });

    it('takes the baton off whoever is driving (the desktop is an owner)', () => {
        joinControl(member('m-1', '🐢'));
        expect(authorizeDrive(member('m-1', '🐢')).allowed).toBe(true);

        setLocked(true);
        expect(isLocked()).toBe(true);
        expect(authorizeDrive(member('m-1', '🐢')).allowed).toBe(false);
    });
});

describe('control:changed is personalised per connected user', () => {
    it('tells the holder it can drive and everyone else they are view-only', () => {
        const a = fakeSocket();
        const b = fakeSocket();
        setEventSockets(new Set([a, b]) as unknown as Set<never>);
        setEventSocketPrincipal((ws) => (ws === (a as unknown as WebSocket) ? 'm-1' : 'm-2'));

        joinControl(member('m-1', '🦊'));
        joinControl(member('m-2', '🐢'));
        authorizeDrive(member('m-1', '🦊'));

        const toHolder = views(a).at(-1)!;
        const toViewer = views(b).at(-1)!;
        expect(toHolder.locked).toBe(false);
        expect(toViewer.locked).toBe(true);
        expect(toHolder.holder).toBe('m-1');
        expect(toViewer.holder).toBe('m-1');
        expect(toViewer.holderEmoji).toBe('🦊');
        expect(toViewer.you).toBe('m-2');
    });

    it('carries the connected-users list with each user’s emoji and who is driving', () => {
        const a = fakeSocket();
        setEventSockets(new Set([a]) as unknown as Set<never>);
        setEventSocketPrincipal(() => 'm-1');

        joinControl(member('m-1', '🦊'));
        joinControl(member('m-2', '🐢'));
        authorizeDrive(member('m-1', '🦊'));

        const roster = views(a).at(-1)!.participants;
        expect(roster.map((p) => [p.id, p.emoji, p.holdsControl])).toEqual([
            ['m-1', '🦊', true],
            ['m-2', '🐢', false],
        ]);
    });
});

describe('control transfers are attributed in the audit trail', () => {
    it('records a refused take with the would-be taker’s emoji', () => {
        joinControl(member('m-1', '🦊'));
        joinControl(member('m-2', '🐢'));
        authorizeDrive(member('m-1', '🦊'));

        const d = requestControl({ kind: 'take', by: 'm-2' });
        expect(d.allowed).toBe(false);

        const entry = recentAudit().at(-1)!;
        expect(entry.action).toBe('control.take.refused');
        expect(entry.by).toBe('m-2');
        expect(entry.emoji).toBe('🐢');
    });

    it('records a hand-over with the giver’s emoji', () => {
        joinControl(member('m-1', '🦊'));
        joinControl(member('m-2', '🐢'));
        authorizeDrive(member('m-1', '🦊'));

        expect(requestControl({ kind: 'give', from: 'm-1', to: 'm-2' }).allowed).toBe(true);
        const entry = recentAudit().at(-1)!;
        expect(entry.action).toBe('control.give');
        expect(entry.emoji).toBe('🦊');
    });
});
