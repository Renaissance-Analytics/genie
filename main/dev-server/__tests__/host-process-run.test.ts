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

    it('writes a start-time [genie] note to the site log, before the dev server output', async () => {
        const appendLog = vi.fn();
        const run = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims(),
            ensureDir: vi.fn(),
            appendLog,
        });
        await run.start({
            siteId: 's',
            workspaceId: 'ws',
            command: ['php', 'artisan', 'serve'],
            cwd: '/r',
            env: {},
            note: '3 service(s) are running but publish no reachable loopback port',
        });
        expect(appendLog).toHaveBeenCalledOnce();
        const [path, text] = appendLog.mock.calls[0];
        expect(path).toContain('s');
        expect(text).toContain('[genie]');
        expect(text).toContain('no reachable loopback port');
    });

    it('writes NO note when the start carries none', async () => {
        const appendLog = vi.fn();
        const run = createHostProcessRun({
            logDir: '/logs',
            primitives: fakePrims(),
            ensureDir: vi.fn(),
            appendLog,
        });
        await run.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {} });
        expect(appendLog).not.toHaveBeenCalled();
    });

    // --- surviving a Genie restart (genie#190) -------------------------------
    //
    // A host-native dev server is spawned to OUTLIVE the call that started it, so
    // it routinely outlives Genie itself (a restart, an update). The registry that
    // knows its pid used to live only in this process's memory, so the moment Genie
    // restarted the run became an ORPHAN: still serving on its port, but invisible
    // — `alive` said no, `stop` was a no-op, `readLog` was empty, and the Site
    // Manager showed a stopped site that was in fact running. The registry is
    // persisted for exactly that reason.
    describe('the run registry survives a Genie restart', () => {
        /** An in-memory stand-in for the on-disk registry file, shared by two
         *  successive `createHostProcessRun`s — i.e. across a restart. */
        function registryFile() {
            let text: string | null = null;
            return {
                readRegistry: (_path: string) => text,
                writeRegistry: (_path: string, next: string) => {
                    text = next;
                },
                get raw() {
                    return text;
                },
            };
        }

        it('a NEW registry re-attaches a run started by the previous process', async () => {
            const file = registryFile();
            const before = createHostProcessRun({
                logDir: '/logs',
                primitives: fakePrims(),
                ensureDir: vi.fn(),
                readRegistry: file.readRegistry,
                writeRegistry: file.writeRegistry,
            });
            await before.start({
                siteId: 's',
                workspaceId: 'ws',
                command: ['php', 'artisan', 'serve'],
                cwd: '/r',
                env: {},
                port: 5321,
            });

            // Genie restarts: a brand-new registry, same log dir, same still-running
            // dev server.
            const readLogTail = vi.fn().mockReturnValue('still serving');
            const after = createHostProcessRun({
                logDir: '/logs',
                primitives: fakePrims({ signal: vi.fn().mockReturnValue(true) }),
                ensureDir: vi.fn(),
                readLogTail,
                readRegistry: file.readRegistry,
                writeRegistry: file.writeRegistry,
            });
            expect(await after.alive('s')).toBe(true);
            expect(await after.readLog('s')).toBe('still serving');
            // …and the PORT comes back too, so the site can be re-routed rather than
            // restarted onto a second port beside the one already serving.
            expect(await after.running?.()).toEqual([{ siteId: 's', port: 5321 }]);
        });

        it('running() reports only the sites whose process is actually still alive', async () => {
            const file = registryFile();
            const before = createHostProcessRun({
                logDir: '/logs',
                primitives: fakePrims({
                    spawnDetached: vi
                        .fn()
                        .mockReturnValueOnce(11)
                        .mockReturnValueOnce(22),
                }),
                ensureDir: vi.fn(),
                readRegistry: file.readRegistry,
                writeRegistry: file.writeRegistry,
            });
            await before.start({ siteId: 'alive', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 4001 });
            await before.start({ siteId: 'dead', workspaceId: 'ws', command: ['y'], cwd: '/r', env: {}, port: 4002 });

            // After the restart only pid 11 is still there — pid 22 died with Genie.
            const after = createHostProcessRun({
                logDir: '/logs',
                primitives: fakePrims({ signal: vi.fn().mockImplementation((pid: number) => pid === 11) }),
                ensureDir: vi.fn(),
                readRegistry: file.readRegistry,
                writeRegistry: file.writeRegistry,
            });
            expect(await after.running?.()).toEqual([{ siteId: 'alive', port: 4001 }]);
            expect(await after.alive('dead')).toBe(false);
        });

        it('stop forgets the run in the PERSISTED registry, not only in memory', async () => {
            const file = registryFile();
            const first = createHostProcessRun({
                logDir: '/logs',
                primitives: fakePrims(),
                ensureDir: vi.fn(),
                readRegistry: file.readRegistry,
                writeRegistry: file.writeRegistry,
            });
            await first.start({ siteId: 's', workspaceId: 'ws', command: ['x'], cwd: '/r', env: {}, port: 5321 });
            await first.stop('s');

            const after = createHostProcessRun({
                logDir: '/logs',
                primitives: fakePrims(),
                ensureDir: vi.fn(),
                readRegistry: file.readRegistry,
                writeRegistry: file.writeRegistry,
            });
            expect(await after.alive('s')).toBe(false);
            expect(await after.running?.()).toEqual([]);
        });

        it('a corrupt or absent registry file is simply no runs — never a throw', async () => {
            const run = createHostProcessRun({
                logDir: '/logs',
                primitives: fakePrims(),
                ensureDir: vi.fn(),
                readRegistry: () => '{not json',
                writeRegistry: vi.fn(),
            });
            expect(await run.running?.()).toEqual([]);
            expect(await run.alive('s')).toBe(false);
        });
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
