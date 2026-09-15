import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    _resetAuthForTest,
    attemptPair,
    initAuth,
    listSessions,
    mintGuestSession,
    revokeGuestSessions,
    sessionPrincipal,
    validateSession,
    _setPinForTest,
} from '../auth';
import { setSecretEncryptor } from '../../secrets/store';
import type { HostAccessPolicy } from '../../host-core/access-policy';

/**
 * A GUEST session: someone a workstation was SHARED with, connected through the
 * relay with a grant naming what they may reach. Unlike a paired device — the
 * owner's own phone or laptop, confirmed at the desktop — a guest's session
 * carries that grant's access policy, and everything the host serves them is
 * judged by it (genie-cloud#33).
 *
 * These pin the session half: the policy rides the session, the principal is
 * NOT an owner (so the baton never lets a guest TAKE control), a read-only guest
 * is marked so, and a guest session is never written to disk — it exists for
 * one relay session, and a persisted one would outlive the revocation that ends it.
 */

const policy = (overrides: Partial<HostAccessPolicy> = {}): HostAccessPolicy => ({
    principalId: 'tynn-user-42',
    principalType: 'tynn-user',
    transports: ['tynn'],
    capability: 'control',
    workspaceScopes: ['workspace:ws-shared'],
    sitePermissions: { 'site-shared': 'interact' },
    ...overrides,
});

let dir: string;

beforeEach(() => {
    _resetAuthForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-guest-session-'));
    // A working encryptor, so a persist that SHOULD skip guests would otherwise
    // happily write them — the negative assertion below needs that to be possible.
    setSecretEncryptor({
        isAvailable: () => true,
        encrypt: (b: Buffer) => b,
        decrypt: (b: Buffer) => b,
    });
    initAuth({ userDataDir: dir, confirmPair: async () => true });
});

afterEach(() => {
    _resetAuthForTest();
    setSecretEncryptor(null);
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('guest sessions', () => {
    it('carries the grant policy on the session and resolves by its token', () => {
        const session = mintGuestSession({ policy: policy(), name: 'Sam Support' });

        expect(validateSession(session.token)?.access).toEqual(policy());
        expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is never an owner, so the baton cannot let a guest take control', () => {
        const session = mintGuestSession({ policy: policy(), name: 'Sam Support' });
        const principal = sessionPrincipal(session);

        expect(principal.isOwner).toBe(false);
        expect(principal.id).toBe('tynn-user-42');
        expect(principal.name).toBe('Sam Support');
        expect(principal.readonly).toBe(false);
    });

    it('marks a read-only guest so it never enters the baton as a driver', () => {
        const session = mintGuestSession({
            policy: policy({ capability: 'readonly' }),
            name: 'Viewer',
        });

        expect(sessionPrincipal(session).readonly).toBe(true);
    });

    it('keeps a paired device an owner (positive control)', async () => {
        _setPinForTest('123456');
        const paired = await attemptPair('123456', { ip: '127.0.0.1', ua: 'test' });
        if (!paired.ok) throw new Error('pair failed');
        const device = validateSession(paired.token)!;

        expect(device.access).toBeUndefined();
        expect(sessionPrincipal(device).isOwner).toBe(true);
        expect(sessionPrincipal(device).readonly).toBe(false);
    });

    it('never writes a guest session to disk', async () => {
        _setPinForTest('123456');
        const paired = await attemptPair('123456', { ip: '127.0.0.1', ua: 'test' });
        if (!paired.ok) throw new Error('pair failed');
        const guest = mintGuestSession({ policy: policy(), name: 'Sam Support' });

        const onDisk = fs.readFileSync(path.join(dir, 'genie-mobile.json'), 'utf8');
        const decoded = Buffer.from(JSON.parse(onDisk).enc, 'base64').toString('utf8');
        // The paired device IS persisted (the store works) …
        expect(decoded).toContain(paired.token);
        // … and the guest is not.
        expect(decoded).not.toContain(guest.token);
    });

    it('revokes every session of one guest, and only theirs', async () => {
        _setPinForTest('123456');
        const paired = await attemptPair('123456', { ip: '127.0.0.1', ua: 'test' });
        if (!paired.ok) throw new Error('pair failed');
        const a = mintGuestSession({ policy: policy(), name: 'Sam' });
        const b = mintGuestSession({ policy: policy(), name: 'Sam' });
        const other = mintGuestSession({ policy: policy({ principalId: 'tynn-user-7' }), name: 'Alex' });

        expect(revokeGuestSessions('tynn-user-42')).toBe(2);

        expect(validateSession(a.token)).toBeNull();
        expect(validateSession(b.token)).toBeNull();
        expect(validateSession(other.token)).not.toBeNull();
        expect(validateSession(paired.token)).not.toBeNull();
        expect(listSessions().map((s) => s.token)).toContain(other.token);
    });
});
