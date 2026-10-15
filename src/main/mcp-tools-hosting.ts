import { isAbsolute, resolve } from 'node:path';
import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import type { EngineStatusView } from '../core/engine-reconcile.js';
import { validateServiceForm, type ServiceForm, type SiteForm, type SiteMode } from '../core/forms.js';
import type { Stack } from '../core/serve-config.js';
import { imageFor, SERVICE_CATALOG, type ServiceInstance } from '../core/services.js';
import { createService, createSite, removeService, removeSite, siteDefaults, startService, startSite, stopService, stopSite, type HostingServices } from './hosting-actions.js';
import { callerFrom } from './mcp-callers.js';
import { MIRRORED_TERMINAL_ID, type Caller, type Registration, type ToolContext, type ToolHandler } from './mcp-tools.js';
import type { SiteInfo } from './site-manager.js';

/**
 * THE AGENTS' SERVICES AND SITES (the owner, 2026-10-14: "agents should be using genie mcp tools to do all configuration
 * and genie app (not the agent), handles sites and services setup, start, etc."). An agent never needs `docker`: it asks
 * Genie, and Genie makes the very calls the Services and Hosting tabs make (hosting-actions.ts).
 *
 * What an agent may do is decided HERE, before anything is called:
 * - Its OWN workspace only. It sees its workspace's engines and the shared ones; it changes only its workspace's own
 *   (a shared engine serves every workspace, so stopping or removing one is the person's). A site is its workspace's.
 * - `services add` and `remove`, and `sites remove`, wait for the PERSON's approval (approval-queue.ts). For an add the
 *   person sees the engine, the version and the image Genie will pull — that approval is the pull's consent.
 * - Never deleting data: `remove` keeps the engine's data volume, and asking for anything else is refused outright.
 * - `env` names every variable with its value, secrets masked — the processes get the real ones, the transcript does not.
 * A refusal never asks for approval, and an answer never carries a credential.
 */

export type HostingApproval = 'services.add' | 'services.remove' | 'sites.remove';

export interface HostingToolsDeps {
    readonly resolveCaller: (terminalId: string) => Caller | null;
    readonly approve: (caller: Caller, action: HostingApproval, detail: string) => Promise<'allowed' | 'denied'>;
    /** The composed services; `null` where this Genie has none (doctor mode), and every action says so. */
    readonly services: HostingServices | null;
}

const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false });
const err = (message: string, extra: Record<string, unknown> = {}): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message, ...extra }), isError: true });
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

const MASK = '********';
const SECRET_NAME = /PASSWORD|SECRET|TOKEN/i;

/**
 * A workspace's service env for an agent to READ: every name, every value — except secrets. A variable whose name says
 * it is one is masked whole; a password inside any other value (a `DATABASE_URL`, a `MONGODB_URI`) is masked in place.
 */
export function maskEnv(env: Readonly<Record<string, string>>): { variables: Record<string, string>; masked: string[] } {
    const secrets = Object.entries(env).filter(([k, v]) => SECRET_NAME.test(k) && v !== '').map(([, v]) => v);
    const variables: Record<string, string> = {};
    const masked: string[] = [];
    for (const [name, value] of Object.entries(env)) {
        let out: string;
        if (SECRET_NAME.test(name)) out = value === '' ? '' : MASK;
        else {
            out = value.replace(/(\/\/[^:/@\s]*:)[^@\s]+@/g, `$1${MASK}@`);
            for (const s of secrets) out = out.split(s).join(MASK);
        }
        variables[name] = out;
        if (out !== value) masked.push(name);
    }
    return { variables, masked };
}

/** Does this workspace see this engine? Its own, and the shared ones (a Genie 1 engine only through the workspace's slice). */
function visibleTo(i: ServiceInstance, workspaceId: string): boolean {
    if (i.scope.kind === 'dedicated') return i.scope.workspaceId === workspaceId;
    return i.adopted === 'v1' ? i.slices?.[workspaceId] !== undefined : true;
}

/** An engine without its credentials: an answer never carries one (`env` is where a process's connection lives). */
function serviceView(i: ServiceInstance, workspaceId: string, status?: Pick<EngineStatusView, 'status' | 'note'>): Record<string, unknown> {
    const active = i.adopted === 'v1' ? i.slices?.[workspaceId]?.active === true : i.active;
    return {
        id: i.id,
        engine: i.engine,
        version: i.version,
        scope: i.scope.kind,
        host: '127.0.0.1',
        port: i.publishedPort,
        active,
        ...(i.adopted ? { takenOverFromGenie1: true } : {}),
        ...(status ? { status: status.status, ...(status.note ? { note: status.note } : {}) } : {}),
    };
}

