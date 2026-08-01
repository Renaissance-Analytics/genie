import type {
    HostedSiteCandidate,
    HostedSiteKind,
    HostedSiteRow,
    HostedState,
    HostingRuntimeStatus,
} from './genie';

/**
 * The Workspace Site Manager's VIEW MODEL (Tynn #232, hosting UX).
 *
 * Kept free of React so it is unit-testable: the renderer test env is Node-only,
 * so the components are verified by hand / e2e and every decision they make
 * lives here — which rows the manager shows, what a row's status reads as,
 * whether "Open in Genie Browser" means anything yet, and which workspaces earn
 * the sites icon in the rail.
 *
 * Everything in this file is PURE.
 */

/** How a site (or the runtime) reads at a glance. Drives the dot colour. */
export type HostingTone = 'running' | 'starting' | 'failed' | 'idle';

/** One row in the Site Manager: a configured site, or a proposal. */
export interface SiteManagerRow {
    /** Stable React key — the siteId once configured, else the docroot. */
    key: string;
    /** Display name (the repo/project the site came from, or its vhost). */
    name: string;
    hostname: string;
    /** The `.gen` name that addresses it in the Genie Browser ('' for a
     *  proposal — it has none until it is configured and running). */
    genName: string;
    kind: HostedSiteKind;
    /** Document root RELATIVE to the workspace. */
    docroot: string;
    index?: string;
    /** Present once the site has stored config; the key for set/remove/stop. */
    siteId?: string;
    /** False = a candidate Genie detected but the user has never set up. */
    configured: boolean;
    /** The stored opt-in. A proposal is never enabled. */
    enabled: boolean;
    state: HostedState;
    origin: string | null;
    error?: string;
    /** Why Genie proposes (or proposed) this site — kept on configured rows too,
     *  so the manager can still explain where a site came from. */
    reason?: string;
    /** Static site whose docroot has no build yet: enabling runs the build. */
    needsBuild?: boolean;
}

/**
 * PURE. The manager's rows: every configured site, then every candidate that is
 * not one of them already.
 *
 * Matching is by hostname OR docroot, and the docroot half matters: a user who
 * renames a site's vhost still has the same directory, and re-offering it as a
 * fresh proposal would invite two sites serving one docroot on two ports.
 * Configured rows come first because they are the ones with real state.
 */
export function siteManagerRows(
    configured: HostedSiteRow[],
    candidates: HostedSiteCandidate[],
): SiteManagerRow[] {
    const byHostname = new Map<string, HostedSiteCandidate>();
    const byDocroot = new Map<string, HostedSiteCandidate>();
    for (const c of candidates) {
        byHostname.set(c.hostname, c);
        byDocroot.set(c.docroot, c);
    }

    const claimed = new Set<HostedSiteCandidate>();
    const rows: SiteManagerRow[] = configured.map((site) => {
        const match = byHostname.get(site.hostname) ?? byDocroot.get(site.docroot);
        if (match) claimed.add(match);
        return {
            key: site.siteId,
            name: match?.name || site.hostname,
            hostname: site.hostname,
            genName: site.genName,
            kind: site.kind,
            docroot: site.docroot,
            ...(site.index ? { index: site.index } : {}),
            siteId: site.siteId,
            configured: true,
            enabled: site.enabled,
            state: site.state,
            origin: site.origin,
            ...(site.error ? { error: site.error } : {}),
            ...(match ? { reason: match.reason, needsBuild: match.needsBuild } : {}),
        };
    });

    for (const c of candidates) {
        if (claimed.has(c)) continue;
        rows.push({
            key: `candidate:${c.docroot}`,
            name: c.name,
            hostname: c.hostname,
            genName: '',
            kind: c.kind,
            docroot: c.docroot,
            configured: false,
            enabled: false,
            state: 'stopped',
            origin: null,
            reason: c.reason,
            needsBuild: c.needsBuild,
        });
    }

    return rows;
}

/**
 * PURE. What a row's status line says.
 *
 * A failure reads as its REASON, never as "off": the whole point of keeping the
 * last failure in the manager is that a site whose build is broken must not look
 * like a site the user simply didn't turn on. For the same reason a running
 * site reads as its URL — the one piece of information the user came for.
 */
export function siteStatusLabel(row: SiteManagerRow): string {
    if (row.state === 'failed') return row.error || 'Failed to start';
    if (row.state === 'running') return row.origin || 'Running';
    if (!row.configured) return 'Not hosted yet';
    if (!row.enabled) return 'Disabled';
    return 'Starting…';
}

