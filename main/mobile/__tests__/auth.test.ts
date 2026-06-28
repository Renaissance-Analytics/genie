import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    _resetAuthForTest,
    attemptPair,
    currentPin,
    generatePin,
    initAuth,
    listSessions,
    regeneratePin,
    revokeAllSessions,
    revokeSession,
    sessionFromAuthHeader,
    validateSession,
} from '../auth';

/**
 * Pairing PIN + session auth. A correct PIN alone is NOT enough — pairing also
 * needs a DESKTOP confirm (the injected confirmPair hook), and PIN compare is
 * constant-time + rate-limited. We drive the hook directly: auto-confirm,
 * auto-deny, and a counter to assert the confirm fires only after the PIN check.
 *
 * safeStorage is the inert vitest electron stub (encryption unavailable), so
 * persistence is memory-only here — exactly the no-OS-keychain fallback.
 */

const info = { ip: '100.64.0.9', ua: 'iPhone' };

afterEach(() => _resetAuthForTest());

describe('generatePin', () => {
    it('is always a 6-digit zero-padded string', () => {
        for (let i = 0; i < 200; i++) {
            const pin = generatePin();
            expect(pin).toMatch(/^\d{6}$/);
        }
    });
});

describe('attemptPair', () => {
    beforeEach(() => {
        _resetAuthForTest();
    });

    it('mints a session on the correct PIN + a desktop confirm', async () => {
        let confirms = 0;
        initAuth({
            userDataDir: null,
            confirmPair: async () => {
                confirms++;
                return true;
            },
        });
        const pin = currentPin();
        const r = await attemptPair(pin, info);
        expect(r.ok).toBe(true);
        expect(confirms).toBe(1);
        if (r.ok) {
            expect(r.token).toMatch(/^[a-f0-9]{64}$/); // 32 random bytes hex
            expect(validateSession(r.token)).not.toBeNull();
        }
    });

    it('rejects a WRONG pin with 401 and never asks the desktop', async () => {
        let confirms = 0;
        initAuth({
            userDataDir: null,
            confirmPair: async () => {
                confirms++;
                return true;
            },
        });
        const r = await attemptPair('000000' === currentPin() ? '111111' : '000000', info);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.status).toBe(401);
        expect(confirms).toBe(0); // confirm only fires AFTER a correct PIN
    });

    it('rejects with 403 when the desktop DENIES the pairing', async () => {
        initAuth({ userDataDir: null, confirmPair: async () => false });
        const r = await attemptPair(currentPin(), info);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.status).toBe(403);
        expect(listSessions()).toHaveLength(0);
    });

    it('rate-limits repeated attempts with 429', async () => {
        initAuth({ userDataDir: null, confirmPair: async () => false });
        const wrong = currentPin() === '999999' ? '000000' : '999999';
        // 5 attempts are allowed per window; the 6th is rate-limited.
        const statuses: number[] = [];
        for (let i = 0; i < 7; i++) {
            const r = await attemptPair(wrong, info);
            if (!r.ok) statuses.push(r.status);
        }
        expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
        expect(statuses.slice(5)).toContain(429);
    });

    it('a constant-length wrong PIN still fails (constant-time path)', async () => {
        initAuth({ userDataDir: null, confirmPair: async () => true });
        // Same length as the real 6-digit PIN, guaranteed different value.
        const real = currentPin();
        const wrong = real
            .split('')
            .map((d) => String((Number(d) + 1) % 10))
            .join('');
        const r = await attemptPair(wrong, info);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.status).toBe(401);
    });
});

describe('sessions', () => {
    beforeEach(() => {
        _resetAuthForTest();
        initAuth({ userDataDir: null, confirmPair: async () => true });
    });

    it('validates a Bearer header and rejects a bad/missing one', async () => {
        const r = await attemptPair(currentPin(), info);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(sessionFromAuthHeader(`Bearer ${r.token}`)).not.toBeNull();
        expect(sessionFromAuthHeader('Bearer deadbeef')).toBeNull();
        expect(sessionFromAuthHeader(undefined)).toBeNull();
        expect(sessionFromAuthHeader(r.token)).toBeNull(); // no "Bearer " prefix
    });

    it('revokeAllSessions drops every token', async () => {
        const a = await attemptPair(currentPin(), info);
        const b = await attemptPair(currentPin(), info);
        expect(listSessions()).toHaveLength(2);
        const n = revokeAllSessions();
        expect(n).toBe(2);
        expect(listSessions()).toHaveLength(0);
        if (a.ok) expect(validateSession(a.token)).toBeNull();
        if (b.ok) expect(validateSession(b.token)).toBeNull();
    });

    it('paired sessions carry a roster id + ip for the Devices page', async () => {
        const r = await attemptPair(currentPin(), info);
        expect(r.ok).toBe(true);
        const [s] = listSessions();
        expect(s.id).toBeTruthy();
        expect(s.id).not.toBe(s.token); // the roster id is NOT the bearer token
        expect(s.ip).toBe(info.ip);
        expect(s.label).toBe('iPhone');
    });

    it('revokeSession unpairs exactly one device by id, leaving the rest', async () => {
        const a = await attemptPair(currentPin(), info);
        await attemptPair(currentPin(), info);
        expect(listSessions()).toHaveLength(2);
        const target = listSessions().find((s) => a.ok && s.token === a.token)!;
        expect(revokeSession(target.id)).toBe(true);
        expect(listSessions()).toHaveLength(1);
        if (a.ok) expect(validateSession(a.token)).toBeNull(); // the revoked one is gone
        expect(revokeSession('no-such-id')).toBe(false); // unknown id is a no-op
        expect(listSessions()).toHaveLength(1);
    });

    it('regeneratePin rolls the PIN but keeps existing sessions', async () => {
        const before = currentPin();
        const r = await attemptPair(before, info);
        expect(r.ok).toBe(true);
        const after = regeneratePin();
        expect(after).not.toBe(before); // overwhelmingly likely (1-in-1e6 clash)
        expect(after).toMatch(/^\d{6}$/);
        if (r.ok) expect(validateSession(r.token)).not.toBeNull(); // session survives
    });
});
