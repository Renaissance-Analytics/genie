import { buildCaddyfile, type CaddySite } from './caddyfile';
import type { ContainerRuntime } from './container-runtime';

/**
 * The per-workspace Caddy, driven inside the sandbox.
 *
 * Caddy runs in the SAME container as the app processes. This module keeps its
 * config in sync with the enabled sites: it writes the generated Caddyfile to a
 * container-internal path and then RELOADs a running Caddy — or STARTs it if it
 * isn't up yet. One idempotent converge step, so a call from sandbox-ensure /
 * site-start / site-stop always lands the same way. Never throws.
 */

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Where Caddy's config + data live inside the sandbox.
 *
 * `/tmp`, not `/run`: the sandbox runs as the NON-ROOT `genie` user (the dev
 * image renumbers it to the host uid), and `/run` is root-owned — so `mkdir`
 * there fails with EACCES and Caddy never starts. `/tmp` is world-writable. It
 * is still outside the mounted workspace, so it never pollutes the user's tree.
 */
export const CADDY_DIR = '/tmp/genie-caddy';
export const CADDY_CONFIG_PATH = `${CADDY_DIR}/Caddyfile`;
/** Caddy's storage (its `tls internal` CA) — pointed here via XDG_DATA_HOME so
 *  the CA can be written by the non-root user; `$HOME/.local/share` is not
 *  writable in the sandbox. */
export const CADDY_DATA_DIR = `${CADDY_DIR}/data`;
export const CADDY_CONFIG_HOME = `${CADDY_DIR}/config`;

export type ApplyCaddyResult = { ok: true } | { ok: false; error: string };

/**
 * Point the sandbox's Caddy at exactly `sites`: write the Caddyfile, then reload
 * (or start) Caddy. The Caddyfile body is passed base64-encoded so an arbitrary
 * config can never break out of the shell command that writes it.
 */
export async function applyCaddyConfig(
    runtime: ContainerRuntime,
    containerId: string,
    sites: CaddySite[],
    opts: { timeoutMs?: number } = {},
): Promise<ApplyCaddyResult> {
    let caddyfile: string;
    try {
        caddyfile = buildCaddyfile(sites); // validates hosts/ports; throws on junk
    } catch (e) {
        return { ok: false, error: messageOf(e) };
    }
    const b64 = Buffer.from(caddyfile, 'utf8').toString('base64');
    const script =
        `set -e; ` +
        // Caddy stores its internal CA under XDG_DATA_HOME; point it (and the
        // config home) at a writable dir so `tls internal` works as non-root.
        `export XDG_DATA_HOME='${CADDY_DATA_DIR}' XDG_CONFIG_HOME='${CADDY_CONFIG_HOME}'; ` +
        `mkdir -p '${CADDY_DIR}' '${CADDY_DATA_DIR}' '${CADDY_CONFIG_HOME}'; ` +
        `printf %s '${b64}' | base64 -d > '${CADDY_CONFIG_PATH}'; ` +
        // Reload if Caddy is already running; otherwise start it. Either path
        // leaves Caddy serving the config just written.
        `caddy reload --config '${CADDY_CONFIG_PATH}' --adapter caddyfile 2>/dev/null || ` +
        `caddy start --config '${CADDY_CONFIG_PATH}' --adapter caddyfile`;
    try {
        const r = await runtime.exec(containerId, ['sh', '-c', script], {
            timeoutMs: opts.timeoutMs ?? 20_000,
        });
        if (r.code !== 0) {
            const detail = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
            return {
                ok: false,
                error: `Caddy config apply failed (exit ${r.code})${detail ? `: ${detail}` : ''}`,
            };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: `Caddy config apply failed: ${messageOf(e)}` };
    }
}
