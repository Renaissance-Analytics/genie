import { spawn } from 'node:child_process';
import { readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * DOES A HOST LEFT RUNNING HOLD THE WINDOW'S SOCKETS? (batch L3, 2026-11-02: after vm-smoke ended Genie's window, its
 * `--remote-debugging-port` 9222 still ACCEPTED connections and nobody answered.) The suspicion: Chromium's sockets carry no
 * close-on-exec, so genie-host — spawned by the window with Node's `spawn`, detached, outliving it on purpose — inherits
 * them. Measured here with real processes, by the socket's INODE in each process's /proc/<pid>/fd, not by a port alone:
 *
 *   POSITIVE CONTROL: the window (a Node parent given the listening socket on fd 3 without O_CLOEXEC, as Chromium's is)
 *   HOLDS it, and the port accepts, while it lives — so "not held" below is a reading, not a blind gauge.
 *   Then: the host the window spawned the product's way (`spawnHostProcess`) holds it, or not; and once the window is gone,
 *   the port is free, or not.
 *
 * MEASURED on CI (2026-11-02): window holds it, port accepts; the host holds NONE of it; port free once the window is gone.
 * So the product's spawn does not hand the window's sockets to the host, and a fd-closing step in the host (tried first, on
 * the suspicion alone) had no cause and was removed. This stays as the regression test for that, with its control.
 * Linux: POSIX fd inheritance, read from /proc.
 */

const hostPids: number[] = [];
const dirs: string[] = [];
afterEach(async () => {
    for (const pid of hostPids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function probe(port: number): Promise<'accepts' | 'refused' | 'timeout'> {
    return new Promise((done) => {
        const socket = connect({ port, host: '127.0.0.1' });
        const t = setTimeout(() => { socket.destroy(); done('timeout'); }, 3_000);
        socket.once('connect', () => { clearTimeout(t); socket.destroy(); done('accepts'); });
        socket.once('error', (e: NodeJS.ErrnoException) => { clearTimeout(t); done(e.code === 'ECONNREFUSED' ? 'refused' : 'timeout'); });
    });
}
/** Does `pid` hold the socket `inode` (`socket:[N]`) on any fd? */
function holds(pid: number, inode: string): boolean {
    try { return readdirSync(`/proc/${pid}/fd`).some((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === inode; } catch { return false; } }); } catch { return false; }
}

async function measure(hostScript: string) {
    const dir = await mkdtemp(join(tmpdir(), 'host-fds-'));
    dirs.push(dir);
    const server: Server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const fd = (server as unknown as { _handle: { fd: number } })._handle.fd;
    const inode = readlinkSync(`/proc/self/fd/${fd}`);
    expect(inode).toMatch(/^socket:\[\d+\]$/);
    const window = spawn(process.execPath, ['--import', 'tsx', resolve('test/fixtures/fd-window.ts'), resolve(hostScript), dir], { stdio: ['ignore', 'pipe', 'inherit', fd] });
    await new Promise<void>((r) => server.close(() => r()));
    const said = await new Promise<{ hostPid: number; ready: string | null }>((ok, fail) => {
        let out = '';
        window.stdout!.on('data', (c: Buffer) => { out += c.toString(); const line = out.split('\n').find((l) => l.startsWith('{')); if (line) ok(JSON.parse(line)); });
        window.once('exit', (code) => fail(new Error(`the window exited (${code}) before it said anything`)));
    });
    hostPids.push(said.hostPid);
    expect(said.ready).toBe(String(said.hostPid));
    const facts = {
        windowHolds: holds(window.pid!, inode),
        acceptsWhileWindowLives: await probe(port),
        hostHolds: holds(said.hostPid, inode),
    };
    writeFileSync(join(dir, 'go'), '');
    await new Promise<void>((r) => window.once('exit', () => r()));
    const after = { hostAlive: (() => { try { process.kill(said.hostPid, 0); return true; } catch { return false; } })(), portAfterWindow: await probe(port) };
    console.log(`[host-spawn-fds] ${hostScript}: ${JSON.stringify({ ...facts, ...after })}`);
    return { ...facts, ...after };
}

describe.skipIf(process.platform !== 'linux')('a host spawned by the window, the window gone', () => {
    it('a host that closes nothing: the window held the socket (control), and the host the product spawned holds NONE of it', async () => {
        const m = await measure('test/fixtures/fd-host-plain.ts');
        expect(m.windowHolds).toBe(true);
        expect(m.acceptsWhileWindowLives).toBe('accepts');
        expect(m.hostAlive).toBe(true);
        expect(m.hostHolds).toBe(false);
        expect(m.portAfterWindow).toBe('refused');
    }, 60_000);

});
