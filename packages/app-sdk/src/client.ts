/**
 * The typed client a Genie App calls Genie through (Tynn #250).
 *
 * The SDK is the second half of the security model. The bridge decides what is
 * ALLOWED; the SDK decides what a developer — or the agent writing the app — finds
 * NATURAL. A client that made "ask for everything and handle the failure" the path
 * of least resistance would undo the consent screen one convenience method at a
 * time.
 *
 * So it is shaped around three things:
 *
 *   - `can()` — know what you were granted, and hide what you were not. Offering a
 *     control that always fails teaches the user the app is broken rather than
 *     that it is restricted.
 *   - `GenieCallError` — carry the refusal's own words. Genie writes refusals for
 *     a person ("not granted Host sites and services"); an SDK that replaced that
 *     with a status code would throw the useful half away.
 *   - `NotInsideGenieError` — fail loudly outside Genie instead of pretending. A
 *     developer's `npm run dev` in a normal browser hits this, and "cannot read
 *     properties of undefined" would send them hunting through their own code.
 */

import type { GenieAppCapability, GenieAppHost, GenieAppIdentity } from './types';

export class NotInsideGenieError extends Error {
    constructor() {
        super(
            'This page is not running in a Genie App window, so Genie is not available. ' +
                'Install the app in Genie (or open it from the Apps rail) and it will be.',
        );
        this.name = 'NotInsideGenieError';
    }
}

/** A call Genie refused, or that failed inside the tool. Carries WHY, for display. */
export class GenieCallError extends Error {
    readonly tool: string;
    constructor(tool: string, reason: string) {
        super(reason);
        this.name = 'GenieCallError';
        this.tool = tool;
    }
}

export interface GenieClientOptions {
    /**
     * Throw immediately when Genie is absent (the default). Set false for a UI
     * that wants to render a degraded state instead of a blank page.
     */
    strict?: boolean;
}

export interface GenieClient {
    /** False when Genie is not there — only reachable with `strict: false`. */
    readonly available: boolean;
    /** Who this app is and what it was GRANTED. Null if Genie disowns the window. */
    me(): Promise<GenieAppIdentity | null>;
    /** Was this capability granted? Ask before you offer the feature. */
    can(capability: GenieAppCapability | string): Promise<boolean>;
    /** Call a Genie tool. Throws {@link GenieCallError} with the reason on refusal. */
    call<T = unknown>(
        tool: string,
        args?: Record<string, unknown>,
        opts?: { workspaceId?: string },
    ): Promise<T>;
}

export function createGenieClient(
    host: GenieAppHost | undefined,
    options: GenieClientOptions = {},
): GenieClient {
    const strict = options.strict !== false;
    if (!host && strict) throw new NotInsideGenieError();

    // Permissions do not change mid-session without the app being restarted, so
    // this is resolved once. A `can()` behind every render would otherwise be an
    // IPC round trip per frame.
    let identity: Promise<GenieAppIdentity | null> | null = null;

    const me = () => {
        if (!host) throw new NotInsideGenieError();
        identity ??= host.me();
        return identity;
    };

    return {
        available: Boolean(host),
        me,
        async can(capability) {
            if (!host) return false;
            const who = await me();
            return who?.capabilities.includes(capability) ?? false;
        },
        async call<T>(tool: string, args?: Record<string, unknown>, opts?: { workspaceId?: string }) {
            if (!host) throw new NotInsideGenieError();
            const outcome = await host.call(tool, args, opts?.workspaceId);
            if (!outcome?.ok) {
                throw new GenieCallError(
                    tool,
                    outcome?.error ?? 'Genie did not answer this call.',
                );
            }
            return outcome.result as T;
        },
    };
}

/** True when this page is running inside a Genie App window. */
export function isInsideGenie(): boolean {
    return typeof globalThis !== 'undefined' && Boolean((globalThis as Record<string, unknown>).genieApp);
}

/**
 * The client for the window this page is in.
 *
 * The one-liner an app starts with: `const genie = useGenie()`.
 */
export function useGenie(options?: GenieClientOptions): GenieClient {
    const host = (globalThis as { genieApp?: GenieAppHost }).genieApp;
    return createGenieClient(host, options);
}
