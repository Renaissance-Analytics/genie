import type {
    DevRuntimeInfo,
    DevServiceInfo,
    DevSiteInfo,
    DevSitePhase,
    DevSiteRunOption,
    HostServeConfig,
} from './genie';

/**
 * PURE. Everything the Site Manager DECIDES (Tynn #234 P4).
 *
 * The renderer test environment has no DOM, so the panel is split the way the
 * beta.218 one was: judgements here, wiring in the component. That split is
 * what makes the three claims below assertable rather than buried in JSX.
 *
 * ## `running` is not `ready`
 *
 * `state: 'running'` says the CONTAINER is up. `ready` says the production server
 * inside it accepted a request. They are different events and the gap between
 * them is seconds to minutes (an `npm install`, a Vite cold start, a Django
 * migration). A panel that collapses them offers "Open in Genie Browser" on a
 * site that will refuse the connection, and the user reads that as a Genie bug.
 *
 * ## Both reaches, always
 *
 * A running site has TWO addresses: `https://<name>.gen`, which works here AND
 * from a connected remote, and `http://127.0.0.1:<published>`, which works only
 * on this machine. Showing one is how people paste the wrong one.
 *
 * ## A shared engine's isolation is not uniform
 *
 * Postgres and MySQL get a real database + role the other workspaces' roles
 * cannot reach. Redis gets an ACL user scoped to a key prefix. The three
 * namespace engines — Mailpit, Meilisearch, MinIO — share a master credential
 * and are separated by an index prefix, a bucket or an inbox. That is the
 * owner's decision and it is fine, but rendering all three as "isolated" would
 * claim a boundary that does not exist, so {@link isolationNote} says which one
 * a workspace actually has.
 */

export type DevTone = 'running' | 'starting' | 'failed' | 'idle';

/** Whether the Hosting Manager can be driven from THIS window at all. */
export type DevAvailability = 'ready' | 'remote';

// --- sites ------------------------------------------------------------------

/**
 * Observable startup (Gap 2). A site being STARTED streams a transient `phase`
 * ahead of its settled state, so a card can show a spinner and the current step
 * the instant Start is clicked — not a disabled button until the whole build
 * finishes. `pulling`/`building`/`starting` are the in-flight stages; `ready` and
 * `failed` are terminal and normally handed straight back to the settled state.
 */
export function siteIsStarting(site: DevSiteInfo): boolean {
    return site.phase === 'pulling' || site.phase === 'building' || site.phase === 'starting';
}

/** A short badge for the current start stage — what the card chips while it comes up. */
export function sitePhaseBadge(phase: DevSitePhase): string {
    switch (phase) {
        case 'pulling':
            return 'Pulling image';
        case 'building':
            return 'Building';
        case 'starting':
            return 'Starting';
        case 'ready':
            return 'Ready';
        case 'failed':
            return 'Failed';
    }
}

/** The full sentence under the card for the current start stage. */
export function sitePhaseLabel(phase: DevSitePhase): string {
    switch (phase) {
        case 'pulling':
            return 'Preparing the container — pulling the image if it is not already cached…';
        case 'building':
            return 'Building — running the production build. Its log is streaming below.';
        case 'starting':
            return 'Starting the container and waiting for the server to answer…';
        case 'ready':
            return 'Serving.';
        case 'failed':
            return 'Failed to start.';
    }
}

export function siteStatusTone(site: DevSiteInfo): DevTone {
    // A start in flight reads as `starting` regardless of the last settled
    // state — the card shows a spinner while it comes up (Gap 2).
    if (siteIsStarting(site)) return 'starting';
    if (site.phase === 'failed' || site.state === 'failed') return 'failed';
    if (site.state !== 'running') return 'idle';
    // Up but not answering. Deliberately NOT `running` — see the file header.
    return site.ready === false ? 'starting' : 'running';
}

