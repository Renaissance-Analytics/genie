import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyNavigation } from '../core/browser-policy.js';
import { siteFormDefaults, validateServiceForm, validateSiteForm, type Problem, type ServiceForm, type SiteForm, type SiteFormDefaults } from '../core/forms.js';
import { normalizeSiteName } from '../core/gen-name.js';
import type { ProcessLog } from '../core/output-tail.js';
import type { EngineChoice, ServiceInstance } from '../core/services.js';
import type { ComposedServices } from './compose.js';
import type { ProcessState, ProcessStatus } from './process-supervisor.js';
import type { CreateSiteInput, SiteInfo } from './site-manager.js';

/**
 * THE SERVICES AND SITES ACTIONS, ONCE (the owner, 2026-10-14: "agents should be using genie mcp tools to do all
 * configuration and genie app (not the agent), handles sites and services setup, start, etc.").
 *
 * The Services and Hosting tabs (feature-ipc.ts) and the agents' `services` / `sites` tools (mcp-tools-hosting.ts) make
 * the SAME calls through these functions: one validation, one env, one record of the person's stops. A second copy of
 * any of this would drift — the caller check had five copies and they disagreed three ways (mcp-callers.ts).
 *
 * WHO is acting is not decided here. The tabs are the person; the tools are an agent, and the tool module decides what
 * an agent may do (its own workspace only, the approval gate, never deleting data) before it calls in.
 */

/** What the actions need from the composition — the real one in Genie and in the tests. */
export type HostingServices = Pick<ComposedServices, 'engines' | 'envelopeSites' | 'sites' | 'supervisor' | 'routes' | 'engineStatuses' | 'startEngine' | 'stopEngine' | 'removeEngine'>;

