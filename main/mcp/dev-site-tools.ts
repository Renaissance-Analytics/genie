import { describeDroppedSiteFields } from '../dev-server/sites-config';
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
import { describeRepoRun, detectPhpServe, detectStaticServe } from '../dev-server/repo-facts';
import { applySetEnv } from '../env-store';
import { devSiteManager } from '../dev-server/site-manager';
import { resolveContainerRuntime } from '../dev-server';
import { detectFolder } from '../workspace/detect';
import { resolveAgentTarget } from './host-tools';
import { planHostAllowlist } from '../dev-server/host-allowlist';
import type { DevFramework } from '../dev-server/host-allowlist';
import { devCommandForRecipe, unrunnableRunModeReason } from '../dev-server/serve-recipe';
import type { BuildStep, HostingOption } from '../dev-server/serve-recipe';
import type { DevSiteRow } from '../dev-server/site-manager';
import type { DevSiteConfig, HostServeConfig } from '../dev-server/sites-config';
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
 * **`create` finishes the job — and defaults to DEV, not production.** An agent
 * asked to "host the frontend" should not have to make four calls. `create` with
 * just a `name` detects the repo's stack and runs its DEV server HOST-NATIVE
 * (runMode `host`): a real host process against the LIVE source, `.gen` routed
 * straight to it, with NO container and NO build — "just serve the repo the site
 * points to", the way Herd did (Docker only for services). Two other host-native
 * shapes: pass `command` + `port` to run YOUR dev server, or `hostPort` to point
 * `.gen` at a dev server you already run (e.g. via `manageProcess`). When nothing
 * can be recommended it FAILS with the options attached, so the next call is
 * obvious.
 *
 * **A production BUILD+SERVE is REFUSED, not silently approximated (genie#191).**
 * `recipe`/`dockerfile`/`compose`/`devcontainer` describe machinery this model
 * dropped — no per-site container, no build runner (`site-build.ts` has had no
 * caller since) — so accepting one stored a production recipe and then ran its
 * serve argv as a dev command with the build skipped, reporting `running` the
 * whole way. {@link unrunnableRunModeReason} is the single policy; create, update
 * and the options `detect` returns all speak through it.
 *
 * **A start that outlives the call answers anyway (genie#194).** A cold image pull
 * is minutes and the MCP transport gives a call ~120s, so every lifecycle action
 * is bounded by {@link settleWithin}: past the budget the tool returns
 * `pending: true` plus the id to poll, rather than holding the call open until the
 * transport kills it and the caller is left with a timeout and no handle.
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
        workspaceId: row.workspaceId,
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
        ...(row.localCurl ? { localCurl: row.localCurl } : {}),
        ...(row.stack ? { stack: row.stack } : {}),
        ...(row.server ? { server: row.server } : {}),
        ...(row.build?.length ? { build: row.build } : {}),
        ...(row.command ? { command: row.command } : {}),
        ...(row.serve ? { serve: row.serve } : {}),
        ...(row.image ? { image: row.image } : {}),
        ...(row.buildLog ? { buildLog: row.buildLog } : {}),
        ...(row.exposed?.length ? { exposed: row.exposed } : {}),
        // Stored env + upstream Host, so the human Edit form can prefill them.
        ...(row.env && Object.keys(row.env).length ? { env: row.env } : {}),
        ...(row.upstreamHost ? { upstreamHost: row.upstreamHost } : {}),
        // The serve mode (static/php), so the Edit form's picker prefills.
        ...(row.hostServe ? { hostServe: row.hostServe } : {}),
        ...(row.browserExposed ? { browserExposed: row.browserExposed } : {}),
        // The transient start phase, present only while a start is in flight.
        ...(row.phase ? { phase: row.phase } : {}),
        ...(row.error ? { error: row.error } : {}),
    };
}

