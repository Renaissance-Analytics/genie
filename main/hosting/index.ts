import { createFrankenPhpRuntime } from './frankenphp';
import { createStaticRuntime } from './static';
import type { HostedSite, HostedStatus, HostingBackend, LocalTarget, SiteRuntime } from './types';

/**
 * Genie's cross-platform hosting runtime — module surface (Tynn #232, P1).
 *
 * ## What this replaces
 *
 * Today a workspace site is DISCOVERED, not served: `mobile/hosts.ts` parses the
 * OS hosts file for `*.test` names and probes loopback to guess a scheme and
 * port, hoping the user has Herd running or has started `artisan serve` /
 * `npm run dev` by hand. Everything downstream inherits that guess.
 *
 * That is the root cause of the `.gen` remote-preview failures. A dev server
 * means a SECOND origin (Vite's port), an HMR websocket, and absolute asset URLs
 * baked at request time — so only sites that happen to be same-origin survive
 * the tunnel. No amount of proxy rewriting fixes it; the reverted rewrite
 * attempts are the evidence.
 *
 * Hosting the site removes the cause: one real server, one built app, ONE
 * origin, a port we chose and can keep. Remote preview then carries a perfectly
 * ordinary origin.
 *
 * ## THE INTEGRATION SEAM (named, deliberately NOT rewired in P1)
 *
 * The join is `main/sites/local-sites.ts`:
 *
 *   - `listLocalEnabledGenSites()` returns `EnabledGenSite[]` — today built from
 *     hosts-file discovery + `probeSite`.
 *   - `localTargetsBySiteId(sites)` reduces those to `Map<siteId, LocalTarget>`.
 *   - `main/testing-browser/index.ts#refreshSites` (~line 343) fills both that
 *     map and `genMap`, and `createLocalSiteCarrier(...)` (wired at ~line 191)
 *     dials whatever `LocalTarget` it is handed.
 *
 * A running site here reports `HostedStatus.target`, which IS a {@link LocalTarget}
 * — the same `{scheme, hostname, port, loopback}` tuple, just sourced from a port
 * we assigned instead of one we probed. So the integration is additive: have
 * `listLocalEnabledGenSites()` emit hosted sites alongside discovered ones and
 * prefer the hosted target when both exist for a hostname. Nothing downstream —
 * the carrier, the site shim, `SessionCa`, the browser chrome — needs to change,
 * because none of it ever learns where the target came from.
 *
 * The second, smaller seam is `main/testing-browser/index.ts:191-193`, where the
 * carrier itself is chosen; swapping there would work too but is strictly more
 * invasive, so the recommendation is the first.
 *
 * P1 stops at "the runtime exists, is tested, and the seam is identified". It
 * does not touch `sites/`, `testing-browser/`, IPC or the UI.
 */

export {
    createFrankenPhpRuntime,
    extensionDirFor,
    phpIniDir,
    runArgs,
    siteConfigPath,
    READY_MARKER,
    START_TIMEOUT_MS,
} from './frankenphp';
export type { FrankenPhpRuntimeOptions } from './frankenphp';

export {
    contentTypeFor,
    createStaticRuntime,
    isInside,
    resolveStaticFile,
    spaFallback,
} from './static';
export type { StaticRuntimeOptions } from './static';

export { caddyPath, globalBlock, quote, renderCaddyfile, siteBlock } from './caddyfile';
export type { CaddyfileOptions } from './caddyfile';

export { LARAVEL_EXTENSIONS, renderPhpIni } from './php-ini';
export type { PhpIniOptions } from './php-ini';

export {
    assignPort,
    hostedOrigin,
    preferredPort,
    HOSTED_PORT_MAX,
    HOSTED_PORT_MIN,
    HOSTED_PORT_SLOTS,
} from './ports';

export type * from './types';

/**
 * Pick the backend for a site.
 *
 * A `php` site needs FrankenPHP; a `static` one does not, and giving it the
 * dependency-free backend means a plain built frontend previews with nothing
 * downloaded. When FrankenPHP is absent, a `php` site cannot be hosted at
 * all — the caller is told so rather than being handed a runtime that will fail
 * on `start`.
 */
export function backendFor(
    site: Pick<HostedSite, 'kind'>,
    available: { frankenphp: boolean },
): HostingBackend | null {
    if (site.kind === 'static') return 'static';
    return available.frankenphp ? 'frankenphp' : null;
}

export type { HostedSite, HostedStatus, HostingBackend, LocalTarget, SiteRuntime };