export function siteStatusLabel(site: DevSiteInfo): string {
    // While starting, the phase IS the status — say which stage it is in.
    if (siteIsStarting(site)) return sitePhaseLabel(site.phase!);
    if (site.phase === 'failed' || site.state === 'failed') {
        return site.error ? `Failed — ${site.error}` : 'Failed to start.';
    }
    if (site.state !== 'running') {
        return site.enabled
            ? 'Not running. Start it to serve this repo.'
            : 'Off. Nothing is served until you start it.';
    }
    if (site.ready === false) {
        // A host-native site (the repo's dev server on the host) has NO container —
        // saying "the container is up" on it is exactly the wrong-model language the
        // panel is meant to have dropped.
        return site.runMode === 'host'
            ? 'The dev server is up but has not answered yet — a first run often installs ' +
                  'dependencies. Check the log if it stays here.'
            : 'The container is up, but the server inside it has not answered yet — ' +
                  'a first run often installs dependencies or builds. Check the log if it stays here.';
    }
    return 'Serving.';
}

/**
 * Can this site be opened in the Genie Browser right now?
 *
 * Three conditions, and each is a different wrong outcome if dropped: a stopped
 * site opens nothing, a not-ready one opens a connection refusal, and a `tcp`
 * surface has no page at all — it is published for `psql`, a gRPC client or an
 * agent, not for a browser.
 */
export function canOpenInBrowser(site: DevSiteInfo): boolean {
    return site.kind === 'http' && site.state === 'running' && site.ready !== false;
}

export interface SiteReach {
    /** The `.gen` origin — works here AND from a connected remote. */
    browser: string | null;
    /** The published loopback origin — works on this machine only. */
    local: string | null;
}

export function siteReach(site: DevSiteInfo): SiteReach {
    return { browser: site.origin ?? null, local: site.localOrigin ?? null };
}

// --- the serve-mode picker --------------------------------------------------

/**
 * The three ways a host-native site is served, as the Site Manager picker offers
 * them (genie #167/#171). `proxy` runs the repo's OWN dev server and Genie only
 * reverse-proxies it — the config-less default. `static`/`php` hand the serving
 * to Genie's bundled Caddy so nobody hand-rolls an nginx/Caddy block; the human
 * declares the mode and a `root`, exactly as an agent does via `hostServe`.
 */
export type ServeMode = 'proxy' | 'static' | 'php';

/** A site's CURRENT serve mode, for prefilling the Edit picker. No stored
 *  `hostServe` means the repo runs its own dev server — the `proxy` default. */
export function serveModeOf(site: DevSiteInfo): ServeMode {
    return site.hostServe?.mode ?? 'proxy';
}

/**
 * The `hostServe` request field a picker choice produces — the SAME shape an
 * agent passes. `proxy` declares nothing (Genie generates no config), so it maps
 * to `undefined`; `static`/`php` carry the trimmed `root` (and, for static only,
 * the SPA fallback). A blank root yields nothing — the form guards submit, and
 * this is the backstop so a half-filled static never ships an empty root.
 */
export function buildHostServe(mode: ServeMode, root: string, spa: boolean): HostServeConfig | undefined {
    const dir = root.trim();
    if (mode === 'proxy' || !dir) return undefined;
    if (mode === 'php') return { mode: 'php', root: dir };
    return { mode: 'static', root: dir, ...(spa ? { spa: true } : {}) };
}

/**
 * Whether a serve-mode choice still lacks the directory it needs, so submit must
 * be blocked. `proxy` runs the repo's own dev server and needs nothing; `static`
 * and `php` serve a folder, so a blank root produces no config
 * ({@link buildHostServe} → `undefined`) and the choice would be SILENTLY DROPPED
 * on save. Both the Add and the Edit form disable submit on this — without it,
 * switching a site to "run PHP app" with no directory looked like it saved but
 * did nothing (genie #198).
 */
export function serveConfigIncomplete(mode: ServeMode, root: string, spa: boolean): boolean {
    return mode !== 'proxy' && !buildHostServe(mode, root, spa);
}

