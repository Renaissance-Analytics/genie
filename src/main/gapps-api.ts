import type { GAppBookApi, GAppListing, GAppSessionInfo, GAppSessionsApi, GAppsApi } from '../core/gapps.js';
import { LOCAL_FRAME_LIMIT_BYTES } from '../core/local-frame.js';
import type { GrantScope, ReviewItem } from '../core/gapp-grants.js';
import type { GAppServer } from './gapp-server.js';
import type { GAppBook, GAppEntry } from './gapps-host.js';

/**
 * WHAT A WINDOW ASKS OF THE GAPP BOOK (GApps v2, V7, Tynn #572). The store acts on the book V3 built, from a local window
 * only: `engine.gapps` for the window's process, `gapps.*` for its page, one check of each operation here for both.
 */
const listing = (entry: GAppEntry): GAppListing => ({ id: entry.packageId, name: entry.name, version: entry.version, state: entry.state, dev: false });

/** The book as the store uses it: what it refuses is thrown in its own words. */
export function gappsApi(book: GAppBook): GAppBookApi {
    return {
        list: async () => book.list().map(listing),
        review: async (folder) => {
            const checked = await book.reviewInstall(folder);
            if (!checked.ok) throw new Error(checked.reason);
            return checked.review;
        },
        install: async (folder, options) => {
            const done = await book.install(folder, options);
            if (!done.ok) throw new Error(done.reason);
            return listing(done.entry);
        },
        setOn: async (id, on) => {
            if (!(await book.setOn(id, on))) throw new Error(`${id} could not be turned ${on ? 'on' : 'off'}: it is not installed`);
        },
        uninstall: async (id) => {
            if (!(await book.uninstall(id))) throw new Error(`${id} could not be uninstalled: it is not installed`);
        },
    };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScope = (v: unknown): v is GrantScope => v === 'workstation' || (Array.isArray(v) && v.every((id) => typeof id === 'string'));
const isConsent = (v: unknown): v is { digest: string; items: readonly ReviewItem[] } => isRecord(v) && typeof v.digest === 'string' && Array.isArray(v.items);

/** One operation from a window: its name and arguments checked, then the host's answer, bounded to what the window can receive. */
export async function dispatchGapps(api: () => (GAppBookApi & Partial<Pick<GAppsApi, 'open'>>) | null, operation: unknown, args: readonly unknown[]): Promise<unknown> {
    const invalid = (): never => { throw new Error('Invalid GApp operation arguments.'); };
    const gapps = api();
    if (!gapps) throw new Error('GApps are not available on this host.');
    const [first, second] = args;
    switch (operation) {
        case 'list':
            return bounded(await gapps.list());
        case 'review':
            if (typeof first !== 'string') return invalid();
            return bounded(await gapps.review(first));
        case 'install': {
            if (typeof first !== 'string' || !isRecord(second) || !isScope(second.scope) || (second.consent !== undefined && !isConsent(second.consent))) return invalid();
            const options = second as { scope: GrantScope; consent?: { digest: string; items: readonly ReviewItem[] } };
            return bounded(await gapps.install(first, options.consent === undefined ? { scope: options.scope } : { scope: options.scope, consent: options.consent }));
        }
        case 'setOn':
            if (typeof first !== 'string' || typeof second !== 'boolean') return invalid();
            return gapps.setOn(first, second);
        case 'uninstall':
            if (typeof first !== 'string') return invalid();
            return gapps.uninstall(first);
        case 'open':
            if (typeof first !== 'string') return invalid();
            if (!gapps.open) throw new Error('Opening an app needs a window.');
            return gapps.open(first);
        default:
            throw new Error('Invalid GApp operation.');
    }
}

/**
 * ONE WINDOW OF ONE APP, FROM THE HOST (Tynn #595). The installed files are checked again first, so a tampered app is
 * refused with the reason before a window exists. A session is the host's to mint and close.
 */
export function gappSessions(book: Pick<GAppBook, 'verifyInstalled' | 'list'>, server: Pick<GAppServer, 'openSession'>): GAppSessionsApi {
    const live = new Map<string, () => void>();
    return {
        open: async (packageId) => {
            const problem = await book.verifyInstalled(packageId);
            if (problem !== null) throw new Error(problem);
            const session = server.openSession(packageId);
            if (session === null) {
                const entry = book.list().find((e) => e.packageId === packageId);
                throw new Error(entry?.state === 'off' ? `${entry.name} is turned off: turn it on to open it.` : `${packageId} cannot be opened: its files are not in the book.`);
            }
            live.set(session.token, session.close);
            const { packageId: id, url, channel, token, window } = session;
            return { packageId: id, url, channel, token, window };
        },
        close: (token) => { live.get(token)?.(); live.delete(token); },
    };
}

/** A window connection's sessions: it can close only its own, and they all end when it goes. */
export class GAppSessionOwner {
    readonly #api: () => GAppSessionsApi | null;
    readonly #tokens = new Set<string>();

    constructor(api: () => GAppSessionsApi | null) {
        this.#api = api;
    }

    async call(operation: unknown, args: readonly unknown[]): Promise<GAppSessionInfo | undefined> {
        const [first] = args;
        if ((operation !== 'openSession' && operation !== 'closeSession') || typeof first !== 'string') throw new Error('Invalid GApp operation arguments.');
        const api = this.#api();
        if (!api) throw new Error('GApps are not available on this host.');
        if (operation === 'openSession') {
            const opened = await api.open(first);
            this.#tokens.add(opened.token);
            return opened;
        }
        if (!this.#tokens.delete(first)) throw new Error('That app session is not this window\'s.');
        api.close(first);
        return undefined;
    }

    closeAll(): void {
        for (const token of this.#tokens) this.#api()?.close(token);
        this.#tokens.clear();
    }
}

function bounded<T>(value: T): T {
    // Room for the protocol's envelope: an oversized answer must be refused in words, never drop the window's connection.
    if (Buffer.byteLength(JSON.stringify(value)) > LOCAL_FRAME_LIMIT_BYTES - 4096) throw new Error('This package\'s review is too large for this window.');
    return value;
}
