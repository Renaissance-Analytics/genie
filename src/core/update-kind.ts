/**
 * WHAT AN UPDATE CHANGES (Tynn #413, host split P6). The release feed says which genie-host the update carries
 * (`genieHostHash` and `genieEngineProtocol` in latest*.yml, scripts/feed-host-identity.mjs). An update whose host is the
 * one running, by its hash and its protocol, never by version, changes only the window: genie-host and every agent keep
 * running through it. Anything the feed does not say, or says in a shape that is not a hash, is a full update.
 */
export interface OfferedHost {
    readonly hostHash?: string | null | undefined;
    readonly engineProtocol?: number | null | undefined;
}

export interface RunningHost {
    /** The running host's build: `<version>+<12 hex of its bundle>` (engine-launch.ts `hostBuild`). */
    readonly build: string;
    readonly protocol: number;
}

export type UpdateScope = { readonly kind: 'client-only' } | { readonly kind: 'full'; readonly why: string };

const HASH = /^[0-9a-f]{12}$/;

/** The host's hash in its build (`2.0.0-beta.61+0123456789ab`), or `null` for a build that carries none (a dev run). */
export function hostHashOf(build: string): string | null {
    const at = build.lastIndexOf('+');
    if (at < 0) return null;
    const hash = build.slice(at + 1);
    return HASH.test(hash) ? hash : null;
}

export function classifyUpdate(offered: OfferedHost, running: RunningHost | null | undefined): UpdateScope {
    const offeredHash = typeof offered.hostHash === 'string' && HASH.test(offered.hostHash) ? offered.hostHash : null;
    const offeredProtocol = typeof offered.engineProtocol === 'number' && Number.isInteger(offered.engineProtocol) ? offered.engineProtocol : null;
    if (offeredHash === null || offeredProtocol === null) return { kind: 'full', why: 'the release feed does not say which host it carries' };
    const runningHash = running ? hostHashOf(running.build) : null;
    if (!running || runningHash === null) return { kind: 'full', why: 'the running host has no hash to compare' };
    if (offeredProtocol !== running.protocol) return { kind: 'full', why: `it speaks engine protocol ${offeredProtocol}, the running host ${running.protocol}` };
    if (offeredHash !== runningHash) return { kind: 'full', why: `it carries another host (${offeredHash}, running ${runningHash})` };
    return { kind: 'client-only' };
}
