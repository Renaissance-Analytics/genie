import type { Server, Socket } from 'node:net';
import { restrictPipeWithLauncher } from './engine-launch.js';

/*
 * THE HOST'S PIPE ANSWERS ITS OWN USER ONLY (Tynn #398). On Windows genie-host serves windows on a named pipe, which
 * Node creates with Windows' default descriptor: full control for Administrators and SYSTEM besides the user, and read
 * access for Everyone and anonymous. Node offers no way to give a pipe a descriptor of its own (no option at listen, and
 * no listening on a handle made elsewhere on Windows), and libuv creates the pipe's first instance itself, so nothing can
 * create it first with the right descriptor. So once the pipe is bound, genie-launch.exe (native/win-launcher,
 * `pipe-owner-only`, run through engine-launch.ts like every launcher call) sets a protected DACL on it: the user the host
 * runs as, and SYSTEM. The pipe's descriptor covers the instances Node creates later too. The token hello stays the
 * second gate, unchanged.
 *
 * It runs before host.json is written, so no window has the pipe's name yet. The launcher's own open is a connection to
 * the pipe; the server takes it and closes it, before the engine listens.
 */
export type PipeAclResult = { readonly ok: true; readonly sddl: string } | { readonly ok: false; readonly reason: string };

/** Sets the pipe's owner-only DACL. On a platform with no named pipe it does nothing (the socket file is chmod 0600). */
export async function restrictHostPipe(
    server: Server,
    endpoint: string,
    platform: NodeJS.Platform = process.platform,
    restrict: (endpoint: string) => Promise<string> | null = (e) => restrictPipeWithLauncher(e),
): Promise<PipeAclResult | null> {
    if (platform !== 'win32') return null;
    // The launcher's open arrives as a connection: taken and closed here, before the engine's own listener exists.
    const drop = (socket: Socket): void => { socket.on('error', () => undefined); socket.destroy(); };
    server.on('connection', drop);
    try {
        const running = restrict(endpoint);
        if (running === null) return { ok: false, reason: "genie-launch.exe was not found, so the pipe keeps Windows' default access" };
        return { ok: true, sddl: await running };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
        server.off('connection', drop);
    }
}
