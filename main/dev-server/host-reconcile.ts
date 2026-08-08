import { buildHostCaddyfile } from './host-caddyfile';
import { issueGenLeaf, loadOrCreateGenCa, type GenCaStore } from './host-ca';
import { reconcileHostsFile } from './hosts-file';

/**
 * The host-native reconcile brain: make the HOST match the machine's live set of
 * `.gen` sites in one idempotent pass. It ties together the four cores —
 * host-ca (trusted CA + multi-SAN leaf), hosts-file (OS name resolution), and
 * host-caddyfile (the :443 reverse proxy) — behind INJECTED side effects, so the
 * orchestration is unit-tested without a real Caddy, trust store, or elevation
 * prompt. The real caller wires the effects to the actual disk/trust-store/Caddy;
 * this module owns only the ordering and the "install/prompt only when needed"
 * logic.
 *
 * Order matters: a trusted CA + a leaf must exist BEFORE Caddy is told to serve
 * with it, and the hosts entry must exist for the name to resolve at all.
 */

export interface HostSiteRoute {
    /** The `.gen` name this site answers on. */
    genName: string;
    /** The app's plain-http port on the HOST's loopback. */
    port: number;
    /** Upstream `Host` override for host-checking frameworks (Django/Vite). */
    upstreamHost?: string;
}

export interface HostReconcileEffects {
    /** Persisted CA store (cert + key). */
    caStore: GenCaStore;
    /** Persist the freshly-issued leaf, returning the paths Caddy's `tls` references. */
    writeLeaf: (leaf: { certPem: string; keyPem: string }) => Promise<{ certPath: string; keyPath: string }>;
    /** Install the CA into the OS trust store (elevated). Called ONLY when a new CA
     *  was minted — so the one-time Administrator prompt fires once, not every run. */
    installCaTrust: (caPem: string) => Promise<void>;
    /** The hosts-file reader + (elevated) writer. */
    hostsIo: { read: () => Promise<string>; write: (next: string) => Promise<void> };
    /** Write the host Caddyfile and reload the host Caddy. */
    writeCaddyfileAndReload: (caddyfile: string) => Promise<void>;
}

export interface HostReconcileResult {
    /** A new CA was minted this run (⇒ the trust-store install ran). */
    caCreated: boolean;
    /** The sorted, de-duplicated `.gen` names now served. */
    genNames: string[];
    /** The Caddyfile handed to {@link HostReconcileEffects.writeCaddyfileAndReload}. */
    caddyfile: string;
    /** The hosts file was rewritten this run (false ⇒ already in sync, no prompt). */
    hostsChanged: boolean;
}

/**
 * Reconcile the host to `sites`. Idempotent: an unchanged set re-issues the leaf
 * and rewrites the (byte-identical) Caddyfile but does NOT rewrite the hosts file
 * or re-prompt for CA trust.
 */
export async function reconcileHostSites(
    sites: HostSiteRoute[],
    fx: HostReconcileEffects,
): Promise<HostReconcileResult> {
    // Dedupe by name (last wins) + sort, so the leaf SANs and the Caddyfile are
    // deterministic and a no-op run is a true no-op.
    const bySite = new Map<string, HostSiteRoute>();
    for (const s of sites) bySite.set(s.genName, s);
    const routes = [...bySite.values()].sort((a, b) => a.genName.localeCompare(b.genName));
    const genNames = routes.map((r) => r.genName);

    // 1. Ensure a trusted CA exists. Install into the trust store ONLY when a new
    //    one was minted (an existing, still-valid CA is already trusted).
    const { material, created } = await loadOrCreateGenCa(fx.caStore);
    if (created) await fx.installCaTrust(material.caPem);

    // 2. Issue ONE multi-SAN leaf over every current name (skip when there are no
    //    sites — an empty Caddyfile references no cert).
    let tls = { certPath: '', keyPath: '' };
    if (genNames.length > 0) {
        const leaf = issueGenLeaf(material, genNames);
        tls = await fx.writeLeaf(leaf);
    }

    // 3. Reconcile the OS hosts file (adds/removes our block; only writes — and only
    //    prompts for elevation — when something actually changed).
    const { changed: hostsChanged } = await reconcileHostsFile(genNames, fx.hostsIo);

    // 4. Write + reload the host Caddyfile pointing every vhost at the new leaf.
    const caddyfile = buildHostCaddyfile(
        routes.map((r) => ({
            host: r.genName,
            port: r.port,
            ...(r.upstreamHost ? { upstreamHost: r.upstreamHost } : {}),
        })),
        tls,
    );
    await fx.writeCaddyfileAndReload(caddyfile);

    return { caCreated: created, genNames, caddyfile, hostsChanged };
}
