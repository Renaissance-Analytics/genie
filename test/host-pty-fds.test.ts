import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseHostRecord } from '../src/core/engine-protocol.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { connectSocket } from '../src/main/engine-launch.js';
import { procStart, readPtyLedger, writePtyLedger } from '../src/main/pty-ledger.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';

/**
 * A TERMINAL'S PROCESSES HOLD NONE OF THE WINDOW'S SOCKETS, AND DIE WITH THEIR OWNER (batch L4; VM job 76 confirmed both).
 *
 * On omarchy-test the window (Electron) held its DevTools listener :9222 as fd 65 without close-on-exec, and so did the
 * genie-host it spawned, all three spawn hosts, the fancy-pty helper and its `bash -l` (bug A). With the host AND its spawn
 * hosts SIGKILLed (vm-smoke's `pkill` of Electron's binary hits both), the helper and the shell lived on under init, still
 * holding :9222 (bug B) — fancy-pty's helper does not end its shell when its control stream closes.
 *
 * A Node-mode window cannot stand in for Electron's (CI: its host held nothing), so this starts where the VM showed the
 * leak already present: the REAL genie-host, on ELECTRON'S binary as Node, started holding an inherited listening socket
 * on fd 3 without O_CLOEXEC. A window client opens a REAL terminal in it (the `terminals` spawn host → fancy-term-host →
 * fancy-pty's helper → the shell). Every holder of the socket is found by its inode in /proc.
 *
 *   A: once the terminal runs, NOTHING holds the socket — the host closed it at startup (its log names it: the positive
 *      control that it arrived), so neither the spawn hosts, the helper nor the shell got it.
 *   B: the host and its spawn hosts SIGKILLed together: whatever the helper and shell do, the NEXT host reaps them
 *      (runtime/ptys.json); and a host shut down (`engine.shutdown`) takes its terminal with it.
 *
 * Linux: POSIX fd inheritance and /proc. Runs in CI and the test VMs (spawns processes), never on the owner's desktop.
 */

