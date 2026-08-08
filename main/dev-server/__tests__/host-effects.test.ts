import { describe, expect, it, vi } from 'vitest';
import { buildHostReconcileEffects, hostsCopyCommand, type HostEffectIo, type HostEffectPaths } from '../host-effects';

/**
 * Wiring reconcileHostSites's injected effects to the real fs + host Caddy +
 * elevation (story #238). The orchestration (write-then-install, temp-then-copy,
 * loud throw on privileged failure) is unit-tested with a fake io; the real fs /
 * spawn leaves are exercised by CI E2E.
 */
const PATHS: HostEffectPaths = {
    caCertPath: '/g/gen-ca.crt',
    caKeyPath: '/g/gen-ca.key',
    leafCertPath: '/g/leaf.crt',
    leafKeyPath: '/g/leaf.key',
    caddyfilePath: '/g/HostCaddyfile',
    hostsFilePath: '/etc/hosts',
    caddyBin: '/g/caddy',
};

function fakeIo(over: Partial<HostEffectIo> = {}): HostEffectIo {
    return {
        platform: 'linux',
        readFile: vi.fn().mockResolvedValue(null),
        writeFile: vi.fn().mockResolvedValue(undefined),
        tempFile: vi.fn().mockResolvedValue('/tmp/hosts.new'),
        spawn: vi.fn().mockResolvedValue({ code: 0 }),
        spawnDetached: vi.fn().mockResolvedValue({ ok: true }),
        isElevated: () => true, // CI-root path: run directly
        ...over,
    };
}

describe('buildHostReconcileEffects', () => {
    it('caStore.write persists cert + key (key mode 0600)', async () => {
        const io = fakeIo();
        const fx = buildHostReconcileEffects(PATHS, io);
        await fx.caStore.write({ caPem: 'CERT', caKeyPem: 'KEY' });
        expect(io.writeFile).toHaveBeenCalledWith('/g/gen-ca.crt', 'CERT');
        expect(io.writeFile).toHaveBeenCalledWith('/g/gen-ca.key', 'KEY', { mode: 0o600 });
    });

    it('writeLeaf writes cert + key and returns their paths', async () => {
        const io = fakeIo();
        const fx = buildHostReconcileEffects(PATHS, io);
        const res = await fx.writeLeaf({ certPem: 'LC', keyPem: 'LK' });
        expect(res).toEqual({ certPath: '/g/leaf.crt', keyPath: '/g/leaf.key' });
        expect(io.writeFile).toHaveBeenCalledWith('/g/leaf.crt', 'LC');
        expect(io.writeFile).toHaveBeenCalledWith('/g/leaf.key', 'LK', { mode: 0o600 });
    });

    it('installCaTrust writes the cert then runs the privileged trust command (direct when root)', async () => {
        const io = fakeIo();
        const fx = buildHostReconcileEffects(PATHS, io);
        await fx.installCaTrust('CAPEM');
        expect(io.writeFile).toHaveBeenCalledWith('/g/gen-ca.crt', 'CAPEM');
        // linux + elevated ⇒ `trust anchor <cert>` spawned directly (no launcher).
        expect(io.spawn).toHaveBeenCalledWith('trust', ['anchor', '/g/gen-ca.crt']);
    });

    it('installCaTrust THROWS loudly when the trust install fails', async () => {
        const io = fakeIo({ spawn: vi.fn().mockResolvedValue({ code: 1, stderr: 'nope' }) });
        const fx = buildHostReconcileEffects(PATHS, io);
        await expect(fx.installCaTrust('CAPEM')).rejects.toThrow(/trust store/i);
    });

    it('hostsIo.write stages a temp file then privilege-copies it over the hosts file', async () => {
        const io = fakeIo();
        const fx = buildHostReconcileEffects(PATHS, io);
        await fx.hostsIo.write('NEWHOSTS');
        expect(io.tempFile).toHaveBeenCalledWith('NEWHOSTS');
        expect(io.spawn).toHaveBeenCalledWith('cp', ['-f', '/tmp/hosts.new', '/etc/hosts']);
    });

    it('hostsIo.read returns "" when the hosts file is absent', async () => {
        const io = fakeIo({ readFile: vi.fn().mockResolvedValue(null) });
        const fx = buildHostReconcileEffects(PATHS, io);
        expect(await fx.hostsIo.read()).toBe('');
    });

    it('writeCaddyfileAndReload drives the host Caddy (reload path)', async () => {
        const io = fakeIo();
        const fx = buildHostReconcileEffects(PATHS, io);
        await fx.writeCaddyfileAndReload('CADDYFILE');
        expect(io.writeFile).toHaveBeenCalledWith('/g/HostCaddyfile', 'CADDYFILE');
        expect(io.spawn).toHaveBeenCalledWith('/g/caddy', ['reload', '--config', '/g/HostCaddyfile', '--adapter', 'caddyfile']);
    });

    it('routes through the elevation launcher when NOT already privileged', async () => {
        const io = fakeIo({ isElevated: () => false });
        const fx = buildHostReconcileEffects(PATHS, io);
        await fx.installCaTrust('CAPEM');
        // linux unprivileged ⇒ pkexec wraps the trust command.
        expect(io.spawn).toHaveBeenCalledWith('pkexec', ['trust', 'anchor', '/g/gen-ca.crt']);
    });
});

describe('hostsCopyCommand', () => {
    it('uses cp -f on unix and cmd copy on windows', () => {
        expect(hostsCopyCommand('/t', '/etc/hosts', 'linux')).toEqual({ cmd: 'cp', args: ['-f', '/t', '/etc/hosts'] });
        const win = hostsCopyCommand('C:/t', 'C:/hosts', 'win32');
        expect(win.cmd).toBe('cmd');
        expect(win.args).toContain('copy');
    });
});
