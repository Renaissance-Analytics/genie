import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    encryptSecret,
    decryptSecret,
    secretEncryptionAvailable,
} from '../secrets/store';

/**
 * Pairing PIN + session-token store for the mobile remote-control server.
 *
 * SECURITY MODEL (the user's "free once paired + kill-switch" choice):
 *   - A 6-digit PIN (crypto.randomInt) is shown on the desktop (Settings → big +
 *     QR). The phone POSTs it to `/api/pair`.
 *   - A correct PIN is NOT enough on its own: pairing ALSO raises a one-time
 *     DESKTOP confirm ("Pair this device?") via the injected `confirmPair` hook,
 *     so a tailnet peer who somehow learns the PIN still can't pair silently.
 *     Only on desktop confirm do we mint a session token.
 *   - PIN compare is CONSTANT-TIME (crypto.timingSafeEqual) and pairing is
 *     RATE-LIMITED (a sliding window of recent attempts) to blunt guessing.
 *   - A session token is `crypto.randomBytes(32)` hex. Every REST request
 *     (Bearer) and WS upgrade (`?token=`) is validated against the live set.
 *   - Tokens persist at rest ENCRYPTED via the injected Encryptor port (desktop:
 *     Electron safeStorage; cloud: KMS) in `<userData>/genie-mobile.json`, so a
 *     paired phone survives a Genie restart. FAIL CLOSED: when no encryptor is
 *     available we keep EVERYTHING in memory only (no PIN/tokens on disk) rather
 *     than writing anything in clear — they just don't survive a restart.
 *   - Revoke ("Disconnect all") drops every token; Regenerate PIN rolls the PIN
 *     (and, by the desktop's choice, may also revoke).
 */

/** A minted session for one paired device. */
export interface MobileSession {
    /** Stable, NON-secret id for the Settings roster + per-device revoke. The
     *  bearer token is never exposed to the renderer; this is. */
    id: string;
    /** The opaque bearer token (hex). */
    token: string;
    /** The tailnet IP the device paired from (for the roster; '' if unknown). */
    ip: string;
    /** When it was minted (epoch ms). */
    createdAt: number;
    /** A short human label for the Settings list (derived from the UA / time). */
    label: string;
}

/**
 * Backfill a persisted session that predates `id` / `ip` (so old paired devices
 * still appear in the roster + can be revoked individually after an upgrade).
 */
function normalizeSession(s: Partial<MobileSession> & { token: string }): MobileSession {
    return {
        id: s.id ?? crypto.randomUUID(),
        token: s.token,
        ip: s.ip ?? '',
        createdAt: s.createdAt ?? Date.now(),
        label: s.label ?? 'Device',
    };
}

interface PersistShape {
    /** Encryptor-port ciphertext blob (base64) of { pin, sessions }. The ONLY
     *  on-disk shape — there is NO plaintext fallback (fail closed). */
    enc?: string;
}

/** Hook the desktop answers to confirm a pairing (reuses the forceQuestion/dialog
 *  pattern). Resolves true to allow the pairing, false to deny. */
export type ConfirmPairHook = (info: { ip: string; ua: string }) => Promise<boolean>;

interface AuthState {
    pin: string;
    sessions: Map<string, MobileSession>;
    userDataDir: string | null;
    confirmPair: ConfirmPairHook;
    /** Sliding window of recent pair-attempt timestamps (epoch ms). */
    attempts: number[];
}

const RATE_WINDOW_MS = 60_000; // 1 minute window
const RATE_MAX = 5; // ≤5 pair attempts per window, then reject

let state: AuthState | null = null;

function statePath(dir: string): string {
    return path.join(dir, 'genie-mobile.json');
}

/**
 * Persist { pin, sessions } ENCRYPTED via the Encryptor port. FAIL CLOSED: when
 * no encryptor is available we write NOTHING (everything stays in memory only) —
 * never a plaintext PIN or token on disk.
 */
function persist(): void {
    if (!state?.userDataDir) return;
    if (!secretEncryptionAvailable()) return; // fail closed — memory only
    const payload = {
        pin: state.pin,
        sessions: [...state.sessions.values()],
    };
    const enc = encryptSecret(JSON.stringify(payload));
    if (enc == null) return; // encrypt failed → don't write plaintext
    try {
        fs.writeFileSync(statePath(state.userDataDir), JSON.stringify({ enc } as PersistShape) + '\n', {
            mode: 0o600,
        });
    } catch {
        /* best-effort persistence */
    }
}

/** Load persisted { pin, sessions } if present + decryptable; else nulls. */
function load(dir: string): { pin: string | null; sessions: MobileSession[] } {
    try {
        const j = JSON.parse(
            fs.readFileSync(statePath(dir), 'utf8'),
        ) as PersistShape;
        if (j.enc) {
            const dec = decryptSecret(j.enc);
            if (dec == null) return { pin: null, sessions: [] }; // can't decrypt → fresh
            const payload = JSON.parse(dec) as {
                pin: string;
                sessions: Array<Partial<MobileSession> & { token: string }>;
            };
            return {
                pin: payload.pin ?? null,
                sessions: (payload.sessions ?? []).map(normalizeSession),
            };
        }
    } catch {
        /* no/garbled state — start fresh */
    }
    return { pin: null, sessions: [] };
}

