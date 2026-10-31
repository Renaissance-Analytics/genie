/**
 * REMOTE, PAIRING, SHARING (§6.8) — the pure half.
 *
 * - The BATON: exactly one connection drives a host at a time. A READ is never gated on it; a
 *   WRITE is; an UPGRADE is gated on OWNERSHIP of the host, not on the baton — the owner on a
 *   phone may upgrade, a guest who happens to be driving may not. `lock` is the kill-switch.
 * - SHARE LINKS: minted for THIS host, served exactly once and never re-served — a link is a
 *   credential you cannot unsend, and a URL that can be shown twice has already been shown to
 *   the wrong screen once. Redeemed by secret; expiry and revocation refuse; another host's link
 *   is simply not a valid link here.
 * - PAIRING by PIN: six digits, two minutes, one use, five attempts.
 * - The THREE-WAY SPLIT of settings is DERIVED from each setting's declared scope, never from a
 *   hand-kept list — the list missed two providers for two releases.
 */

export type Capability = 'read' | 'write' | 'upgrade';

export class Baton {
    #holder: { connectionId: string; label: string } | null = null;
    #locked = false;

    take(connectionId: string, label: string): { ok: true; driver: string } | { ok: false; driver: string; driverLabel: string } {
        if (this.#holder && this.#holder.connectionId !== connectionId) {
            return { ok: false, driver: this.#holder.connectionId, driverLabel: this.#holder.label };
        }
        this.#holder = { connectionId, label };
        return { ok: true, driver: connectionId };
    }

    release(connectionId: string): boolean {
        if (this.#holder?.connectionId !== connectionId) return false;
        this.#holder = null;
        return true;
    }

    holder(): { connectionId: string; label: string } | null {
        return this.#holder;
    }

    connectionLost(connectionId: string): void {
        if (this.#holder?.connectionId === connectionId) this.#holder = null;
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
            return { ok: false, reason: `${this.#holder.label} is driving; take the baton to make changes` };
        }
        return { ok: true };
    }
}

export interface ShareLink {
    readonly id: string;
    readonly workspaceId: string;
    readonly grantedTo: string;
    readonly expiresAt: number;
    readonly served: boolean;
    readonly revoked: boolean;
}

interface ShareRecord extends ShareLink {
    readonly secret: string;
}

export class ShareLinks {
    readonly #host: string;
    readonly #now: () => number;
    readonly #random: () => string;
    readonly #links = new Map<string, ShareRecord>();

    constructor(deps: { host: string; now: () => number; random: () => string }) {
        this.#host = deps.host;
        this.#now = deps.now;
        this.#random = deps.random;
    }

    mint(input: { workspaceId: string; grantedTo: string; expiresInMs: number }): ShareLink {
        const secret = this.#random();
        const record: ShareRecord = {
            id: `share_${secret}`,
            workspaceId: input.workspaceId,
            grantedTo: input.grantedTo,
            expiresAt: this.#now() + input.expiresInMs,
            served: false,
            revoked: false,
            secret,
        };
        this.#links.set(record.id, record);
        return publicView(record);
    }

    /** The URL, exactly once. */
    serve(id: string): { ok: true; url: string } | { ok: false; reason: string } {
        const r = this.#links.get(id);
        if (!r) return { ok: false, reason: 'not a valid link' };
        if (r.served) return { ok: false, reason: 'this link was already served once and cannot be shown again; mint a new one' };
        this.#links.set(id, { ...r, served: true });
        return { ok: true, url: `https://${this.#host}/share/${id}#${r.secret}` };
    }

    redeem(id: string, secret: string): { ok: true; workspaceId: string; grantedTo: string } | { ok: false; reason: string } {
        const r = this.#links.get(id);
        if (!r || r.secret !== secret) return { ok: false, reason: 'not a valid link' };
        if (r.revoked) return { ok: false, reason: 'this link was revoked' };
        if (this.#now() > r.expiresAt) return { ok: false, reason: 'this link expired' };
        return { ok: true, workspaceId: r.workspaceId, grantedTo: r.grantedTo };
    }

    revoke(id: string): boolean {
        const r = this.#links.get(id);
        if (!r) return false;
        this.#links.set(id, { ...r, revoked: true });
        return true;
    }

    /** Roster first, minting form second: who holds a link to this host. */
    roster(): ShareLink[] {
        return [...this.#links.values()].map(publicView);
    }

    static hostOf(url: string): string | null {
        try {
            return new URL(url).host;
        } catch {
            return null;
        }
    }
}

function publicView(r: ShareRecord): ShareLink {
    return { id: r.id, workspaceId: r.workspaceId, grantedTo: r.grantedTo, expiresAt: r.expiresAt, served: r.served, revoked: r.revoked };
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
