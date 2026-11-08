import './process-start.js';
import './close-inherited-fds.js';
// ^ FIRST but for the line above, which opens nothing (bug A, VM job 76): whatever its parent held (a window's, on the emergency path) never reaches a pty helper or a shell.
import { configureInProcessBackend, inProcessBackend, resolveDefaultShell } from '@particle-academy/fancy-term-host';
import { fancyTermPort, NO_SNAPSHOTS } from './fancy-term-port.js';
import { processChannel } from './spawn-host-protocol.js';
import { serveSpawnHost } from './spawn-host-server.js';
import { execInProcess, streamInProcess } from './spawn-exec.js';
import { execFile } from 'node:child_process';

/**
 * THE SPAWN HOST (genie#1397): the child process that creates every process Electron main used to create on its own
 * thread — `execFileRunner`'s commands (the Docker CLI first), long-lived streams (`docker events`) and the supervisor's
 * ptys (sites, queue workers, the front door). Main forks it at boot (main/spawn-host-client.ts) as Genie's own
 * executable run as Node, and talks to it over the fork's IPC channel (main/spawn-host-protocol.ts).
 *
 * Imports nothing from `electron`. It dies with Genie: a disconnect (Genie quit, or crashed) ends every pty and stream
 * it made, then the process.
 *
 * The supervisor's pty engine is fancy-term-host's in-process backend, as main's own was, minus what supervised
 * processes never used: no cwd hook (that is for interactive shells) and no snapshot store (the supervisor keeps each
 * process's log itself).
 */

// THE PROFILE (the host split, P2.1): under genie-host this entry runs twice. `terminals` hosts interactive shells, which
// report their working directory (OSC-7, the cwd resume); `processes` (the default, and #1405's only one) hosts commands,
// which never get the hook. The engine's settings are global per process, hence one child per profile.
const terminals = process.env['GENIE_SPAWN_PROFILE'] === 'terminals';
const settings = { get: (key: string) => (key === 'track_cwd' ? (terminals ? 'on' : 'off') : key === 'detached_terminals' ? 'off' : undefined) };
configureInProcessBackend({
    settings,
    snapshots: NO_SNAPSHOTS,
} as unknown as Parameters<typeof configureInProcessBackend>[0]);

const channel = processChannel(process);
const served = serveSpawnHost(channel, {
    exec: execInProcess,
    stream: streamInProcess,
    pty: fancyTermPort(inProcessBackend(), { defaultShell: () => resolveDefaultShell(settings) }),
    // genie-host's git (Tynn #532): created here, off genie-host's thread.
    gitExec: (file, args, options, callback) => execFile(file, [...args], options, callback),
});

let ending = false;
const end = (code: number) => {
    if (ending) return;
    ending = true;
    try { served.killAll(); } finally { setTimeout(() => process.exit(code), 100); }
};
channel.onClose(() => end(0));
channel.onFrame((frame) => {
    // `host.shutdown` was answered by the server (after it killed everything); the process follows.
    if (frame.kind === 'call' && frame.method === 'host.shutdown') end(0);
});
process.on('uncaughtException', (error) => {
    console.error(`[spawn-host] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
