import type { HostedSiteRow } from './manager';
import type { HostedStatus } from './types';

/**
 * Restarting a workspace's hosted sites after its SERVICES changed (#232).
 *
 * The seam between the two halves of "hosted", and the one place they have to
 * know about each other. A hosted site is handed its database credentials as
 * ENVIRONMENT (see `services/env.ts` for why that path, and not the file, is the
 * authoritative one) — and a process reads its environment exactly once, when it
 * starts. So a site that was already up when the user enabled Postgres is
 * serving an app with no `DB_*` at all, and the symptom is a 500 on the first
 * query with nothing on screen tying it to the switch they just flipped.
 *
 * Deliberately NOT inside either manager. The site manager depends on the
 * service manager through one injected function and the service manager knows
 * nothing about sites at all, which is what keeps both testable without the
 * other; making services reach back into hosting would close that loop. This is
 * the caller's job, so it lives beside the callers (`ipc.ts`) as a function that
 * takes the manager it drives.
 */

/** The slice of `HostingManager` a restart needs. */
export interface RestartableHosting {
    list(workspaceId?: string): HostedSiteRow[];
    stop(siteId: string): Promise<void>;
    start(workspaceId: string, hostname: string): Promise<HostedStatus>;
}

/**
 * Restart every RUNNING site in one workspace, and report how many came back.
 *
 * Only the running ones: a site the user stopped, or one whose build is broken,
 * must not be silently started by a change to a database — that would be this
 * function deciding to serve something nobody asked it to serve.
 *
 * A site that fails to come back is not allowed to strand the others, so each is
 * attempted independently; the failure is already recorded as that site's status
 * by the manager, which is where the Site Manager reads it from.
 */
export async function restartSitesForWorkspace(
    hosting: RestartableHosting | null | undefined,
    workspaceId: string,
): Promise<number> {
    if (!hosting) return 0;
    const running = hosting.list(workspaceId).filter((site) => site.state === 'running');
    let restarted = 0;
    for (const site of running) {
        try {
            await hosting.stop(site.siteId);
            const status = await hosting.start(workspaceId, site.hostname);
            if (status.state === 'running') restarted += 1;
        } catch {
            // Swallowed on purpose: the manager keeps the reason as this site's
            // last failure, and the next site still deserves its restart.
        }
    }
    return restarted;
}
