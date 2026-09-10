import { describe, expect, it, vi } from 'vitest';
import { buildHostReconcileEffects, type HostEffectIo, type HostEffectPaths } from '../host-effects';
import { reconcileHostSites } from '../host-reconcile';
import { PRIVILEGED_STEP_EXIT_BASE } from '../elevate';

/**
 * ONE administrator approval per reconcile pass (genie#604).
 *
 * Enabling a browser-exposed `.gen` site needs two privileged things — the CA
 * into the trust store and the `.gen` line into the OS hosts file. Each used to
 * elevate on its own, so the owner answered TWO UAC shields for one action. The
 * pass now collects every privileged step it needs and runs them under a single
 * elevation.
 *
 * This is the acceptance test for that: drive the real effect wiring (fake io,
 * unprivileged, linux ⇒ pkexec) through the real reconcile brain and count the
 * elevations. It is deliberately end-to-end across the seam — the per-platform
 * command strings are asserted in elevate.test.ts, and the staging in
 * host-effects.test.ts, but only this level can prove the COUNT.
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

/** A fake host: no CA on disk (⇒ a mint + trust install is owed) and a hosts
 *  file with no Genie block (⇒ a hosts write is owed). Unprivileged, so every
 *  privileged run routes through the launcher. */
function fakeHost(over: Partial<HostEffectIo> = {}) {
    const files = new Map<string, string>([['/etc/hosts', '127.0.0.1\tlocalhost\n']]);
    const spawn = vi.fn().mockResolvedValue({ code: 0 });
    const io: HostEffectIo = {
        platform: 'linux',
        readFile: async (p: string) => files.get(p) ?? null,
        writeFile: async (p: string, c: string) => {
            files.set(p, c);
        },
        tempFile: async (c: string) => {
            files.set('/tmp/hosts.new', c);
            return '/tmp/hosts.new';
        },
        spawn,
        spawnDetached: vi.fn().mockResolvedValue({ ok: true }),
        isElevated: () => false, // a normal desktop: every privileged run prompts
        ...over,
    };
    /** The spawns that put an administrator prompt on screen. */
    const elevations = () => spawn.mock.calls.filter((c) => c[0] === 'pkexec');
    return { io, files, spawn, elevations };
}

describe('one elevation per reconcile pass (genie#604)', () => {
    it('asks for ONE approval when a pass needs BOTH the CA trust install and a hosts write', async () => {
        const host = fakeHost();
        const fx = buildHostReconcileEffects(PATHS, host.io);

        const res = await reconcileHostSites({ names: ['moic.gen'], routes: [{ genName: 'moic.gen', port: 8080 }] }, fx);

        expect(res.caCreated).toBe(true); // a CA was minted ⇒ a trust install is owed
        expect(res.hostsChanged).toBe(true); // the hosts file gained the name
        expect(host.elevations()).toHaveLength(1);
    });

    it('asks for ONE UAC shield on Windows, carrying certutil AND the hosts copy', async () => {
        const host = fakeHost({ platform: 'win32' });
        const fx = buildHostReconcileEffects(
            { ...PATHS, hostsFilePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts' },
            host.io,
        );

        await reconcileHostSites({ names: ['moic.gen'], routes: [{ genName: 'moic.gen', port: 8080 }] }, fx);

        const shields = host.spawn.mock.calls.filter((c) => String(c[0]).toLowerCase().includes('powershell'));
        expect(shields).toHaveLength(1);
        const script = Buffer.from(
            String(shields[0][1].join(' ')).match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/)![1],
            'base64',
        ).toString('utf16le');
        expect(script).toContain('certutil');
        expect(script).toContain('drivers\\etc\\hosts');
    });

    it('prompts for NOTHING on a second pass that is already in sync', async () => {
        const host = fakeHost();
        const fx = buildHostReconcileEffects(PATHS, host.io);
        await reconcileHostSites({ names: ['moic.gen'], routes: [{ genName: 'moic.gen', port: 8080 }] }, fx);
        // The first pass wrote the hosts file for real (the fake copies it through).
        host.files.set('/etc/hosts', host.files.get('/tmp/hosts.new')!);
        host.spawn.mockClear();

        const res = await reconcileHostSites({ names: ['moic.gen'], routes: [{ genName: 'moic.gen', port: 8080 }] }, fx);

        expect(res.caCreated).toBe(false);
        expect(res.hostsChanged).toBe(false);
        expect(host.elevations()).toHaveLength(0);
    });

    it('still names WHICH action failed, even though both shared one prompt', async () => {
        // The batch reports the failing step's index in its exit code; the effects
        // turn that back into the sentence the owner used to get from the separate
        // per-action calls.
        const host = fakeHost({
            spawn: vi.fn().mockImplementation(async (cmd: string) =>
                cmd === 'pkexec' ? { code: PRIVILEGED_STEP_EXIT_BASE + 1, stderr: 'cp: read-only file system' } : { code: 0 },
            ),
        });
        const fx = buildHostReconcileEffects(PATHS, host.io);

        await expect(reconcileHostSites({ names: ['moic.gen'], routes: [{ genName: 'moic.gen', port: 8080 }] }, fx)).rejects.toThrow(
            /Genie could not update the hosts file: cp: read-only file system/,
        );
    });
});
