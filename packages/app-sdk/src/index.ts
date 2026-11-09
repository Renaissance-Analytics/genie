import type { BRIDGE_CALLS, GenieElements } from './generated.js';

/**
 * @genie/app-sdk: what a Genie app (a GApp) uses to talk to Genie from its own window. It wraps `window.genieApp`, the only
 * thing Genie exposes there, and adds types: an app calls the elements it lists in `uses`, with their own arguments.
 *
 *     const genie = await connect<ElementsOf<'knowledge'>>();
 *     if (genie.can('knowledge')) await genie.call('knowledge', { action: 'search', query: 'x' }, { workspaceId });
 */
export type { AppElementPayload, GenieElements } from './generated.js';
export { BRIDGE_CALLS, BRIDGE_EVENTS } from './generated.js';

/** The arguments of just these elements: the ones an app lists in `uses`. */
export type ElementsOf<K extends keyof GenieElements> = Pick<GenieElements, K>;

export type GrantScope = 'workstation' | readonly string[];

export interface AppIdentity {
    readonly packageId: string;
    readonly version: string;
    readonly preview: boolean;
    readonly scope: GrantScope;
    readonly publisher: string;
}

export interface CallOptions {
    /** The workspace to act in. An app granted the whole workstation must name one; one granted a single workspace acts there. */
    readonly workspaceId?: string;
}

export interface AppEvents {
    grantChanged: { readonly granted: readonly string[]; readonly scope: GrantScope };
    catalogChanged: { readonly revision: number; readonly granted: readonly string[] };
}

type CallRest<A> = {} extends A ? [args?: A, options?: CallOptions] : [args: A, options?: CallOptions];

export interface GenieApp<E extends object = GenieElements> {
    /** Who this app is. */
    me(): AppIdentity;
    /** Whether the grant allows this element now. */
    can(elementId: string): boolean;
    /** Call an element. Rejects with NotGrantedError(elementId), or RefusedError(reason). */
    call<K extends keyof E & string>(elementId: K, ...rest: CallRest<E[K]>): Promise<unknown>;
    /** The app's own isolated store: 50 MB, never shared. */
    readonly storage: {
        get<T = unknown>(key: string): Promise<T | null>;
        set(key: string, value: unknown): Promise<void>;
        /** `true` if the key was there. */
        delete(key: string): Promise<boolean>;
        list(prefix?: string): Promise<string[]>;
    };
    /** Follow a change. Returns the function that stops following it. */
    on<K extends keyof AppEvents>(event: K, listener: (data: AppEvents[K]) => void): () => void;
}

/** Not running in a Genie app window. */
export class NotInGenieError extends Error {
    override readonly name = 'NotInGenieError';
    constructor() { super('Not in a Genie app window: window.genieApp is only there when Genie opens this app.'); }
}

/** The app's grant does not include this element. */
export class NotGrantedError extends Error {
    override readonly name = 'NotGrantedError';
    constructor(readonly elementId: string, message: string) { super(message); }
}

/** Genie refused, and says why. */
export class RefusedError extends Error {
    override readonly name = 'RefusedError';
    constructor(readonly reason: string) { super(reason); }
}

interface Bridge {
    request(method: string, params?: unknown): Promise<unknown>;
    on(event: string, listener: (data: never) => void): () => void;
}

/** An Error crossing into the page keeps only its message, so the preload says the kind of refusal there. */
function asSdkError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const notGranted = /^NotGrantedError\(([^)]+)\): ([\s\S]*)$/.exec(message);
    return notGranted ? new NotGrantedError(notGranted[1]!, notGranted[2]!) : new RefusedError(message);
}

/** Connect to Genie from an app's window. Throws NotInGenieError anywhere else. */
export async function connect<E extends object = GenieElements>(): Promise<GenieApp<E>> {
    const bridge = (globalThis as { genieApp?: Bridge }).genieApp;
    if (!bridge) throw new NotInGenieError();
    const ask = (method: (typeof BRIDGE_CALLS)[number], params?: unknown): Promise<unknown> => bridge.request(method, params).catch((error: unknown) => { throw asSdkError(error); });

    // Listening before asking, so a change during the first answer is not overwritten by it.
    let granted: ReadonlySet<string> | null = null;
    let scope: GrantScope | null = null;
    bridge.on('app.grantChanged', (data: AppEvents['grantChanged']) => { granted = new Set(data.granted); scope = data.scope; });
    bridge.on('app.catalogChanged', (data: AppEvents['catalogChanged']) => { granted = new Set(data.granted); });

    const answer = await ask('app.me') as AppIdentity & { granted: readonly string[] };
    const identity: AppIdentity = { packageId: answer.packageId, version: answer.version, preview: answer.preview, scope: answer.scope, publisher: answer.publisher };
    granted ??= new Set(answer.granted);

    return {
        me: () => ({ ...identity, scope: scope ?? identity.scope }),
        can: (elementId) => granted!.has(elementId),
        call: (elementId, ...rest) => {
            const [args, options] = rest as [unknown?, CallOptions?];
            return ask('app.call', { elementId, args: args ?? {}, ...(options?.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }) });
        },
        storage: {
            get: async <T>(key: string) => await ask('app.storage.get', { key }) as T | null,
            set: async (key, value) => { await ask('app.storage.set', { key, value }); },
            delete: async (key) => await ask('app.storage.delete', { key }) as boolean,
            list: async (prefix) => await ask('app.storage.list', prefix === undefined ? {} : { prefix }) as string[],
        },
        on: (event, listener) => bridge.on(`app.${event}`, listener as (data: never) => void),
    };
}
