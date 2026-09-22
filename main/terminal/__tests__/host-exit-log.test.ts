import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(), log: vi.fn(), runtime: vi.fn(), close: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../db', () => ({}));
vi.mock('../process-supervisor', () => ({}));
vi.mock('@particle-academy/fancy-term-host', () => ({}));
vi.mock('../host-service', () => ({
    resolveShippedRuntime: mocks.runtime,
    resolveMaterializedHostScript: () => '/materialized/pty-host.js',
    openPtyhostLogStdio: () => ({ stdio: ['ignore', 10, 11], close: mocks.close }),
    writeDetachedMode: vi.fn(),
    logHostService: mocks.log,
}));
import { electronHostSpawner, retainHostExitTerminalView } from '../genie-adapter';

describe.each(['standalone', 'electron'])('detached %s host diagnostics', (mode) => {
    let child: EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> };
    beforeEach(() => {
        vi.clearAllMocks();
        child = Object.assign(new EventEmitter(), { pid: 4321, unref: vi.fn() });
        mocks.spawn.mockReturnValue(child);
        mocks.runtime.mockReturnValue(mode === 'standalone' ? { nodePath: '/runtime/node' } : null);
    });

    it.each([[0, null], [3221225477, null], [null, 'SIGTERM']])(
        'records exit code %s and signal %s with the host identity', (code, signal) => {
            electronHostSpawner('').spawnDetached('/host.js', {});
            retainHostExitTerminalView({ list: () => [{}, {}] });
            child.emit('exit', code, signal);
            const line = mocks.log.mock.calls.map(([line]) => line).find(line => line.includes('host exited'));
            expect(line).toBeDefined();
            expect(line).toContain('pid=4321');
            expect(line).toContain(`mode=${mode}`);
            expect(line).toContain(`code=${code}`);
            expect(line).toContain(`signal=${signal}`);
            expect(line).toContain('/materialized/pty-host.js');
            expect(line).toContain('terminals=2');
            expect(line).toMatch(/uptimeMs=\d+/);
            expect(child.unref).toHaveBeenCalledOnce();
            expect(mocks.close).toHaveBeenCalledOnce();
        },
    );

    it('records asynchronous spawn errors without an unhandled error event', () => {
        electronHostSpawner('').spawnDetached('/host.js', {});
        expect(() => child.emit('error', new Error('spawn EACCES'))).not.toThrow();
        expect(mocks.log.mock.calls.some(([line]) => line.includes('spawn EACCES'))).toBe(true);
    });

    it('retains the dying host view across backend fallback', () => {
        electronHostSpawner('').spawnDetached('/host.js', {});
        retainHostExitTerminalView({ list: () => [{}, {}, {}] });
        child.emit('exit', 1, null);
        expect(mocks.log.mock.calls.some(([line]) => line.includes('terminals=3'))).toBe(true);
    });

    it('reports an unknown count when the host never connected', () => {
        electronHostSpawner('').spawnDetached('/host.js', {});
        child.emit('exit', 1, null);
        expect(mocks.log.mock.calls.some(([line]) => line.includes('terminals=unknown'))).toBe(true);
    });

    it('does not let a late old-host exit detach the replacement host view', () => {
        electronHostSpawner('').spawnDetached('/host.js', {});
        const old = child;
        child = Object.assign(new EventEmitter(), { pid: 9876, unref: vi.fn() });
        mocks.spawn.mockReturnValue(child);
        electronHostSpawner('').spawnDetached('/host.js', {});
        old.emit('exit', 1, null);
        retainHostExitTerminalView({ list: () => [{}] });
        child.emit('exit', 1, null);
        expect(mocks.log.mock.calls.some(([line]) => line.includes('pid=9876') && line.includes('terminals=1'))).toBe(true);
    });
});
