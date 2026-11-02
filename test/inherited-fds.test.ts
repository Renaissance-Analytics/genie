import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { O_CLOEXEC, inheritedFds, type FdInfo } from '../src/main/inherited-fds.js';

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

describe('the entries that start processes close what they inherited FIRST', () => {
    const firstImport = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).find((l) => /^import\b/.test(l));
    it('genie-host.ts', () => { expect(firstImport('src/main/genie-host.ts')).toBe("import './close-inherited-fds.js';"); });
    it('spawn-host.ts', () => { expect(firstImport('src/main/spawn-host.ts')).toBe("import './close-inherited-fds.js';"); });
});