/** A fresh 6-digit PIN as a zero-padded string ('000000'..'999999'). */
export function generatePin(): string {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Initialise the auth store: restore a persisted PIN + sessions, or mint a new
 * PIN. Idempotent per process — re-init refreshes the deps (confirmPair hook)
 * without dropping live sessions.
 */
export function initAuth(opts: {
    userDataDir: string | null;
    confirmPair: ConfirmPairHook;
}): void {
    if (state) {
        state.confirmPair = opts.confirmPair;
        if (opts.userDataDir) state.userDataDir = opts.userDataDir;
        return;
    }
    const restored = opts.userDataDir ? load(opts.userDataDir) : { pin: null, sessions: [] };
    state = {
        pin: restored.pin ?? generatePin(),
        sessions: new Map(restored.sessions.map((s) => [s.token, s])),
        userDataDir: opts.userDataDir,
        confirmPair: opts.confirmPair,
        attempts: [],
    };
    if (!restored.pin) persist(); // freshly minted PIN → persist it
}

/** The current pairing PIN (shown on the desktop). */
export function currentPin(): string {
    return state?.pin ?? '------';
}

/** Roll a new PIN (Settings → Regenerate). Existing sessions are NOT dropped
 *  here — that's `revokeAllSessions`. Returns the new PIN. */
export function regeneratePin(): string {
    if (!state) return '------';
    state.pin = generatePin();
    persist();
    return state.pin;
}

/** Constant-time compare of a candidate PIN against the current one. */
function pinMatches(candidate: string): boolean {
    if (!state) return false;
    const a = Buffer.from(state.pin, 'utf8');
    const b = Buffer.from(String(candidate ?? ''), 'utf8');
    // timingSafeEqual throws on length mismatch — guard, but still do a compare
    // against a fixed buffer so a wrong-length PIN doesn't short-circuit timing.
    if (a.length !== b.length) {
        try {
            crypto.timingSafeEqual(a, a);
        } catch {
            /* ignore */
        }
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

/** Record a pair attempt + return whether we're under the rate limit. */
function underRateLimit(): boolean {
    if (!state) return false;
    const now = Date.now();
    state.attempts = state.attempts.filter((t) => now - t < RATE_WINDOW_MS);
    if (state.attempts.length >= RATE_MAX) return false;
    state.attempts.push(now);
    return true;
}

/** The result of a pairing attempt. */
export type PairResult =
    | { ok: true; token: string }
    | { ok: false; status: 429 | 401 | 403; error: string };

/**
 * Attempt to pair: rate-limit → constant-time PIN check → DESKTOP confirm → mint
 * a session token. Each failure mode maps to an HTTP status the server returns.
 */
export async function attemptPair(
    candidatePin: string,
    info: { ip: string; ua: string },
): Promise<PairResult> {
    if (!state) return { ok: false, status: 403, error: 'auth not initialised' };
    if (!underRateLimit()) {
        return { ok: false, status: 429, error: 'too many attempts — wait a minute' };
    }
    if (!pinMatches(candidatePin)) {
        return { ok: false, status: 401, error: 'incorrect PIN' };
    }
    // Correct PIN is necessary but not sufficient — the desktop must confirm.
    let confirmed = false;
    try {
        confirmed = await state.confirmPair(info);
    } catch {
        confirmed = false;
    }
    if (!confirmed) {
        return { ok: false, status: 403, error: 'pairing was not confirmed on the desktop' };
    }
    const token = crypto.randomBytes(32).toString('hex');
    const session: MobileSession = {
        id: crypto.randomUUID(),
        token,
        ip: info.ip,
        createdAt: Date.now(),
        label: deviceLabel(info.ua),
    };
    state.sessions.set(token, session);
    persist();
    return { ok: true, token };
}

/** A short human label from the User-Agent for the Settings device list. */
function deviceLabel(ua: string): string {
    const u = ua || '';
    if (/iphone/i.test(u)) return 'iPhone';
    if (/ipad/i.test(u)) return 'iPad';
    if (/android/i.test(u)) return 'Android';
    if (/macintosh|mac os/i.test(u)) return 'Mac';
    if (/windows/i.test(u)) return 'Windows';
    return 'Device';
}

/** Validate a bearer/query token against the live session set. */
export function validateSession(token: string | undefined | null): MobileSession | null {
    if (!state || !token) return null;
    return state.sessions.get(token) ?? null;
}

/** Extract + validate the Bearer token from an Authorization header. */
export function sessionFromAuthHeader(
    header: string | undefined,
): MobileSession | null {
    if (!header) return null;
    // `(\S+)` (not `(.+)`): a bearer token is a single non-whitespace blob, and
    // `\s+`/`\S+` are disjoint classes, so there's no whitespace overlap for the
    // engine to backtrack over — closing a polynomial-ReDoS (CodeQL
    // js/polynomial-redos) on the attacker-controlled Authorization header.
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return m ? validateSession(m[1]) : null;
}

/** Drop EVERY session (Settings → Disconnect all). The PIN is left intact. */
export function revokeAllSessions(): number {
    if (!state) return 0;
    const n = state.sessions.size;
    state.sessions.clear();
    persist();
    return n;
}

/**
 * Drop ONE session by its (non-secret) id — the per-device "unpair" in the
 * Devices roster. Returns true when a matching session was found + removed.
 */
export function revokeSession(id: string): boolean {
    if (!state) return false;
    for (const [token, s] of state.sessions) {
        if (s.id === id) {
            state.sessions.delete(token);
            persist();
            return true;
        }
    }
    return false;
}

/** The live sessions (for the Settings device list). */
export function listSessions(): MobileSession[] {
    return state ? [...state.sessions.values()] : [];
}

/** Reset module state (test-only). */
export function _resetAuthForTest(): void {
    state = null;
}

/**
 * Force the current PIN to a fixed value (test-only). Lets the E2E harness pair
 * with a KNOWN pin instead of the crypto-random one `generatePin` mints, so the
 * Playwright test can deep-link `?pair=<pin>` deterministically. No-op until
 * `initAuth` has run. NEVER called in production (only from main/e2e/mock.ts,
 * which is itself gated on GENIE_E2E).
 */
export function _setPinForTest(pin: string): void {
    if (state) state.pin = pin;
}
