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

/** A plan whose CONFIGURED names are exactly its RUNNING routes — the shape every
 *  test below the genie#624 block describes, where the two sets coincide. */
function plan(routes: Array<{ genName: string; port: number }>) {
    return { names: routes.map((r) => r.genName), routes };
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
        const res = await reconcileHostSites(plan([{ genName: 'moic.gen', port: 8080 }]), fx);

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
        await reconcileHostSites(plan([{ genName: 'moic.gen', port: 8080 }]), fx);
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
        const res = await reconcileHostSites(plan([{ genName: 'app.gen', port: 5173 }]), fx);
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
        const res = await reconcileHostSites(plan([{ genName: 'moic.gen', port: 8080 }]), fx);
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
        const res = await reconcileHostSites(plan([]), fx);
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
            plan([
                { genName: 'b.gen', port: 2 },
                { genName: 'a.gen', port: 1 },
                { genName: 'b.gen', port: 2 },
            ]),
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
        await reconcileHostSites(plan([{ genName: 'moic.gen', port: 8080 }]), fx);
        (fx.hostsIo.prepareWrite as ReturnType<typeof vi.fn>).mockClear();
        (fx.applyPrivileged as ReturnType<typeof vi.fn>).mockClear();
        (fx.prepareCaTrust as ReturnType<typeof vi.fn>).mockClear();

        const res2 = await reconcileHostSites(plan([{ genName: 'moic.gen', port: 8080 }]), fx);
        expect(res2.hostsChanged).toBe(false);
        expect(fx.hostsIo.prepareWrite).not.toHaveBeenCalled();
        expect(fx.prepareCaTrust).not.toHaveBeenCalled();
        expect(fx.applyPrivileged).not.toHaveBeenCalled();
    });

    it('propagates a privileged failure so the caller can report WHICH action failed', async () => {
        const fx = fakeEffects({
            applyPrivileged: vi.fn().mockRejectedValue(new Error('Genie could not update the hosts file: read-only')),
        });
        await expect(reconcileHostSites(plan([{ genName: 'moic.gen', port: 8080 }]), fx)).rejects.toThrow(
            /could not update the hosts file/,
        );
        // A failed elevation must not leave a half-configured Caddy serving the name.
        expect(fx.writeCaddyfileAndReload).not.toHaveBeenCalled();
    });
});

/**
 * genie#624 — the elevated artifact must hold still while the unprivileged one moves.
 *
 * Both artifacts used to be built from the RUNNING set: a start added a name, a
 * stop removed one, so the hosts file genuinely differed on every lifecycle event
 * and its Administrator write fired every time. `hostsBlockNeedsUpdate` was right
 * all along — the content really had changed. The fix is upstream of it: the hosts
 * block tracks what is CONFIGURED, and only the Caddyfile tracks what is running.
 */