function siteView(s: SiteInfo): Record<string, unknown> {
    return { id: s.id, name: s.name, host: s.host, url: `https://${s.host}/`, state: s.state, port: s.port, repoPath: s.repoPath, problem: s.problem };
}

const NOT_HERE = 'this Genie has no services or sites to manage (doctor mode runs none); nothing was done';
const ENV_NOTE = 'Genie hands these to every terminal and every site process in this workspace; never copy them into a file or start an engine yourself. A site that was already running gets a new engine’s variables when it is stopped and started again.';

export function hostingTools(deps: HostingToolsDeps): Registration[] {
    const withServices = (body: (s: HostingServices, caller: Caller, args: JsonObject) => McpToolResult | Promise<McpToolResult>): ToolHandler => async (args: JsonObject, context: ToolContext) => {
        const caller = callerFrom(args, context.headers, deps.resolveCaller);
        if (typeof caller === 'string') return err(caller);
        if (!deps.services) return err(NOT_HERE);
        try {
            return await body(deps.services, caller, args);
        } catch (error) {
            return err((error as Error).message);
        }
    };

    const services: Registration = {
        definition: new ToolDefinition(
            'services',
            'Your workspace’s service engines — Postgres, MySQL, MariaDB, Redis, MongoDB, Mailpit, Reverb. GENIE runs them: never run `docker` (or docker compose) yourself. '
                + 'Genie pulls the image, creates, starts and stops the container, and gives every terminal and site in this workspace the connection variables (DB_*, DATABASE_URL, REDIS_URL…). '
                + 'Actions: `catalog` — the engines and versions Genie offers, with each image. '
                + '`list` — this workspace’s engines and the shared ones, with live status. '
                + '`env` — the variables a process here gets: names and values, secrets masked. '
                + '`add` {engine, version, scope: dedicated (default, this workspace only) | shared (one for the whole machine)} — the person approves it first and sees the image Genie will pull. '
                + '`start` / `stop` {id} — this workspace’s own engines (a shared one is started, never stopped, by an agent). '
                + '`remove` {id} — the person approves it; the data is ALWAYS kept (deleting data is the person’s alone, in the Services tab).',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    action: { type: 'string', enum: ['catalog', 'list', 'env', 'add', 'start', 'stop', 'remove'] },
                    engine: { type: 'string', description: 'add: the engine, as `catalog` names it (postgres, mysql, mariadb, redis, mongo, mailpit, reverb).' },
                    version: { type: 'string', description: 'add: a version `catalog` lists for that engine (postgres: 14–17).' },
                    scope: { type: 'string', enum: ['dedicated', 'shared'], description: 'add: dedicated (this workspace only; the default) or shared (one engine for every workspace on this machine).' },
                    id: { type: 'string', description: 'start / stop / remove: the engine’s id, from `list`.' },
                    deleteData: { type: 'boolean', description: 'Never true: an agent cannot delete a service’s data.' },
                },
                required: ['action'],
            },
            'Services',
        ),
        handler: withServices(async (s, caller, args) => {
            const action = str(args.action) ?? '';
            const own = (id: string | undefined): ServiceInstance | string => {
                if (!id) return `${action} needs \`id\`; \`services list\` shows them`;
                const i = s.engines.list().find((x) => x.id === id);
                return i && visibleTo(i, caller.workspaceId) ? i : `${id} is not one of this workspace’s services; \`services list\` shows them`;
            };
            const mineOutright = (i: ServiceInstance): string | null =>
                i.scope.kind === 'dedicated' ? null : `${i.engine} ${i.version} is shared by every workspace on this machine; stopping or removing it is the person’s, from the Services tab`;
            const statusOf = async (id: string) => (await s.engineStatuses()).find((v) => v.instance.id === id);
            switch (action) {
                case 'catalog':
                    return ok({
                        ok: true,
                        engines: SERVICE_CATALOG.filter((d) => !d.adoptOnly).map((d) => ({
                            engine: d.engine,
                            versions: d.majors,
                            scopes: d.sharing === 'shared-only' ? ['shared'] : ['dedicated', 'shared'],
                            images: d.majors.map((m) => imageFor(d, m)),
                        })),
                    });
                case 'list': {
                    const views = (await s.engineStatuses()).filter((v) => visibleTo(v.instance, caller.workspaceId));
                    return ok({ ok: true, services: views.map((v) => serviceView(v.instance, caller.workspaceId, v)) });
                }
                case 'env': {
                    const { variables, masked } = maskEnv(s.engines.envFor(caller.workspaceId));
                    return ok({ ok: true, variables, masked, note: ENV_NOTE });
                }
                case 'add': {
                    const engine = str(args.engine);
                    const version = str(args.version);
                    if (!engine || !version) return err('add needs `engine` and `version`; `services catalog` lists them');
                    if (args.scope !== undefined && args.scope !== 'dedicated' && args.scope !== 'shared') return err('`scope` is dedicated or shared');
                    const form: ServiceForm = { workspaceId: caller.workspaceId, engine, major: version, scope: args.scope === 'shared' ? 'shared' : 'dedicated' };
                    // The form's own validation, BEFORE anyone is asked: a request Genie would refuse is never put to the person.
                    const problems = validateServiceForm(form);
                    if (problems.length > 0) return err(problems.map((p) => p.message).join(' '), { problems });
                    const def = SERVICE_CATALOG.find((d) => d.engine === engine)!;
                    const image = imageFor(def, version);
                    const where = form.scope === 'shared' ? 'shared by every workspace on this machine' : 'for this workspace only';
                    const verdict = await deps.approve(caller, 'services.add', `${engine} ${version}, ${where} — Genie pulls the image ${image} if it is not on this machine yet, then creates and starts the container`);
                    if (verdict !== 'allowed') return err(`adding ${engine} ${version} was denied by the person; nothing was pulled or created`);
                    // The person's approval, which named the image, IS the pull's consent.
                    const r = await createService(s, form, true);
                    if (r.kind === 'problems') return err(r.problems.map((p) => p.message).join(' '), { problems: r.problems });
                    if (r.kind === 'needs-consent') return err(`${r.image} was not pulled: ${r.note}`);
                    return ok({ ok: true, outcome: r.kind, service: serviceView(r.instance, caller.workspaceId, await statusOf(r.instance.id)), note: ENV_NOTE });
                }
                case 'start': {
                    const i = own(str(args.id));
                    if (typeof i === 'string') return err(i);
                    await startService(s, i.id);
                    return ok({ ok: true, service: serviceView(i, caller.workspaceId, await statusOf(i.id)) });
                }
                case 'stop': {
                    const i = own(str(args.id));
                    if (typeof i === 'string') return err(i);
                    const notMine = mineOutright(i);
                    if (notMine) return err(notMine);
                    await stopService(s, i.id);
                    return ok({ ok: true, service: serviceView(i, caller.workspaceId, await statusOf(i.id)) });
                }
                case 'remove': {
                    // Refused outright, never put to the person: an agent does not delete data, approved or not.
                    if (args.deleteData !== undefined && args.deleteData !== false) return err('an agent never deletes a service’s data; `remove` always keeps it. Deleting the data is the person’s, from the Services tab. Nothing was done');
                    const i = own(str(args.id));
                    if (typeof i === 'string') return err(i);
                    const notMine = mineOutright(i);
                    if (notMine) return err(notMine);
                    const verdict = await deps.approve(caller, 'services.remove', `${i.engine} ${i.version} (127.0.0.1:${i.publishedPort}) — its container is removed; its data volume is KEPT`);
                    if (verdict !== 'allowed') return err(`removing ${i.engine} ${i.version} was denied by the person; nothing was done`);
                    await removeService(s, i.id, { deleteData: false });
                    return ok({ ok: true, removed: i.id, dataKept: true });
                }
                default:
                    return err(`unknown action ${JSON.stringify(action)}; the actions are catalog, list, env, add, start, stop, remove`);
            }
        }),
    };

    const sites: Registration = {
        definition: new ToolDefinition(
            'sites',
            'Your workspace’s sites, served by Genie at https://<name>.gen. GENIE runs them — the dev server (or the static / PHP server) and the front door — and gives every process the workspace’s service variables; never start a server with `docker`, or keep one running in a terminal, for this. '
                + 'Actions: `list`. '
                + '`add` {name?, repoPath? (a folder in this workspace; default its root), mode? proxy | static | php, devCommand? (put {port} where the port goes — Genie picks it), stack? laravel | node | django | go, hostPort? (a server you already run), root? (static/php: the folder to serve), spa?} — anything left out takes the defaults Genie detects from the folder, exactly as the Hosting tab’s form does, and it is kept in the workspace’s project.json. '
                + '`start` / `stop` {site} — by id, name or host. '
                + '`remove` {site} — the person approves it; the folder and its files are never touched.',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    action: { type: 'string', enum: ['list', 'add', 'start', 'stop', 'remove'] },
                    site: { type: 'string', description: 'start / stop / remove: the site’s id, name or host, from `list`.' },
                    name: { type: 'string', description: 'add: one hostname label (a-z, 0-9, hyphens); the site is https://<name>.gen.' },
                    repoPath: { type: 'string', description: 'add: the folder to serve, inside this workspace (relative to its root, or absolute).' },
                    mode: { type: 'string', enum: ['proxy', 'static', 'php'] },
                    devCommand: { type: 'string', description: 'add (proxy): the dev server Genie runs, with {port} where the port goes.' },
                    stack: { type: 'string', enum: ['laravel', 'node', 'django', 'go'] },
                    hostPort: { type: 'number', description: 'add (proxy): a port a server you already run listens on; Genie starts nothing.' },
                    root: { type: 'string', description: 'add (static / php): the folder to serve, relative to repoPath (dist, public…).' },
                    spa: { type: 'boolean', description: 'add (static): serve index.html for unknown paths.' },
                },
                required: ['action'],
            },
            'Sites',
        ),
        handler: withServices(async (s, caller, args) => {
            const action = str(args.action) ?? '';
            const own = (key: string | undefined): SiteInfo | string => {
                if (!key) return `${action} needs \`site\`; \`sites list\` shows them`;
                const site = s.sites.list(caller.workspaceId).find((x) => x.id === key || x.name === key || x.host === key);
                return site ?? `no site "${key}" in this workspace; \`sites list\` shows them`;
            };
            switch (action) {
                case 'list':
                    return ok({ ok: true, sites: s.sites.list(caller.workspaceId).map(siteView) });
                case 'add': {
                    const given = str(args.repoPath);
                    const repoPath = given ? (isAbsolute(given) ? given : resolve(caller.workspacePath, given)) : caller.workspacePath;
                    const modes: readonly SiteMode[] = ['proxy', 'static', 'php'];
                    const stacks: readonly Stack[] = ['laravel', 'node', 'django', 'go'];
                    if (args.mode !== undefined && !modes.includes(args.mode as SiteMode)) return err('`mode` is proxy, static or php');
                    if (args.stack !== undefined && !stacks.includes(args.stack as Stack)) return err('`stack` is laravel, node, django or go');
                    if (args.hostPort !== undefined && typeof args.hostPort !== 'number') return err('`hostPort` is a number');
                    // The Hosting tab's defaults for this folder, then what the agent said — and the tab's own validation.
                    const d = await siteDefaults(repoPath);
                    const mode = (args.mode as SiteMode | undefined) ?? d.mode;
                    const devCommand = str(args.devCommand);
                    const hostPort = typeof args.hostPort === 'number' ? args.hostPort : d.hostPort;
                    const devServer = devCommand
                        ? { stack: (args.stack as Stack | undefined) ?? d.devServer?.stack ?? 'node', command: devCommand }
                        : typeof args.hostPort === 'number' ? null : d.devServer;
                    const form: SiteForm = {
                        name: str(args.name) ?? d.name,
                        mode,
                        devServer: mode === 'proxy' ? devServer : null,
                        hostPort: mode === 'proxy' ? hostPort : null,
                        root: mode === 'proxy' ? null : (str(args.root) ?? d.root),
                        spa: typeof args.spa === 'boolean' ? args.spa : d.spa,
                    };
                    const r = await createSite(s, { workspaceId: caller.workspaceId, repoPath, form });
                    if (r.kind === 'problems') return err(r.problems.map((p) => p.message).join(' '), { problems: r.problems, form });
                    return ok({ ok: true, site: siteView(r.site) });
                }
                case 'start': {
                    const site = own(str(args.site));
                    if (typeof site === 'string') return err(site);
                    return ok({ ok: true, site: siteView(await startSite(s, site.id)) });
                }
                case 'stop': {
                    const site = own(str(args.site));
                    if (typeof site === 'string') return err(site);
                    await stopSite(s, site.id);
                    const after = s.sites.get(site.id);
                    return ok({ ok: true, site: after ? siteView(after) : { id: site.id, state: 'stopped' } });
                }
                case 'remove': {
                    const site = own(str(args.site));
                    if (typeof site === 'string') return err(site);
                    const verdict = await deps.approve(caller, 'sites.remove', `${site.host} (${site.repoPath}) — stopped and removed from this workspace’s project.json; the folder and its files are not touched`);
                    if (verdict !== 'allowed') return err(`removing ${site.host} was denied by the person; nothing was done`);
                    await removeSite(s, site.id);
                    return ok({ ok: true, removed: site.id });
                }
                default:
                    return err(`unknown action ${JSON.stringify(action)}; the actions are list, add, start, stop, remove`);
            }
        }),
    };

    return [services, sites];
}
