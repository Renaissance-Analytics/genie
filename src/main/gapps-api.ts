import type { GAppListing, GAppsApi } from '../core/gapps.js';
import { LOCAL_FRAME_LIMIT_BYTES } from '../core/local-frame.js';
import type { GrantScope, ReviewItem } from '../core/gapp-grants.js';
import type { GAppBook, GAppEntry } from './gapps-host.js';

/**
 * WHAT A WINDOW ASKS OF THE GAPP BOOK (GApps v2, V7, Tynn #572). The store acts on the book V3 built, from a local window
 * only: `engine.gapps` for the window's process, `gapps.*` for its page, one check of each operation here for both.
 */
const listing = (entry: GAppEntry): GAppListing => ({ id: entry.packageId, name: entry.name, version: entry.version, state: entry.state, dev: false });

/** The book as the store uses it: what it refuses is thrown in its own words. */
export function gappsApi(book: GAppBook): GAppsApi {
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
export async function dispatchGapps(api: () => GAppsApi | null, operation: unknown, args: readonly unknown[]): Promise<unknown> {
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
        default:
            throw new Error('Invalid GApp operation.');
    }
}

function bounded<T>(value: T): T {
    // Room for the protocol's envelope: an oversized answer must be refused in words, never drop the window's connection.
    if (Buffer.byteLength(JSON.stringify(value)) > LOCAL_FRAME_LIMIT_BYTES - 4096) throw new Error('This package\'s review is too large for this window.');
    return value;
}
