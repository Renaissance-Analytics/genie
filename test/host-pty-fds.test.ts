import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseHostRecord } from '../src/core/engine-protocol.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { connectSocket } from '../src/main/engine-launch.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';

/**
 * A TERMINAL'S PROCESSES HOLD NONE OF THE WINDOW'S SOCKETS, AND DIE WITH THEIR OWNER (batch L4, 2026-11-02).
 *
 * After vm-smoke ended Genie, port 9222 still accepted and nobody answered. `ss` named the holders: a fancy-pty-helper and
 * its `bash -l`, re-parented to init, BOTH holding Chromium's DevTools listening socket as fd 65. Two bugs:
 *   A. the window's socket crossed into a terminal's helper and shell;
 *   B. that helper and shell outlived the Genie that owned them.
 *
 * Measured here on the PRODUCT'S chain and runtime, with real processes: a window-like parent on ELECTRON'S binary as Node,
 * holding a listening socket on fd 3 without O_CLOEXEC (Chromium's situation), starts the REAL genie-host the product's way
 * (`spawnHostProcess`); a window client opens a REAL terminal in it (the host's `terminals` spawn host → fancy-term-host →
 * fancy-pty's helper → the shell). Every process holding the socket is found by its inode in /proc/<pid>/fd — all of them,
 * not only the expected ones.
 *
 *   POSITIVE CONTROLS: the window holds the socket; the terminal's shell is alive and its parent is the fancy-pty helper.
 *   A: no process but the window holds it.
 *   B: once the host is gone — SIGKILLed (a crashed Genie), or shut down (`engine.shutdown`, a quit) — the helper and the
 *      shell are gone too: the spawn host ends every pty it made when its host goes (src/main/spawn-host.ts).
 *
 * Linux: POSIX fd inheritance and /proc. Runs in CI and the test VMs (spawns processes), never on the owner's desktop.
 */

const electron = createRequire(import.meta.url)('electron') as unknown as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Never pid ≤ 0: kill(0) addresses THIS process group — a first version's cleanup SIGKILLed the vitest worker that way.
function alive(pid: number): boolean { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function cmdline(pid: number): string { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch { return ''; } }
function ppid(pid: number): number { try { return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[1]); } catch { return 0; } }
function children(pid: number): number[] {
    return readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number).filter((p) => ppid(p) === pid);
}
/** Every process holding the socket `inode` (`socket:[N]`), with its command line. */
function holders(inode: string): Array<{ pid: number; ppid: number; cmd: string }> {
    const out: Array<{ pid: number; ppid: number; cmd: string }> = [];
    for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        let fds: string[] = [];
        try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
        if (fds.some((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === inode; } catch { return false; } })) out.push({ pid, ppid: ppid(pid), cmd: cmdline(pid).slice(0, 160) });
    }
    return out;
}
function probe(port: number): Promise<'accepts' | 'refused' | 'timeout'> {
    return new Promise((done) => {
        const s = connect({ port, host: '127.0.0.1' });
        const t = setTimeout(() => { s.destroy(); done('timeout'); }, 3_000);
        s.once('connect', () => { clearTimeout(t); s.destroy(); done('accepts'); });
        s.once('error', (e: NodeJS.ErrnoException) => { clearTimeout(t); done(e.code === 'ECONNREFUSED' ? 'refused' : 'timeout'); });
    });
}
/** `p`, or a rejection naming what missed its deadline — with what the window and the host said. */
function within<T>(ms: number, what: string, p: Promise<T>, said: () => string): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`deadline: ${what} (${ms / 1000} s)\n${said()}`)), ms); })]).finally(() => clearTimeout(t));
}
async function until<T>(what: string, fn: () => T | null | undefined | false, ms: number): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v as T;
        if (Date.now() > end) throw new Error(`timed out: ${what}`);
        await sleep(200);
    }
}

interface Rig {
    home: string;
    port: number;
    inode: string;
    window: ChildProcess;
    hostPid: number;
    client: SessionEngineClient;
    transport: ClientTransport;
    shellPid: number;
    helperPid: number;
    spawnHosts: number[];
}
const rigs: Rig[] = [];
const homes: string[] = [];
/**
 * Every process of this run carries this in its environment (the window's env travels to the host, its spawn hosts and the
 * terminal's helper). Twice a first version left orphans holding the CI runner's pipes, and the unit job ran to its
 * 15-minute limit with no log: whatever a test leaves, the run ends here — and what had to be ended is printed (it is
 * evidence for B in its own right).
 */
