import { describe, expect, it, vi } from 'vitest';
import { reconcileHostSites, type HostReconcileEffects } from '../host-reconcile';
import { generateGenCa } from '../host-ca';
import { upsertGenHostsBlock } from '../hosts-file';
import type { PrivilegedStep } from '../elevate';

/**
 * The host-native reconcile brain (story #238): given the machine's live host
 * sites, make the host match — ensure a trusted CA, issue the multi-SAN leaf,
 * reconcile the OS hosts file, and write + reload the host Caddyfile. All side
 * effects are injected so the orchestration (what gets installed/issued/written,
 * and when) is testable without a real Caddy, trust store, or elevation.
 *
 * Since genie#604 the brain also owns the ELEVATION BUDGET: it stages the
 * privileged steps a pass needs and hands them to `applyPrivileged` exactly
 * once — one administrator prompt per pass, and none when nothing is owed.
 */
const CA_TRUST_STEP: PrivilegedStep = {
    id: 'ca-trust',
    label: 'install its local CA into the trust store',
    run: { cmd: 'trust', args: ['anchor', '/g/gen-ca.crt'] },
};
const HOSTS_STEP: PrivilegedStep = {
    id: 'hosts-file',
    label: 'update the hosts file',
    run: { cmd: 'cp', args: ['-f', '/tmp/hosts.new', '/etc/hosts'] },
};

/** A fake hosts file that only actually changes when the staged write is APPLIED
 *  — the same two-phase shape the real effects have, so "already in sync on the
 *  second pass" means what it means on a real machine. */
function fakeHostsIo(initial = '127.0.0.1\tlocalhost\n') {
    let content = initial;
    let pending: string | null = null;
    return {
        read: async () => content,
        prepareWrite: vi.fn().mockImplementation(async (next: string) => {
            pending = next;
            return HOSTS_STEP;
        }),
        commit: () => {
            if (pending !== null) content = pending;
            pending = null;
        },
    };
}

/** A CA store that actually PERSISTS what it is given, so a second reconcile
 *  finds the CA the first one minted — the difference between "the steady state
 *  prompts for nothing" and a fake that re-mints on every pass. */
function fakeCaStore() {
    let material: { caPem: string; caKeyPem: string } | null = null;
    return {
        readCert: async () => material?.caPem ?? null,
        readKey: async () => material?.caKeyPem ?? null,
        write: vi.fn().mockImplementation(async (m: { caPem: string; caKeyPem: string }) => {
            material = m;
        }),
    };
}

function fakeEffects(over: Partial<HostReconcileEffects> & { hostsIo?: ReturnType<typeof fakeHostsIo> } = {}) {
    const hostsIo = over.hostsIo ?? fakeHostsIo();
    const fx: HostReconcileEffects = {
        caStore: fakeCaStore(),
        writeLeaf: vi.fn().mockResolvedValue({ certPath: '/g/leaf.crt', keyPath: '/g/leaf.key' }),
        prepareCaTrust: vi.fn().mockResolvedValue(CA_TRUST_STEP),
        hostsIo: { read: hostsIo.read, prepareWrite: hostsIo.prepareWrite },
        applyPrivileged: vi.fn().mockImplementation(async (steps: PrivilegedStep[]) => {
            if (steps.some((s) => s.id === 'hosts-file')) hostsIo.commit();
        }),
        writeCaddyfileAndReload: vi.fn().mockResolvedValue(undefined),
        ...over,
    };
    return fx;
}

