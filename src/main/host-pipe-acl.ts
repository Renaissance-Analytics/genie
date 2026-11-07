import { execFile } from 'node:child_process';
import type { Server, Socket } from 'node:net';
import { winLauncherPath } from './win-launcher.js';

/*
 * THE HOST'S PIPE ANSWERS ITS OWN USER ONLY (Tynn #398). On Windows genie-host serves windows on a named pipe, which
 * Node creates with Windows' default descriptor: full control for Administrators and SYSTEM besides the user, and read
 * access for Everyone and anonymous. Node offers no way to give a pipe a descriptor of its own, so once the pipe is
 * bound genie-launch.exe (native/win-launcher, `pipe-owner-only`) sets a protected DACL on it: the user the host runs
 * as, and SYSTEM. The pipe's descriptor covers the instances Node creates later too. The token hello stays the second
 * gate, unchanged.
 *
 * It runs before host.json is written, so no window has the pipe's name yet. The launcher's own open is a connection to
 * the pipe; the server takes it and closes it, before the engine listens.
 */
export type PipeAclResult = { readonly ok: true; readonly sddl: string } | { readonly ok: false; readonly reason: string };

export interface PipeAclPorts {
    readonly launcher: () => string | null;
    readonly run: (file: string, args: readonly string[]) => Promise<string>;
}

const realPorts: PipeAclPorts = {
    launcher: () => winLauncherPath(),
    run: (file, args) => new Promise((done, fail) => {
        execFile(file, [...args], { encoding: 'utf8', timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
            if (error) fail(new Error(String(stderr).trim() || error.message));
            else done(String(stdout));
        });
    }),
};

/** Sets the pipe's owner-only DACL. On a platform with no named pipe it does nothing (the socket file is chmod 0600). */
export async function restrictHostPipe(server: Server, endpoint: string, platform: NodeJS.Platform = process.platform, ports: PipeAclPorts = realPorts): Promise<PipeAclResult | null> {
    if (platform !== 'win32') return null;
    const launcher = ports.launcher();
    if (launcher === null) return { ok: false, reason: "genie-launch.exe was not found, so the pipe keeps Windows' default access" };
    // The launcher's open arrives as a connection: taken and closed here, before the engine's own listener exists.
    const drop = (socket: Socket): void => { socket.on('error', () => undefined); socket.destroy(); };
    server.on('connection', drop);
    try {
        const out = await ports.run(launcher, ['pipe-owner-only', endpoint]);
        return { ok: true, sddl: out.trim() };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
        server.off('connection', drop);
    }
}
