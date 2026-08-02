import path from 'node:path';
import {
    deleteWorkspaceDevSite,
    getWorkspaceDevSites,
    setWorkspaceDevSite,
} from '../db';
import { devSiteIdFor, defaultGenNameFor, slugLabel } from '../dev-server/sites-config';
import { describeRepoRun } from '../dev-server/repo-facts';
import { devSiteManager } from '../dev-server/site-manager';
import { resolveContainerRuntime } from '../dev-server';
import { detectFolder } from '../workspace/detect';
import { resolveAgentTarget } from './host-tools';
import type { DevSiteOption } from '../dev-server/site-def';
import type { DevSiteRow } from '../dev-server/site-manager';
import type { DevSiteConfig } from '../dev-server/sites-config';
import type {
    DevSiteInfo,
    DevSiteRunOption,
    ManageSiteRequest,
    ManageSiteResult,
} from './protocol';

/**
 * The HOST side of the `manageSite` MCP tool (Tynn #234, P2 item 5) — the
 * agent-first administration surface for the container Dev Server.
 *
 * The discovery's decision was that agents drive this and the human UX is the
 * secondary viewer, so this file is the primary path, not a convenience wrapper
 * over one. It does the four kinds of I/O `protocol.ts` deliberately has none
 * of: resolving the caller's workspace, reading a repo off disk to detect how it
 * runs, persisting the definition, and driving the site manager.
 *
 * ## Two behaviours worth naming
 *
 * **`create` finishes the job.** An agent asked to "serve the frontend" should
 * not have to make four calls. `create` with just a `name` detects how the repo
 * runs, takes the recommended option, stores it, and starts it — reporting which
 * option it applied and what else was on offer. When nothing can be recommended
 * it FAILS with the options attached, so the next call is obvious rather than a
 * guess.
 *
 * **The runtime's absence is data, not an exception.** Every result carries
 * `runtime`, so an agent that gets `ok: false` on a machine with no Docker reads
 * the install hint out of the same object instead of parsing a message.
 */

// --- the desktop seam -------------------------------------------------------

export interface DevSiteToolsDeps {
    /** Show a `.gen` site in the Genie Browser for the user (no-op headless). */
    openInBrowser?: (genName: string) => Promise<{ ok: boolean; error?: string }>;
}

let deps: DevSiteToolsDeps = {};

/** Inject the GUI hook (desktop boot wires the Testing Browser; headless does
 *  not, and `open` then says so rather than pretending). */
export function registerDevSiteTools(d: DevSiteToolsDeps): void {
    deps = d;
}

// --- runtime detection, cached -----------------------------------------------

/**
 * Detection is two process spawns. `tools/list` runs on every agent connection,
 * so it is cached — briefly, because a user who starts Docker Desktop must not
 * have to restart Genie for the tool to appear.
 */
const DETECTION_TTL_MS = 30_000;
let cached: { at: number; kind: string; version?: string; installHint?: string } | null = null;

export async function runtimeInfo(): Promise<{ kind: string; version?: string; installHint?: string }> {
    if (cached && Date.now() - cached.at < DETECTION_TTL_MS) {
        const { at: _at, ...info } = cached;
        return info;
    }
    try {
        const { detection } = await resolveContainerRuntime();
        cached = {
            at: Date.now(),
            kind: detection.kind,
            ...(detection.version ? { version: detection.version } : {}),
            ...(detection.installHint ? { installHint: detection.installHint } : {}),
        };
    } catch (e) {
        cached = {
            at: Date.now(),
            kind: 'none',
            installHint: e instanceof Error ? e.message : String(e),
        };
    }
    const { at: _at, ...info } = cached;
    return info;
}

/**
 * Is the container Dev Server usable here? Gates `manageSite` out of
 * `tools/list`. Fail CLOSED — see `McpContext.devServerAvailable`.
 */
export async function devServerAvailableForMcp(): Promise<boolean> {
    try {
        return (await runtimeInfo()).kind !== 'none';
    } catch {
        return false;
    }
}

/** Test/boot hook: forget the cached probe (a runtime was just installed). */
export function resetDevServerDetectionCache(): void {
    cached = null;
}

// --- shaping ----------------------------------------------------------------

