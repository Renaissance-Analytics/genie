import nodePath from 'node:path';

/**
 * WHO MAY NAME A PATH ON THIS HOST (genie#1354, after genie#1347).
 *
 * The person's AgentInbox attachments are named as host paths and read at send time. That is right for the person AT
 * the host, picking in the host's own file picker. The same feature action can be driven by a client that is NOT at the
 * host — a paired device, a relay connection, a share guest, the mobile web app — through the remote API's
 * `features.act`. Such a client attaches only BYTES it uploads (`inbox.sendFile`, main/uploads.ts), never a host path.
 * Genie 1 (v0.7.0-beta.342) worked that way: the person's files travelled as inline bytes — main/agentinbox/human.ts
 * `postAsHuman` → main/agentinbox/attachments.ts `storeInlineAttachments`, read by the browser's own file input in
 * renderer/components/Master/AgentInboxFlyout.tsx `readFileAsBase64`.
 *
 * WHERE a request came from decides, never what it says: main's own IPC handler builds a local origin only for a sender
 * that is not one of the remote windows (main.ts `isRemoteWindow`), and every other caller — the remote API included —
 * gets the default, {@link REMOTE_ORIGIN}. Nothing in the action can change that: the origin is a separate argument the
 * request never reaches.
 *
 * Locally, a path is attached only when the host's own picker picked it: the window reports its picks to main
 * (`FEATURE_CHANNELS.picked`, again only from a window that is not remote) and main keeps them here.
 */

/** The paths the host's own picker picked, by resolved absolute path; the oldest fall out past `limit`. */
export class HostPicks {
    readonly #paths = new Set<string>();

    constructor(readonly limit = 500) {}

    record(paths: readonly unknown[]): void {
        for (const p of paths) {
            if (typeof p !== 'string' || p === '' || !nodePath.isAbsolute(p)) continue;
            const key = nodePath.resolve(p);
            // Re-picking refreshes it: delete then add moves it to the newest end.
            this.#paths.delete(key);
            this.#paths.add(key);
        }
        while (this.#paths.size > this.limit) {
            const oldest = this.#paths.values().next().value as string;
            this.#paths.delete(oldest);
        }
    }

    has(path: string): boolean {
        if (typeof path !== 'string' || path === '' || !nodePath.isAbsolute(path)) return false;
        return this.#paths.has(nodePath.resolve(path));
    }
}

export type FeatureOrigin = { readonly kind: 'remote' } | { readonly kind: 'local'; readonly picks: HostPicks };

/** Every caller that is not main's own IPC from a non-remote window. The default. */
export const REMOTE_ORIGIN: FeatureOrigin = Object.freeze({ kind: 'remote' as const });

/** The origin main's own IPC hands on: local only for a window that is not a remote window. */
export function featureOrigin(input: { remoteWindow: boolean; picks: HostPicks }): FeatureOrigin {
    return input.remoteWindow ? REMOTE_ORIGIN : Object.freeze({ kind: 'local' as const, picks: input.picks });
}

/** Why these host paths may not be attached from `origin` — or `null` when every one may. Nothing is read here. */
export function hostPathRefusal(origin: FeatureOrigin, paths: readonly string[]): string | null {
    if (paths.length === 0) return null;
    if (origin.kind !== 'local') {
        return 'a file on this computer can be attached only from its own window; attach a file from your device instead (it is uploaded), and nothing was sent';
    }
    for (const p of paths) {
        if (!origin.picks.has(p)) return `${p} was not picked in this window's file picker; pick it there to attach it, and nothing was sent`;
    }
    return null;
}