/**
 * The serve-mode value an Edit patch should carry, given the site's stored config
 * and the picker's new one. `undefined` ⇒ unchanged, so omit it and the update
 * never restarts a running site for a serve mode that did not move. `null` ⇒
 * CLEAR it back to proxy — an explicit signal, because the store merges the patch
 * OVER the stored row, so a plain omit would leave a static site static forever.
 */
export function hostServePatch(
    prev: HostServeConfig | undefined,
    next: HostServeConfig | undefined,
): HostServeConfig | null | undefined {
    if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) return undefined;
    return next ?? null;
}

// --- the rail indicator -----------------------------------------------------

/**
 * PURE. The tone of one workspace's dev-sites indicator, or null when it has
 * none enabled (the icon is hidden entirely — "this workspace serves nothing"
 * is the common case and has to stay silent).
 *
 * `running` wins over `failed`: something IS being served, and an amber icon on
 * a workspace whose site is up would be a lie. A broken site with nothing else
 * running still shows failed — that is the case the user has to notice.
 */
export function railSitesTone(sites: DevSiteInfo[], workspaceId: string): DevTone | null {
    const mine = minesites(sites, workspaceId);
    if (mine.length === 0) return null;
    if (mine.some((s) => s.state === 'running')) return 'running';
    // A start in flight lights the rail amber (Gap 2) — something IS happening,
    // so an idle dot would read as "nothing here".
    if (mine.some((s) => siteIsStarting(s))) return 'starting';
    if (mine.some((s) => s.state === 'failed' || s.phase === 'failed')) return 'failed';
    return 'idle';
}

export function railSitesTitle(sites: DevSiteInfo[], workspaceId: string): string {
    const mine = minesites(sites, workspaceId);
    // The indicator is always shown (greyed) even with nothing hosted, so it needs
    // a sensible empty title rather than "0 hosted sites".
    if (mine.length === 0) return 'No hosted sites yet — click to open the Site Manager';
    const running = mine.filter((s) => s.state === 'running').length;
    const failed = mine.filter((s) => s.state === 'failed').length;
    const parts = [`${mine.length} hosted site${mine.length === 1 ? '' : 's'}`];
    if (running) parts.push(`${running} running`);
    if (failed) parts.push(`${failed} failed`);
    return `${parts.join(' · ')} — click to open the Site Manager`;
}

/** The rail is fed a list already scoped to one workspace by the caller, but a
 *  future all-workspaces feed must not light every project's icon. */
function minesites(sites: DevSiteInfo[], _workspaceId: string): DevSiteInfo[] {
    return sites.filter((s) => s.enabled);
}

// --- services ---------------------------------------------------------------

const ENGINE_LABELS: Readonly<Record<string, string>> = {
    postgres: 'Postgres',
    mysql: 'MySQL',
    redis: 'Redis',
    meilisearch: 'Meilisearch',
    minio: 'MinIO',
    mailpit: 'Mailpit',
    custom: 'Custom image',
};

export function serviceTitle(service: DevServiceInfo): string {
    const label = ENGINE_LABELS[service.engine] ?? service.engine;
    // A custom image has no version Genie chose, so appending one would invent
    // a fact. Everything else NAMES its version, because the major version is
    // the unit engines are shared by.
    return service.engine === 'custom' || !service.version ? label : `${label} ${service.version}`;
}

export function serviceStatusTone(service: DevServiceInfo): DevTone {
    if (service.state === 'failed') return 'failed';
    if (service.state !== 'running') return 'idle';
    return service.ready === false ? 'starting' : 'running';
}

export function serviceStatusLabel(service: DevServiceInfo): string {
    if (service.state === 'failed') {
        return service.error ? `Failed — ${service.error}` : 'Failed to start.';
    }
    if (service.state !== 'running') {
        return service.enabled
            ? 'Not running. Start it to give this workspace its slice.'
            : 'Off. This workspace holds no slice of it.';
    }
    if (service.ready === false) return 'Starting — the engine has not answered its check yet.';
    return 'Running.';
}

