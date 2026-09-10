import { buildHostCaddyfile } from './host-caddyfile';
import { issueGenLeaf, loadOrCreateGenCa, type GenCaStore } from './host-ca';
import type { PrivilegedStep } from './elevate';
import { stageHostsFile } from './hosts-file';

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
 *
 * It takes a {@link HostReconcilePlan} rather than one list because its two
 * artifacts have different lifetimes (genie#624): the hosts block follows the
 * CONFIGURED sites, the Caddyfile follows the RUNNING ones. Building both from the
 * running set is what made every site start and stop rewrite an Administrator-owned
 * file, and so prompt.
 *
 * It also owns the pass's ELEVATION BUDGET (genie#604). The two privileged
 * actions — the trust-store install and the hosts write — used to elevate
 * separately, so enabling one browser-exposed site cost the user two
 * administrator approvals. They are now STAGED as they become necessary and run
 * together under a single elevation; a pass that needs neither elevates not at
 * all, which is the steady state.
 */

export interface HostSiteRoute {
    /** The `.gen` name this site answers on. */
    genName: string;
    /** The upstream port on the HOST's loopback — a host-native dev server's plain
     *  port, or (for a container site) its sandbox Caddy's published https port. */
    port: number;
    /** Upstream `Host` override for host-checking frameworks (Django/Vite). */
    upstreamHost?: string;
    /** `https-insecure` for a container site (reach its self-signed sandbox Caddy);
     *  omitted/`http` for a host-native dev server. */
    upstreamScheme?: 'http' | 'https-insecure';
}

/**
 * What ONE pass must make true on the host. Its two halves have deliberately
 * DIFFERENT lifetimes (genie#624).
 *
 * `names` is the CONFIGURED set: every `.gen` name the machine is set up to serve
 * to a real browser, whether or not anything is running behind it. `routes` is the
 * RUNNING set, and carries the live loopback port — which is precisely why it
 * cannot answer for the hosts file: a stopped site has no port.
 *
 * The split exists because exactly one artifact here is privileged. The hosts file
 * needs Administrator/root, so its content must move only when a person changes
 * the CONFIGURATION — adding or removing a browser-exposed site, which is a moment
 * they expect a prompt. The Caddyfile is written unprivileged and may therefore
 * churn freely with every start, stop and restart, which is what it must do to
 * point at a port that only exists while the site is up.
 */
export interface HostReconcilePlan {
    /** CONFIGURED browser-exposed `.gen` names → the hosts block and the leaf SANs. */
    names: string[];
    /** RUNNING routes (name + live port) → the Caddyfile, and nothing else. */
    routes: HostSiteRoute[];
}

export interface HostReconcileEffects {
    /** Persisted CA store (cert + key). */
    caStore: GenCaStore;
    /** Persist the freshly-issued leaf, returning the paths Caddy's `tls` references. */
    writeLeaf: (leaf: { certPem: string; keyPem: string }) => Promise<{ certPath: string; keyPath: string }>;
    /** Stage the CA cert on disk and return the privileged trust-store install to
     *  run. Called ONLY when a new CA was minted — an existing, still-valid CA is
     *  already trusted, so nothing is staged and nothing prompts. */
    prepareCaTrust: (caPem: string) => Promise<PrivilegedStep>;
    /** The hosts-file reader + stager. `prepareWrite` writes NOTHING privileged:
     *  it stages the new content and returns the copy to run under the pass's one
     *  elevation. */
    hostsIo: { read: () => Promise<string>; prepareWrite: (next: string) => Promise<PrivilegedStep> };
    /** Run every step this pass staged under a SINGLE elevation, throwing an error
     *  that names the step that failed. The brain calls it only when something was
     *  staged; an empty list is a no-op that elevates nothing. */
    applyPrivileged: (steps: PrivilegedStep[]) => Promise<void>;
    /** Write the host Caddyfile and reload the host Caddy. */
    writeCaddyfileAndReload: (caddyfile: string) => Promise<void>;
}

export interface HostReconcileResult {
    /** A new CA was minted this run (⇒ the trust-store install ran). */
    caCreated: boolean;
    /** The sorted, de-duplicated `.gen` names now RESOLVABLE — the hosts block and
     *  the leaf's SANs. Configured, not running: most of these have a Caddy vhost,
     *  and a stopped one deliberately does not. */
    genNames: string[];
    /** The Caddyfile handed to {@link HostReconcileEffects.writeCaddyfileAndReload}. */
    caddyfile: string;
    /** The hosts file was rewritten this run (false ⇒ already in sync, no prompt). */
    hostsChanged: boolean;
}

/**
 * Reconcile the host to `plan`. Idempotent: an unchanged plan re-issues the leaf
 * and rewrites the (byte-identical) Caddyfile but does NOT rewrite the hosts file
 * or re-prompt for CA trust. A plan whose `routes` changed while its `names` did
 * not — every start, stop and restart — rewrites only the unprivileged Caddyfile.
 */
export async function reconcileHostSites(
    plan: HostReconcilePlan,
    fx: HostReconcileEffects,
): Promise<HostReconcileResult> {
    // Dedupe by name (last wins) + sort, so the leaf SANs and the Caddyfile are
    // deterministic and a no-op run is a true no-op.
    const bySite = new Map<string, HostSiteRoute>();
    for (const s of plan.routes) bySite.set(s.genName, s);
    const routes = [...bySite.values()].sort((a, b) => a.genName.localeCompare(b.genName));

    // The NAME set — the hosts block and the leaf SANs — is the CONFIGURED set
    // (genie#624), which is why a start or a stop no longer moves it and no longer
    // costs an administrator prompt. `routes` is unioned in only to keep one
    // invariant: every vhost Caddy serves must have a hosts entry and a SAN. The
    // two sets differ in exactly one situation — a site deleted from the envelope
    // while its process is still up — and there the alternative to the union is a
    // browser TLS error with nothing to explain it.
    const genNames = [...new Set([...plan.names, ...routes.map((r) => r.genName)])].sort((a, b) =>
        a.localeCompare(b),
    );

    // The privileged work this pass owes, collected rather than performed: every
    // step runs under ONE elevation at step 3½, so enabling a browser-exposed site
    // costs the user a single administrator approval instead of one per action
    // (genie#604). Each step is added only when it is genuinely needed, so a pass
    // that owes nothing elevates not at all.
    const privileged: PrivilegedStep[] = [];

    // 1 + 2. Ensure a trusted CA and issue ONE multi-SAN leaf — but ONLY when there
    //    are sites to serve. An empty reconcile is a DRAIN (clear the hosts block +
    //    write a bare Caddyfile); it needs no cert and must NEVER mint/install a CA,
    //    so a teardown can never trigger the one-time Administrator trust prompt.
    let tls = { certPath: '', keyPath: '' };
    let created = false;
    if (genNames.length > 0) {
        const ca = await loadOrCreateGenCa(fx.caStore);
        created = ca.created;
        // Install into the trust store ONLY when a new CA was minted (an existing,
        // still-valid CA is already trusted).
        if (created) privileged.push(await fx.prepareCaTrust(ca.material.caPem));
        const leaf = issueGenLeaf(ca.material, genNames);
        tls = await fx.writeLeaf(leaf);
    }

    // 3. Reconcile the OS hosts file (adds/removes our block; only stages — and so
    //    only contributes to the elevation — when something actually changed).
    const staged = await stageHostsFile(genNames, fx.hostsIo);
    const hostsChanged = staged.changed;
    if (staged.changed) privileged.push(staged.step);

    // 3½. ONE prompt, carrying everything above. Throws naming the failing step, so
    //     Caddy is never left serving a name whose cert nobody trusts.
    if (privileged.length > 0) await fx.applyPrivileged(privileged);

    // 4. Write + reload the host Caddyfile pointing every vhost at the new leaf.
    const caddyfile = buildHostCaddyfile(
        routes.map((r) => ({
            host: r.genName,
            port: r.port,
            ...(r.upstreamHost ? { upstreamHost: r.upstreamHost } : {}),
            ...(r.upstreamScheme ? { upstreamScheme: r.upstreamScheme } : {}),
        })),
        tls,
    );
    await fx.writeCaddyfileAndReload(caddyfile);

    return { caCreated: created, genNames, caddyfile, hostsChanged };
}
