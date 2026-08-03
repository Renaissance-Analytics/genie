import path from 'node:path';
import {
    deleteWorkspaceDevSite,
    getWorkspaceDevSites,
    setWorkspaceDevSite,
} from '../db';
import {
    devSiteIdFor,
    defaultGenNameFor,
    devSiteReconfigureNeedsRestart,
    slugLabel,
} from '../dev-server/sites-config';
import { describeRepoRun } from '../dev-server/repo-facts';
import { devSiteManager } from '../dev-server/site-manager';
import { resolveContainerRuntime } from '../dev-server';
import { detectFolder } from '../workspace/detect';
import { resolveAgentTarget } from './host-tools';
import { planHostAllowlist } from '../dev-server/host-allowlist';
import type { DevFramework } from '../dev-server/host-allowlist';
import type { BuildStep, HostingOption } from '../dev-server/serve-recipe';
import type { DevSiteRow } from '../dev-server/site-manager';
import type { DevSiteConfig } from '../dev-server/sites-config';
import type {
    DevSiteInfo,
    DevSiteRunOption,
    ManageSiteRequest,
    ManageSiteResult,
} from './protocol';

/**
 * The HOST side of the `manageSite` MCP tool — the agent-first administration
 * surface for the Hosting Manager.
 *
 * The discovery's decision was that agents drive this and the human UX is the
 * secondary viewer, so this file is the primary path, not a convenience wrapper
 * over one. It does the four kinds of I/O `protocol.ts` deliberately has none
 * of: resolving the caller's workspace, reading a repo off disk to detect how it
 * runs, persisting the definition, and driving the site manager.
 *
 * ## Two behaviours worth naming
 *
 * **`create` finishes the job.** An agent asked to "host the frontend" should
 * not have to make four calls. `create` with just a `name` detects the repo's
 * stack, takes the recommended production BUILD + SERVE recipe, stores it,
 * builds it and starts the production server — reporting which recipe it applied
 * and what else was on offer. When nothing can be recommended it FAILS with the
 * options attached, so the next call is obvious rather than a guess.
 *
 * **The runtime's absence is data, not an exception.** Every result carries
 * `runtime`, so an agent that gets `ok: false` on a machine with no Docker reads
 * the install hint out of the same object instead of parsing a message.
 *
 * ## The human UX runs THIS code (P4)
 *
 * {@link runManageSite} is the whole tool with the agent's authorization lifted
 * off the front. `manageSiteForMcp` is that plus `resolveAgentTarget`; the
 * Site Manager's `dev:site` IPC is that plus "the workspace the window is
 * showing". So the secondary UX is not a parallel implementation of the same
 * verbs — it IS the verbs, and a behaviour can never drift between the two.
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
 * Is the Hosting Manager usable here? Gates `manageSite` out of `tools/list`.
 * Fail CLOSED — see `McpContext.devServerAvailable`.
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
        ...(row.stack ? { stack: row.stack } : {}),
        ...(row.server ? { server: row.server } : {}),
        ...(row.build?.length ? { build: row.build } : {}),
        ...(row.serve ? { serve: row.serve } : {}),
        ...(row.image ? { image: row.image } : {}),
        ...(row.buildLog ? { buildLog: row.buildLog } : {}),
        ...(row.exposed?.length ? { exposed: row.exposed } : {}),
        // Stored env + upstream Host, so the human Edit form can prefill them.
        ...(row.env && Object.keys(row.env).length ? { env: row.env } : {}),
        ...(row.upstreamHost ? { upstreamHost: row.upstreamHost } : {}),
        // The transient start phase, present only while a start is in flight.
        ...(row.phase ? { phase: row.phase } : {}),
        ...(row.error ? { error: row.error } : {}),
    };
}

function toOption(option: HostingOption): DevSiteRunOption {
    return {
        runMode: option.runMode,
        ...(option.stack ? { stack: option.stack } : {}),
        ...(option.server ? { server: option.server } : {}),
        source: option.source,
        reason: option.reason,
        ...(option.build.length ? { build: option.build } : {}),
        ...(option.serve ? { serve: option.serve } : {}),
        ...(option.image ? { image: option.image } : {}),
        ...(option.port ? { port: option.port } : {}),
        confident: option.confident,
        ...(option.needs ? { needs: option.needs } : {}),
    };
}

/** Normalize a caller-supplied build list — a step with no label still runs. */
function toBuildSteps(
    steps: NonNullable<ManageSiteRequest['build']>,
): BuildStep[] {
    return steps
        .filter((step) => Array.isArray(step?.command) && step.command.length > 0)
        .map((step) => ({
            label: step.label?.trim() || step.command.join(' '),
            command: step.command,
            ...(step.optional ? { optional: true } : {}),
        }));
}

