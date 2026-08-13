import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
    ptyhostLogPaths,
    openPtyhostLogStdio,
    PTYHOST_LOG_MAX_BYTES,
    type HostLogIo,
} from '../host-service';

/**
 * The detached pty-host used to be spawned with stdio:'ignore' (genie-adapter
 * electronHostSpawner.spawnDetached) — so when the single shared host died it
 * left ZERO trace ("all terminals frozen, no sign of a crash"; genie#203). This
 * helper opens append fds for the host's stdout/stderr under <userData>/logs so
 * the next death is diagnosable. It must NEVER throw: a logging failure can't be
 * allowed to block the host spawn (that would trade a silent death for no host
 * at all).
 */

const USER_DATA = path.join('C:', 'Users', 'x', 'AppData', 'Roaming', 'genie');

/** A recording fake of the fs seam so tests never touch the real disk. */
function fakeIo(opts: {
    sizes?: Record<string, number>;
    throwOn?: Partial<Record<'mkdir' | 'openOut' | 'openErr', boolean>>;
} = {}): { io: HostLogIo; calls: {
    mkdir: string[]; rotate: string[]; open: string[]; close: number[];
} } {
    const calls = { mkdir: [] as string[], rotate: [] as string[], open: [] as string[], close: [] as number[] };
    let nextFd = 10;
    const { out, err } = ptyhostLogPaths(USER_DATA);
    const io: HostLogIo = {
        mkdir: (d) => {
            if (opts.throwOn?.mkdir) throw new Error('mkdir denied');
            calls.mkdir.push(d);
        },
        size: (p) => opts.sizes?.[p] ?? 0,
        rotate: (p) => { calls.rotate.push(p); },
        open: (p) => {
            if (p === out && opts.throwOn?.openOut) throw new Error('open out failed');
            if (p === err && opts.throwOn?.openErr) throw new Error('open err failed');
            calls.open.push(p);
            return nextFd++;
        },
        close: (fd) => { calls.close.push(fd); },
    };
    return { io, calls };
}

describe('ptyhostLogPaths', () => {
    it('puts the host logs under <userData>/logs', () => {
        const p = ptyhostLogPaths(USER_DATA);
        expect(p.dir).toBe(path.join(USER_DATA, 'logs'));
        expect(p.out).toBe(path.join(USER_DATA, 'logs', 'ptyhost.out.log'));
        expect(p.err).toBe(path.join(USER_DATA, 'logs', 'ptyhost.err.log'));
    });
});

describe('openPtyhostLogStdio', () => {
    it('opens append fds for stdout+stderr and returns them as the spawn stdio triple', () => {
        const { io, calls } = fakeIo();
        const { out, err } = ptyhostLogPaths(USER_DATA);

        const res = openPtyhostLogStdio(USER_DATA, io);

        expect(res.stdio[0]).toBe('ignore'); // stdin is never a log
        expect(typeof res.stdio[1]).toBe('number');
        expect(typeof res.stdio[2]).toBe('number');
        expect(res.stdio[1]).not.toBe(res.stdio[2]);
        expect(calls.mkdir).toContain(path.join(USER_DATA, 'logs'));
        expect(calls.open).toEqual([out, err]);
        expect(calls.rotate).toEqual([]); // nothing oversized → no rotation
    });

    it('rotates a log that has grown past the cap BEFORE opening it', () => {
        const { out, err } = ptyhostLogPaths(USER_DATA);
        const { io, calls } = fakeIo({ sizes: { [out]: PTYHOST_LOG_MAX_BYTES, [err]: 0 } });

        openPtyhostLogStdio(USER_DATA, io);

        expect(calls.rotate).toEqual([out]); // only the oversized one
        expect(calls.open).toEqual([out, err]); // both still opened after
    });

    it('falls back to "ignore" for a stream it cannot open, and never throws', () => {
        const { io, calls } = fakeIo({ throwOn: { openErr: true } });

        const res = openPtyhostLogStdio(USER_DATA, io);

        expect(typeof res.stdio[1]).toBe('number'); // stdout still captured
        expect(res.stdio[2]).toBe('ignore'); // stderr degraded, not fatal
        expect(calls.close).toEqual([]); // nothing closed yet
    });

    it('degrades to all-ignore when the log dir cannot be created', () => {
        const { io } = fakeIo({ throwOn: { mkdir: true } });

        const res = openPtyhostLogStdio(USER_DATA, io);

        expect(res.stdio).toEqual(['ignore', 'ignore', 'ignore']);
    });

    it('close() releases exactly the fds it opened (the child dups them on spawn)', () => {
        const { io, calls } = fakeIo();

        const res = openPtyhostLogStdio(USER_DATA, io);
        const opened = [res.stdio[1], res.stdio[2]].filter((s): s is number => typeof s === 'number');
        res.close();

        expect(calls.close.sort()).toEqual(opened.sort());
    });
});