/** What the form defaults are derived from: the repo's top-level files plus one level of built dirs, and package.json scripts. */
async function repoFacts(repoPath: string): Promise<{ files: string[]; packageScripts: Record<string, string> }> {
    const files: string[] = [];
    let packageScripts: Record<string, string> = {};
    try {
        for (const entry of await readdir(repoPath, { withFileTypes: true })) {
            files.push(entry.name);
            if (entry.isDirectory() && ['dist', 'build', 'out', 'public'].includes(entry.name)) {
                try {
                    for (const inner of await readdir(join(repoPath, entry.name))) files.push(`${entry.name}/${inner}`);
                } catch { /* unreadable built dir: not a fact we have */ }
            }
        }
        if (files.includes('package.json')) {
            const pkg = JSON.parse(await readFile(join(repoPath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
            packageScripts = pkg.scripts ?? {};
        }
    } catch { /* a folder we cannot read yields no facts, and the form says so through its hint */ }
    return { files, packageScripts };
}

/**
 * "Add a site"'s defaults for a folder: derived from what is on disk, never guessed when nothing is. Named Genie 1's way,
 * `<site>.<workspace>` (gen-name.ts), when the workspace is given — a site at the workspace's own folder is the
 * workspace's name alone.
 */
export async function siteDefaults(repoPath: string, where: { workspaceName?: string | null; workspacePath?: string | null } = {}): Promise<SiteFormDefaults> {
    return siteFormDefaults({ repoPath, ...where, ...(await repoFacts(repoPath)) });
}

/** {@link siteDefaults} for a folder in a workspace Genie knows: its name read from its envelope, its folder from the registry. */
export async function siteDefaultsIn(s: HostingServices, workspaceId: string, repoPath: string): Promise<SiteFormDefaults> {
    return siteDefaults(repoPath, { workspaceName: await s.envelopeSites.workspaceName(workspaceId), workspacePath: s.envelopeSites.workspacePath(workspaceId) });
}

/**
 * DETECT: what Genie would serve for a folder — the mode, the dev server or built directory it found, the default name
 * — with NO side effect: nothing started, written or kept. The same defaults "Add a site" opens with.
 */
export function detectSite(s: HostingServices, input: { workspaceId: string; repoPath: string }): Promise<SiteFormDefaults> {
    return siteDefaultsIn(s, input.workspaceId, input.repoPath);
}

export type CreateSiteOutcome = { readonly kind: 'problems'; readonly problems: Problem[] } | { readonly kind: 'created'; readonly site: SiteInfo };

/** A validated form as what the site manager declares (the name as Genie keeps it — lower-case, no `.gen`). */
function siteInputOf(s: HostingServices, input: { workspaceId: string; repoPath: string; form: SiteForm }): CreateSiteInput {
    const f = input.form;
    // The workspace's service env (its engines + the shared ones) reaches every process of the site.
    const env = s.engines.envFor(input.workspaceId);
    return {
        ...(Object.keys(env).length > 0 ? { env } : {}),
        name: normalizeSiteName(f.name),
        workspaceId: input.workspaceId,
        repoPath: input.repoPath,
        // A php site's PIN (T4) is `serve.version` — project.json `hostServe.version` — carried by Add and Edit alike.
        serve: f.mode === 'proxy' ? { mode: 'proxy' } : f.mode === 'static' ? { mode: 'static', root: f.root ?? 'dist', spa: f.spa } : { mode: 'php', root: f.root ?? 'public', ...(f.phpVersion ? { version: f.phpVersion } : {}) },
        ...(f.mode === 'proxy' && f.devServer && f.hostPort === null ? { devServer: f.devServer } : {}),
        ...(f.mode === 'proxy' && f.hostPort !== null ? { hostPort: f.hostPort } : {}),
    };
}

/**
 * A PIN Genie cannot run, refused with the START's own reason (site-manager.ts `phpCgiFor`) — before anything is written
 * or anyone is asked. Only a pin the form CHANGES is checked: an Edit of something else keeps the site's pin as it is,
 * even one whose version is not installed here (its start says why; the edit does not drop it). A pin that is not a
 * version at all is the form validation's to name.
 */
function pinProblems(s: HostingServices, form: SiteForm, currentPin: string | null): Problem[] {
    const pin = form.mode === 'php' && form.phpVersion ? form.phpVersion : null;
    if (pin === null || pin === currentPin) return [];
    const cgi = s.sites.phpCgiFor(pin);
    return cgi.ok ? [] : [{ field: 'phpVersion', message: cgi.reason }];
}

/** Create a site from the form: validated (every problem at once), served with the workspace's service env, kept in its envelope. */
export async function createSite(s: HostingServices, input: { workspaceId: string; repoPath: string; form: SiteForm }): Promise<CreateSiteOutcome> {
    const problems = validateSiteForm(input.form, s.sites.list().map((x) => x.host));
    if (!problems.some((p) => p.field === 'phpVersion')) problems.push(...pinProblems(s, input.form, null));
    if (problems.length > 0) return { kind: 'problems', problems };
    // Kept in the workspace's envelope (project.json `sites`), so it is there on the next launch.
    const site = await s.envelopeSites.create(siteInputOf(s, input));
    return { kind: 'created', site };
}

/** Where a site is declared and what it serves — what an Edit starts from and is checked against. */
export interface SiteEditTarget {
    readonly site: SiteInfo;
    readonly workspaceId: string;
    readonly workspacePath: string;
    /** The form's starting values: the site as it is declared now. */
    readonly form: SiteForm;
}

/**
 * The site an Edit acts on, or the reason it cannot be edited: a site Genie 2 cannot serve (its reason is the row's), or
 * one no workspace's project.json declares.
 */
export function siteEditTarget(s: HostingServices, siteId: string): SiteEditTarget {
    const site = s.sites.get(siteId);
    if (!site) throw new Error(`no site ${siteId}`);
    const spec = s.sites.spec(siteId);
    if (site.state === 'unservable' || spec === null) throw new Error(`${site.host} cannot be edited here: ${site.problem ?? 'Genie 2 cannot serve it'}. Edit its entry in the workspace’s project.json`);
    const where = s.envelopeSites.declaredIn(siteId);
    if (!where) throw new Error(`${site.host} is not kept in a workspace’s project.json, so there is nothing to edit`);
    const form: SiteForm = {
        name: spec.name,
        mode: spec.serve.mode,
        devServer: spec.devServer ?? null,
        hostPort: spec.hostPort ?? null,
        root: spec.serve.mode === 'proxy' ? null : spec.serve.root,
        spa: spec.serve.mode === 'static' ? spec.serve.spa : false,
        // The pin it is declared with (project.json `hostServe.version`): an Edit starts from it, so saving never drops it.
        ...(spec.serve.mode === 'php' ? { phpVersion: spec.serve.version ?? null } : {}),
    };
    return { site, ...where, form };
}

/**
 * What an edit of `siteId` to `form` would be refused for: the Add form's validation, with every OTHER site's name
 * taken and its own free. The agents' `sites update` asks it BEFORE putting the change to the person.
 */
export function siteEditProblems(s: HostingServices, siteId: string, form: SiteForm): Problem[] {
    const problems = validateSiteForm(form, s.sites.list().filter((x) => x.id !== siteId).map((x) => x.host));
    // A NEW pin must be one Genie runs — refused with the start's reason; the site's own pin, unchanged, is kept as it is.
    const spec = s.sites.spec(siteId);
    const currentPin = spec?.serve.mode === 'php' ? (spec.serve.version ?? null) : null;
    if (!problems.some((p) => p.field === 'phpVersion')) problems.push(...pinProblems(s, form, currentPin));
    return problems;
}

export type UpdateSiteOutcome ={ readonly kind: 'problems'; readonly problems: Problem[] } | { readonly kind: 'updated'; readonly site: SiteInfo };

/**
 * EDIT a site from the form — the SAME validation as Add (every other site's name is taken; its own is not), then
 * written back to its project.json entry and served as edited (core/envelope-sites.ts keeps every field the edit did
 * not touch). A folder outside the workspace is refused. `repoPath` absent = the folder it serves now.
 */
export async function updateSite(s: HostingServices, input: { siteId: string; form: SiteForm; repoPath?: string }): Promise<UpdateSiteOutcome> {
    const target = siteEditTarget(s, input.siteId);
    const problems = siteEditProblems(s, input.siteId, input.form);
    if (problems.length > 0) return { kind: 'problems', problems };
    const site = await s.envelopeSites.update(input.siteId, siteInputOf(s, { workspaceId: target.workspaceId, repoPath: input.repoPath ?? target.site.repoPath, form: input.form }));
    return { kind: 'updated', site };
}

/** Start: serves a listed site that is not running, and lifts a remembered Stop. Throws the reason it cannot be served. */
export async function startSite(s: HostingServices, siteId: string): Promise<SiteInfo> {
    return s.envelopeSites.start(siteId);
}

/** Restart: stopped and started again as Start starts it (its config and env read anew); a remembered Stop is lifted (it is running now). Throws why it cannot. */
export async function restartSite(s: HostingServices, siteId: string): Promise<SiteInfo> {
    return s.envelopeSites.restart(siteId);
}

/** One of a site's processes and the end of its output — the dev server, or Caddy and (php) its worker. */
export interface SiteProcessLog extends ProcessLog {
    readonly processId: string;
    /** What it is, as the supervisor names it (`web.acme.gen server`, `… php worker`). */
    readonly name: string;
    readonly state: ProcessState | null;
}

/**
 * A site's LOGS: each of its processes' output, the supervisor's tail — still there after a crash, with Genie's own
 * `[genie]` lines saying what happened. Empty for a site with no process of Genie's (external, unservable, never
 * started). `lines` bounds each; absent = all that is kept.
 */
export function siteLogs(s: HostingServices, siteId: string, lines?: number): SiteProcessLog[] {
    const site = s.sites.get(siteId);
    if (!site) throw new Error(`no site ${siteId}`);
    return site.processIds.flatMap((processId) => {
        const log = s.supervisor.readLog(processId, lines);
        if (!log) return [];
        const status = s.supervisor.status(processId);
        return [{ processId, name: status?.name ?? processId, state: status?.state ?? null, ...log }];
    });
}

/** A site's STATUS: the row, and each of its processes as the supervisor sees it now. */
export function siteStatus(s: HostingServices, siteId: string): { site: SiteInfo; processes: ProcessStatus[] } {
    const site = s.sites.get(siteId);
    if (!site) throw new Error(`no site ${siteId}`);
    return { site, processes: site.processIds.map((p) => s.supervisor.status(p)).filter((p): p is ProcessStatus => p !== null) };
}

/** Puts a URL in front of the person, in Genie's own browser (main.ts wires the real pane and the navigation). */
export type OpenInBrowser = (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

/**
 * OPEN a site in Genie's browser: its https URL, checked against the front door's routes the way the browser checks
 * any address (core/browser-policy.ts) — a site that is not up is refused with the reason and nothing is opened.
 */
export async function openSite(s: HostingServices, siteId: string, open: OpenInBrowser): Promise<{ url: string }> {
    const site = s.sites.get(siteId);
    if (!site) throw new Error(`no site ${siteId}`);
    const url = `https://${site.host}/`;
    const nav = classifyNavigation(url, s.routes());
    if (nav.kind !== 'site') {
        throw new Error(site.state === 'unservable'
            ? `${site.host} cannot be served by Genie 2: ${site.problem ?? 'no serve spec'}`
            : `${site.host} is not being served (${site.state}); start it first`);
    }
    const r = await open(url);
    if (!r.ok) throw new Error(`${url} could not be opened in Genie’s browser: ${r.reason}`);
    return { url };
}

/** Stop, remembered on this machine: the next launch leaves it down. */
export async function stopSite(s: HostingServices, siteId: string): Promise<void> {
    if (!(await s.envelopeSites.stop(siteId))) throw new Error(`no site ${siteId}`);
}

/** Removed from the workspace's envelope too, so it does not come back on the next launch. */
export async function removeSite(s: HostingServices, siteId: string): Promise<void> {
    if (!(await s.envelopeSites.remove(siteId))) throw new Error(`no site ${siteId}`);
}

export type CreateServiceOutcome =
    | { readonly kind: 'problems'; readonly problems: Problem[] }
    | { readonly kind: 'needs-consent'; readonly image: string; readonly note: string }
    | { readonly kind: 'added' | 'exists'; readonly instance: ServiceInstance };

/**
 * Add an engine from the form: validated first; an image not on the machine is pulled only with `consent`. The form's
 * workspace is the one that USES it: on a shared Postgres/MySQL/MariaDB/Redis it gets its own database and role (or
 * Redis user), made once — whether the engine is new or already serves other workspaces.
 */
export async function createService(s: HostingServices, form: ServiceForm, consent: boolean): Promise<CreateServiceOutcome> {
    const problems = validateServiceForm(form);
    if (problems.length > 0) return { kind: 'problems', problems };
    const scope = form.scope === 'shared' ? { kind: 'shared' as const } : { kind: 'dedicated' as const, workspaceId: form.workspaceId };
    // A custom image (validated above): its name is its "version" — one per name per workspace — and the rest is the person's.
    const c = form.engine === 'custom' ? form.custom : undefined;
    const r = await s.engines.add(c
        ? { engine: form.engine, major: c.name, scope, consent, workspaceId: form.workspaceId, custom: { image: c.image, internalPort: c.port!, env: { ...c.env }, ...(c.kind !== undefined ? { kind: c.kind } : {}) } }
        : { engine: form.engine, major: form.major, scope, consent, workspaceId: form.workspaceId, ...(form.variant !== undefined ? { variant: form.variant } : {}) });
    return r.kind === 'needs-consent' ? { kind: 'needs-consent', image: r.image, note: r.note } : r;
}

export function setActiveService(s: HostingServices, workspaceId: string, engine: string, version: string): Promise<void> {
    return s.engines.setActive(workspaceId, engine, version);
}

/** Make this engine the one of its kind the workspace uses (service-registry.ts `use`) — the Services tab's and an agent's. */
export function useService(s: HostingServices, workspaceId: string, id: string): Promise<EngineChoice> {
    return s.engines.use(workspaceId, id);
}

/** Stop a shared engine giving this workspace its env; its slice and data stay (service-registry.ts `detach`). */
export function detachService(s: HostingServices, workspaceId: string, id: string): Promise<EngineChoice> {
    return s.engines.detach(workspaceId, id);
}

/** Start / stop / remove, recorded (machine-local) so a restart keeps a stopped engine stopped. */
export function startService(s: HostingServices, id: string): Promise<void> {
    return s.startEngine(id);
}

export function stopService(s: HostingServices, id: string): Promise<void> {
    return s.stopEngine(id);
}

/** `deleteData` acts for `workspaceId`, and is refused while any OTHER workspace keeps data in the engine (core/service-tenancy.ts). */
export function removeService(s: HostingServices, id: string, options: { deleteData: boolean; workspaceId?: string }): Promise<void> {
    return s.removeEngine(id, options);
}

/** The end of an engine's own output (`docker logs`, bounded) — the Services tab's "Logs" and an agent's `services logs`. */
export function serviceLogs(s: HostingServices, id: string, tail?: number): Promise<{ text: string; tail: number }> {
    return s.engines.logs(id, tail);
}

/**
 * The env a workspace's terminal gets — the Terminals tab's and an agent's `manageTerminals create` alike: the
 * workspace's service engines (DB_*, REDIS_URL…), like its processes, then Genie's MCP endpoint (§6.9). The agent path
 * once opened terminals with neither, so a shell an agent opened could not reach the database the person's could.
 */
export function terminalEnvFor(services: { readonly engines: Pick<HostingServices['engines'], 'envFor'> } | null, workspaceId: string, mcpEnv: Readonly<Record<string, string>>): Record<string, string> {
    return { ...(services?.engines.envFor(workspaceId) ?? {}), ...mcpEnv };
}
