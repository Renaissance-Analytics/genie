import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    _resetAuthForTest,
    attemptPair,
    currentPin,
    generatePin,
    initAuth,
    listSessions,
    pairingStoreIssue,
    regeneratePin,
    revokeAllSessions,
    revokeSession,
    sessionFromAuthHeader,
    validateSession,
} from '../auth';
import { setSecretEncryptor } from '../../secrets/store';
import {
    _resetPairingJournalForTest,
    readPairingJournal,
    setPairingJournalDir,
} from '../../pairing-journal';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';

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

    it('parses the Bearer token in linear time (ReDoS-safe, was js/polynomial-redos)', async () => {
        const r = await attemptPair(currentPin(), info);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // A valid single-blob token still resolves.
        expect(sessionFromAuthHeader(`Bearer ${r.token}`)).not.toBeNull();
        // `\S+` stops at whitespace, so a token with an internal space is rejected.
        expect(sessionFromAuthHeader('Bearer tok en')).toBeNull();
        // Adversarial header: a long whitespace/newline run (which `\s` matches but
        // `.` does not) is exactly what made the old `(.+)` backtrack polynomially.
        // The `(\S+)` fix keeps it linear — this must return null effectively
        // instantly; a regression to `(.+)` would blow the time bound / time out.
        const evil = 'Bearer ' + ' \n'.repeat(50_000) + 'x';
        const start = Date.now();
        expect(sessionFromAuthHeader(evil)).toBeNull();
        expect(Date.now() - start).toBeLessThan(1000);
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

describe('at-rest persistence (fail closed — no plaintext tokens)', () => {
    const fakeEnc = {
        isAvailable: () => true,
        encrypt: (b: Buffer) => Buffer.concat([Buffer.from('ENC:'), b]),
        decrypt: (b: Buffer) => b.subarray(4),
    };
    afterEach(() => {
        _resetAuthForTest();
        setSecretEncryptor(null);
    });
    afterAll(() => cleanupTmpRoot());

    it('writes NOTHING to disk when no encryptor is available (memory only)', async () => {
        setSecretEncryptor(null);
        const dir = makeTmpDir('auth-failclosed');
        initAuth({ userDataDir: dir, confirmPair: async () => true });
        const r = await attemptPair(currentPin(), info);
        expect(r.ok).toBe(true);
        if (r.ok) expect(validateSession(r.token)).not.toBeNull(); // in memory
        // No genie-mobile.json (fail closed — never a plaintext PIN/token on disk).
        expect(fs.existsSync(path.join(dir, 'genie-mobile.json'))).toBe(false);
    });

    it('persists an ENCRYPTED blob (not the raw token) and restores it', async () => {
        setSecretEncryptor(fakeEnc);
        const dir = makeTmpDir('auth-enc');
        initAuth({ userDataDir: dir, confirmPair: async () => true });
        const r = await attemptPair(currentPin(), info);
        expect(r.ok).toBe(true);
        const raw = fs.readFileSync(path.join(dir, 'genie-mobile.json'), 'utf8');
        const file = JSON.parse(raw) as { enc?: string; plain?: unknown };
        expect(file.enc).toBeTruthy();
        expect(file.plain).toBeUndefined(); // the plaintext shape is gone
        if (r.ok) expect(raw).not.toContain(r.token); // the token is NOT on disk in clear

        // A fresh init (same dir + encryptor) restores the session.
        _resetAuthForTest();
        initAuth({ userDataDir: dir, confirmPair: async () => true });
        if (r.ok) expect(validateSession(r.token)).not.toBeNull();
    });
});

/**
 * genie#578 — "remote pairing keeps having to be redone".
 *
 * The store that holds every paired device used to be destroyed by the very
 * failure that stopped it being read: `load()` answered an undecryptable blob
 * with `{pin: null, sessions: []}`, `initAuth` read that as "first run", minted
 * a PIN and persisted it — writing over the only copy of the sessions. A
 * transient key problem became permanent loss, and the file that would have
 * shown what happened was the file we overwrote.
 *
 * The invariant these pin down: NEVER overwrite a `genie-mobile.json` we did
 * not successfully load. Either we read it, or we keep it.
 */
describe('an unreadable store is preserved, never overwritten (genie#578)', () => {
    const fakeEnc = {
        isAvailable: () => true,
        encrypt: (b: Buffer) => Buffer.concat([Buffer.from('ENC:'), b]),
        decrypt: (b: Buffer) => b.subarray(4),
    };
    /** Available — so `persist()` will happily write — but this blob is from
     *  another key. Exactly the shape that used to destroy the store. */
    const wrongKeyEnc = {
        isAvailable: () => true,
        encrypt: (b: Buffer) => Buffer.concat([Buffer.from('ENC2:'), b]),
        decrypt: () => {
            throw new Error('decrypt failed: not our key');
        },
    };

    afterEach(() => {
        _resetAuthForTest();
        _resetPairingJournalForTest();
        setSecretEncryptor(null);
    });
    afterAll(() => cleanupTmpRoot());

    /** Seed `dir` with a real, encrypted store holding one paired device. */
    async function seedPairedStore(dir: string): Promise<string> {
        setSecretEncryptor(fakeEnc);
        initAuth({ userDataDir: dir, confirmPair: async () => true });
        const r = await attemptPair(currentPin(), info);
        expect(r.ok).toBe(true);
        _resetAuthForTest();
        _resetPairingJournalForTest();
        return fs.readFileSync(path.join(dir, 'genie-mobile.json'), 'utf8');
    }

    function preservedFiles(dir: string): string[] {
        return fs.readdirSync(dir).filter((f) => f.startsWith('genie-mobile.json.unreadable-'));
    }

    it('moves an UNDECRYPTABLE store aside instead of writing over it', async () => {
        const dir = makeTmpDir('auth-578-corrupt');
        const original = await seedPairedStore(dir);

        // Boot again under a different key: the store cannot be read.
        setSecretEncryptor(wrongKeyEnc);
        initAuth({ userDataDir: dir, confirmPair: async () => true });

        const kept = preservedFiles(dir);
        expect(kept).toHaveLength(1);
        expect(fs.readFileSync(path.join(dir, kept[0]), 'utf8')).toBe(original);

        // The live file is a NEW store (fresh PIN), not the old one — pairing
        // still works from here, it just starts over.
        expect(fs.readFileSync(path.join(dir, 'genie-mobile.json'), 'utf8')).not.toBe(original);

        const issue = pairingStoreIssue();
        expect(issue?.reason).toBe('decrypt-failed');
        expect(issue?.preservedPath).toBe(path.join(dir, kept[0]));
    });

    it('a FIRST boot with no keychain at all moves nothing and reports nothing (the CI-mac shape)', () => {
        // A headless macOS runner has no unlocked login keychain, so
        // safeStorage reports unavailable there in a way it never does on
        // ubuntu or windows. That is the one environment where a new
        // preserve-aside path could plausibly fire when it should not — a fresh
        // profile plus a dead encryptor — so pin it: nothing is moved, nothing
        // is written, no issue is raised, and boot does not throw.
        const dir = makeTmpDir('auth-578-nokeychain-fresh');
        setSecretEncryptor(null);
        expect(() => initAuth({ userDataDir: dir, confirmPair: async () => true })).not.toThrow();

        expect(preservedFiles(dir)).toHaveLength(0);
        expect(fs.existsSync(path.join(dir, 'genie-mobile.json'))).toBe(false);
        expect(pairingStoreIssue()).toBeNull(); // nothing was there to fail on
        expect(currentPin()).toMatch(/^\d{6}$/); // and pairing still works in memory

        // The ONLY thing this adds to a profile directory is the journal. Named
        // exactly, so a future addition here has to be deliberate.
        expect(fs.readdirSync(dir).sort()).toEqual(['genie-pairing-journal.jsonl']);
    });

    it('does NOT touch the store while the keychain is unavailable, and recovers when it returns', async () => {
        const dir = makeTmpDir('auth-578-unavailable');
        const original = await seedPairedStore(dir);

        // Boot with no encryptor at all — a transient condition, not a dead key.
        setSecretEncryptor(null);
        initAuth({ userDataDir: dir, confirmPair: async () => true });
        expect(pairingStoreIssue()?.reason).toBe('keychain-unavailable');
        expect(preservedFiles(dir)).toHaveLength(0); // nothing moved: it may still be good
        expect(fs.readFileSync(path.join(dir, 'genie-mobile.json'), 'utf8')).toBe(original);

        // Next boot, the keychain is back — every paired device returns.
        _resetAuthForTest();
        setSecretEncryptor(fakeEnc);
        initAuth({ userDataDir: dir, confirmPair: async () => true });
        expect(pairingStoreIssue()).toBeNull();
        expect(listSessions()).toHaveLength(1);
    });

    it('preserves the unread blob before the FIRST write once the keychain comes back mid-run', async () => {
        const dir = makeTmpDir('auth-578-deferred');
        const original = await seedPairedStore(dir);

        // Boot with the keychain down: the store is unread, nothing is written.
        setSecretEncryptor(null);
        initAuth({ userDataDir: dir, confirmPair: async () => true });

        // …then it comes back and something persists (here: a new pairing). The
        // in-memory state knows nothing of the old devices, so writing it out
        // would destroy them — the deferred form of the same bug.
        setSecretEncryptor(fakeEnc);
        const r = await attemptPair(currentPin(), info);
        expect(r.ok).toBe(true);

        const kept = preservedFiles(dir);
        expect(kept).toHaveLength(1);
        expect(fs.readFileSync(path.join(dir, kept[0]), 'utf8')).toBe(original);
        expect(pairingStoreIssue()?.preservedPath).toBe(path.join(dir, kept[0]));
    });

    it('preserves nothing and reports no issue on a genuinely first run', async () => {
        const dir = makeTmpDir('auth-578-firstrun');
        setSecretEncryptor(fakeEnc);
        initAuth({ userDataDir: dir, confirmPair: async () => true });
        expect(pairingStoreIssue()).toBeNull();
        expect(preservedFiles(dir)).toHaveLength(0);
        // …and the fresh PIN IS persisted, which is the whole point of a first run.
        expect(fs.existsSync(path.join(dir, 'genie-mobile.json'))).toBe(true);
        const restoredPin = currentPin();
        _resetAuthForTest();
        initAuth({ userDataDir: dir, confirmPair: async () => true });
        expect(currentPin()).toBe(restoredPin);
    });

    it('moves a MALFORMED store aside rather than silently replacing it', () => {
        const dir = makeTmpDir('auth-578-malformed');
        const garbage = '{ this is not json';
        fs.writeFileSync(path.join(dir, 'genie-mobile.json'), garbage);
        setSecretEncryptor(fakeEnc);
        initAuth({ userDataDir: dir, confirmPair: async () => true });
        const kept = preservedFiles(dir);
        expect(kept).toHaveLength(1);
        expect(fs.readFileSync(path.join(dir, kept[0]), 'utf8')).toBe(garbage);
        expect(pairingStoreIssue()?.reason).toBe('malformed');
    });

    it('records WHICH of the four paths happened, in the journal that survives the restart', async () => {
        const dir = makeTmpDir('auth-578-journal');
        await seedPairedStore(dir);
        setPairingJournalDir(dir);

        setSecretEncryptor(wrongKeyEnc);
        initAuth({ userDataDir: dir, confirmPair: async () => true });

        const events = readPairingJournal().map((e) => e.event);
        expect(events).toContain('host-store-unreadable');
        const entry = readPairingJournal().find((e) => e.event === 'host-store-unreadable')!;
        expect(entry.side).toBe('host');
        expect(entry.detail.reason).toBe('decrypt-failed');
        expect(String(entry.detail.preserved)).toContain('genie-mobile.json.unreadable-');
    });

    it('records a restore, so "it was fine yesterday" is checkable', async () => {
        const dir = makeTmpDir('auth-578-journal-ok');
        await seedPairedStore(dir);
        setPairingJournalDir(dir);
        setSecretEncryptor(fakeEnc);
        initAuth({ userDataDir: dir, confirmPair: async () => true });
        const entry = readPairingJournal().find((e) => e.event === 'host-store-restored');
        expect(entry).toBeDefined();
        expect(entry!.detail.devices).toBe(1);
    });
});
