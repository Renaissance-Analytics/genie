import { describe, expect, it, vi } from 'vitest';
import { createHostProcessRun } from '../host-process-run';
import type { HostSpawnPrimitives } from '../host-site-process';

/**
 * The real HostProcessRun binding (story #238): runs a host-native site's dev
 * server as a detached HOST process, keyed by siteId. The Node child_process /
 * process.kill / fs primitives are injected here so the REGISTRY orchestration —
 * start tracks a pid+log, stop signals + forgets it, alive/readLog look it up — is
 * unit-tested; the real spawn is a thin default binding CI/real machines exercise.
 */
function fakePrims(over: Partial<HostSpawnPrimitives> = {}): HostSpawnPrimitives {
    return {
        platform: 'linux',
        spawnDetached: vi.fn().mockReturnValue(4242),
        signal: vi.fn().mockReturnValue(true),
        killTreeWin: vi.fn().mockResolvedValue(undefined),
        ...over,
    };
}

describe('createHostProcessRun', () => {
    it('start spawns the dev server (in the repo cwd, with env) and tracks its pid', async () => {
        const prims = fakePrims();
        const run = createHostProcessRun({ logDir: '/logs', primitives: prims, ensureDir: vi.fn() });
        const res = await run.start({
            siteId: 'site-1',
            workspaceId: 'ws',
            command: ['php', 'artisan', 'serve'],
            cwd: '/repo',
            env: { DB_HOST: '127.0.0.1' },
        });
        expect(res).toEqual({ ok: true, pid: 4242 });
        const spec = (prims.spawnDetached as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(spec.command).toEqual(['php', 'artisan', 'serve']);
        expect(spec.cwd).toBe('/repo');
        expect(spec.env.DB_HOST).toBe('127.0.0.1');
        expect(spec.logPath).toContain('site-1');
        expect(await run.alive('site-1')).toBe(true);
    });

    it('stop signals the process GROUP on posix and forgets it', async () => {
        const prims = fakePrims({ platform: 'linux' });
        const run = createHostProcessRun({ logDir: '/logs', primitives: prims, ensureDir: vi.fn() });
        await run.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {} });
        await run.stop('s');
        expect(prims.signal).toHaveBeenCalledWith(-4242, 'SIGTERM');
        expect(await run.alive('s')).toBe(false); // forgotten
    });

    it('alive is false for an unknown site; readLog returns the tail of its log', async () => {
        const readLogTail = vi.fn().mockReturnValue('last lines');
        const run = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims(),
            ensureDir: vi.fn(),
            readLogTail,
        });
        expect(await run.alive('nope')).toBe(false);
        expect(await run.readLog('nope')).toBe('');
        await run.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {} });
        expect(await run.readLog('s', 50)).toBe('last lines');
        expect(readLogTail.mock.calls[0][1]).toBe(50);
    });

    it('surfaces a spawn failure as ok:false rather than throwing', async () => {
        const prims = fakePrims({
            spawnDetached: vi.fn().mockImplementation(() => {
                throw new Error('ENOENT php');
            }),
        });
        const run = createHostProcessRun({ logDir: '/logs', primitives: prims, ensureDir: vi.fn() });
        const res = await run.start({ siteId: 's', workspaceId: 'ws', command: ['php'], cwd: '/r', env: {} });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain('ENOENT');
    });
});
