import { describe, expect, it, vi } from 'vitest';
import { reconcileHostSites, type HostReconcileEffects } from '../host-reconcile';
import { generateGenCa } from '../host-ca';

/**
 * The host-native reconcile brain (story #238): given the machine's live host
 * sites, make the host match — ensure a trusted CA, issue the multi-SAN leaf,
 * reconcile the OS hosts file, and write + reload the host Caddyfile. All side
 * effects are injected so the orchestration (what gets installed/issued/written,
 * and when) is testable without a real Caddy, trust store, or elevation.
 */
function fakeEffects(over: Partial<HostReconcileEffects> = {}): HostReconcileEffects {
    let hosts = '127.0.0.1\tlocalhost\n';
    return {
        caStore: {
            readCert: async () => null,
            readKey: async () => null,
            write: vi.fn().mockResolvedValue(undefined),
        },
        writeLeaf: vi.fn().mockResolvedValue({ certPath: '/g/leaf.crt', keyPath: '/g/leaf.key' }),
        installCaTrust: vi.fn().mockResolvedValue(undefined),
        hostsIo: {
            read: async () => hosts,
            write: vi.fn().mockImplementation(async (next: string) => {
                hosts = next;
            }),
        },
        writeCaddyfileAndReload: vi.fn().mockResolvedValue(undefined),
        ...over,
    };
}

describe('reconcileHostSites', () => {
    it('mints + trusts a CA, issues a leaf, writes hosts + a Caddyfile that uses the leaf', async () => {
        const fx = fakeEffects();
        const res = await reconcileHostSites([{ genName: 'moic.gen', port: 8080 }], fx);

        expect(res.caCreated).toBe(true);
        expect(fx.installCaTrust).toHaveBeenCalledOnce(); // new CA ⇒ install into trust store
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
        expect(fx.hostsIo.write).toHaveBeenCalledOnce();
        expect((fx.hostsIo.write as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('127.0.0.1\tmoic.gen');
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
        expect(fx.installCaTrust).not.toHaveBeenCalled();
        expect(fx.caStore.write).not.toHaveBeenCalled();
        expect(fx.writeLeaf).toHaveBeenCalledOnce(); // still (re)issues the leaf
    });

    it('with zero sites: no leaf, hosts block removed, empty Caddyfile reloaded', async () => {
        const fx = fakeEffects({ hostsIo: (() => {
            let hosts = '127.0.0.1\tlocalhost\n# BEGIN GENIE SITES\n127.0.0.1\told.gen\n::1\told.gen\n# END GENIE SITES\n';
            return { read: async () => hosts, write: vi.fn().mockImplementation(async (n: string) => { hosts = n; }) };
        })() });
        const res = await reconcileHostSites([], fx);
        expect(fx.writeLeaf).not.toHaveBeenCalled();
        expect(res.genNames).toEqual([]);
        const cf = (fx.writeCaddyfileAndReload as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(cf).not.toContain('reverse_proxy');
        // The stale hosts block is removed.
        expect((fx.hostsIo.write as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toContain('old.gen');
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

    it('reports hostsChanged=false when the hosts file is already in sync', async () => {
        // First reconcile syncs the file; a second identical run must not rewrite it.
        const fx = fakeEffects();
        await reconcileHostSites([{ genName: 'moic.gen', port: 8080 }], fx);
        (fx.hostsIo.write as ReturnType<typeof vi.fn>).mockClear();
        const res2 = await reconcileHostSites([{ genName: 'moic.gen', port: 8080 }], fx);
        expect(res2.hostsChanged).toBe(false);
        expect(fx.hostsIo.write).not.toHaveBeenCalled();
    });
});
