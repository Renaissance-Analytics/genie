import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { O_CLOEXEC, inheritedFds, type FdInfo } from '../src/main/inherited-fds.js';
import { spawn } from 'node:child_process';
import { connect, createServer, type AddressInfo } from 'node:net';

/**
 * WHAT A HOST INHERITED, AND LETS GO OF (batch L4, bug A; VM job 76). On the VM, genie-host held the window's DevTools
 * listener (:9222) and eight more of the window's sockets and pipes, all WITHOUT close-on-exec, and handed every one on to
 * its spawn hosts, the pty helper and the shell. Every fd Node and libuv open carries O_CLOEXEC, and on the VM the host had
 * no socket or pipe of its own without it — so at startup, a SOCKET or PIPE at fd 3 or above without O_CLOEXEC came through
 * the exec, and is closed. Kept: stdio, close-on-exec fds, files (nothing that holds a port or a pipe end open), and Node's
 * IPC channel (NODE_CHANNEL_FD, inherited on purpose by a forked spawn host). host-pty-fds.test.ts measures it end to end.
 */

const info = (map: Record<number, FdInfo | null>) => (fd: number) => (fd in map ? map[fd]! : null);

describe('inheritedFds', () => {
    it('picks sockets and pipes at ≥ 3 without O_CLOEXEC; keeps stdio, close-on-exec fds, files and the IPC channel', () => {
        const fds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        const read = info({
            0: { flags: 0o2, target: 'pipe:[1]' },
            1: { flags: 0o1, target: 'socket:[2]' },
            2: { flags: 0o1, target: '/dev/null' },
            3: { flags: 0o2, target: 'socket:[13671]' }, // the window's :9222 listener — inherited
            4: { flags: 0o2 | O_CLOEXEC, target: 'socket:[5]' }, // this process's own
            5: { flags: 0o4002, target: 'pipe:[15892]' }, // an inherited pipe
            6: { flags: 0o2, target: 'socket:[7]' }, // the IPC channel
            7: null, // gone before it could be read
            8: { flags: 0o0, target: '/usr/share/icu/icudtl.dat' }, // a file: left alone
            9: { flags: 0o2, target: 'anon_inode:[eventfd]' }, // not a socket or a pipe: left alone
        });
        expect(inheritedFds(fds, read, new Set([6]), new Set())).toEqual([3, 5]);
    });

    it('a socket or pipe the PARENT also holds is inherited whatever its flag (CI: close-on-exec was set on the window’s socket in the host)', () => {
        const read = info({
            3: { flags: 0o2004002, target: 'socket:[29170]' }, // the parent's listener, flagged close-on-exec in this process — inherited
            4: { flags: 0o2004002, target: 'pipe:[900]' }, // close-on-exec, the parent does NOT hold it: this process's own (tsx's esbuild pipe)
            5: { flags: 0o2000002, target: '/tmp/a-file' }, // a file the parent holds too: files are never closed here
        });
        expect(inheritedFds([3, 4, 5], read, new Set(), new Set(['socket:[29170]', '/tmp/a-file']))).toEqual([3]);
    });
});

describe('the entries that start processes close what they inherited first, but for process-start', () => {
    const imports = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^import\b/.test(l));
    it.each(['src/main/genie-host.ts', 'src/main/spawn-host.ts'])('%s: process-start, then this, then anything else', (file) => {
        expect(imports(file).slice(0, 2)).toEqual(["import './process-start.js';", "import './close-inherited-fds.js';"]);
    });

    it('process-start opens nothing: it imports one module, and that one only reads the file system', () => {
        const from = (file: string) => imports(file).map((l) => /from '([^']+)'|^import '([^']+)'/.exec(l)).map((m) => m?.[1] ?? m?.[2]);
        expect(from('src/main/process-start.ts')).toEqual(['../core/program-lookup.js']);
        for (const name of from('src/core/program-lookup.ts')) expect(['node:fs', 'node:os', 'node:path']).toContain(name);
        const source = readFileSync('src/core/program-lookup.ts', 'utf8');
        expect(source).not.toMatch(/\b(openSync|createServer|createConnection|connect|fork|spawn|execFile|watch)\(/);
    });
});

/** A real child, given a real socket on fd 3 the way a parent's would leak, importing the two in the entries' order. */
describe.runIf(process.platform === 'linux')('a real child, on Linux', () => {
    const child = async (imports: readonly string[]) => {
        const server = createServer();
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
        await new Promise<void>((r) => socket.once('connect', () => r()));
        const list = "require('node:fs').readdirSync('/proc/self/fd').filter((fd) => { try { return /^(socket|pipe):/.test(require('node:fs').readlinkSync('/proc/self/fd/' + fd)); } catch { return false; } }).map(Number).filter((fd) => fd >= 3)";
        const script = `const list = () => ${list}; const before = list(); (async () => { ${imports.map((name) => `await import(${JSON.stringify(new URL(`../src/main/${name}`, import.meta.url).href)});`).join(' ')} console.log(JSON.stringify({ before, after: list() })); process.exit(0); })();`;
        const running = spawn(process.execPath, ['--import', 'tsx', '-e', script], { stdio: ['ignore', 'pipe', 'inherit', socket] });
        let out = '';
        running.stdout!.on('data', (d) => { out += d; });
        await new Promise((r) => running.once('exit', r));
        socket.destroy();
        server.close();
        return JSON.parse(out.trim().split('\n').pop()!) as { before: number[]; after: number[] };
    };

    it('in the entries order, what it inherited is closed', async () => {
        const { before, after } = await child(['process-start.ts', 'close-inherited-fds.ts']);
        // CONTROL: the socket was there to close.
        expect(before).toContain(3);
        expect(after).not.toContain(3);
    }, 30_000);

    it('process-start alone leaves it, and adds no socket or pipe of its own', async () => {
        const { before, after } = await child(['process-start.ts']);
        expect(before).toContain(3);
        expect(after).toEqual(before);
    }, 30_000);
});