/**
 * Who else is holding this engine — the sentence that makes "stop" honest.
 *
 * `stop` on a shared service is a RELEASE: it drops this workspace's hold and
 * the container keeps running for everyone else. A user who thinks they just
 * stopped a database and finds it still up has been misled by the button, not
 * by the backend.
 */
export function holdersNote(service: DevServiceInfo): string | null {
    if (service.state !== 'running') return null;
    if (service.dedicated) {
        return 'Dedicated to this workspace — stopping it stops the container.';
    }
    const holders = service.holders ?? 0;
    if (holders <= 1) {
        return 'Held by only this workspace — stopping it stops the container.';
    }
    return (
        `Shared with ${holders} workspaces. Stopping only releases THIS workspace's hold; ` +
        'the engine keeps running for the others.'
    );
}

/**
 * What this engine's per-workspace boundary actually is.
 *
 * Three strategies with genuinely different strength, named honestly rather
 * than flattened into "isolated" — see the file header.
 */
export function isolationNote(provision: string): string {
    switch (provision) {
        case 'sql-database-role':
            return 'This workspace gets its own database and role on the shared engine; another workspace’s role cannot reach it.';
        case 'redis-acl':
            return 'This workspace gets its own ACL user on the shared engine, restricted to its own key prefix.';
        case 'namespace':
            return 'This workspace gets its own namespace on the shared engine, but shares the engine’s master credential — treat it as separated, not sealed.';
        default:
            return 'This workspace runs its own container for this service.';
    }
}

// --- the runtime ------------------------------------------------------------

export interface RuntimeSummary {
    label: string;
    tone: DevTone;
    /** What to do about it, when there is something to do. */
    guidance: string | null;
}

const RUNTIME_LABELS: Readonly<Record<string, string>> = {
    docker: 'Docker',
    podman: 'Podman',
};

export function runtimeSummary(info: DevRuntimeInfo | null): RuntimeSummary {
    if (!info || info.kind === 'none' || !info.kind) {
        return {
            label: 'No container runtime',
            // `idle`, not `failed`: most desktops have no Docker the first time
            // this is opened, and that is a next step rather than a fault.
            tone: 'idle',
            guidance:
                info?.installHint ??
                'Install Docker Desktop (or Podman) to build and serve sites, and to run their services, in containers.',
        };
    }
    const name = RUNTIME_LABELS[info.kind] ?? info.kind;
    return {
        label: info.version ? `${name} ${info.version}` : name,
        tone: 'running',
        guidance: null,
    };
}

/** Why this window cannot drive the Hosting Manager, when it cannot. */
export function devServerGuidance(availability: DevAvailability): string | null {
    if (availability !== 'remote') return null;
    return (
        'Hosting runs on the machine itself. This window is driving another ' +
        'Genie, so open the Site Manager on that machine to manage them.'
    );
}

// --- the run-option picker --------------------------------------------------

const STACK_LABELS: Readonly<Record<string, string>> = {
    node: 'Node',
    php: 'PHP',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
};

const RUN_MODE_LABELS: Readonly<Record<string, string>> = {
    dockerfile: 'Dockerfile',
    devcontainer: 'Devcontainer',
    compose: 'Compose',
    explicit: 'Explicit',
};

/** One line naming WHAT this option runs and WHICH repo file said so. */
export function optionLabel(option: DevSiteRunOption): string {
    const what =
        (option.stack && STACK_LABELS[option.stack]) ??
        RUN_MODE_LABELS[option.runMode] ??
        option.runMode;
    return option.source ? `${what} — ${option.source}` : what;
}

/** What is still a GUESS about this option, or null when nothing is.
 *
 *  Never decoration: an option whose port was defaulted rather than read will
 *  publish 8080, get a connection refused, and look like a working site. */
export function optionCaveat(option: DevSiteRunOption): string | null {
    if (option.confident) return null;
    return option.needs ?? 'Some of this was inferred — check the command and the port.';
}
