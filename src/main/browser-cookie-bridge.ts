import type { Session } from 'electron';
import { CookieSync, cookieToSet, isGenCookie, type SyncedCookie } from '../core/cookie-sync.js';
import type { BrowserEvent } from './browser-service.js';

/**
 * ONE SIDE OF A WORKSPACE'S COOKIE SYNC (the host split, P2b): the window's stores or the browser process's. Rules in
 * core/cookie-sync.ts. A store just opened asks for what the other side has, so a login made before it existed reaches it.
 */
export interface CookieBridgePorts {
    /** The host's browser service. */
    call(method: string, args: readonly unknown[]): Promise<unknown>;
    /** This side's connection, to ignore what it sent itself. */
    me(): string | null;
    /** The workspace's store on this side, opened if it isn't. */
    openStore(workspaceId: string): Session;
}

export class BrowserCookieBridge {
    readonly #ports: CookieBridgePorts;
    readonly #syncs = new Map<string, { sync: CookieSync; ses: Session }>();

    constructor(ports: CookieBridgePorts) {
        this.#ports = ports;
    }

    /** A store opened on this side (genie-browser-electron.ts, for each one). */
    attach(workspaceId: string, ses: Session): void {
        if (this.#syncs.has(workspaceId)) return;
        const sync = new CookieSync({
            send: (message) => { void this.#ports.call('cookies', [workspaceId, message]).catch(() => {}); },
            set: async (cookie) => { await ses.cookies.set(cookieToSet(cookie) as never); },
            remove: async (cookie) => { await ses.cookies.remove(String(cookieToSet(cookie)['url']), cookie.name); },
        });
        this.#syncs.set(workspaceId, { sync, ses });
        void this.#ports.call('cookiesWanted', [workspaceId]).catch(() => {});
    }

    /** Linked again (or for the first time): every store asks once more, as one opened unlinked asked into nothing. */
    relinked(): void {
        for (const workspaceId of this.#syncs.keys()) void this.#ports.call('cookiesWanted', [workspaceId]).catch(() => {});
    }

    /** The store's own `changed` event. */
    changed(workspaceId: string, cookie: SyncedCookie, cause: string, removed: boolean): void {
        this.#syncs.get(workspaceId)?.sync.changed(cookie, cause, removed);
    }

    onEvent(event: BrowserEvent): void {
        if (event.kind !== 'cookies' && event.kind !== 'cookiesWanted') return;
        if (event.from === this.#ports.me()) return;
        if (event.kind === 'cookies') {
            if (!this.#syncs.has(event.workspaceId)) this.#ports.openStore(event.workspaceId);
            void this.#syncs.get(event.workspaceId)?.sync.receive(event.message);
            return;
        }
        const here = this.#syncs.get(event.workspaceId);
        if (!here) return;
        void here.ses.cookies.get({}).then((cookies) => {
            for (const cookie of cookies) {
                if (isGenCookie(cookie)) void this.#ports.call('cookies', [event.workspaceId, { op: 'set', cookie }]).catch(() => {});
            }
        }, () => {});
    }
}