function toInfo(row: DevSiteRow): DevSiteInfo {
    return {
        id: row.siteId,
        name: row.name,
        genName: row.genName,
        repo: row.repo,
        runMode: row.runMode,
        kind: row.kind,
        enabled: row.enabled,
        state: row.state,
        ...(row.ready === undefined ? {} : { ready: row.ready }),
        ...(row.port ? { port: row.port } : {}),
        ...(row.hostPort ? { hostPort: row.hostPort } : {}),
        ...(row.origin ? { origin: row.origin } : {}),
        ...(row.localOrigin ? { localOrigin: row.localOrigin } : {}),
        ...(row.command ? { command: row.command } : {}),
        ...(row.image ? { image: row.image } : {}),
        ...(row.error ? { error: row.error } : {}),
    };
}

function toOption(option: DevSiteOption): DevSiteRunOption {
    return {
        runMode: option.runMode,
        ...(option.stack ? { stack: option.stack } : {}),
        source: option.source,
        reason: option.reason,
        ...(option.command ? { command: option.command } : {}),
        ...(option.port ? { port: option.port } : {}),
        confident: option.confident,
        ...(option.needs ? { needs: option.needs } : {}),
    };
}

// --- the tool ---------------------------------------------------------------

export async function manageSiteForMcp(
    terminalId: string,
    req: ManageSiteRequest,
): Promise<ManageSiteResult> {
    const runtime = await runtimeInfo();
    const bare = (error: string): ManageSiteResult => ({ ok: false, error, sites: [], runtime });

    const { decision, ws } = await resolveAgentTarget(terminalId, req.workspaceId);
    if (!decision.allowed || !ws) return bare(decision.reason);

    const manager = devSiteManager();
    if (!manager) {
        return bare(
            'The Genie Dev Server is not running in this process, so sites cannot be managed here.',
        );
    }

    const sites = () => manager.list(ws.id).map(toInfo);
    const fail = (error: string, extra: Partial<ManageSiteResult> = {}): ManageSiteResult => ({
        ok: false,
        error,
        sites: sites(),
        runtime,
        ...extra,
    });

    /** The repo subfolder a create/detect targets, validated against the envelope. */
    const resolveRepoDir = (repo: string | undefined): { dir: string } | { error: string } => {
        if (!repo) return { dir: ws.path };
        let repos: string[] = [];
        try {
            repos = detectFolder(ws.path).repos ?? [];
        } catch {
            repos = [];
        }
        if (!repos.includes(repo)) {
            return {
                error: `Unknown repo "${repo}". Available: ${repos.join(', ') || '(none)'}.`,
            };
        }
        return { dir: path.join(ws.path, 'repos', repo) };
    };

    /** Every non-create action needs an id that is actually a site here. */
    const targetSite = (): { siteId: string; config: DevSiteConfig } | { error: string } => {
        const siteId = req.id?.trim();
        if (!siteId) return { error: 'This action needs `id` — the site id from a `list` result.' };
        const config = getWorkspaceDevSites(ws.id)[siteId];
        if (!config) {
            return { error: `No site "${siteId}" in workspace ${ws.project_name}.` };
        }
        return { siteId, config };
    };

    try {
        switch (req.action) {
            case 'list':
            case 'status':
                return { ok: true, sites: sites(), runtime, ...(req.id ? { affectedId: req.id } : {}) };

            case 'detect': {
                const repo = resolveRepoDir(req.repo);
                if ('error' in repo) return fail(repo.error);
                const { options } = describeRepoRun(repo.dir, req.port ? { port: req.port } : {});
                return { ok: true, sites: sites(), runtime, options: options.map(toOption) };
            }

            case 'create': {
                const name = req.name?.trim().toLowerCase();
                if (!name) return fail('create requires `name` — a DNS label like "web" or "api".');
                const repo = resolveRepoDir(req.repo);
                if ('error' in repo) return fail(repo.error);

                let command = req.command;
                let port = req.port;
                let runMode = req.runMode;
                let applied: DevSiteOption | undefined;
                let options: DevSiteOption[] | undefined;

                // Nothing explicit supplied → read the repo and take the
                // recommendation, so "serve the frontend" is ONE call.
                if (!command && !req.image) {
                    const described = describeRepoRun(repo.dir, port ? { port } : {});
                    options = described.options;
                    applied = runMode
                        ? described.options.find((o) => o.runMode === runMode)
                        : (described.recommended ?? undefined);
                    if (!applied || (!applied.command && applied.runMode !== 'dockerfile')) {
                        return fail(
                            `Nothing in ${req.repo || 'this workspace'} says how it runs. Supply \`command\` (literal argv) and \`port\`, or pick one of the options below.`,
                            { options: described.options.map(toOption) },
                        );
                    }
                    command = applied.command;
                    port = port ?? applied.port;
                    runMode = applied.runMode as ManageSiteRequest['runMode'];
                }

                if (!port) {
                    return fail(
                        'create requires `port` — the port the server listens on INSIDE the container. Without it there is nothing to publish.',
                        options ? { options: options.map(toOption) } : {},
                    );
                }

                const siteId = setWorkspaceDevSite(ws.id, {
                    name,
                    genName: req.genName ?? defaultGenNameFor(slugLabel(ws.project_name), name),
                    repo: req.repo ?? '',
                    runMode: runMode ?? 'explicit',
                    ...(req.image ? { image: req.image } : {}),
                    ...(command ? { command } : {}),
                    port,
                    ...(req.env ? { env: req.env } : {}),
                    kind: req.kind ?? 'http',
                    ...(req.upstreamHost ? { upstreamHost: req.upstreamHost } : {}),
                    // Defined AND started unless the caller says otherwise: a
                    // site nobody asked to keep off is one they want serving.
                    enabled: req.enabled !== false,
                });
                if (!siteId) {
                    return fail(
                        `Could not define a site called "${name}". A name must be a DNS label — letters, digits and hyphens only — and a \`genName\`, if you pass one, must end in \`.gen\`.`,
                        options ? { options: options.map(toOption) } : {},
                    );
                }

                if (req.enabled === false) {
                    return {
                        ok: true,
                        sites: sites(),
                        affectedId: siteId,
                        runtime,
                        ...(options ? { options: options.map(toOption) } : {}),
                        ...(applied ? { applied: toOption(applied) } : {}),
                    };
                }
                const status = await manager.start(ws.id, siteId);
                return {
                    ok: status.state !== 'failed',
                    ...(status.error ? { error: status.error } : {}),
                    sites: sites(),
                    affectedId: siteId,
                    runtime,
                    ...(options ? { options: options.map(toOption) } : {}),
                    ...(applied ? { applied: toOption(applied) } : {}),
                };
            }

            case 'start':
            case 'restart': {
                const target = targetSite();
                if ('error' in target) return fail(target.error);
                // Starting a site is also the act of enabling it — otherwise a
                // reconcile after the next launch would quietly stop it again.
                if (!target.config.enabled) {
                    setWorkspaceDevSite(ws.id, { siteId: target.siteId, enabled: true });
                }
                const status =
                    req.action === 'restart'
                        ? await manager.restart(ws.id, target.siteId)
                        : await manager.start(ws.id, target.siteId);
                return {
                    ok: status.state !== 'failed',
                    ...(status.error ? { error: status.error } : {}),
                    sites: sites(),
                    affectedId: target.siteId,
                    runtime,
                };
            }

            case 'stop': {
                const target = targetSite();
                if ('error' in target) return fail(target.error);
                await manager.stop(target.siteId);
                // Persisted, so it stays stopped across a restart rather than
                // being started again by the boot reconcile.
                setWorkspaceDevSite(ws.id, { siteId: target.siteId, enabled: false });
                return { ok: true, sites: sites(), affectedId: target.siteId, runtime };
            }

            case 'logs': {
                const target = targetSite();
                if ('error' in target) return fail(target.error);
                return {
                    ok: true,
                    sites: sites(),
                    affectedId: target.siteId,
                    logs: await manager.logs(target.siteId, req.tail),
                    runtime,
                };
            }

            case 'open': {
                const target = targetSite();
                if ('error' in target) return fail(target.error);
                if (!deps.openInBrowser) {
                    return fail(
                        `This Genie has no browser to open (a headless host). The site is reachable at https://${target.config.genName} from a Genie client connected to it.`,
                    );
                }
                const opened = await deps.openInBrowser(target.config.genName);
                return {
                    ok: opened.ok,
                    ...(opened.error ? { error: opened.error } : {}),
                    sites: sites(),
                    affectedId: target.siteId,
                    runtime,
                };
            }

            case 'remove': {
                const target = targetSite();
                if ('error' in target) return fail(target.error);
                // Stop FIRST: forgetting the definition while the container is
                // up would orphan it — nothing would know its name to remove it.
                await manager.stop(target.siteId);
                deleteWorkspaceDevSite(ws.id, target.siteId);
                return { ok: true, sites: sites(), affectedId: target.siteId, runtime };
            }

            default:
                return fail(`Unknown action ${String(req.action)}.`);
        }
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    }
}

/** Re-exported so a caller can build the same id the tool reports. */
export { devSiteIdFor };
