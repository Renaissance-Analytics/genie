/**
 * REMOTE AND PAIRING (§6.8) — the pure half.
 *
 * - The BATON: exactly one connection drives a host at a time. A READ is never gated on it; a
 *   WRITE is; an UPGRADE is gated on OWNERSHIP of the host, not on the baton — the owner on a
 *   phone may upgrade, a guest who happens to be driving may not. `lock` is the kill-switch.
 * - Sharing is a Tynn link (main/tynn-share-links.ts): the old local share link was removed
 *   (audit M-d), so nothing here mints or redeems one.
 * - PAIRING by PIN: six digits, two minutes, one use, five attempts.
 * - The THREE-WAY SPLIT of settings is DERIVED from each setting's declared scope, never from a
 *   hand-kept list — the list missed two providers for two releases.
 */

export type Capability = 'read' | 'write' | 'upgrade';

/** The words a write is refused with for lack of the baton end with this; the window offers Take control beside them. */
export const BATON_REFUSAL = 'take the baton to make changes';

export class Baton {
    #holder: { connectionId: string; label: string; isOwner: boolean } | null = null;
    #locked = false;

    /**
     * A plain take never takes the baton from someone driving: it says who is. `force` is Take control (Tynn #529): the
     * owner takes control from anyone; anyone else from anyone but the owner. A read-only grant is refused before here.
     */
    take(connectionId: string, label: string, options: { force?: boolean; isOwner?: boolean } = {}): { ok: true; driver: string } | { ok: false; driver: string; driverLabel: string; ownerHolds?: true } {
        const isOwner = options.isOwner === true;
        if (this.#holder && this.#holder.connectionId !== connectionId) {
            const refused = { ok: false as const, driver: this.#holder.connectionId, driverLabel: this.#holder.label };
            if (options.force !== true) return refused;
            if (this.#holder.isOwner && !isOwner) return { ...refused, ownerHolds: true };
        }
        this.#holder = { connectionId, label, isOwner };
        return { ok: true, driver: connectionId };
    }

    release(connectionId: string): boolean {
        if (this.#holder?.connectionId !== connectionId) return false;
        this.#holder = null;
        return true;
    }

    holder(): { connectionId: string; label: string } | null {
        return this.#holder ? { connectionId: this.#holder.connectionId, label: this.#holder.label } : null;
    }

    /** The connection is gone: if it held the baton, nobody does now (true). */
    connectionLost(connectionId: string): boolean {
        if (this.#holder?.connectionId !== connectionId) return false;
        this.#holder = null;
        return true;
    }

    lock(): void {
        this.#locked = true;
    }

    unlock(): void {
        this.#locked = false;
    }

    may(connectionId: string, capability: Capability, context: { isOwner?: boolean } = {}): { ok: true } | { ok: false; reason: string } {
        if (capability === 'read') return { ok: true };
        if (this.#locked) return { ok: false, reason: 'this Genie is locked' };
        if (capability === 'upgrade') {
            return context.isOwner === true ? { ok: true } : { ok: false, reason: 'only the host owner may upgrade this Genie' };
        }
        if (this.#holder && this.#holder.connectionId !== connectionId) {
            return { ok: false, reason: `${this.#holder.label} is driving; ${BATON_REFUSAL}` };
        }
        return { ok: true };
    }
}

export const PIN_TTL_MS = 120_000;
const PIN_ATTEMPTS = 5;

/**
 * A uniform 0..999999 from the OS's CSPRNG (Web Crypto, in main and in a window alike) — Genie 1's `crypto.randomInt`.
 * Rejection sampling, so no code is likelier than another. `Math.random` drew the PIN before genie#1346.
 */
function cryptoPinDraw(): number {
    const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
    const word = new Uint32Array(1);
    for (;;) {
        globalThis.crypto.getRandomValues(word);
        if (word[0]! < limit) return (word[0]! % 1_000_000) / 1_000_000;
    }
}

/** Equal strings, compared without stopping at the first difference (Genie 1 compared the PIN with timingSafeEqual). */
function sameCode(a: string, b: string): boolean {
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
}

export class PairingPins {
    readonly #now: () => number;
    readonly #random: () => number;
    #active: { code: string; expiresAt: number; attemptsLeft: number } | null = null;

    /** `random` is for tests that need a known PIN; absent, the PIN comes from the CSPRNG. */
    constructor(deps: { now: () => number; random?: () => number }) {
        this.#now = deps.now;
        this.#random = deps.random ?? cryptoPinDraw;
    }

    issue(): { code: string; expiresAt: number } {
        const code = String(Math.floor(this.#random() * 1_000_000)).padStart(6, '0');
        this.#active = { code, expiresAt: this.#now() + PIN_TTL_MS, attemptsLeft: PIN_ATTEMPTS };
        return { code, expiresAt: this.#active.expiresAt };
    }

    redeem(code: string): { ok: true } | { ok: false; reason: string; attemptsLeft: number } {
        const a = this.#active;
        if (!a) return { ok: false, reason: 'no PIN is active; issue a new one', attemptsLeft: 0 };
        if (this.#now() > a.expiresAt) {
            this.#active = null;
            return { ok: false, reason: 'the PIN expired; issue a new one', attemptsLeft: 0 };
        }
        if (!sameCode(code, a.code)) {
            a.attemptsLeft -= 1;
            if (a.attemptsLeft <= 0) {
                this.#active = null;
                return { ok: false, reason: 'too many wrong attempts; the PIN was cancelled', attemptsLeft: 0 };
            }
            return { ok: false, reason: 'wrong PIN', attemptsLeft: a.attemptsLeft };
        }
        this.#active = null;
        return { ok: true };
    }
}

export interface SettingDefinition {
    readonly key: string;
    /** `device` = this screen's preference; `workspace` = the host's workspace/agent environment; `host` = never leaves the host. */
    readonly scope: 'device' | 'workspace' | 'host';
}

export interface SettingsSplit {
    readonly clientLocal: string[];
    readonly hostSourced: string[];
    readonly hostOnly: string[];
}

/** Derived from the registry. Adding a setting with a scope places it; no list to forget. */
export function splitSettings(registry: readonly SettingDefinition[]): SettingsSplit {
    return {
        clientLocal: registry.filter((s) => s.scope === 'device').map((s) => s.key),
        hostSourced: registry.filter((s) => s.scope === 'workspace').map((s) => s.key),
        hostOnly: registry.filter((s) => s.scope === 'host').map((s) => s.key),
    };
}