const RUN = `host-pty-fds-${process.pid}-${Date.now()}`;
function processesOfThisRun(): Array<{ pid: number; cmd: string }> {
    const out: Array<{ pid: number; cmd: string }> = [];
    for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
        try { if (readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(`HOST_PTY_FDS_RUN=${RUN}`)) out.push({ pid: Number(name), cmd: cmdline(Number(name)).slice(0, 120) }); } catch { /* gone, or not ours */ }
    }
    return out;
}
afterAll(async () => {
    if (process.platform !== 'linux') return;
    for (const r of rigs) { try { writeFileSync(join(r.home, 'go'), ''); } catch { /* gone */ } }
    await sleep(500);
    const left = processesOfThisRun();
    console.log(`[host-pty-fds] afterAll: ${left.length} process(es) of this run still alive: ${JSON.stringify(left)}`);
    for (const p of left) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const home of homes) await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A window on Electron's runtime holding a listening socket starts the real host; a client opens a real terminal in it. */
async function rig(): Promise<Rig> {
    const home = await mkdtemp(join(tmpdir(), 'host-pty-fds-'));
    homes.push(home);
    const server: Server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const fd = (server as unknown as { _handle: { fd: number } })._handle.fd;
    const inode = readlinkSync(`/proc/self/fd/${fd}`);
    let log = '';
    const window = spawn(electron, ['--import', 'tsx', resolve('test/fixtures/pty-window.ts'), home], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GENIE_SPAWN_HOST_ENTRY: resolve('src/main/spawn-host.ts'), GENIE_HOST_IDLE_MS: '600000', HOST_PTY_FDS_RUN: RUN },
        stdio: ['ignore', 'pipe', 'pipe', fd],
    });
    window.stderr!.on('data', (c: Buffer) => { log += c.toString(); });
    // From here only the window (and whatever took it from the window) holds the socket.
    await new Promise<void>((r) => server.close(() => r()));
    // Every wait bounded, and every miss says what the window and the host said (a first run with none ran the unit job
    // into its 15-minute limit, and a cancelled job keeps no log).
    const tell = () => `--- window stderr ---\n${log.slice(-2000)}\n--- host log ---\n${readHostLog(home)}`;
    const said = await within(75_000, 'the window starting the host', new Promise<{ hostPid: number; hostRecord: string | null }>((ok, fail) => {
        let out = '';
        window.stdout!.on('data', (c: Buffer) => { out += c.toString(); const line = out.split('\n').find((l) => l.startsWith('{')); if (line) ok(JSON.parse(line)); });
        window.once('exit', (code) => fail(new Error(`the window exited (${code}) before the host was up\n${tell()}`)));
    }), tell);
    const record = parseHostRecord(said.hostRecord);
    if (!record) throw new Error(`no host record\n${tell()}`);
    const token = readFileSync(join(home, 'runtime', 'host.token'), 'utf8').trim();
    const transport = await within(10_000, 'the socket to the host', connectSocket(record.endpoint), tell);
    const client = new SessionEngineClient();
    expect(await within(15_000, 'the client connecting to the host', client.connect(transport, token), tell)).toMatchObject({ ok: true });
    const opened = await within(30_000, 'a terminal opening in the host', client.terminals().openReady({ workspaceId: 'ws', cwd: home }), tell);
    // The helper and its shell, found in the process table by this run's marker — not by the pid the open reported (CI
    // measured it 0 on this path). The tree is printed, so a run that finds no helper still says what it did find.
    const helperPid = await until('the terminal\'s fancy-pty helper', () => processesOfThisRun().find((p) => /fancy-pty-helper/.test(p.cmd))?.pid ?? null, 15_000)
        .catch((e: unknown) => { throw new Error(`${String(e)}\nopened ${JSON.stringify(opened)}\nthis run: ${JSON.stringify(processesOfThisRun().map((p) => ({ ...p, ppid: ppid(p.pid) })))}\n${tell()}`); });
    const shellPid = await until('the shell under the helper', () => children(helperPid)[0] ?? null, 15_000);
    const spawnHosts = children(record.pid).filter((p) => /spawn-host/.test(cmdline(p)));
    console.log(`[host-pty-fds] the run's processes: ${JSON.stringify(processesOfThisRun().map((p) => ({ ...p, ppid: ppid(p.pid) })))}; opened reported pid ${opened.pid}; shell ${shellPid}: ${cmdline(shellPid).slice(0, 80)}`);
    const r: Rig = { home, port, inode, window, hostPid: record.pid, client, transport, shellPid, helperPid, spawnHosts };
    rigs.push(r);
    return r;
}
function readHostLog(home: string): string {
    const f = join(home, 'logs', 'genie-host.log');
    return existsSync(f) ? readFileSync(f, 'utf8').slice(-3000) : '(no host log)';
}

