import type { SiteScheme } from '../mobile/hosts';
import type { LocalTarget } from '../sites/local-carrier';

/**
 * Genie's own cross-platform HOSTING runtime (Tynn #232, P1) — the type surface.
 *
 * Today a `.gen` site is *discovered*: we parse the hosts file, probe loopback,
 * and hope whatever the user happened to start (`artisan serve`, `npm run dev`,
 * Herd) is still there. That is the root of every remote-preview failure — a dev
 * server means a second Vite port, HMR sockets, absolute asset URLs and a
 * volatile origin, so only same-origin sites survive the tunnel.
 *
 * A {@link SiteRuntime} inverts that: Genie SERVES the site itself, from a real
 * server, at ONE stable same-origin URL. Then remote preview is just a normal
 * origin over the carrier, and nothing depends on the user's dev tooling or on
 * Herd (which is mac/win only anyway).
 *
 * Split, mirroring `mobile/hosts.ts`:
 *   - PURE (unit-tested directly, no I/O): everything in `ports.ts`,
 *     `caddyfile.ts`, and `resolveStaticFile` in `static.ts`.
 *   - THIN IMPURE (spawn / fs / net): the two adapters' `start`/`stop`. Both
 *     take their process/fs/listen access as INJECTED seams (below), so the
 *     lifecycle is unit-tested with fakes — no FrankenPHP binary, no real port.
 *
 * P1 is the web+PHP+static tier only. The local CA / OS trust store (P2), the
 * service manager (P3) and Genie Cloud reuse (P4) are deliberately out of scope.
 */

// --- what gets hosted ------------------------------------------------------

/** Which backend can serve a given site. */
export type HostingBackend = 'frankenphp' | 'static';

/**
 * How a site's document root is served.
 *
 * `php` — a Laravel (or any front-controller) app: `root` is the app's
 * `public/`, unmatched paths fall through to `index.php`. Needs FrankenPHP.
 *
 * `static` — a built frontend (`vite build` → `dist/`): unmatched paths fall
 * back to `index.html` so client-side routing works. Needs no PHP at all, so
 * either backend can serve it.
 */
export type HostedSiteKind = 'php' | 'static';

/** A site Genie has been asked to host. */
export interface HostedSite {
    /** Opaque stable id — upstream this is `siteIdFor(hostname)` from
     *  `mobile/hosts.ts`, so a hosted site keys the same maps a discovered one does. */
    id: string;
    /** Browser-facing vhost, lowercased (e.g. `tynn.test`). Also the TLS SNI name. */
    hostname: string;
    /** ABSOLUTE path to the document root actually served — a Laravel app's
     *  `public/`, or a built frontend's `dist/`. Never the repo root. */
    root: string;
    kind: HostedSiteKind;
    /** Front controller for `php` sites, relative to {@link root}. Default `index.php`. */
    index?: string;
    /** Extra environment exposed to PHP (`env` in the Caddyfile). Never secrets —
     *  P1 has no escrow path, so callers pass only non-sensitive app config. */
    env?: Record<string, string>;
    /**
     * FrankenPHP worker mode: keep the app booted in memory between requests
     * (Laravel Octane-style). Path is relative to {@link root}. Off by default —
     * worker mode changes app semantics (leaked state between requests), so it
     * is opt-in per site rather than a runtime-wide default.
     */
    worker?: { file: string; num?: number; watch?: string[] };
}

// --- lifecycle -------------------------------------------------------------

export type HostedState = 'stopped' | 'starting' | 'running' | 'failed';

/** What a runtime reports about one site. */
export interface HostedStatus {
    siteId: string;
    state: HostedState;
    backend: HostingBackend;
    /**
     * The loopback dial for this site, or `null` unless `running`.
     *
     * Deliberately the EXISTING {@link LocalTarget} shape rather than a new one:
     * that is the integration seam. `sites/local-sites.ts#localTargetsBySiteId`
     * builds this map today from hosts-file discovery + a loopback probe; a
     * hosted site produces the identical tuple from a port WE chose, so
     * everything downstream (the local carrier, the site shim, the Testing
     * Browser's `genMap`) works unchanged. See `docs` note in `index.ts`.
     */
    target: LocalTarget | null;
    /** The stable same-origin URL a normal browser can hit directly, or `null`.
     *  e.g. `https://tynn.test:20431`. */
    origin: string | null;
    /** OS pid, when the backend runs out-of-process. */
    pid?: number;
    /** Redacted failure detail when `state === 'failed'`. */
    error?: string;
}

/**
 * "Given a workspace site, serve it at a stable same-origin URL with local TLS;
 * start / stop / status."
 *
 * Both adapters implement exactly this, so the caller never learns whether a
 * site is served by an embedded PHP app server or by plain file serving.
 */
export interface SiteRuntime {
    readonly backend: HostingBackend;
    /** Idempotent: starting an already-running site returns its current status. */
    start(site: HostedSite): Promise<HostedStatus>;
    stop(siteId: string): Promise<void>;
    /** Synchronous — callers poll this from IPC without awaiting a probe. */
    status(siteId: string): HostedStatus;
    list(): HostedStatus[];
    /** Stop everything. Called on app quit. */
    stopAll(): Promise<void>;
}

// --- injected seams (this is what makes the adapters unit-testable) ---------

/** A spawned server process, reduced to what the runtime actually needs. */
export interface HostedProcessHandle {
    readonly pid?: number;
    /** Resolves with the exit code once the process is gone. Never rejects. */
    readonly exited: Promise<number | null>;
    /** Ask the process to terminate. Idempotent. */
    stop(): void;
}

export interface SpawnOptions {
    cwd: string;
    /** Merged over the parent environment — carries `PHP_INI_SCAN_DIR`. */
    env?: Record<string, string>;
    /** Caddy logs to stderr — the runtime keeps the tail for {@link HostedStatus.error}. */
    onStderr?: (chunk: string) => void;
}

/** Spawning seam for the hosting server binary — injected so tests assert the
 *  argv and generated config without a real FrankenPHP on the machine. */
export interface ProcessSpawner {
    spawn(command: string, args: string[], opts: SpawnOptions): HostedProcessHandle;
}

/** fs seam for the generated Caddyfile — injected for the same reason. */
export interface ConfigWriter {
    write(filePath: string, contents: string): Promise<void>;
}

/** A bound listener, from {@link HttpListener}. */
export interface BoundServer {
    /** The port actually bound (resolves `port: 0`). */
    readonly port: number;
    close(): Promise<void>;
}

/** PEM material for a site's local TLS. In Genie this comes from the session CA
 *  (`remote/site-ca.ts`); P2 replaces it with a persistent, OS-trusted CA. */
export interface TlsMaterial {
    certPem: string;
    keyPem: string;
}

export interface ListenOptions {
    port: number;
    host: string;
    tls?: TlsMaterial;
}

/** net seam for the static adapter — injected so lifecycle tests bind nothing. */
export interface HttpListener {
    listen(
        handler: (req: unknown, res: unknown) => void,
        opts: ListenOptions,
    ): Promise<BoundServer>;
}

/** Re-exported so callers of this module never import the carrier directly. */
export type { LocalTarget, SiteScheme };
