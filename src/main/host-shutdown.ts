import type { SupervisorApi } from './process-supervisor.js';

/**
 * "SHUT DOWN EVERYTHING", IN GENIE-HOST (the host split, P5a.3). The host owns the sites, the front door's Caddy, the kept
 * processes and every other supervised process, and the hosting that runs them; a window that quits stops none of it
 * (compose.ts) and asks the host to end. In this order:
 *  0. the host's clocks stop — the process scheduler and the flows engine — so no task or flow falling due starts a process
 *     after the stops below (decision 2);
 *  1. nothing more is started or synced (the hosting quiesces: no front-door restart, no hosts write, no docker watch);
 *  2. every supervised process is stopped — `stop`, so its restart policy does not bring it back;
 *  3. the hosting's own shutdown (the `.env` pass let finish, the in-app front door closed, the port record written);
 *  4. the spawn-host children end (whatever pty is still there goes with them).
 * An engine's CONTAINER is never stopped or removed here: databases and Redis outlive a quit (`--restart unless-stopped`)
 * and the next host's boot reconcile finds them running. There are no native (non-container) engines.
 */
export async function shutDownHosted(input: {
    readonly supervisor: Pick<SupervisorApi, 'list' | 'stop'>;
    readonly hosting: { quiesce(): void; shutdown(): Promise<void> } | null;
    readonly endChildren: () => Promise<void>;
    /** The host's clocks (the process scheduler, the flows engine), stopped first. */
    readonly schedulers?: ReadonlyArray<{ stop(): void }>;
    readonly log?: (line: string) => void;
}): Promise<void> {
    for (const s of input.schedulers ?? []) {
        try { s.stop(); } catch (error) { input.log?.(`a scheduler did not stop: ${error instanceof Error ? error.message : String(error)}`); }
    }
    input.hosting?.quiesce();
    const running = input.supervisor.list();
    for (const p of running) input.supervisor.stop(p.id);
    input.log?.(`stopped ${running.length} supervised process(es)`);
    await input.hosting?.shutdown().catch((error: unknown) => input.log?.(`the hosting's shutdown failed: ${error instanceof Error ? error.message : String(error)}`));
    await input.endChildren().catch(() => undefined);
}
