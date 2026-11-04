/**
 * A SITE'S LOGIN, IN THE PANEL AND THE BROWSER (the host split, P2b; the owner: "Logins: sync cookies"). Two processes can't
 * share a store (measured on Electron 45.2.2), so a workspace has one per process, and its `.gen` cookies cross the host.
 * `.gen` hosts only; what a store is told is not sent back; a value is never in a log or an error here.
 * `localStorage` and IndexedDB don't sync: a site keeping its login there stays signed out in the other place.
 */

export interface SyncedCookie {
    readonly name: string;
    readonly value: string;
    readonly domain?: string;
    readonly hostOnly?: boolean;
    readonly path?: string;
    readonly secure?: boolean;
    readonly httpOnly?: boolean;
    readonly sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
    readonly expirationDate?: number;
}

export interface CookieMessage {
    readonly op: 'set' | 'remove';
    readonly cookie: SyncedCookie;
}

const GEN = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*\.gen$/i;

export function isGenCookie(cookie: Pick<SyncedCookie, 'domain'>): boolean {
    return typeof cookie.domain === 'string' && GEN.test(cookie.domain);
}

export function isCookieMessage(value: unknown): value is CookieMessage {
    if (typeof value !== 'object' || value === null) return false;
    const m = value as Partial<CookieMessage>;
    return (m.op === 'set' || m.op === 'remove') && typeof m.cookie === 'object' && m.cookie !== null && typeof m.cookie.name === 'string' && typeof m.cookie.value === 'string' && isGenCookie(m.cookie);
}

/** What `session.cookies.set` takes, every flag kept (measured: a copy sends the site what the original did). */
export function cookieToSet(cookie: SyncedCookie): Record<string, unknown> {
    const host = (cookie.domain ?? '').replace(/^\./, '');
    return {
        url: `https://${host}${cookie.path ?? '/'}`,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.hostOnly === false && cookie.domain ? { domain: cookie.domain } : {}),
        ...(cookie.path !== undefined ? { path: cookie.path } : {}),
        ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
        ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
        ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
        ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
    };
}

const key = (c: SyncedCookie) => `${c.domain ?? ''}|${c.path ?? ''}|${c.name}`;

export interface CookieSyncPorts {
    send(message: CookieMessage): void;
    set(cookie: SyncedCookie): Promise<void>;
    remove(cookie: SyncedCookie): Promise<void>;
}

export class CookieSync {
    readonly #ports: CookieSyncPorts;
    /** What it was told and has not yet heard back from its own store. */
    readonly #told = new Map<string, string | null>();

    constructor(ports: CookieSyncPorts) {
        this.#ports = ports;
    }

    /** The store's own `changed` event. */
    changed(cookie: SyncedCookie, cause: string, removed: boolean): void {
        if (!isGenCookie(cookie)) return;
        // Its insert follows; a remove here would race it on the other side. Not `expired-overwrite`: set again already
        // expired, which is how a site logs out, has no insert after it.
        if (removed && cause === 'overwrite') return;
        const k = key(cookie);
        const told = this.#told.get(k);
        if (told !== undefined) {
            if ((removed && told === null) || (!removed && told === cookie.value)) {
                this.#told.delete(k);
                return;
            }
        }
        this.#ports.send({ op: removed ? 'remove' : 'set', cookie });
    }

    async receive(message: CookieMessage): Promise<void> {
        if (!isGenCookie(message.cookie)) return;
        const k = key(message.cookie);
        this.#told.set(k, message.op === 'set' ? message.cookie.value : null);
        try {
            if (message.op === 'set') await this.#ports.set(message.cookie);
            else await this.#ports.remove(message.cookie);
        } catch {
            // Nothing happened in the store, so nothing is coming back. Not worded: a cookie's failure carries no value out.
            this.#told.delete(k);
        }
    }
}