function toOption(option: HostingOption): DevSiteRunOption {
    // An option Genie cannot RUN says so in the same field a caller already reads
    // for "what is still missing" (genie#191). Detection describes the repo
    // honestly; whether this build can execute the mode is our fact to add, and
    // offering a recipe with nothing attached is how one gets picked and stored.
    const cannotRun = unrunnableRunModeReason(option.runMode);
    const needs = [
        option.needs,
        cannotRun ? `Genie cannot run this mode in this build: ${cannotRun}` : '',
    ]
        .filter(Boolean)
        .join(' ');
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
        ...(needs ? { needs } : {}),
    };
}

/**
 * How long a lifecycle action waits for the site to SETTLE before answering
 * "still going" instead (genie#194).
 *
 * An MCP call gets ~120s from the transport, and a start can legitimately take
 * longer: a cold dev-image pull is minutes, and a first `npm install` inside it is
 * not quick either. Blocking to the cap gave the caller "The operation timed out"
 * — no state, no handle — while the start carried on unobserved, so the only way
 * to learn the outcome was to poll `status` anyway. This budget is comfortably
 * under the cap and comfortably over a warm start (the readiness probe alone is
 * 15s), so an ordinary call still returns the real result.
 */
const DEFAULT_SETTLE_MS = 30_000;

/** Options the callers of {@link runManageSite} may tune. Tests shorten the wait;
 *  nothing in the product does. */
export interface RunManageSiteOptions {
    settleMs?: number;
}

/**
 * Await a lifecycle call, but never past `settleMs` — `null` means "not settled".
 *
 * The work is NOT cancelled: the site manager owns it, de-duplicates a concurrent
 * `start` for the same site, and records the outcome for the next `list`/`status`.
 * So returning early loses nothing except the wait.
 */
