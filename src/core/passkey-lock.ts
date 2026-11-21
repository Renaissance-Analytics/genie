/**
 * THE PASSKEY LOCK'S WIRE (Tynn #677, S1). genie-host is the judge (main/passkey-lock.ts); this is what a client may say
 * to it, and what a LOCKED client may say at all. Everything not in {@link LOCKED_ALLOWED} is refused to a locked client
 * with a result typed `code: 'locked'`, before anything on the host is asked; no live push reaches it but
 * {@link PASSKEY_LOCK_EVENT}.
 */

export const PASSKEY_LOCK_METHODS = [
    'passkeyLock.status',
    'passkeyLock.lockNow',
    'passkeyLock.beginUnlock',
    'passkeyLock.finishUnlock',
    'passkeyLock.beginEnroll',
    'passkeyLock.finishEnroll',
    'passkeyLock.disable',
    'passkeyLock.devices',
    'passkeyLock.removeDevice',
] as const;
export type PasskeyLockMethod = (typeof PASSKEY_LOCK_METHODS)[number];

/**
 * What a locked client may call: its status (the lock screen's whole state), lock itself, and the two halves of unlocking.
 * Enrolling another device, turning the lock off and managing devices need an unlocked client — otherwise they would be a
 * way in that needs no passkey.
 */
export const LOCKED_ALLOWED: ReadonlySet<string> = new Set<PasskeyLockMethod>(['passkeyLock.status', 'passkeyLock.lockNow', 'passkeyLock.beginUnlock', 'passkeyLock.finishUnlock']);

export const mayCallWhileLocked = (method: string): boolean => LOCKED_ALLOWED.has(method);
export const isPasskeyLockMethod = (method: unknown): method is PasskeyLockMethod => typeof method === 'string' && (PASSKEY_LOCK_METHODS as readonly string[]).includes(method);

/** The one push a locked client receives: its own lock status, whenever it changes. */
export const PASSKEY_LOCK_EVENT = 'passkey-lock';

/** The typed refusal's code, on a `result` frame. */
export const LOCKED_CODE = 'locked';

/** A client's lock, as it is told. `canUnlock`: a passkey enrolled for this client's relying party exists. */
export interface PasskeyLockStatus {
    readonly enabled: boolean;
    readonly locked: boolean;
    readonly devices: number;
    readonly canUnlock: boolean;
    /** The lock's file could not be read: everything is locked and nothing unlocks until it is put right. */
    readonly damaged?: true;
}

/** The relying party Genie's own windows use: their origin is http://genie.localhost:<port> (Tynn #683). */
export const WINDOW_RP_ID = 'genie.localhost';