// --- the tool ---------------------------------------------------------------

/** The workspace fields the tool reads. Narrower than a `WorkspaceRow` so the
 *  UX can call this without pretending to be an agent. */
export interface DevSiteTarget {
    id: string;
    path: string;
    project_name: string;
}

export async function manageSiteForMcp(
    terminalId: string,
    req: ManageSiteRequest,
): Promise<ManageSiteResult> {
    const { decision, ws } = await resolveAgentTarget(terminalId, req.workspaceId);
    if (!decision.allowed || !ws) {
        return { ok: false, error: decision.reason, sites: [], runtime: await runtimeInfo() };
    }
    return runManageSite(ws, req);
}

/**
 * The tool itself, against an ALREADY-RESOLVED workspace.
 *
 * The MCP path resolves it through the agent-access decision; the Site Manager
 * resolves it from the window's own workspace. Everything after that point is
 * identical, and deliberately so — see the file header.
 */
export async function runManageSite(
    ws: DevSiteTarget,
    req: ManageSiteRequest,
): Promise<ManageSiteResult> {
    const runtime = await runtimeInfo();
    const bare = (error: string): ManageSiteResult => ({ ok: false, error, sites: [], runtime });

    const manager = devSiteManager();
    if (!manager) {
        return bare(
            'The Genie Hosting Manager is not running in this process, so sites cannot be managed here.',
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

                let serve = req.serve;
                let build = req.build ? toBuildSteps(req.build) : undefined;
                let image = req.image;
                let env = req.env;
                let port = req.port;
                let runMode = req.runMode;
                let applied: HostingOption | undefined;
                let options: HostingOption[] | undefined;
                let framework: DevFramework | undefined;
                let stack: HostingOption['stack'] | undefined;
                let server: HostingOption['server'] | undefined;

                // Nothing explicit supplied → read the repo and take the
                // recommended PRODUCTION recipe, so "host the frontend" is ONE
                // call that builds and serves.
                if (!serve && !req.image) {
                    const described = describeRepoRun(repo.dir, port ? { port } : {});
                    options = described.options;
                    applied = runMode
                        ? described.options.find((o) => o.runMode === runMode)
                        : (described.recommended ?? undefined);
                    if (!applied || (!applied.serve && applied.runMode !== 'dockerfile')) {
                        return fail(
                            `Nothing in ${req.repo || 'this workspace'} says how it is built and served in production. Supply \`serve\` (literal argv) and \`port\` — plus \`build\` steps if it has to be built — or pick one of the options below.`,
                            { options: described.options.map(toOption) },
                        );
                    }
                    serve = applied.serve;
                    build = build ?? applied.build;
                    // The recipe's image is load-bearing, not a preference: a
                    // PHP site serves from FrankenPHP and a built front end from
                    // nginx, and neither is the workspace dev image.
                    image = image ?? applied.image;
                    // UNDER the caller's env — a value they pinned always wins.
                    env = { ...(applied.env ?? {}), ...(env ?? {}) };
                    port = port ?? applied.port;
                    runMode = applied.runMode as ManageSiteRequest['runMode'];
                    stack = applied.stack;
                    server = applied.server;
                    // The ONLY moment this is knowable: `gunicorn mysite.wsgi`
                    // contains no token spelling "django", and Django is the one
                    // framework whose host allowlist still bites in production.
                    framework = applied.framework;
                }

                if (!port) {
                    return fail(
                        'create requires `port` — the port the production server listens on INSIDE the container. Without it there is nothing to publish.',
                        options ? { options: options.map(toOption) } : {},
                    );
                }

                const siteId = setWorkspaceDevSite(ws.id, {
                    name,
                    genName: req.genName ?? defaultGenNameFor(slugLabel(ws.project_name), name),
                    repo: req.repo ?? '',
                    runMode: runMode ?? 'explicit',
                    ...(stack ? { stack } : {}),
                    ...(server ? { server } : {}),
                    ...(image ? { image } : {}),
                    ...(build?.length ? { build } : {}),
                    ...(serve ? { serve } : {}),
                    port,
                    ...(req.exposed
                        ? { exposed: req.exposed as never }
                        : {}),
                    ...(env && Object.keys(env).length ? { env } : {}),
                    kind: req.kind ?? 'http',
                    ...(framework ? { framework } : {}),
                    ...(req.upstreamHost ? { upstreamHost: req.upstreamHost } : {}),
                    // Defined, BUILT and served unless the caller says
                    // otherwise: a site nobody asked to keep off is one they
                    // want hosted.
                    enabled: req.enabled !== false,
                });
                if (!siteId) {
                    return fail(
                        `Could not define a site called "${name}". A name must be a DNS label — letters, digits and hyphens only — and a \`genName\`, if you pass one, must end in \`.gen\`. An \`exposed\` surface must carry a \`reason\` naming what the BROWSER needs it for.`,
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
                // Reported on CREATE, where it is actionable. A `documented`
                // status means the repo still has to change, and an agent that
                // does not hear that will debug a working container.
                const plan = planHostAllowlist({
                    genName: getWorkspaceDevSites(ws.id)[siteId]?.genName ?? '',
                    ...(framework ? { framework } : {}),
                    // The recipe stack/server, so a production serve (e.g. a
                    // FrankenPHP Laravel app with no `artisan` token) is reported
                    // with its real host/scheme plan rather than as `none` (#119).
                    ...(stack ? { stack } : {}),
                    ...(server ? { server } : {}),
                    ...(serve ? { command: serve } : {}),
                    ...(req.upstreamHost ? { upstreamHost: req.upstreamHost } : {}),
                });
                return {
                    ok: status.state !== 'failed',
                    ...(status.error ? { error: status.error } : {}),
                    sites: sites(),
                    affectedId: siteId,
                    runtime,
                    hostAllowlist: {
                        framework: plan.framework,
                        status: plan.status,
                        note: plan.note,
                        ...(plan.upstreamHostFallback
                            ? { upstreamHostFallback: plan.upstreamHostFallback }
                            : {}),
                    },
                    ...(options ? { options: options.map(toOption) } : {}),
                    ...(applied ? { applied: toOption(applied) } : {}),
                };
            }

            case 'update': {
                const target = targetSite();
                if ('error' in target) return fail(target.error);
                const before = target.config;

                // A patch of ONLY the fields the caller named — anything omitted
                // is left exactly as stored (see setWorkspaceDevSite's merge).
                const patch: Partial<DevSiteConfig> & { siteId: string } = {
                    siteId: target.siteId,
                };
                if (req.name !== undefined) patch.name = req.name;
                if (req.genName !== undefined) patch.genName = req.genName;
                if (req.repo !== undefined) patch.repo = req.repo;
                if (req.runMode !== undefined) patch.runMode = req.runMode;
                if (req.image !== undefined) patch.image = req.image;
                if (req.build !== undefined) patch.build = toBuildSteps(req.build);
                if (req.serve !== undefined) patch.serve = req.serve;
                if (req.port !== undefined) patch.port = req.port;
                if (req.exposed !== undefined) patch.exposed = req.exposed as never;
                if (req.env !== undefined) patch.env = req.env;
                if (req.kind !== undefined) patch.kind = req.kind;
                if (req.upstreamHost !== undefined) patch.upstreamHost = req.upstreamHost;
                if (req.enabled !== undefined) patch.enabled = req.enabled;

                // Read live state under the CURRENT id BEFORE persisting — a
                // rename moves the config to a new id, so afterwards the manager
                // could no longer find the old-id container that is still running.
                const running =
                    manager.list(ws.id).find((s) => s.siteId === target.siteId)?.state === 'running';

                const newId = setWorkspaceDevSite(ws.id, patch);
                if (!newId) {
                    return fail(
                        'That change would make the site unusable. A `name` must be a DNS label, a `genName` must end in `.gen`, and an `exposed` surface must carry a `reason` naming what the BROWSER needs it for.',
                    );
                }
                const after = getWorkspaceDevSites(ws.id)[newId];

                // Only a RUNNING site whose container facts moved needs the
                // rebuild/restart; a stopped site, or a cosmetic edit, is left as
                // it is. `previousSiteId` differs only on a rename.
                const restart = running && devSiteReconfigureNeedsRestart(before, after);
                const status = await manager.reconfigure(ws.id, newId, {
                    previousSiteId: target.siteId,
                    restart,
                });
                return {
                    ok: status.state !== 'failed',
                    ...(status.error ? { error: status.error } : {}),
                    sites: sites(),
                    affectedId: newId,
                    runtime,
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