/** The steps handed to the single `applyPrivileged` call, by id. */
function batched(fx: HostReconcileEffects): string[] {
    const calls = (fx.applyPrivileged as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    return (calls[0][0] as PrivilegedStep[]).map((s) => s.id);
}

describe('reconcileHostSites', () => {
    it('mints + trusts a CA, issues a leaf, writes hosts + a Caddyfile that uses the leaf', async () => {
        const fx = fakeEffects();
        const res = await reconcileHostSites([{ genName: 'moic.gen', port: 8080 }], fx);

        expect(res.caCreated).toBe(true);
        expect(fx.prepareCaTrust).toHaveBeenCalledOnce(); // new CA ⇒ install into trust store
        expect(fx.writeLeaf).toHaveBeenCalledOnce();
        // The leaf covers the site's name.
        const leafArg = (fx.writeLeaf as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(leafArg.certPem).toContain('CERTIFICATE');
        // The reloaded Caddyfile serves the site with the freshly-written leaf paths.
        const cf = (fx.writeCaddyfileAndReload as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(cf).toContain('moic.gen:443 {');
        expect(cf).toContain('reverse_proxy 127.0.0.1:8080');
        expect(cf).toContain('tls "/g/leaf.crt" "/g/leaf.key"');
        // The hosts file gained the name.
        expect(res.hostsChanged).toBe(true);
        expect(fx.hostsIo.prepareWrite).toHaveBeenCalledOnce();
        expect((fx.hostsIo.prepareWrite as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('127.0.0.1\tmoic.gen');
    });

    it('takes ONE elevation carrying BOTH the trust install and the hosts write (genie#604)', async () => {
        const fx = fakeEffects();
        await reconcileHostSites([{ genName: 'moic.gen', port: 8080 }], fx);
        expect(batched(fx)).toEqual(['ca-trust', 'hosts-file']);
    });

    it('does NOT re-install trust when a valid CA already exists', async () => {
        const existing = generateGenCa();
        const fx = fakeEffects({
            caStore: {
                readCert: async () => existing.caPem,
                readKey: async () => existing.caKeyPem,
                write: vi.fn(),
            },
        });
        const res = await reconcileHostSites([{ genName: 'app.gen', port: 5173 }], fx);
        expect(res.caCreated).toBe(false);
        expect(fx.prepareCaTrust).not.toHaveBeenCalled();
        expect(fx.caStore.write).not.toHaveBeenCalled();
        expect(fx.writeLeaf).toHaveBeenCalledOnce(); // still (re)issues the leaf
        // …and the one elevation carries ONLY the hosts write.
        expect(batched(fx)).toEqual(['hosts-file']);
    });

    it('elevates for the CA ALONE when the hosts file is already in sync', async () => {
        // The batch must not drag an unneeded action along just because a sibling
        // action needs the prompt (the skip-when-unchanged guarantee, per action).
        const fx = fakeEffects({
            hostsIo: fakeHostsIo(upsertGenHostsBlock('127.0.0.1\tlocalhost\n', ['moic.gen'])),
        });
        const res = await reconcileHostSites([{ genName: 'moic.gen', port: 8080 }], fx);
        expect(res.caCreated).toBe(true);
        expect(res.hostsChanged).toBe(false);
        expect(fx.hostsIo.prepareWrite).not.toHaveBeenCalled();
        expect(batched(fx)).toEqual(['ca-trust']);
    });

    it('with zero sites: no leaf, hosts block removed, empty Caddyfile reloaded', async () => {
        const fx = fakeEffects({
            hostsIo: fakeHostsIo(
                '127.0.0.1\tlocalhost\n# BEGIN GENIE SITES\n127.0.0.1\told.gen\n::1\told.gen\n# END GENIE SITES\n',
            ),
        });
        const res = await reconcileHostSites([], fx);
        expect(fx.writeLeaf).not.toHaveBeenCalled();
        expect(res.genNames).toEqual([]);
        const cf = (fx.writeCaddyfileAndReload as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(cf).not.toContain('reverse_proxy');
        // The stale hosts block is removed.
        expect((fx.hostsIo.prepareWrite as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toContain('old.gen');
        // A DRAIN must never mint/install a CA — a teardown can't trigger the
        // one-time Administrator trust prompt (the machine has no CA here).
        expect(fx.prepareCaTrust).not.toHaveBeenCalled();
        expect(batched(fx)).toEqual(['hosts-file']);
        expect(res.caCreated).toBe(false);
    });

    it('dedupes + sorts sites so the Caddyfile is deterministic', async () => {
        const fx = fakeEffects();
        const res = await reconcileHostSites(
            [
                { genName: 'b.gen', port: 2 },
                { genName: 'a.gen', port: 1 },
                { genName: 'b.gen', port: 2 },
            ],
            fx,
        );
        expect(res.genNames).toEqual(['a.gen', 'b.gen']);
        const cf = (fx.writeCaddyfileAndReload as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(cf.indexOf('a.gen:443')).toBeLessThan(cf.indexOf('b.gen:443'));
    });

    it('reports hostsChanged=false — and prompts for NOTHING — when everything is in sync', async () => {
        // First reconcile syncs the file; a second identical run must not rewrite it
        // and must not elevate at all.
        const fx = fakeEffects();
        await reconcileHostSites([{ genName: 'moic.gen', port: 8080 }], fx);
        (fx.hostsIo.prepareWrite as ReturnType<typeof vi.fn>).mockClear();
        (fx.applyPrivileged as ReturnType<typeof vi.fn>).mockClear();
        (fx.prepareCaTrust as ReturnType<typeof vi.fn>).mockClear();

        const res2 = await reconcileHostSites([{ genName: 'moic.gen', port: 8080 }], fx);
        expect(res2.hostsChanged).toBe(false);
        expect(fx.hostsIo.prepareWrite).not.toHaveBeenCalled();
        expect(fx.prepareCaTrust).not.toHaveBeenCalled();
        expect(fx.applyPrivileged).not.toHaveBeenCalled();
    });

    it('propagates a privileged failure so the caller can report WHICH action failed', async () => {
        const fx = fakeEffects({
            applyPrivileged: vi.fn().mockRejectedValue(new Error('Genie could not update the hosts file: read-only')),
        });
        await expect(reconcileHostSites([{ genName: 'moic.gen', port: 8080 }], fx)).rejects.toThrow(
            /could not update the hosts file/,
        );
        // A failed elevation must not leave a half-configured Caddy serving the name.
        expect(fx.writeCaddyfileAndReload).not.toHaveBeenCalled();
    });
});
