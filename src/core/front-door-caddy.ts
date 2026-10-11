import type { GenRoute } from './gen-router.js';

/**
 * THE EXTERNAL-BROWSER PATH (§6.6) — what Genie's bundled Caddy serves on 443 so Chrome/Edge reach
 * `https://<name>.gen`: one site block per route with `tls internal` (Caddy's own local CA, whose
 * root `caddy trust` installs into the OS store once) and a reverse_proxy to the site's loopback
 * target; http redirects to https. Bound to loopback only. The in-app browser does not need any of
 * this — it goes through the loopback front door directly.
 */

const LOOPBACK_TARGET = /^127\.0\.0\.1:\d{1,5}$/;

export function frontDoorCaddyfile(routes: readonly GenRoute[]): string {
    for (const r of routes) if (!LOOPBACK_TARGET.test(r.target)) throw new Error(`${r.host} → ${r.target}: the front door proxies loopback targets only`);
    const blocks: string[] = ['{\n\tdefault_bind 127.0.0.1\n\tauto_https disable_redirects\n}'];
    for (const r of routes) blocks.push(`https://${r.host} {\n\ttls internal\n\treverse_proxy ${r.target}\n}`);
    if (routes.length > 0) blocks.push(`${routes.map((r) => `http://${r.host}`).join(', ')} {\n\tredir https://{host}{uri} permanent\n}`);
    return `${blocks.join('\n\n')}\n`;
}

export interface TrustPlan {
    readonly command: string;
    readonly args: string[];
    readonly env: Record<string, string>;
    readonly elevates: true;
    readonly note: string;
}

/** `caddy trust` against Genie's own Caddy data dir — the one elevation the external path needs. */
export function trustPlan(caddyBin: string, caddyDir: string): TrustPlan {
    return {
        command: caddyBin,
        args: ['trust', '--config', `${caddyDir}/Caddyfile`, '--adapter', 'caddyfile'],
        env: { XDG_DATA_HOME: `${caddyDir}/data`, XDG_CONFIG_HOME: `${caddyDir}/config` },
        elevates: true,
        note: 'Installs Genie’s local root certificate into the system trust store so browsers accept https://<name>.gen. Your OS will ask for permission once.',
    };
}

export function hostsFilePath(platform: NodeJS.Platform): string {
    return platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
}
