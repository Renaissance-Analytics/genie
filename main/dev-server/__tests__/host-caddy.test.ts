import { describe, expect, it, vi } from 'vitest';
import { applyHostCaddy, hostCaddyReloadArgv, hostCaddyStartArgv, type HostCaddyDeps } from '../host-caddy';

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
