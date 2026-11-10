import { gappInstallDetail, type GAppBookApi, type GAppListing, type GAppReview, type GAppSessionInfo, type GAppSessionsApi, type GAppsApi } from '../core/gapps.js';
import { LOCAL_FRAME_LIMIT_BYTES } from '../core/local-frame.js';
import type { GrantScope, ReviewItem } from '../core/gapp-grants.js';
import type { GAppPreviews } from './gapp-previews.js';
import type { GAppServer } from './gapp-server.js';
import type { GAppBook, GAppEntry } from './gapps-host.js';
import type { Caller } from './mcp-tools.js';

/**
 * WHAT A WINDOW ASKS OF THE GAPP BOOK (GApps v2, V7, Tynn #572). The store acts on the book V3 built, from a local window
 * only: `engine.gapps` for the window's process, `gapps.*` for its page, one check of each operation here for both.
 */
const listing = (entry: GAppEntry): GAppListing => ({ id: entry.packageId, name: entry.name, version: entry.version, state: entry.state, dev: false });

export type AskPerson = (review: GAppReview, scope: GrantScope) => Promise<'allowed' | 'denied'>;

/**
 * CONSENT IS THE PERSON'S, ON THE DECK (Tynn #596): a blocking item carrying the review, in Genie's own section. The host
 * asks, so the install waits for the answer wherever it is given. `workspaceName` says a workspace as a person knows it.
 */
export function askOnDeck(approvals: { gate(caller: Caller, action: string, detail: string): Promise<'allowed' | 'denied'> }, workspaceName: (id: string) => string): AskPerson {
    const store = { agentId: 'gapp-store' as Caller['agentId'], agentName: 'GApp Store', workspaceId: '', workspacePath: '' };
    return (review, scope) => approvals.gate(store, 'gapps.install', gappInstallDetail(review, scope === 'workstation' ? 'every workspace' : scope.map(workspaceName).join(', ')));
}

/** The book as the store uses it: what it refuses is thrown in its own words. */
export function gappsApi(book: GAppBook, ask: AskPerson, previews?: GAppPreviews): GAppBookApi {
    return {
        list: async () => {
            // A workspace's launcher (V8): what its folder holds now.
            await previews?.scan();
            const launchers = (previews?.list() ?? []).map((p): GAppListing => ({
                id: `preview:${p.packageId}`, packageId: p.packageId, name: p.name, version: p.version, state: 'installed', dev: true,
                workspace: p.workspaceName, unverified: p.unverified, networkAllowed: p.networkAllowed,
            }));
            return [...book.list().map(listing), ...launchers];
        },
        allowPreviewNetwork: async (packageId, allowed) => {
            if (!previews) throw new Error('No workspace previews here.');
            await previews.allowNetwork(packageId, allowed);
        },
        review: async (folder) => {
            const checked = await book.reviewInstall(folder);
            if (!checked.ok) throw new Error(checked.reason);
            return checked.review;
        },
        install: async (folder, options) => {
            // What the person reviewed must still be this package; if not, the book refuses it below and nobody is asked.
            const checked = await book.reviewInstall(folder);
            if (checked.ok && checked.review.consent && options.consent?.digest === checked.review.digest) {
                if ((await ask(checked.review, options.scope)) !== 'allowed') throw new Error(`${checked.review.name} was not installed: it was denied on the Deck.`);
            }
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
export async function dispatchGapps(api: () => (GAppBookApi & Partial<Pick<GAppsApi, 'open' | 'preview'>>) | null, operation: unknown, args: readonly unknown[]): Promise<unknown> {
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
        case 'allowPreviewNetwork':
            if (typeof first !== 'string' || typeof second !== 'boolean') return invalid();
            return gapps.allowPreviewNetwork(first, second);
        case 'preview':
            if (typeof first !== 'string') return invalid();
            if (!gapps.preview) throw new Error('Running a preview needs a window.');
            return gapps.preview(first);
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
export function gappSessions(book: Pick<GAppBook, 'verifyInstalled' | 'list'>, server: Pick<GAppServer, 'openSession'>, preview?: { previews: GAppPreviews; ask: AskPerson }): GAppSessionsApi {
    const live = new Map<string, () => void>();
    return {
        open: async (packageId, options = {}) => {
            if (options.preview === true) {
                if (!preview) throw new Error('No workspace previews here.');
                await preview.previews.scan();
                const p = preview.previews.entry(packageId);
                if (!p) throw new Error(`no workspace holds a preview of ${packageId}`);
                // Its own grant, asked like an install, for its own workspace; again only for what the workspace added since.
                const review = preview.previews.review(packageId);
                if (review.consent) {
                    const scope = p.grant?.scope ?? [p.workspaceId];
                    if ((await preview.ask(review, scope)) !== 'allowed') throw new Error(`The preview of ${p.name} was not run: it was denied on the Deck.`);
                    await preview.previews.grant(packageId, scope);
                }
                const session = server.openSession(packageId, { preview: true });
                if (session === null) throw new Error(`The preview of ${p.name} cannot be opened: its folder has no app to serve.`);
                live.set(session.token, session.close);
                const { packageId: id, url, channel, token, window } = session;
                return { packageId: id, url, channel, token, window };
            }
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
        const [first, second] = args;
        if ((operation !== 'openSession' && operation !== 'closeSession') || typeof first !== 'string') throw new Error('Invalid GApp operation arguments.');
        const api = this.#api();
        if (!api) throw new Error('GApps are not available on this host.');
        if (operation === 'openSession') {
            const opened = await api.open(first, { preview: typeof second === 'object' && second !== null && (second as { preview?: unknown }).preview === true });
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