describe.skipIf(process.platform !== 'linux')('a terminal in genie-host, started from a window on Electron', () => {
    let r: Rig;

    it('A: no process the window started holds its listening socket — not the host, a spawn host, the pty helper or the shell', async () => {
        r = await rig();
        // POSITIVE CONTROLS: the window holds the socket (and it accepts); a real shell runs under a real fancy-pty helper.
        expect(holders(r.inode).map((h) => h.pid)).toContain(r.window.pid);
        expect(await probe(r.port)).toBe('accepts');
        expect(alive(r.shellPid)).toBe(true);
        expect(cmdline(r.helperPid)).toMatch(/fancy-pty-helper/);
        const others = holders(r.inode).filter((h) => h.pid !== r.window.pid);
        console.log(`[host-pty-fds] A: window ${r.window.pid}, host ${r.hostPid}, spawn hosts ${JSON.stringify(r.spawnHosts)}, helper ${r.helperPid}, shell ${r.shellPid}; other holders ${JSON.stringify(others)}`);
        expect(others).toEqual([]);
    }, 150_000);

    it('B: the host SIGKILLed (a crashed Genie): the helper and the shell it owned are gone too, and nothing holds the port', async () => {
        expect(r).toBeDefined();
        r.transport.close();
        writeFileSync(join(r.home, 'go'), '');
        await new Promise<void>((done) => { if (r.window.exitCode !== null) done(); else r.window.once('exit', () => done()); });
        // Control: the host and its terminal are alive with the window gone (that is the host split's point).
        expect(alive(r.hostPid)).toBe(true);
        expect(alive(r.helperPid) && alive(r.shellPid)).toBe(true);
        process.kill(r.hostPid, 'SIGKILL');
        const gone = await until('the terminal to go with its host', () => (!alive(r.helperPid) && !alive(r.shellPid) ? true : null), 10_000).catch(() => false);
        const left = { helper: alive(r.helperPid) ? { pid: r.helperPid, ppid: ppid(r.helperPid) } : null, shell: alive(r.shellPid) ? { pid: r.shellPid, ppid: ppid(r.shellPid) } : null, spawnHosts: r.spawnHosts.filter(alive), port: await probe(r.port) };
        console.log(`[host-pty-fds] B (SIGKILL): ${JSON.stringify(left)}`);
        expect(gone).toBe(true);
        expect(left.port).toBe('refused');
    }, 60_000);

    it('B: the host SHUT DOWN (engine.shutdown, a quit): the helper and the shell are gone too', async () => {
        const g = await rig();
        expect(alive(g.helperPid) && alive(g.shellPid)).toBe(true);
        await within(15_000, "engine.shutdown", g.client.shutdown(), () => readHostLog(g.home));
        g.transport.close();
        writeFileSync(join(g.home, 'go'), '');
        const hostGone = await until('the host to exit', () => (!alive(g.hostPid) ? true : null), 30_000).catch(() => false);
        const gone = await until('the terminal to go with its host', () => (!alive(g.helperPid) && !alive(g.shellPid) ? true : null), 10_000).catch(() => false);
        console.log(`[host-pty-fds] B (shutdown): host gone ${hostGone}; helper ${alive(g.helperPid) ? `alive (ppid ${ppid(g.helperPid)})` : 'gone'}, shell ${alive(g.shellPid) ? `alive (ppid ${ppid(g.shellPid)})` : 'gone'}`);
        expect(hostGone).toBe(true);
        expect(gone).toBe(true);
    }, 150_000);
});