/** PURE. The tone of a row's status dot. */
export function siteStatusTone(row: SiteManagerRow): HostingTone {
    if (row.state === 'failed') return 'failed';
    if (row.state === 'running') return 'running';
    if (row.configured && row.enabled) return 'starting';
    return 'idle';
}

/**
 * PURE. Whether "Open in Genie Browser" does anything for this row.
 *
 * Only a RUNNING site with a `.gen` name is addressable — offering the action
 * before then would open a browser on a port nothing is listening to, which
 * reads to the user as Genie being broken rather than the site not being up.
 */
export function canOpenInBrowser(row: SiteManagerRow): boolean {
    return row.state === 'running' && !!row.genName;
}

/**
 * PURE. The workspaces that have at least one site ENABLED — the rail's sites
 * icon (owner decision, 2026-08-01: it sits next to the Process icon).
 *
 * Enabled, not running: the icon says "this workspace serves sites", which stays
 * true while a site is starting or has failed. Whether it is UP is the dot's
 * job ({@link railSitesTone}).
 */
export function hostedSiteWorkspaces(rows: HostedSiteRow[]): Set<string> {
    const out = new Set<string>();
    for (const row of rows) {
        if (row.enabled) out.add(row.workspaceId);
    }
    return out;
}

/**
 * PURE. The tone of one workspace's sites indicator, or null when it hosts
 * none (the icon is hidden entirely).
 *
 * `running` wins over `failed`: something IS being served, and an amber icon on
 * a workspace whose site is up would be a lie. A broken site with nothing else
 * running still shows failed rather than idle — that is the case the user has
 * to notice.
 */
export function railSitesTone(rows: HostedSiteRow[], workspaceId: string): HostingTone | null {
    const mine = rows.filter((r) => r.workspaceId === workspaceId && r.enabled);
    if (mine.length === 0) return null;
    if (mine.some((r) => r.state === 'running')) return 'running';
    if (mine.some((r) => r.state === 'failed')) return 'failed';
    return 'idle';
}

/** PURE. A short count for the rail tooltip. */
export function railSitesTitle(rows: HostedSiteRow[], workspaceId: string): string {
    const mine = rows.filter((r) => r.workspaceId === workspaceId && r.enabled);
    const running = mine.filter((r) => r.state === 'running').length;
    const failed = mine.filter((r) => r.state === 'failed').length;
    const parts = [`${mine.length} hosted site${mine.length === 1 ? '' : 's'}`];
    if (running) parts.push(`${running} running`);
    if (failed) parts.push(`${failed} failed`);
    return `${parts.join(' · ')} — click to open the Site Manager`;
}

/** PURE. The hosting runtime's one-line diagnosis + whether a download is worth
 *  offering. */
export function runtimeSummary(status: HostingRuntimeStatus | null): {
    label: string;
    tone: HostingTone;
    installable: boolean;
} {
    if (!status) {
        return { label: 'Checking the PHP runtime…', tone: 'idle', installable: false };
    }
    if (!status.supported) {
        return {
            label: `No FrankenPHP build for ${status.platform}/${status.arch} — PHP sites cannot be hosted on this machine. Static sites still work.`,
            tone: 'failed',
            installable: false,
        };
    }
    if (status.installed) {
        return {
            label: `FrankenPHP ${status.version} installed — PHP sites start without a download.`,
            tone: 'running',
            installable: false,
        };
    }
    return {
        label: `FrankenPHP ${status.version} is not installed — it downloads (~277 MB, checksum-verified) the first time a PHP site starts.`,
        tone: 'idle',
        installable: true,
    };
}

/** PURE. The sites that are actually being served right now, for the
 *  workstation diagnostics list. */
export function runningSites(rows: HostedSiteRow[]): HostedSiteRow[] {
    return rows.filter((r) => r.state === 'running');
}

/**
 * PURE. Turn an absolutely-picked directory into a docroot RELATIVE to its
 * workspace, or null when it is not inside one.
 *
 * A docroot is stored relative and main refuses anything else — a workspace
 * whose settings could name any directory on the machine would be a way to
 * publish `~/.ssh` to a browser. Rejecting the pick HERE means the user is told
 * why at the moment they choose, instead of a save that silently does nothing.
 *
 * Windows-aware: separators are normalised and the comparison is
 * case-insensitive, because `C:\Dev\ws` and `c:\dev\ws` are one directory.
 */
export function relativeDocroot(workspacePath: string, picked: string): string | null {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const root = norm(workspacePath);
    const target = norm(picked);
    if (!root || !target) return null;
    if (target.toLowerCase() === root.toLowerCase()) return '';
    const prefix = `${root.toLowerCase()}/`;
    if (!target.toLowerCase().startsWith(prefix)) return null;
    return target.slice(prefix.length);
}
