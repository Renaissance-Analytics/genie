import { describe, expect, it, vi } from 'vitest';
import { buildHostReconcileEffects, hostsCopyCommand, type HostEffectIo, type HostEffectPaths } from '../host-effects';
import { PRIVILEGED_STEP_EXIT_BASE } from '../elevate';

/**
 * Wiring reconcileHostSites's injected effects to the real fs + host Caddy +
 * elevation (story #238). The orchestration (write-then-install, temp-then-copy,
 * loud throw on privileged failure) is unit-tested with a fake io; the real fs /
 * spawn leaves are exercised by CI E2E.
 *
 * Since genie#604 the privileged verbs come in two halves: `prepare…` does the
 * unprivileged staging and RETURNS the command to run, and `applyPrivileged`
 * runs everything the pass staged under one elevation. So the tests below check
 * two distinct things — that staging never prompts, and that the batch still
 * blames the right action when it fails.
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

    it('prepareCaTrust writes the cert and RETURNS the trust command — without running it', async () => {
        const io = fakeIo();
        const fx = buildHostReconcileEffects(PATHS, io);
        const step = await fx.prepareCaTrust('CAPEM');
        // The trust command reads the cert from disk, so staging must put it there.
        expect(io.writeFile).toHaveBeenCalledWith('/g/gen-ca.crt', 'CAPEM');
        expect(step.id).toBe('ca-trust');
        expect(step.run).toEqual({ cmd: 'trust', args: ['anchor', '/g/gen-ca.crt'] });
        // Staging is unprivileged: nothing spawned, nothing prompted.
        expect(io.spawn).not.toHaveBeenCalled();
    });

    it('hostsIo.prepareWrite stages a temp file and RETURNS the copy — without running it', async () => {
        const io = fakeIo();
        const fx = buildHostReconcileEffects(PATHS, io);
        const step = await fx.hostsIo.prepareWrite('NEWHOSTS');
        expect(io.tempFile).toHaveBeenCalledWith('NEWHOSTS');
        expect(step.id).toBe('hosts-file');
        expect(step.run).toEqual({ cmd: 'cp', args: ['-f', '/tmp/hosts.new', '/etc/hosts'] });
        expect(io.spawn).not.toHaveBeenCalled();
    });

    it('hostsIo.read returns "" when the hosts file is absent', async () => {
        const io = fakeIo({ readFile: vi.fn().mockResolvedValue(null) });
        const fx = buildHostReconcileEffects(PATHS, io);
        expect(await fx.hostsIo.read()).toBe('');
    });

    it('applyPrivileged does nothing at all for an empty batch', async () => {
        const io = fakeIo({ isElevated: () => false });
        const fx = buildHostReconcileEffects(PATHS, io);
        await fx.applyPrivileged([]);
        expect(io.spawn).not.toHaveBeenCalled();
    });

    it('applyPrivileged runs the staged commands directly when already privileged (CI root)', async () => {
        const io = fakeIo();
        const fx = buildHostReconcileEffects(PATHS, io);
        await fx.applyPrivileged([await fx.prepareCaTrust('CAPEM'), await fx.hostsIo.prepareWrite('NEWHOSTS')]);
        expect(io.spawn).toHaveBeenCalledWith('trust', ['anchor', '/g/gen-ca.crt']);
        expect(io.spawn).toHaveBeenCalledWith('cp', ['-f', '/tmp/hosts.new', '/etc/hosts']);
    });

    it('applyPrivileged takes ONE elevation for both staged commands (genie#604)', async () => {
        const io = fakeIo({ isElevated: () => false });
        const fx = buildHostReconcileEffects(PATHS, io);
        await fx.applyPrivileged([await fx.prepareCaTrust('CAPEM'), await fx.hostsIo.prepareWrite('NEWHOSTS')]);
        expect(io.spawn).toHaveBeenCalledOnce();
        const [cmd, args] = (io.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(cmd).toBe('pkexec');
        expect(args.join(' ')).toContain('anchor');
        expect(args.join(' ')).toContain('/etc/hosts');
    });

    it('applyPrivileged THROWS naming the CA trust install when THAT is what failed', async () => {
        const io = fakeIo({ spawn: vi.fn().mockResolvedValue({ code: 1, stderr: 'nope' }) });
        const fx = buildHostReconcileEffects(PATHS, io);
        const steps = [await fx.prepareCaTrust('CAPEM'), await fx.hostsIo.prepareWrite('NEWHOSTS')];
        await expect(fx.applyPrivileged(steps)).rejects.toThrow(
            /Genie could not install its local CA into the trust store: nope/,
        );
    });

    it('applyPrivileged THROWS naming the HOSTS write when that is the step that failed', async () => {
        // Unprivileged: one elevated batch, and the exit code says step 1 failed.
        const io = fakeIo({
            isElevated: () => false,
            spawn: vi.fn().mockResolvedValue({ code: PRIVILEGED_STEP_EXIT_BASE + 1, stderr: 'cp: read-only' }),
        });
        const fx = buildHostReconcileEffects(PATHS, io);
        const steps = [await fx.prepareCaTrust('CAPEM'), await fx.hostsIo.prepareWrite('NEWHOSTS')];
        await expect(fx.applyPrivileged(steps)).rejects.toThrow(/Genie could not update the hosts file: cp: read-only/);
    });

    it('applyPrivileged names every pending action when the ELEVATION itself failed', async () => {
        // A dismissed prompt blames no single step — but the message must still say
        // what Genie was trying to do, or the owner is left with a mystery.
        const io = fakeIo({
            isElevated: () => false,
            spawn: vi.fn().mockResolvedValue({ code: 126, stderr: 'Request dismissed' }),
        });
        const fx = buildHostReconcileEffects(PATHS, io);
        const steps = [await fx.prepareCaTrust('CAPEM'), await fx.hostsIo.prepareWrite('NEWHOSTS')];
        const err = await fx.applyPrivileged(steps).catch((e: Error) => e);
        expect(String(err)).toContain('install its local CA into the trust store');
        expect(String(err)).toContain('update the hosts file');
        expect(String(err)).toContain('Request dismissed');
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
        await fx.applyPrivileged([await fx.prepareCaTrust('CAPEM')]);
        // linux unprivileged ⇒ pkexec runs the batch script.
        const [cmd, args] = (io.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(cmd).toBe('pkexec');
        expect(args.join(' ')).toContain(`'trust' 'anchor' '/g/gen-ca.crt'`);
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
