import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * GENIE'S RECORDS ARE DURABLE, NOT ONLY ATOMIC (hosting fixes 3.1). `writeJsonAtomic` wrote a temp file and renamed it
 * over the real one — atomic, so a reader never sees half a file — but never flushed either: after a power cut the
 * rename can be on disk while the bytes it points at are not, and `services.json` (or an agent's record) comes back
 * EMPTY. Now the temp file's bytes are synced before the rename, and on POSIX the directory is synced after it so the
 * rename itself is kept. (Windows cannot open a directory to flush it.)
 *
 * Read from the real calls, in order, on a real temp directory: `node:fs/promises` is wrapped, not replaced.
 */
const events: string[] = [];
vi.mock('node:fs/promises', async (original) => {
    const real = await original<typeof import('node:fs/promises')>();
    const label = (p: unknown) => (String(p).endsWith('.tmp') ? 'tmp' : String(p).endsWith('.json') ? 'file' : 'dir');
    return {
        ...real,
        open: async (path: Parameters<typeof real.open>[0], ...rest: unknown[]) => {
            const fh = await (real.open as (...a: unknown[]) => ReturnType<typeof real.open>)(path, ...rest);
            const what = label(path);
            events.push(`open ${what}`);
            const sync = fh.sync.bind(fh);
            const close = fh.close.bind(fh);
            return Object.assign(fh, {
                sync: async () => { events.push(`sync ${what}`); return sync(); },
                close: async () => { events.push(`close ${what}`); return close(); },
            });
        },
        rename: async (from: string, to: string) => { events.push('rename'); return real.rename(from, to); },
    };
});
const { writeJsonAtomic } = await import('../src/main/store.js');

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-durable-')); events.length = 0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('the bytes are synced BEFORE the rename names them; the file reads back whole', async () => {
    const file = join(dir, 'services.json');
    await writeJsonAtomic(file, { instances: [{ id: 'svc_1' }] });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ instances: [{ id: 'svc_1' }] });
    const synced = events.indexOf('sync tmp');
    expect(synced).toBeGreaterThanOrEqual(0);
    expect(synced).toBeLessThan(events.indexOf('rename'));
    expect(events.indexOf('close tmp')).toBeLessThan(events.indexOf('rename'));
});

it('on POSIX the directory is synced AFTER the rename, so the rename itself is kept', async () => {
    await writeJsonAtomic(join(dir, 'agents.json'), { agents: [] });
    if (process.platform === 'win32') {
        expect(events.filter((e) => e === 'sync dir')).toHaveLength(0);
        return;
    }
    expect(events.indexOf('sync dir')).toBeGreaterThan(events.indexOf('rename'));
    expect(events.filter((e) => e === 'sync dir')).toHaveLength(1);
});

it('CONTROL on the gauge: the wrapper sees real calls — one rename per write, into the file’s own directory', async () => {
    const file = join(dir, 'nested', 'x.json');
    await writeJsonAtomic(file, 1);
    await writeJsonAtomic(file, 2);
    expect(events.filter((e) => e === 'rename')).toHaveLength(2);
    expect(basename(dirname(file))).toBe('nested');
    expect(JSON.parse(await readFile(file, 'utf8'))).toBe(2);
});