describe('the hosts file follows CONFIGURED sites; the Caddyfile follows RUNNING ones', () => {
    it('a site STARTING rewrites the Caddyfile and does not touch the hosts file', async () => {
        const fx = fakeEffects();
        // Configured, nothing running: the name is already resolvable.
        await reconcileHostSites({ names: ['moic.gen'], routes: [] }, fx);
        expect(fx.hostsIo.prepareWrite).toHaveBeenCalledOnce();
        (fx.applyPrivileged as ReturnType<typeof vi.fn>).mockClear();

        // …and now it starts.
        const res = await reconcileHostSites(
            { names: ['moic.gen'], routes: [{ genName: 'moic.gen', port: 8080 }] },
            fx,
        );

        expect(res.hostsChanged).toBe(false);
        expect(fx.hostsIo.prepareWrite).toHaveBeenCalledOnce(); // still just the first one
        expect(fx.applyPrivileged).not.toHaveBeenCalled(); // ⇒ no administrator prompt
        // The Caddyfile, which costs nothing to write, DID move — it has to, since
        // the port only exists while the site is up.
        const cf = (fx.writeCaddyfileAndReload as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
        expect(cf).toContain('reverse_proxy 127.0.0.1:8080');
    });

    it('a site STOPPING drops its Caddy vhost and leaves the hosts entry alone', async () => {
        const fx = fakeEffects();
        await reconcileHostSites(
            { names: ['moic.gen'], routes: [{ genName: 'moic.gen', port: 8080 }] },
            fx,
        );
        (fx.hostsIo.prepareWrite as ReturnType<typeof vi.fn>).mockClear();
        (fx.applyPrivileged as ReturnType<typeof vi.fn>).mockClear();

        const res = await reconcileHostSites({ names: ['moic.gen'], routes: [] }, fx);

        expect(res.hostsChanged).toBe(false);
        expect(fx.hostsIo.prepareWrite).not.toHaveBeenCalled();
        expect(fx.applyPrivileged).not.toHaveBeenCalled();
        // `moic.gen` still resolves to 127.0.0.1 with nothing listening — a
        // connection refused, which beats a DNS failure and never claimed the
        // service was up.
        expect(res.genNames).toEqual(['moic.gen']);
        const cf = (fx.writeCaddyfileAndReload as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
        expect(cf).not.toContain('reverse_proxy');
    });

    it('a RESTART — stop then start — costs no elevation at all', async () => {
        const fx = fakeEffects();
        await reconcileHostSites({ names: ['moic.gen'], routes: [] }, fx);
        (fx.applyPrivileged as ReturnType<typeof vi.fn>).mockClear();

        for (const routes of [
            [{ genName: 'moic.gen', port: 8080 }],
            [],
            [{ genName: 'moic.gen', port: 8081 }],
        ]) {
            await reconcileHostSites({ names: ['moic.gen'], routes }, fx);
        }
        expect(fx.applyPrivileged).not.toHaveBeenCalled();
    });

    it('names a configured site in the hosts block and the LEAF before it ever runs', async () => {
        const fx = fakeEffects();
        const res = await reconcileHostSites({ names: ['moic.gen', 'api.gen'], routes: [] }, fx);
        expect(res.genNames).toEqual(['api.gen', 'moic.gen']);
        expect((fx.hostsIo.prepareWrite as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('127.0.0.1\tmoic.gen');
        // The leaf is issued over the configured set, so the certificate is already
        // right the moment a site comes up — the cert never lags the start.
        expect(fx.writeLeaf).toHaveBeenCalledOnce();
        // No vhost yet: nothing is listening, so there is no port to proxy to.
        const cf = (fx.writeCaddyfileAndReload as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(cf).not.toContain('reverse_proxy');
    });

    it('un-configuring the last site DRAINS the block — that prompt is the one a person expects', async () => {
        const fx = fakeEffects();
        await reconcileHostSites({ names: ['moic.gen'], routes: [] }, fx);
        (fx.hostsIo.prepareWrite as ReturnType<typeof vi.fn>).mockClear();

        const res = await reconcileHostSites({ names: [], routes: [] }, fx);
        expect(res.hostsChanged).toBe(true);
        expect((fx.hostsIo.prepareWrite as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toContain('moic.gen');
        expect(res.genNames).toEqual([]);
    });

    it('a boot that restores fifteen sites stages ONE hosts write, on the first pass', async () => {
        // The worst instance of the bug, and the one the owner counted: an upgrade
        // restores every enabled site, each start fires `onChanged`, and each pass
        // used to find one more name in the block than the last. genie#225 stopped
        // those passes STACKING their prompts; this stops them owing one. The names
        // are all configured before the first site is up, so pass 1 writes the block
        // and passes 2-15 find it already right.
        const fx = fakeEffects();
        const names = Array.from({ length: 15 }, (_, i) => `site-${i}.gen`);
        const routes: Array<{ genName: string; port: number }> = [];
        for (let i = 0; i < 15; i++) {
            routes.push({ genName: `site-${i}.gen`, port: 4000 + i });
            await reconcileHostSites({ names, routes: [...routes] }, fx);
        }
        expect(fx.applyPrivileged).toHaveBeenCalledOnce();
        expect(batched(fx)).toEqual(['ca-trust', 'hosts-file']);
    });

    it('covers a RUNNING route the configured set has lost, so Caddy never serves a name with no SAN', async () => {
        // The one case the two sets can disagree: a site deleted from the envelope
        // while its process is still up. The union keeps the invariant that every
        // vhost Caddy serves has a hosts entry and a SAN; the alternative is a TLS
        // error with no explanation. It costs a prompt in a state that is already
        // anomalous, and resolves the moment the site stops.
        const fx = fakeEffects();
        const res = await reconcileHostSites({ names: [], routes: [{ genName: 'orphan.gen', port: 9000 }] }, fx);
        expect(res.genNames).toEqual(['orphan.gen']);
        expect((fx.hostsIo.prepareWrite as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('orphan.gen');
    });
});
