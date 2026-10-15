import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { siteFormDefaults, validateServiceForm, validateSiteForm, type Problem, type ServiceForm, type SiteForm, type SiteFormDefaults } from '../core/forms.js';
import type { ServiceInstance } from '../core/services.js';
import type { ComposedServices } from './compose.js';
import type { SiteInfo } from './site-manager.js';

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
export type HostingServices = Pick<ComposedServices, 'engines' | 'envelopeSites' | 'sites' | 'engineStatuses' | 'startEngine' | 'stopEngine' | 'removeEngine'>;

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

/** "Add a site"'s defaults for a folder: derived from what is on disk, never guessed when nothing is. */
export async function siteDefaults(repoPath: string): Promise<SiteFormDefaults> {
    return siteFormDefaults({ repoPath, ...(await repoFacts(repoPath)) });
}

export type CreateSiteOutcome = { readonly kind: 'problems'; readonly problems: Problem[] } | { readonly kind: 'created'; readonly site: SiteInfo };

/** Create a site from the form: validated (every problem at once), served with the workspace's service env, kept in its envelope. */
export async function createSite(s: HostingServices, input: { workspaceId: string; repoPath: string; form: SiteForm }): Promise<CreateSiteOutcome> {
    const problems = validateSiteForm(input.form, s.sites.list().map((x) => x.host));
    if (problems.length > 0) return { kind: 'problems', problems };
    const f = input.form;
    // The workspace's service env (its engines + the shared ones) reaches every process of the site.
    const env = s.engines.envFor(input.workspaceId);
    // Kept in the workspace's envelope (project.json `sites`), so it is there on the next launch.
    const site = await s.envelopeSites.create({
        ...(Object.keys(env).length > 0 ? { env } : {}),
        name: f.name,
        workspaceId: input.workspaceId,
        repoPath: input.repoPath,
        serve: f.mode === 'proxy' ? { mode: 'proxy' } : f.mode === 'static' ? { mode: 'static', root: f.root ?? 'dist', spa: f.spa } : { mode: 'php', root: f.root ?? 'public' },
        ...(f.devServer ? { devServer: f.devServer } : {}),
        ...(f.hostPort !== null ? { hostPort: f.hostPort } : {}),
    });
    return { kind: 'created', site };
}

/** Start: serves a listed site that is not running, and lifts a remembered Stop. Throws the reason it cannot be served. */
export async function startSite(s: HostingServices, siteId: string): Promise<SiteInfo> {
    return s.envelopeSites.start(siteId);
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

/** Add an engine from the form: validated first; an image not on the machine is pulled only with `consent`. */
export async function createService(s: HostingServices, form: ServiceForm, consent: boolean): Promise<CreateServiceOutcome> {
    const problems = validateServiceForm(form);
    if (problems.length > 0) return { kind: 'problems', problems };
    const scope = form.scope === 'shared' ? { kind: 'shared' as const } : { kind: 'dedicated' as const, workspaceId: form.workspaceId };
    const r = await s.engines.add({ engine: form.engine, major: form.major, scope, consent });
    return r.kind === 'needs-consent' ? { kind: 'needs-consent', image: r.image, note: r.note } : r;
}

export function setActiveService(s: HostingServices, workspaceId: string, engine: string, version: string): Promise<void> {
    return s.engines.setActive(workspaceId, engine, version);
}

/** Start / stop / remove, recorded (machine-local) so a restart keeps a stopped engine stopped. */
export function startService(s: HostingServices, id: string): Promise<void> {
    return s.startEngine(id);
}

export function stopService(s: HostingServices, id: string): Promise<void> {
    return s.stopEngine(id);
}

export function removeService(s: HostingServices, id: string, options: { deleteData: boolean }): Promise<void> {
    return s.removeEngine(id, options);
}

/**
 * The env a workspace's terminal gets — the Terminals tab's and an agent's `manageTerminals create` alike: the
 * workspace's service engines (DB_*, REDIS_URL…), like its processes, then Genie's MCP endpoint (§6.9). The agent path
 * once opened terminals with neither, so a shell an agent opened could not reach the database the person's could.
 */
export function terminalEnvFor(services: { readonly engines: Pick<HostingServices['engines'], 'envFor'> } | null, workspaceId: string, mcpEnv: Readonly<Record<string, string>>): Record<string, string> {
    return { ...(services?.engines.envFor(workspaceId) ?? {}), ...mcpEnv };
}
