/**
 * Start a real ACP agent: spawn the adapter, wire its stdio to a client.
 *
 * The child is a plain `child_process` with **stdio pipes, never a pty** — a pty would
 * echo, translate CRLF and apply flow control to NDJSON, corrupting the frames in ways
 * that look like a malformed protocol rather than a wrong transport.
 *
 * Everything reachable is a PORT, because the interesting decisions here are all
 * REFUSALS and refusals are the kind that do not fail loudly when they are missing:
 *
 * - spawning a provider with no ACP mode starts something that is not an ACP server and
 *   then times out in the handshake, which reads as a hung agent;
 * - spawning on the pty host's Node 20 dies on an unsupported-engine error with nothing
 *   on screen;
 * - forwarding an API key works perfectly, while billing the wrong account.
 *
 * So each one is a named error returned to the caller rather than an exception or a
 * silent degradation.
 */

import { acpEnv, acpLaunch, ACP_MIN_NODE_MAJOR, nodeMajorOk, type AcpAuth, type HostEnv } from './agent-spec';
import { AcpClient } from './client';
import { NdjsonReader, encodeNdjson } from './ndjson';

/** The slice of a Node child process this uses. */
export interface ChildLike {
    pid?: number;
    stdout: { on: (event: 'data', cb: (chunk: Buffer | string) => void) => void };
    stderr: { on: (event: 'data', cb: (chunk: Buffer | string) => void) => void };
    stdin: { write: (data: string) => void };
    on: (event: 'exit' | 'error', cb: (...args: never[]) => void) => void;
    kill: () => void;
}

export interface SpawnPorts {
    spawn: (command: string, args: string[], env: Record<string, string>, cwd: string) => ChildLike;
    /** The runtime the child will run on — NOT necessarily this process's own. */
    nodeVersion: () => string;
    /** The Node an adapter is run WITH — never its `bin` shim, which on Windows does
     *  not exist under the bare name and which re-enters whatever `node` is on PATH. */
    nodeExec: () => string;
    /** A package's CLI entry, from its `bin` field, or null when not installed. */
    adapterScript: (pkg: string) => string | null;
    hostEnv: () => HostEnv;
    /** Stderr, line by line. An ACP child that cannot authenticate says so here and
     *  then exits; dropping it discards the only evidence of why. */
    onStderr?: (line: string) => void;
    /** A protocol-level framing problem, reported rather than thrown. */
    onFramingError?: (message: string) => void;
}

export interface StartRequest {
    provider: string;
    cwd: string;
    auth: AcpAuth['auth'];
}

export type StartResult = { client: AcpClient; pid: number | undefined; kill: () => void } | { error: string };

export function startAcpAgent(req: StartRequest, ports: SpawnPorts): StartResult {
    const resolved = acpLaunch(req.provider, {
        nodeExec: ports.nodeExec(),
        adapterScript: ports.adapterScript,
    });
    if (!resolved.ok) {
        // Two different sentences, because only one of them has a fix.
        return {
            error:
                resolved.reason === 'no-acp-mode'
                    ? `${resolved.provider} has no ACP mode, so it cannot run as a structured session. It stays on the terminal.`
                    : `${resolved.pkg} is not installed, so this provider cannot run as a structured session yet.`,
        };
    }
    const launch = resolved.launch;

    const version = ports.nodeVersion();
    if (!nodeMajorOk(version)) {
        // Named, with the version found and the floor required. "Unsupported engine"
        // from a dead child tells an operator nothing.
        return {
            error:
                `ACP needs Node ${ACP_MIN_NODE_MAJOR} or newer and this runtime reports ` +
                `${version || '(unreadable)'}. The pty host runs an older standalone Node on purpose, ` +
                `so an ACP agent must not be started on it.`,
        };
    }

    const env = acpEnv(req.provider, ports.hostEnv(), { auth: req.auth });
    const child = ports.spawn(launch.command, launch.args, env, req.cwd);

    let deliver: ((m: unknown) => void) | null = null;
    let close: ((reason: string) => void) | null = null;

    const client = new AcpClient({
        send: (message) => child.stdin.write(encodeNdjson(message)),
        onMessage: (cb) => {
            deliver = cb;
        },
        onClose: (cb) => {
            close = cb;
        },
    });

    const reader = new NdjsonReader(
        (value) => deliver?.(value),
        (message) => ports.onFramingError?.(message),
    );

    child.stdout.on('data', (chunk) => reader.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    child.stderr.on('data', (chunk) =>
        ports.onStderr?.(typeof chunk === 'string' ? chunk : chunk.toString('utf8')),
    );

    // Both paths close the client, because the alternative is every request in flight
    // hanging — and upstream a hung request is indistinguishable from an agent thinking
    // very hard, which is the failure the whole transport exists to remove.
    child.on('exit', ((code: number | null, signal: string | null) => {
        close?.(`agent exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`);
    }) as never);
    child.on('error', ((err: Error) => {
        close?.(`agent failed to start: ${err.message}`);
    }) as never);

    return { client, pid: child.pid, kill: () => child.kill() };
}
