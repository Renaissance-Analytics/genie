import type {
    DevRuntimeInfo,
    DevServiceInfo,
    DevSiteInfo,
    DevSiteRunOption,
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
 * `state: 'running'` says the CONTAINER is up. `ready` says the dev server
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

/** Whether the Dev Server can be driven from THIS window at all. */
export type DevAvailability = 'ready' | 'remote';

// --- sites ------------------------------------------------------------------

export function siteStatusTone(site: DevSiteInfo): DevTone {
    if (site.state === 'failed') return 'failed';
    if (site.state !== 'running') return 'idle';
    // Up but not answering. Deliberately NOT `running` — see the file header.
    return site.ready === false ? 'starting' : 'running';
}

export function siteStatusLabel(site: DevSiteInfo): string {
    if (site.state === 'failed') {
        return site.error ? `Failed — ${site.error}` : 'Failed to start.';
    }
    if (site.state !== 'running') {
        return site.enabled
            ? 'Not running. Start it to serve this repo.'
            : 'Off. Nothing is served until you start it.';
    }
    if (site.ready === false) {
        return (
            'The container is up, but the server inside it has not answered yet — ' +
            'a first run often installs dependencies or builds. Check the log if it stays here.'
        );
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
    if (mine.some((s) => s.state === 'failed')) return 'failed';
    return 'idle';
}

export function railSitesTitle(sites: DevSiteInfo[], workspaceId: string): string {
    const mine = minesites(sites, workspaceId);
    const running = mine.filter((s) => s.state === 'running').length;
    const failed = mine.filter((s) => s.state === 'failed').length;
    const parts = [`${mine.length} dev site${mine.length === 1 ? '' : 's'}`];
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
                'Install Docker Desktop (or Podman) to run dev servers and services in containers.',
        };
    }
    const name = RUNTIME_LABELS[info.kind] ?? info.kind;
    return {
        label: info.version ? `${name} ${info.version}` : name,
        tone: 'running',
        guidance: null,
    };
}

/** Why this window cannot drive the Dev Server, when it cannot. */
export function devServerGuidance(availability: DevAvailability): string | null {
    if (availability !== 'remote') return null;
    return (
        'Dev servers and services run on the machine itself. This window is driving another ' +
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
