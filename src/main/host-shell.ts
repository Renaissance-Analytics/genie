/**
 * OPEN WITH THE HOST'S APP, SHOW IN ITS FILE MANAGER — FOR A CLIENT ON ANOTHER MACHINE (Tynn #841; #912 2f-1, the
 * coordinator's ruling of 2026-11-19). This machine's own window keeps the OS shell (genie:files-open-external /
 * genie:files-reveal, window:os-shell). A client on another machine asks the host (`files.openExternal` / `files.reveal`):
 * the host confines the path to the workspace, then a Genie window on ITS machine opens the file, or shows it, on the host's
 * own screen — the window-local operation genie-host asks for, like the trash (window-tunnel.ts). With no window open there
 * the person is told so; nothing is opened anywhere else.
 */
export type HostShellAnswer = { ok: true } | { ok: false; reason: string };
export interface HostShell {
    open(workspaceId: string, path: string): Promise<HostShellAnswer>;
    reveal(workspaceId: string, path: string): Promise<HostShellAnswer>;
}

const OUTSIDE = 'that file is not in this workspace';
/** What SessionEngineServer.windowOp says when no window is open on this machine. */
const NO_WINDOW = 'no Genie window is open on this machine';

export function hostShellFor(ports: { absolute(workspaceId: string, path: string): string | null; windowOp(op: string, args: unknown[]): Promise<unknown>; hostName(): string }): HostShell {
    const ask = async (op: 'shell.open' | 'shell.reveal', workspaceId: string, path: string): Promise<HostShellAnswer> => {
        const abs = ports.absolute(workspaceId, path);
        if (!abs) return { ok: false, reason: OUTSIDE };
        try {
            const answer = await ports.windowOp(op, [abs]);
            // The OS's own words when it could not open it (Electron's shell.openPath answers them; '' = opened).
            return typeof answer === 'string' && answer !== '' ? { ok: false, reason: answer } : { ok: true };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { ok: false, reason: reason === NO_WINDOW ? `${ports.hostName()} has no Genie window open to show it on` : reason };
        }
    };
    return {
        open: (workspaceId, path) => ask('shell.open', workspaceId, path),
        reveal: (workspaceId, path) => ask('shell.reveal', workspaceId, path),
    };
}