const electron = createRequire(import.meta.url)('electron') as unknown as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Never pid ≤ 0: kill(0) addresses THIS process group (a first version's cleanup SIGKILLed the vitest worker that way).
function alive(pid: number): boolean { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function cmdline(pid: number): string { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch { return ''; } }
function ppid(pid: number): number { try { return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[1]); } catch { return 0; } }
const pids = () => readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
function children(pid: number): number[] { return pids().filter((p) => ppid(p) === pid); }
function descendants(root: number): number[] {
    const all = pids();
    const below: number[] = [];
    let frontier = [root];
    while (frontier.length) { const next = all.filter((p) => frontier.includes(ppid(p))); below.push(...next); frontier = next; }
    return below;
}
/** Every process holding the socket `inode` (`socket:[N]`). */
function holders(inode: string): Array<{ pid: number; ppid: number; cmd: string }> {
    const out: Array<{ pid: number; ppid: number; cmd: string }> = [];
    for (const pid of pids()) {
        let fds: string[] = [];
        try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
        if (fds.some((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === inode; } catch { return false; } })) out.push({ pid, ppid: ppid(pid), cmd: cmdline(pid).slice(0, 120) });
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

const homes: string[] = [];
/**
 * This run's processes, whatever a test left: those carrying the marker, and those working in one of its homes (a
 * terminal's shell has an environment of its own; an orphan re-parented to init is still found by its cwd). Ended in
 * afterAll, and printed — what had to be ended is evidence in its own right.
 */
const RUN = `host-pty-fds-${process.pid}-${Date.now()}`;
function processesOfThisRun(): Array<{ pid: number; cmd: string }> {
    const out: Array<{ pid: number; cmd: string }> = [];
    for (const pid of pids()) {
        if (pid === process.pid) continue;
        let ours = false;
        try { ours = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOST_PTY_FDS_RUN=${RUN}`); } catch { /* not ours */ }
        if (!ours) { try { const cwd = readlinkSync(`/proc/${pid}/cwd`); ours = homes.some((h) => cwd === h || cwd.startsWith(`${h}/`)); } catch { /* gone */ } }
        if (ours) out.push({ pid, cmd: cmdline(pid).slice(0, 120) });
    }
    return out;
}
afterAll(async () => {
    if (process.platform !== 'linux') return;
    const left = processesOfThisRun();
    console.log(`[host-pty-fds] afterAll: ${left.length} process(es) of this run still alive: ${JSON.stringify(left)}`);
    for (const p of left) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const home of homes) await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The real genie-host on Electron's runtime, given `fd` (if any) on fd 3; its log captured. */
function startHost(home: string, fd: number | null): { child: ChildProcess; log: () => string } {
    let log = '';
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', GENIE_HOME: home, GENIE_HOST_BUILD: 'pty-fds-test', GENIE_SPAWN_HOST_ENTRY: resolve('src/main/spawn-host.ts'), GENIE_HOST_IDLE_MS: '600000', HOST_PTY_FDS_RUN: RUN };
    const argv = ['--import', 'tsx', resolve('src/main/genie-host.ts')];
    /*
     * The socket arrives the way the VM showed the window's do: a PLAIN inherited fd, no close-on-exec (VM job 76: the host
     * held fds 41–69 with cloexec=no). Handed straight over as stdio[3], libuv's stdio mapping left it flagged
     * close-on-exec in the host (CI measured flags 02004002) — a shape the product never produces (it spawns the host with
     * stdio 0–2 only). So a shell takes it on fd 3, moves it to fd 7 (a shell's dup never sets close-on-exec), closes 3,
     * and execs the host in its own place (same pid): the host inherits fd 7 exactly as genie-host inherits the window's.
     */
    const child = fd === null
        ? spawn(electron, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('/bin/sh', ['-c', 'exec 7<&3 3<&-; exec "$0" "$@"', electron, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe', fd] });
    child.stdout!.on('data', (c: Buffer) => { log += c.toString(); });
    child.stderr!.on('data', (c: Buffer) => { log += c.toString(); });
    return { child, log: () => log };
}

interface Rig { home: string; port: number; inode: string; host: ChildProcess; hostLog: () => string; client: SessionEngineClient; transport: ClientTransport; helperPid: number; shellPid: number; spawnHosts: number[] }

async function rig(): Promise<Rig> {
    const home = await mkdtemp(join(tmpdir(), 'host-pty-fds-'));
    homes.push(home);
    const server: Server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const fd = (server as unknown as { _handle: { fd: number } })._handle.fd;
    const inode = readlinkSync(`/proc/self/fd/${fd}`);
    const host = startHost(home, fd);
    const tell = () => `--- host log ---\n${host.log().slice(-3000)}`;
    // The parent keeps ITS copy while the host starts, as the window holds :9222 while genie-host comes up.
    const record = await within(90_000, 'the host writing host.json', until('host.json', () => {
        const r = parseHostRecord(existsSync(join(home, 'runtime', 'host.json')) ? readFileSync(join(home, 'runtime', 'host.json'), 'utf8') : null);
        return r && r.pid === host.child.pid ? r : null;
    }, 85_000), tell);
    // From here only the host (and whatever it handed it to) could hold the socket.
    await new Promise<void>((r) => server.close(() => r()));
    await within(25_000, 'the host\'s terminals spawn host', until('terminals ready', () => /spawn host ready pid=\d+ profile=terminals/.test(host.log()), 20_000), tell);
    const token = readFileSync(join(home, 'runtime', 'host.token'), 'utf8').trim();
    const transport = await within(10_000, 'the socket to the host', connectSocket(record.endpoint), tell);
    const client = new SessionEngineClient();
    expect(await within(15_000, 'the client connecting', client.connect(transport, token), tell)).toMatchObject({ ok: true });
    const opened = await within(30_000, 'a terminal opening', client.terminals().openReady({ workspaceId: 'ws', cwd: home }), tell);
    const helperPid = await within(20_000, 'the fancy-pty helper below the host', until('helper', () => descendants(record.pid).find((p) => /fancy-pty-helper/.test(cmdline(p))) ?? null, 15_000), () => `opened ${JSON.stringify(opened)}\n${tell()}`);
    const shellPid = await within(20_000, 'the shell under the helper', until('shell', () => children(helperPid)[0] ?? null, 15_000), tell);
    const spawnHosts = children(record.pid).filter((p) => /spawn-host/.test(cmdline(p)));
    return { home, port, inode, host: host.child, hostLog: host.log, client, transport, helperPid, shellPid, spawnHosts };
}

describe.skipIf(process.platform !== 'linux')('a terminal in genie-host on Electron, the host started holding an inherited socket', () => {
    let r: Rig;

    it('A: once the terminal runs, NOTHING holds the inherited socket — not the host, a spawn host, the helper or the shell', async () => {
        r = await rig();
        // CONTROL: a real shell runs under a real fancy-pty helper, below the host.
        expect(alive(r.shellPid)).toBe(true);
        expect(cmdline(r.helperPid)).toMatch(/fancy-pty-helper/);
        const held = holders(r.inode);
        // For each holder: WHICH fd, and its flags (octal; 02000000 = close-on-exec) — what the host saw at startup.
        const flagsOf = (pid: number) => readdirSync(`/proc/${pid}/fd`).flatMap((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === r.inode ? [`fd ${fd} ${/^flags:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'))?.[1] ?? '?'}`] : []; } catch { return []; } });
        console.log(`[host-pty-fds] A: host ${r.host.pid}, spawn hosts ${JSON.stringify(r.spawnHosts)}, helper ${r.helperPid}, shell ${r.shellPid}; holders of ${r.inode}: ${JSON.stringify(held.map((h) => ({ ...h, fds: flagsOf(h.pid) })))}; host log head: ${JSON.stringify(r.hostLog().split('\n').slice(0, 4))}`);
        expect(held).toEqual([]);
        expect(await probe(r.port)).toBe('refused');
        // CONTROL that it ARRIVED (so "nothing holds it" is a reading, not a socket that never got there): the host says so.
        expect(r.hostLog()).toContain(r.inode);
    }, 180_000);

    it('B: the host AND its spawn hosts SIGKILLed (vm-smoke’s pkill): the NEXT host reaps the helper and the shell they left', async () => {
        expect(r).toBeDefined();
        r.transport.close();
        // CONTROL: the terminal is alive before the kill.
        expect(alive(r.helperPid) && alive(r.shellPid)).toBe(true);
        for (const pid of [r.host.pid!, ...r.spawnHosts]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
        await sleep(3_000);
        const survived = { helper: alive(r.helperPid) ? { pid: r.helperPid, ppid: ppid(r.helperPid) } : null, shell: alive(r.shellPid) ? { pid: r.shellPid, ppid: ppid(r.shellPid) } : null };
        console.log(`[host-pty-fds] B: 3 s after the host and its spawn hosts were SIGKILLed: ${JSON.stringify(survived)}`);
        /*
         * A LEFTOVER THAT DOES NOT END ON ITS OWN (batch N). From fancy-pty 0.2.0 the helper ends its tree when its controller
         * dies, so on 0.2.1 the helper and shell above may be gone before any reap — and a test that only watched them stayed
         * green with the reap removed. The reap is for whatever outlives its owner regardless (a helper of another version, a
         * platform where it does not, a process tree a helper missed): a plain long-running process this test starts stands
         * for it, recorded in the dead host's ledger by the same rules as any pty — its real pid, its real start time.
         */
        const stray = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
        const strayPid = stray.pid!;
        const ledgerFile = join(r.home, 'runtime', 'ptys.json');
        const left = readPtyLedger(ledgerFile);
        expect(left?.owner).toBe(r.host.pid); // the dead host's own ledger
        writePtyLedger(ledgerFile, { owner: left!.owner, ptys: [...left!.ptys, { profile: 'terminals', id: 'stray', pid: strayPid, start: procStart(strayPid) }] });
        // CONTROL: the stray runs, and nothing but a reap would end it.
        expect(alive(strayPid)).toBe(true);
        const next = startHost(r.home, null);
        await within(90_000, 'the next host', until('next host.json', () => parseHostRecord(existsSync(join(r.home, 'runtime', 'host.json')) ? readFileSync(join(r.home, 'runtime', 'host.json'), 'utf8') : null)?.pid === next.child.pid || null, 85_000), () => next.log().slice(-3000));
        const reaped = await until('the leftovers reaped', () => (!alive(strayPid) && !alive(r.helperPid) && !alive(r.shellPid) ? true : null), 15_000).catch(() => false);
        console.log(`[host-pty-fds] B: the next host (${next.child.pid}) started; stray ${alive(strayPid) ? 'ALIVE' : 'gone'}, helper ${alive(r.helperPid) ? 'ALIVE' : 'gone'}, shell ${alive(r.shellPid) ? 'ALIVE' : 'gone'}; its log: ${JSON.stringify(next.log().split('\n').filter((l) => /reap|ptys/i.test(l)))}`);
        try { process.kill(strayPid, 'SIGKILL'); } catch { /* gone */ }
        expect(reaped).toBe(true);
        try { process.kill(next.child.pid!, 'SIGKILL'); } catch { /* gone */ }
    }, 150_000);

    it('B: a host SHUT DOWN (engine.shutdown, a quit) takes its terminal with it', async () => {
        const g = await rig();
        expect(alive(g.helperPid) && alive(g.shellPid)).toBe(true);
        await within(15_000, 'engine.shutdown', g.client.shutdown(), () => g.hostLog().slice(-3000));
        g.transport.close();
        const hostGone = await until('the host to exit', () => (!alive(g.host.pid!) ? true : null), 30_000).catch(() => false);
        const gone = await until('the terminal to go with its host', () => (!alive(g.helperPid) && !alive(g.shellPid) ? true : null), 10_000).catch(() => false);
        expect(hostGone).toBe(true);
        expect(gone).toBe(true);
    }, 180_000);
});
