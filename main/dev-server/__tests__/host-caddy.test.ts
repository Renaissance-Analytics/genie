import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
    applyHostCaddy,
    awaitCaddyStart,
    hostCaddyReloadArgv,
    hostCaddyStartArgv,
    type HostCaddyDeps,
} from '../host-caddy';

/**
 * Driving the HOST Caddy (story #238, task #673 real binding). Mirrors the sandbox
 * caddy-proxy.ts converge step — write the config, then RELOAD a running Caddy or
 * START it if it isn't up — but on the host it spawns the caddy binary directly
 * instead of exec-ing into a container. The orchestration is injected so "reload,
 * else start" is unit-tested; the real spawn/fs are thin bindings CI exercises.
 */
function deps(over: Partial<HostCaddyDeps> = {}): HostCaddyDeps {
    return {
        caddyBin: '/opt/genie/caddy',
        configPath: '/var/genie/HostCaddyfile',
        writeFile: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockResolvedValue({ code: 0 }),
        startDetached: vi.fn().mockResolvedValue({ ok: true }),
        ...over,
    };
}

describe('host-caddy argv', () => {
    it('builds reload + start argv against the binary and config', () => {
        expect(hostCaddyReloadArgv('/c/caddy', '/cfg')).toEqual([
            '/c/caddy',
            'reload',
            '--config',
            '/cfg',
            '--adapter',
            'caddyfile',
        ]);
        expect(hostCaddyStartArgv('/c/caddy', '/cfg')).toEqual([
            '/c/caddy',
            'start',
            '--config',
            '/cfg',
            '--adapter',
            'caddyfile',
        ]);
    });
});

describe('applyHostCaddy', () => {
    it('writes the config then RELOADs a running Caddy (no start)', async () => {
        const d = deps();
        const res = await applyHostCaddy('CADDYFILE', d);
        expect(res.ok).toBe(true);
        expect(d.writeFile).toHaveBeenCalledWith('/var/genie/HostCaddyfile', 'CADDYFILE');
        expect(d.run).toHaveBeenCalledOnce();
        expect((d.run as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(
            hostCaddyReloadArgv('/opt/genie/caddy', '/var/genie/HostCaddyfile'),
        );
        expect(d.startDetached).not.toHaveBeenCalled();
    });

    it('STARTs Caddy when reload fails (not yet running)', async () => {
        const d = deps({ run: vi.fn().mockResolvedValue({ code: 1, stderr: 'no admin endpoint' }) });
        const res = await applyHostCaddy('CADDYFILE', d);
        expect(res.ok).toBe(true);
        expect(d.startDetached).toHaveBeenCalledOnce();
        expect((d.startDetached as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(
            hostCaddyStartArgv('/opt/genie/caddy', '/var/genie/HostCaddyfile'),
        );
    });

    it('reports an error when the start also fails', async () => {
        const d = deps({
            run: vi.fn().mockResolvedValue({ code: 1 }),
            startDetached: vi.fn().mockResolvedValue({ ok: false, error: 'port 443 in use' }),
        });
        const res = await applyHostCaddy('CADDYFILE', d);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain('443');
    });

    it('never throws — a writeFile failure becomes an error result', async () => {
        const d = deps({ writeFile: vi.fn().mockRejectedValue(new Error('EACCES')) });
        const res = await applyHostCaddy('CADDYFILE', d);
        expect(res.ok).toBe(false);
    });
});

// --- CONTRIBUTING.md "Never report a success you have not verified" ---------
//
// The real `startDetached` binding used to be a 50ms `setTimeout` that resolved
// `{ ok: true }` without ever looking at the process:
//
//     // `caddy start` daemonises and exits; give it a tick to fail loudly.
//     setTimeout(() => resolve({ ok: true }), 50);
//
// So `applyHostCaddy` reported the host Caddy converged when :443 was taken, or
// when the binary was missing, and anything issuing a `reload` behind it raced
// an admin API that was not listening yet. A LONGER timer is not the fix: a
// timer that always passes cannot fail, whatever its length.
//
// `caddy start` daemonises the server and exits 0 only once that server has
// signalled it is up and serving — so its exit code is a real readiness answer,
// and waiting for it is outcome 1 (verify). A start we cannot see finish is
// reported as a FAILURE naming what to check, which is outcome 3.

/** A spawned `caddy start`, faked at the events the waiter listens on. */
function fakeStart() {
    const child = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        unref: () => void;
    };
    child.stderr = new EventEmitter();
    let unrefs = 0;
    child.unref = () => {
        unrefs += 1;
    };
    return { child, unrefs: () => unrefs };
}

/** Has the promise settled YET? The whole bug was settling too early. */
async function settled<T>(p: Promise<T>): Promise<T | 'pending'> {
    return await Promise.race([p, Promise.resolve<'pending'>('pending')]);
}

describe('awaitCaddyStart', () => {
    it('does NOT report success until the process has actually exited', async () => {
        const { child } = fakeStart();
        const p = awaitCaddyStart(child, { timeoutMs: 5_000, stderrGraceMs: 1 });

        // Nothing has happened yet. The old binding was already resolved by now.
        expect(await settled(p)).toBe('pending');

        child.emit('exit', 0);
        expect(await p).toEqual({ ok: true });
    });

    it('reports the FAILURE when the start exits non-zero, with what caddy said', async () => {
        const { child } = fakeStart();
        const p = awaitCaddyStart(child, { timeoutMs: 5_000, stderrGraceMs: 50 });
        child.stderr.emit('data', 'loading initial config: listen tcp :443: bind: address already in use');
        child.emit('exit', 1);
        child.emit('close', 1);

        const res = await p;
        expect(res.ok).toBe(false);
        expect(res.error).toContain('443');
    });

    it('reports a spawn error rather than a success', async () => {
        const { child } = fakeStart();
        const p = awaitCaddyStart(child, { timeoutMs: 5_000, stderrGraceMs: 1 });
        child.emit('error', new Error('spawn caddy ENOENT'));

        const res = await p;
        expect(res.ok).toBe(false);
        expect(res.error).toContain('ENOENT');
    });

    it('a start it cannot see finish is UNVERIFIED — a failure that names what to check', async () => {
        const { child } = fakeStart();
        const res = await awaitCaddyStart(child, { timeoutMs: 5, stderrGraceMs: 1 });
        expect(res.ok).toBe(false);
        // Option 3, not an uncheckable hedge: it has to point at something.
        expect(res.error).toMatch(/confirm/i);
        expect(res.error).toMatch(/443|caddy/i);
    });

    it('releases the process handle once, whatever the outcome', async () => {
        const { child, unrefs } = fakeStart();
        const p = awaitCaddyStart(child, { timeoutMs: 5_000, stderrGraceMs: 1 });
        // Not before the exit: unref'ing early drops the very handle whose exit
        // code is the evidence.
        expect(unrefs()).toBe(0);
        child.emit('exit', 0);
        await p;
        child.emit('close', 0);
        expect(unrefs()).toBe(1);
    });
});
