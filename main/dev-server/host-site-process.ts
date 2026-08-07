import { planHostAllowlist } from './host-allowlist';
import type { DevSiteConfig } from './sites-config';

/**
 * The env a host-native site process runs with (story #238, task #672).
 *
 * A host-native site is the user's serve command run as a HOST process (not inside
 * the sandbox), so it reaches the workspace's Genie-managed services on their
 * PUBLISHED loopback ports — the same host-form env terminals + `manageProcess`
 * already get (beta.237, terminal/ipc.ts). The composition mirrors the sandbox
 * path's precedence exactly (site-manager.ts), so switching a site to host-native
 * changes only WHERE it runs, not which values win:
 *   1. GENIE_HOST_GATEWAY — weakest, user-overridable. On the host, `localhost`
 *      already IS the host, so it's plain loopback (in the sandbox it was the
 *      host-gateway address a container needs to escape its netns).
 *   2. the host-allowlist plan — Genie's guess at making a framework accept the
 *      `.gen` Host (Django ALLOWED_HOSTS, Vite allowedHosts, …).
 *   3. the site's OWN pinned env.
 *   4. the workspace SERVICE env (host-form) — injected LAST, and it WINS: it names
 *      the real engine on 127.0.0.1:<published port>.
 */

/** On the host, services bind loopback directly — no host-gateway hop. */
const HOST_LOOPBACK = '127.0.0.1';

export function composeHostSiteEnv(
    config: DevSiteConfig,
    command: string[],
    serviceHostEnv: Record<string, string>,
): Record<string, string> {
    return {
        GENIE_HOST_GATEWAY: HOST_LOOPBACK,
        ...planHostAllowlist({
            genName: config.genName,
            ...(config.framework ? { framework: config.framework } : {}),
            ...(config.stack ? { stack: config.stack } : {}),
            ...(config.server ? { server: config.server } : {}),
            command,
            ...(config.upstreamHost ? { upstreamHost: config.upstreamHost } : {}),
        }).env,
        ...(config.env ?? {}),
        ...serviceHostEnv,
    };
}