async function settleWithin<T>(work: Promise<T>, settleMs: number): Promise<T | null> {
    // A late failure must not become an unhandled rejection once the race is over;
    // the manager has already recorded it as this site's last failure.
    work.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), settleMs);
    });
    try {
        return await Promise.race([work, deadline]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** The note a PENDING result carries: what is still happening, and the exact call
 *  that reads the outcome. */
function pendingNote(action: string, siteId: string): string {
    return `The ${action} is still running — this call returned before it finished so it would not hit the 120s tool timeout. Nothing was abandoned: poll \`manageSite {action:'status', id:'${siteId}'}\` until \`phase\` reaches \`ready\` or \`failed\` (\`logs\` shows it as it goes). Do NOT report the site as live until then.`;
}

/**
 * Narrow the loose request/detected serve shape to the stored discriminated
 * union — the create AND update paths share this. A falsy input (proxy, cleared,
 * or nothing detected) is `undefined`; the store re-validates the `root` through
 * `sanitizeDevSitePatch`, so this only picks the branch.
 */
function narrowHostServe(
    hs: { mode: 'static' | 'php'; root: string; spa?: boolean; version?: string } | null | undefined,
): HostServeConfig | undefined {
    if (!hs) return undefined;
    return hs.mode === 'php'
        ? // The pin rides through as given; `sanitizeDevSitePatch` is what decides a
          // string is a version, so one validator owns that rule (genie#207).
          { mode: 'php', root: hs.root, ...(hs.version ? { version: hs.version } : {}) }
        : { mode: 'static', root: hs.root, ...(hs.spa ? { spa: true } : {}) };
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
/**
 * Advisory notes to surface on `create` AND `update` — things recorded but not the
 * trap they look like. Pure, so it is tested without the DB/manager the rest of the
 * tool needs. Currently: a custom `image` is a legacy per-site-container concept;
 * in the sandbox-serve model a site runs its command inside the shared workspace
 * dev sandbox, so the ref is stored but never used — say so rather than let it be a
 * silent trap (genie #125). Surfaced on UPDATE too, because that is where it was
 * silent: `update {image}` recorded the ref and reported success (genie#191).
 */
export function siteAdvisoryNotes(req: Pick<ManageSiteRequest, 'image' | 'build'>): string[] {
    const notes: string[] = [];
    if (req.image) {
        notes.push(
            'The custom `image` is recorded but NOT used at runtime — a site runs its command inside the workspace dev sandbox, not a per-site image container. Put extra runtime tools in the workspace / its dev image, not a per-site `image`.',
        );
    }
    if (req.build?.length) {
        notes.push(
            'The `build` steps are recorded but NOT run — nothing executes a site build in this model (genie#191), so the site starts against the tree exactly as it is on disk. Run the build yourself (a terminal, or `manageProcess`) and serve the output with `hostServe`.',
        );
    }
    return notes;
}

/**
 * Route a site's `env` to the repo's `.env`, NOT the tracked `project.json` (genie
 * #168). `project.json` is committed + pushed, so a secret in `sites.<id>.env`
 * leaks; env — secret or not, and per-dev — belongs in the repo's `.env`, which the
 * app reads and which Genie gitignores. Writes each key via {@link applySetEnv} and
 * returns advisory notes naming where they went (so the write is never silent).
 */
export function routeSiteEnvToDotEnv(
    workspaceRoot: string,
    repo: string | undefined,
    env: Record<string, string> | undefined,
): string[] {
    if (!env || Object.keys(env).length === 0) return [];
    const wrote: string[] = [];
    const failed: string[] = [];
    for (const [key, value] of Object.entries(env)) {
        const res = applySetEnv(workspaceRoot, { key, value, ...(repo ? { target: repo } : {}) });
        if (res.ok) wrote.push(key);
        else failed.push(`${key} (${res.error})`);
    }
    const file = repo ? `repos/${repo}/.env` : '.env';
    const notes: string[] = [];
    if (wrote.length) {
        notes.push(
            `Wrote ${wrote.join(', ')} to ${file} (gitignored), NOT project.json — a site's env is never stored in the tracked manifest (it would leak on push); the app reads it from its \`.env\` and Genie injects service env at runtime.`,
        );
    }
    if (failed.length) notes.push(`Could not write to ${file}: ${failed.join('; ')}.`);
    return notes;
}

export async function runManageSite(
    ws: DevSiteTarget,
    req: ManageSiteRequest,
    opts: RunManageSiteOptions = {},
): Promise<ManageSiteResult> {
    const runtime = await runtimeInfo();
    const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
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
                // The INVENTORY, on the state the manager already holds. Every
                // other action's envelope calls this too, so a probe here would put
                // a network round-trip behind all of them.
                return { ok: true, sites: sites(), runtime, ...(req.id ? { affectedId: req.id } : {}) };

            case 'status':
                // The HEALTH question, and it is a LIVE one (genie#305). `ready` was
                // written only on the start path, so a `hostServe: php` site whose
                // php-cgi backend died went on reporting `ready: true` while every
                // request 502'd — the answer outliving the thing it measured. Re-ask
                // before answering, and read the sites AFTER.
                await manager.refresh(ws.id);
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
                // A run mode this build cannot run is REFUSED before anything is
                // stored (genie#191). Recording it and starting the site anyway is
                // what produced a `recipe` site that ran an unbuilt dev command
                // while reporting a production build+serve.
                const cannotRun = unrunnableRunModeReason(req.runMode);
                if (cannotRun) return fail(cannotRun);
                const repo = resolveRepoDir(req.repo);
                if ('error' in repo) return fail(repo.error);

                // The USER-CONTROLLED startup argv — the canonical way to start a
                // site in the sandbox-serve model. When supplied, Genie runs it
                // verbatim against the live source; no recipe is detected.
                let command = req.command;
                let serve = req.serve;
                let build = req.build ? toBuildSteps(req.build) : undefined;
                let image = req.image;
                let env = req.env;
                let port = req.port;
                let runMode = req.runMode;
                // HOST-NATIVE (story #238): point .gen at a dev server already
                // running as a HOST process on 127.0.0.1:<hostPort> — no container,
                // no recipe, no build. When set, it bypasses recipe detection and
                // the command/port requirements below.
                const hostPort = req.hostPort;
                // GENIE-served host-native site (static / php): an explicit serve MODE,
                // OR — when nothing else is specified — a DETECTED built static site
                // (dist/build/out + index.html, no dev server). Genie owns the web
                // server AND the port, so there is nothing to detect or require below.
                const nothingElseSpecified =
                    !command && !serve && !req.image && !hostPort && !req.hostServe;
                // A PHP app is SERVED, never run: `public/` over FastCGI, the shape
                // every host uses. Checked before the static case because a Laravel
                // repo can also carry a built `public/build`, and `artisan serve`
                // must not be the answer for either — it is a development
                // convenience that leaves two long-lived processes per site with
                // nothing to do but leak.
                const detectedServe = nothingElseSpecified
                    ? (detectPhpServe(repo.dir) ?? detectStaticServe(repo.dir))
                    : null;
                const hostServe = req.hostServe ?? detectedServe ?? undefined;
                if (hostServe) runMode = 'host';
                // Narrow the loose request shape to the stored discriminated union;
                // the store re-validates the root through sanitizeDevSitePatch.
                const hostServeConfig = narrowHostServe(hostServe);
                let applied: HostingOption | undefined;
                let options: HostingOption[] | undefined;
                let framework: DevFramework | undefined;
                let stack: HostingOption['stack'] | undefined;

                // Nothing to start supplied → read the repo and, BY DEFAULT, run its
                // DEV server host-native (story #238): "just serve the repo the site
                // points to" — a HOST process against live source, NO container, NO
                // build. A production BUILD+SERVE is still available, but only when
                // the caller EXPLICITLY asks (runMode: recipe|dockerfile|compose|
                // devcontainer). Skipped entirely when the caller gave a `command`,
                // `image` or `hostPort`.
                if (!command && !serve && !req.image && !hostPort && !hostServe) {
                    const described = describeRepoRun(repo.dir, port ? { port } : {});
                    options = described.options;
                    applied = runMode
                        ? described.options.find((o) => o.runMode === runMode)
                        : (described.recommended ?? undefined);
                    if (!applied) {
                        return fail(
                            `Genie could not detect how to run ${req.repo || 'this workspace'}. Pass a \`command\` + \`port\` (the dev server to run), or \`hostPort\` to point \`.gen\` at a dev server you already run on the host.`,
                            { options: described.options.map(toOption) },
                        );
                    }

                    const dev = devCommandForRecipe(applied);

                    if (dev) {
                        // DEV BY DEFAULT — the repo's dev server run host-native.
                        command = dev.command;
                        port = port ?? dev.port;
                        runMode = 'host';
                        stack = dev.stack ?? applied.stack;
                        framework = dev.framework ?? applied.framework;
                    } else {
                        // No dev server Genie can pick. The detected recipe is NOT a
                        // fallback: adopting it stored a production build+serve and
                        // then ran its serve argv in the sandbox with the build steps
                        // skipped — a site that reports `running` having built
                        // nothing (genie#191). Say why, attach the options, stop.
                        const cannotRunApplied = unrunnableRunModeReason(applied.runMode);
                        return fail(
                            `Genie could not pick a dev server for ${req.repo || 'this workspace'}.${
                                cannotRunApplied
                                    ? ` The best it detected uses runMode:'${applied.runMode}', and that one is not runnable here: ${cannotRunApplied}`
                                    : ' Pass a `command` + `port` (the dev server to run), or `hostPort` to point `.gen` at one you already run.'
                            }`,
                            { options: described.options.map(toOption) },
                        );
                    }
                }

                if (!command && !serve && !image && !hostPort && !hostServe) {
                    return fail(
                        'create needs a `command` — the argv Genie runs to start the site against the live source, e.g. ["npm","run","dev"]. (Legacy `serve`/`image` also work; pass `hostPort` to point `.gen` at a dev server you already run on the host, or `hostServe` to have Genie serve a built dir / PHP app itself.)',
                        options ? { options: options.map(toOption) } : {},
                    );
                }
                // A managed host-native site needs NO port from the caller: the HOST
                // allocates a guaranteed-free one at start (agents never pick ports).
                // Only a container/recipe site needs a port for its sandbox-Caddy
                // upstream; an external `hostPort` site brings its own.
                if (!port && !hostPort && runMode !== 'host') {
                    return fail(
                        'create requires `port` — the port the site\'s command listens on INSIDE the sandbox. Without it Caddy has nothing to route `.gen` to. (Or pass `hostPort` for a host-native site that points `.gen` straight at a host dev-server port.)',
                        options ? { options: options.map(toOption) } : {},
                    );
                }

                const siteId = setWorkspaceDevSite(ws.id, {
                    name,
                    genName: req.genName ?? defaultGenNameFor(slugLabel(ws.project_name), name),
                    repo: req.repo ?? '',
                    runMode: runMode ?? 'explicit',
                    ...(stack ? { stack } : {}),
                    ...(image ? { image } : {}),
                    ...(build?.length ? { build } : {}),
                    ...(command?.length ? { command } : {}),
                    ...(serve ? { serve } : {}),
                    // A managed host-native site's port is HOST-owned (allocated fresh
                    // at start), so it is never persisted — persisting a fixed port is
                    // exactly the collision vector this redesign removes.
                    ...(port && runMode !== 'host' ? { port } : {}),
                    ...(hostPort ? { hostPort } : {}),
                    ...(hostServeConfig ? { hostServe: hostServeConfig } : {}),
                    ...(req.exposed
                        ? { exposed: req.exposed as never }
                        : {}),
                    ...(env && Object.keys(env).length ? { env } : {}),
                    kind: req.kind ?? 'http',
                    ...(framework ? { framework } : {}),
                    ...(req.upstreamHost ? { upstreamHost: req.upstreamHost } : {}),
                    ...(req.browserExposed ? { browserExposed: req.browserExposed } : {}),
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

                // Advisory notes, surfaced on CREATE where they are actionable. A
                // passed `env` is written to the repo's `.env` (gitignored), never
                // the tracked project.json (genie #168) — done before the site
                // starts so the app reads it.
                const notes = [
                    ...siteAdvisoryNotes(req),
                    ...routeSiteEnvToDotEnv(ws.path, req.repo, req.env),
                    ...(detectedServe && !req.hostServe
                        ? [
                              `Detected a built static site (${detectedServe.root}/) — serving it with Genie's static file server + SPA fallback. Pass a \`command\` to run a dev server instead, or \`hostServe\` to override.`,
                          ]
                        : []),
                ];
                if (req.enabled === false) {
                    return {
                        ok: true,
                        sites: sites(),
                        affectedId: siteId,
                        runtime,
                        ...(notes.length ? { notes } : {}),
                        ...(options ? { options: options.map(toOption) } : {}),
                        ...(applied ? { applied: toOption(applied) } : {}),
                    };
                }
                // Bounded (genie#194): a cold image pull outlives the tool call, and
                // an unanswered call is worse than a pending one — the start keeps
                // running either way, so say which happened.
                const status = await settleWithin(manager.start(ws.id, siteId), settleMs);
                // Reported on CREATE, where it is actionable. A `documented`
                // status means the repo still has to change, and an agent that
                // does not hear that will debug a working container.
                const plan = planHostAllowlist({
                    genName: getWorkspaceDevSites(ws.id)[siteId]?.genName ?? '',
                    ...(framework ? { framework } : {}),
                    // The stack, so the host/scheme plan is reported for what the
                    // site actually runs rather than as `none` (#119).
                    ...(stack ? { stack } : {}),
                    // The site's actual startup argv (the new command, or a legacy
                    // serve), so a framework hint the argv carries is recognised.
                    ...(command ?? serve ? { command: command ?? serve } : {}),
                    ...(req.upstreamHost ? { upstreamHost: req.upstreamHost } : {}),
                    ...(req.browserExposed ? { browserExposed: req.browserExposed } : {}),
                });
                return {
                    ok: status ? status.state !== 'failed' : true,
                    ...(status?.error ? { error: status.error } : {}),
                    ...(status ? {} : { pending: true }),
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
                    ...(notes.length || !status
                        ? { notes: [...notes, ...(status ? [] : [pendingNote('start', siteId)])] }
                        : {}),
                    ...(options ? { options: options.map(toOption) } : {}),
                    ...(applied ? { applied: toOption(applied) } : {}),
                };
            }

            case 'update': {
                const target = targetSite();
                if ('error' in target) return fail(target.error);
                const before = target.config;
                // Same refusal as create, and this is where it was reported from:
                // `update {runMode:'recipe', image:'…'}` came back `running` at once,
                // recorded the image, and built nothing (genie#191).
                const cannotRun = unrunnableRunModeReason(req.runMode);
                if (cannotRun) return fail(cannotRun);

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
                if (req.command !== undefined) patch.command = req.command;
                if (req.serve !== undefined) patch.serve = req.serve;
                if (req.port !== undefined) patch.port = req.port;
                if (req.exposed !== undefined) patch.exposed = req.exposed as never;
                if (req.env !== undefined) patch.env = req.env;
                if (req.kind !== undefined) patch.kind = req.kind;
                if (req.upstreamHost !== undefined) patch.upstreamHost = req.upstreamHost;
                if (req.enabled !== undefined) patch.enabled = req.enabled;
                if (req.browserExposed !== undefined) patch.browserExposed = req.browserExposed;
                // Serve mode (genie #167/#171). `null` CLEARS it (back to the repo's
                // own dev server); a config SETS it — and a served site is host-native,
                // so set `runMode:'host'` too (mirrors create). The key is set even for
                // the clear (undefined value) so the merge overrides the stored serve;
                // an OMITTED hostServe leaves it untouched.
                if (req.hostServe !== undefined) {
                    patch.hostServe = req.hostServe === null ? undefined : narrowHostServe(req.hostServe);
                    if (patch.hostServe && req.runMode === undefined) patch.runMode = 'host';
                }

                // A passed `env` goes to the repo's `.env` (gitignored), never the
                // tracked project.json (genie #168) — written before the reconfigure
                // below so a restart picks it up.
                const envNotes = routeSiteEnvToDotEnv(ws.path, req.repo ?? before.repo, req.env);

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
                // Bounded like create (genie#194): a restart re-runs the whole start,
                // and that is exactly the call that was blowing the 120s cap.
                const status = await settleWithin(
                    manager.reconfigure(ws.id, newId, {
                        previousSiteId: target.siteId,
                        restart,
                    }),
                    settleMs,
                );
                const updateNotes = [
                    ...envNotes,
                    // A field the sanitiser REFUSED. `setWorkspaceDevSite` copies
                    // only values that pass their check, so a bad `repo` or
                    // `genName` was previously dropped in silence and the site
                    // came back looking updated. The rules are right — a repo name
                    // becomes a path segment inside the workspace mount, and a
                    // non-`.gen` name would mint a cert the session must not trust
                    // — so this reports rather than relaxes.
                    ...describeDroppedSiteFields(patch),
                    ...siteAdvisoryNotes(req),
                    ...(status ? [] : [pendingNote('restart', newId)]),
                ];
                return {
                    ok: status ? status.state !== 'failed' : true,
                    ...(status?.error ? { error: status.error } : {}),
                    ...(status ? {} : { pending: true }),
                    sites: sites(),
                    affectedId: newId,
                    runtime,
                    ...(updateNotes.length ? { notes: updateNotes } : {}),
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
                // Bounded (genie#194) — see `settleWithin`. The site manager keeps
                // starting it; this call just stops holding the transport open.
                const status = await settleWithin(
                    req.action === 'restart'
                        ? manager.restart(ws.id, target.siteId)
                        : manager.start(ws.id, target.siteId),
                    settleMs,
                );
                return {
                    ok: status ? status.state !== 'failed' : true,
                    ...(status?.error ? { error: status.error } : {}),
                    ...(status ? {} : { pending: true }),
                    sites: sites(),
                    affectedId: target.siteId,
                    runtime,
                    ...(status ? {} : { notes: [pendingNote(req.action, target.siteId)] }),
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
