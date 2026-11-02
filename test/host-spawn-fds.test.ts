import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A HOST LEFT RUNNING MUST NOT HOLD THE WINDOW'S SOCKETS (batch L3, 2026-11-02: after vm-smoke ended Genie's window, its
 * `--remote-debugging-port` 9222 still ACCEPTED connections and nobody answered them — the next launch's debugger port was
 * taken by a dead window).
 *
 * The cause, measured here with real processes: Chromium creates its sockets WITHOUT close-on-exec (its own launcher closes
 * unmapped fds; Node's `spawn` closes nothing), so genie-host — spawned by the window, detached, outliving it on purpose —
 * inherits every one of them, and so does everything the host spawns after. The window here is a Node parent given a
 * listening socket on fd 3 without O_CLOEXEC, exactly that situation, spawning the host through the product's own
 * `spawnHostProcess`. Then the window exits.
 *
 *   - CONTROL: a host that closes nothing keeps the port ACCEPTING (the leak, reproduced; the gauge can read "held").
 *   - THE FIX: a host whose first module is `close-inherited-fds` (genie-host.ts's) leaves the port REFUSING.
 *
 * Linux: the leak is POSIX fd inheritance through exec; the fix reads /proc. (Windows handle inheritance is its own
 * question, for the Windows proof.)
 */

const hostPids: number[] = [];
const dirs: string[] = [];
afterEach(async () => {
    for (const pid of hostPids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Does anything accept on the port? `accepts` / `refused`, bounded. */
function probe(port: number): Promise<'accepts' | 'refused' | 'timeout'> {
    return new Promise((done) => {
        const socket = connect({ port, host: '127.0.0.1' });
        const t = setTimeout(() => { socket.destroy(); done('timeout'); }, 3_000);
        socket.once('connect', () => { clearTimeout(t); socket.destroy(); done('accepts'); });
        socket.once('error', (e: NodeJS.ErrnoException) => { clearTimeout(t); done(e.code === 'ECONNREFUSED' ? 'refused' : 'timeout'); });
    });
}

/** A window holding a listening socket (no close-on-exec) spawns `hostScript` the product's way, then exits. */
async function windowSpawnsHostThenExits(hostScript: string) {
    const dir = await mkdtemp(join(tmpdir(), 'host-fds-'));
    dirs.push(dir);
    const server: Server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const fd = (server as unknown as { _handle: { fd: number } })._handle.fd;
    expect(fd).toBeGreaterThan(2);
    const window = spawn(process.execPath, ['--import', 'tsx', resolve('test/fixtures/fd-window.ts'), resolve(hostScript), dir], { stdio: ['ignore', 'pipe', 'inherit', fd] });
    // Only the window (fd 3, and then whatever it spawned) holds the socket from here.
    await new Promise<void>((r) => server.close(() => r()));
    let out = '';
    window.stdout!.on('data', (c: Buffer) => { out += c.toString(); });
    const code = await new Promise<number | null>((r) => window.once('exit', (c) => r(c)));
    expect(code).toBe(0);
    const said = JSON.parse(out.trim().split('\n').at(-1)!) as { hostPid: number | null; ready: string | null };
    expect(said.hostPid).toBeGreaterThan(0);
    hostPids.push(said.hostPid!);
    // The host ran its first module and is alive; the window is gone.
    expect(said.ready).toBe(String(said.hostPid));
    expect(() => process.kill(said.hostPid!, 0)).not.toThrow();
    return { port, hostPid: said.hostPid! };
}

describe.skipIf(process.platform !== 'linux')('a host spawned by the window, the window gone', () => {
    it('CONTROL: a host that closes nothing keeps the window’s listening socket — the port still ACCEPTS', async () => {
        const { port } = await windowSpawnsHostThenExits('test/fixtures/fd-host-plain.ts');
        expect(await probe(port)).toBe('accepts');
    }, 60_000);

    it('a host whose first module is close-inherited-fds holds none of it — the port REFUSES', async () => {
        const { port } = await windowSpawnsHostThenExits('test/fixtures/fd-host-closing.ts');
        expect(await probe(port)).toBe('refused');
    }, 60_000);
});
