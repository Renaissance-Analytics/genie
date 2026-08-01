import { createFrankenPhpRuntime } from './frankenphp';
import { createStaticRuntime } from './static';
import type { HostedSite, HostedStatus, HostingBackend, LocalTarget, SiteRuntime } from './types';

/**
 * Genie's cross-platform hosting runtime — module surface (Tynn #232, P1–P2).
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
 * ## THE INTEGRATION SEAM (identified in P1, wired in P2)
 *
 * The join is `main/sites/local-sites.ts`:
 *
 *   - `listLocalEnabledGenSites()` returns `EnabledGenSite[]` — historically
 *     built only from hosts-file discovery + `probeSite`.
 *   - `localTargetsBySiteId(sites)` reduces those to `Map<siteId, LocalTarget>`.
 *   - `main/testing-browser/index.ts#refreshSites` fills both that map and
 *     `genMap`, and `createLocalSiteCarrier(...)` dials whatever `LocalTarget`
 *     it is handed.
 *
 * A running site here reports `HostedStatus.target`, which IS a {@link LocalTarget}
 * — the same `{scheme, hostname, port, loopback}` tuple, just sourced from a port
 * we assigned instead of one we probed. The wiring is therefore purely ADDITIVE
 * and lives in two places only:
 *
 *   - `manager.ts#genSites()` emits RUNNING hosted sites as `EnabledGenSite`
 *     rows, keyed by the SAME `siteIdFor(hostname)` a discovered site uses;
 *   - `local-sites.ts#mergeHostedSites` overlays them, hosted winning.
 *
 * Nothing downstream changed — the carrier, the site shim, `SessionCa` and the
 * browser chrome are untouched, because none of them ever learns where a target
 * came from. `testing-browser/index.ts` needed no edit at all.
 *
 * P2 additionally owns: fetch-on-first-use for FrankenPHP
 * (`frankenphp-fetch.ts`), build-on-first-use for static sites (`build.ts`), the
 * persisted per-workspace site config (`sites-config.ts` + `workspaces.hosted_sites`),
 * and the manager that orchestrates them. The Site Manager UX is P3.
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

export { contentTypeFor, createStaticRuntime, resolveStaticFile, spaFallback } from './static';
export type { StaticRuntimeOptions } from './static';

export {
    assetNameFor,
    ensureFrankenPhp,
    installDirFor,
    isArchive,
    layoutFor,
    releaseApiUrl,
    selectAsset,
    stagingRootFor,
    FRANKENPHP_VERSION,
} from './frankenphp-fetch';
export type {
    EnsureFrankenPhpOptions,
    FrankenPhpFetchSeams,
    FrankenPhpInstall,
    GithubRelease,
    GithubReleaseAsset,
    RuntimeLayout,
} from './frankenphp-fetch';

export { buildPlanFor, ensureBuilt, npmExecutable, npxExecutable } from './build';
export type { BuildPlan, BuildSeams, EnsureBuiltOptions } from './build';

export {
    hostedSiteIdFor,
    parseHostedSites,
    resolveHostedSite,
    sanitizeHostedSitePatch,
} from './sites-config';
export type { HostedSiteConfig, HostedSites } from './sites-config';

export {
    createHostingManager,
    hostedGenSites,
    hostingManager,
    initHosting,
    resetHostingForTests,
} from './manager';
export type {
    HostedGenSite,
    HostedSiteRow,
    HostingManager,
    HostingManagerDeps,
    HostingWorkspace,
} from './manager';

export { isInside } from './paths';

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
