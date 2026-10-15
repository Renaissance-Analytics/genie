import { isAbsolute, relative, resolve } from 'node:path';
import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import type { EngineStatusView } from '../core/engine-reconcile.js';
import { validateServiceForm, type ServiceForm, type SiteForm, type SiteMode } from '../core/forms.js';
import { normalizeSiteName } from '../core/gen-name.js';
import type { Stack } from '../core/serve-config.js';
import { DEFAULT_CUSTOM_NAME, imageFor, SERVICE_CATALOG, type ServiceInstance } from '../core/services.js';
import {
    createService, createSite, detectSite, openSite, removeService, removeSite, restartSite, serviceLogs, siteDefaultsIn, siteEditProblems, siteEditTarget, siteLogs, siteStatus, startService, startSite, stopService, stopSite, updateSite,
    type HostingServices, type OpenInBrowser,
} from './hosting-actions.js';
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
 * - `services add` and `remove`, and `sites update` and `remove`, wait for the PERSON's approval (approval-queue.ts). For
 *   an add the person sees the engine, the version and the image Genie will pull — that approval is the pull's consent;
 *   for a site update, every field that changes, before and after. A change Genie would refuse is refused WITHOUT asking.
 * - `sites detect` reads a folder and answers what Genie would serve: nothing is started, written or kept. `status`,
 *   `logs`, `restart` and `open` act at once, on the workspace's own sites only; `open` puts the site in front of the
 *   person in Genie's browser.
 * - Never deleting data: `remove` keeps the engine's data volume, and asking for anything else is refused outright.
 * - A custom image is added only through the same approval, with the IMAGE named to the person (and the env names, never
 *   their values) — an agent never runs an image the person did not see.
 * - `env` names every variable with its value, secrets masked — the processes get the real ones, the transcript does not.
 * - `logs` is the end of an engine's output with every credential Genie holds for that engine masked in it: a shared
 *   engine's log can carry another workspace's statements (a failed `ALTER ROLE … PASSWORD` is logged whole).
 * A refusal never asks for approval, and an answer never carries a credential.
 */

export type HostingApproval = 'services.add' | 'services.remove' | 'sites.update' | 'sites.remove';

export interface HostingToolsDeps {
    readonly resolveCaller: (terminalId: string) => Caller | null;
    readonly approve: (caller: Caller, action: HostingApproval, detail: string) => Promise<'allowed' | 'denied'>;
    /** The composed services; `null` where this Genie has none (doctor mode), and every action says so. */
    readonly services: HostingServices | null;
    /** Genie's browser, for `sites open` — the same one the Hosting tab's Open uses. Absent = none here (doctor mode). */
    readonly openInBrowser?: OpenInBrowser;
}

/** How much of each of a site's processes' output `sites logs` reads by default — as `processes logs` does. */
export const DEFAULT_SITE_LOG_LINES = 200;

const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false });
const err = (message: string, extra: Record<string, unknown> = {}): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message, ...extra }), isError: true });
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

const MASK = '********';
// `…_KEY` too: Meilisearch's MEILISEARCH_KEY is its master key (an `AWS_ACCESS_KEY_ID` ends `_ID`: the bucket name, not a secret).
const SECRET_NAME = /PASSWORD|SECRET|TOKEN|(^|_)KEY$/i;

/** Every credential Genie holds for an engine — its admin's, its own, each workspace slice's: what a log answer masks. */
function secretsOf(i: ServiceInstance): string[] {
    return [i.admin?.password, i.credentials.password, ...Object.values(i.slices ?? {}).map((x) => x.password)]
        .filter((p): p is string => typeof p === 'string' && p.length >= 4);
}

/** Text with each of `secrets` replaced by the mask, longest first (one secret may contain another). */
export function maskSecrets(text: string, secrets: readonly string[]): string {
    let out = text;
    for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join(MASK);
    return out;
}

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
    // A multi-tenant engine (adopted, or a new shared one) is active per workspace: its slice's.
    const active = i.slices !== undefined ? i.slices[workspaceId]?.active === true : i.active;
    return {
        id: i.id,
        engine: i.engine,
        version: i.version,
        scope: i.scope.kind,
        host: '127.0.0.1',
        port: i.publishedPort,
        active,
        // The surfaces beside the primary port, by name — and Mailpit's web inbox as the address to open.
        ...(i.publishedPorts && Object.keys(i.publishedPorts).length > 0 ? { surfaces: { ...i.publishedPorts } } : {}),
        ...(i.engine === 'mailpit' && i.publishedPorts?.ui !== undefined ? { inbox: `http://127.0.0.1:${i.publishedPorts.ui}/` } : {}),
        ...(i.engine === 'custom' && i.image ? { image: i.image } : {}),
        ...(i.adopted ? { takenOverFromGenie1: true } : {}),
        ...(status ? { status: status.status, ...(status.note ? { note: status.note } : {}) } : {}),
    };
}

/** An agent's `env` argument for a custom image: an object of string values, or why not. */
function customEnvArg(v: unknown): Record<string, string> | string {
    if (v === undefined) return {};
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return '`env` is an object of NAME: value strings';
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (typeof x !== 'string') return `\`env\`: ${JSON.stringify(k)} must be a string`;
        out[k] = x;
    }
    return out;
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
            'Your workspace’s service engines — Postgres, MySQL, MariaDB, Redis, MongoDB, Mailpit (SMTP + a web inbox), Reverb, Meilisearch, S3 (SeaweedFS), or a custom image. GENIE runs them: never run `docker` (or docker compose) yourself. '
                + 'Genie pulls the image, creates, starts and stops the container, and gives every terminal and site in this workspace the connection variables (DB_*, DATABASE_URL, REDIS_URL, MAIL_*, MEILISEARCH_*, AWS_*…). '
                + 'Actions: `catalog` — the engines and versions Genie offers, with each image. '
                + '`list` — this workspace’s engines and the shared ones, with live status (Mailpit’s `inbox` is its web inbox). '
                + '`env` — the variables a process here gets: names and values, secrets masked. '
                + '`logs` {id, tail?} — the last lines the engine wrote (default 500), credentials masked. '
                + '`add` {engine, version, scope: dedicated (default, this workspace only) | shared (one for the whole machine)} — the person approves it first and sees the image Genie will pull. '
                + 'A custom image: `add` {engine: "custom", image, port (the one it listens on inside), env?, name?} — always dedicated; the person sees the image before anything is pulled. '
                + '`start` / `stop` {id} — this workspace’s own engines (a shared one is started, never stopped, by an agent). '
                + '`remove` {id} — the person approves it; the data is ALWAYS kept (deleting data is the person’s alone, in the Services tab).',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    action: { type: 'string', enum: ['catalog', 'list', 'env', 'logs', 'add', 'start', 'stop', 'remove'] },
                    engine: { type: 'string', description: 'add: the engine, as `catalog` names it (postgres, mysql, mariadb, redis, mongo, mailpit, reverb, meilisearch, seaweedfs, custom).' },
                    version: { type: 'string', description: 'add: a version `catalog` lists for that engine (postgres: 14–17). Not for custom.' },
                    scope: { type: 'string', enum: ['dedicated', 'shared'], description: 'add: dedicated (this workspace only; the default) or shared (one engine for every workspace on this machine).' },
                    image: { type: 'string', description: 'add (custom): the image to run, e.g. registry.example/team/app:1.' },
                    port: { type: 'number', description: 'add (custom): the port the image listens on inside its container.' },
                    env: { type: 'object', description: 'add (custom): NAME: value strings for the container — and this workspace’s processes.' },
                    name: { type: 'string', description: `add (custom): a short name (lowercase, digits, hyphens); default "${DEFAULT_CUSTOM_NAME}".` },
                    id: { type: 'string', description: 'logs / start / stop / remove: the engine’s id, from `list`.' },
                    tail: { type: 'number', description: 'logs: how many of the last lines (default 500, at most 5000).' },
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
                            scopes: d.sharing === 'shared-only' ? ['shared'] : d.sharing === 'dedicated-only' ? ['dedicated'] : ['dedicated', 'shared'],
                            images: d.majors.map((m) => imageFor(d, m)),
                            ...(d.custom ? { note: 'any image you name, with its port and env — the person sees the image and approves it before anything is pulled' } : {}),
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
                case 'logs': {
                    const i = own(str(args.id));
                    if (typeof i === 'string') return err(i);
                    if (args.tail !== undefined && typeof args.tail !== 'number') return err('`tail` is a number of lines');
                    const r = await serviceLogs(s, i.id, typeof args.tail === 'number' ? args.tail : undefined);
                    return ok({ ok: true, id: i.id, engine: i.engine, version: i.version, tail: r.tail, logs: maskSecrets(r.text, secretsOf(i)) });
                }
                case 'add': {
                    const engine = str(args.engine);
                    const custom = engine === 'custom';
                    // A custom image has no version: its name stands in (one per name per workspace).
                    const version = custom ? (str(args.name) ?? DEFAULT_CUSTOM_NAME) : str(args.version);
                    if (!engine || !version) return err('add needs `engine` and `version`; `services catalog` lists them');
                    if (args.scope !== undefined && args.scope !== 'dedicated' && args.scope !== 'shared') return err('`scope` is dedicated or shared');
                    const env = custom ? customEnvArg(args.env) : {};
                    if (typeof env === 'string') return err(env);
                    if (custom && args.port !== undefined && typeof args.port !== 'number') return err('`port` is a number');
                    const form: ServiceForm = {
                        workspaceId: caller.workspaceId, engine, major: custom ? '' : version, scope: args.scope === 'shared' ? 'shared' : 'dedicated',
                        ...(custom ? { custom: { name: version, image: str(args.image) ?? '', port: typeof args.port === 'number' ? args.port : null, env } } : {}),
                    };
                    // The form's own validation, BEFORE anyone is asked: a request Genie would refuse is never put to the person.
                    const problems = validateServiceForm(form);
                    if (problems.length > 0) return err(problems.map((p) => p.message).join(' '), { problems });
                    const def = SERVICE_CATALOG.find((d) => d.engine === engine)!;
                    const image = form.custom ? form.custom.image : imageFor(def, version);
                    const where = form.scope === 'shared' ? 'shared by every workspace on this machine' : 'for this workspace only';
                    // A custom image is named to the person BEFORE anything runs — the image, its port, and its env NAMES (never values).
                    const what = form.custom
                        ? `a custom image ${image} named "${version}" (listening on ${form.custom.port} inside)${Object.keys(env).length > 0 ? `, env ${Object.keys(env).join(', ')}` : ''}`
                        : `${engine} ${version}`;
                    const verdict = await deps.approve(caller, 'services.add', `${what}, ${where} — Genie pulls the image ${image} if it is not on this machine yet, then creates and starts the container`);
                    if (verdict !== 'allowed') return err(`adding ${form.custom ? `the custom image ${image}` : `${engine} ${version}`} was denied by the person; nothing was pulled or created`);
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
                    return err(`unknown action ${JSON.stringify(action)}; the actions are catalog, list, env, logs, add, start, stop, remove`);
            }
        }),
    };

    const modes: readonly SiteMode[] = ['proxy', 'static', 'php'];
    const stacks: readonly Stack[] = ['laravel', 'node', 'django', 'go'];
    /** The arguments' shape, refused by name before anything is read or asked. */
    const shapeProblem = (args: JsonObject): string | null => {
        if (args.mode !== undefined && !modes.includes(args.mode as SiteMode)) return '`mode` is proxy, static or php';
        if (args.stack !== undefined && !stacks.includes(args.stack as Stack)) return '`stack` is laravel, node, django or go';
        if (args.hostPort !== undefined && typeof args.hostPort !== 'number') return '`hostPort` is a number';
        if (args.lines !== undefined && (typeof args.lines !== 'number' || !Number.isFinite(args.lines) || args.lines < 1)) return '`lines` is a positive number';
        if (args.phpVersion !== undefined && args.phpVersion !== null && typeof args.phpVersion !== 'string') return '`phpVersion` is a PHP version like 8.4 or 8.4.26, or "" for the PHP on PATH';
        return null;
    };
    /** A folder the agent named, resolved in ITS workspace — or the refusal, before anything is read there. */
    const folderIn = (caller: Caller, given: string | undefined, fallback: string): string | { refused: string } => {
        const repoPath = given ? (isAbsolute(given) ? given : resolve(caller.workspacePath, given)) : fallback;
        const rel = relative(caller.workspacePath, repoPath);
        if (rel.startsWith('..') || isAbsolute(rel)) return { refused: `${given ?? repoPath} is outside this workspace; a site serves a folder inside it, and nothing was read or done` };
        return repoPath;
    };
    /**
     * The form an agent asks for: `base` (the folder's detected defaults for an add, the site as it is for an update),
     * then whatever the agent said. A command given is the dev server; a port given is a server it already runs.
     */
    const formOf = (base: SiteForm, args: JsonObject): SiteForm => {
        const mode = (args.mode as SiteMode | undefined) ?? base.mode;
        const devCommand = str(args.devCommand);
        // A command given replaces a port the site had (it is now Genie's dev server), as a port given replaces the command.
        const hostPort = typeof args.hostPort === 'number' ? args.hostPort : devCommand ? null : base.hostPort;
        const devServer = devCommand
            ? { stack: (args.stack as Stack | undefined) ?? base.devServer?.stack ?? 'node', command: devCommand }
            : typeof args.hostPort === 'number' ? null : base.devServer;
        // The PHP pin: kept from `base` unless given; `""` / null clears it (the PATH PHP). Only a php site carries one —
        // a pin GIVEN for another mode is passed on, so the form's validation refuses it by name rather than dropping it.
        const givenPin = args.phpVersion === null ? null : typeof args.phpVersion === 'string' ? (args.phpVersion.trim() || null) : undefined;
        const phpVersion = givenPin !== undefined ? givenPin : mode === 'php' ? (base.phpVersion ?? null) : null;
        return {
            name: str(args.name) ?? base.name,
            mode,
            devServer: mode === 'proxy' ? devServer : null,
            hostPort: mode === 'proxy' ? hostPort : null,
            root: mode === 'proxy' ? null : (str(args.root) ?? base.root),
            spa: typeof args.spa === 'boolean' ? args.spa : base.spa,
            ...(mode === 'php' || givenPin !== undefined ? { phpVersion } : {}),
        };
    };
    /** What an update changes, for the person who approves it: each field that differs, before → after. */
    const changesOf = (before: SiteForm, after: SiteForm): string[] => {
        const show = (v: unknown) => (v === null || v === undefined || v === '' ? 'none' : String(v));
        const out: string[] = [];
        if (normalizeSiteName(after.name) !== normalizeSiteName(before.name)) out.push(`name ${normalizeSiteName(before.name)}.gen → ${normalizeSiteName(after.name)}.gen`);
        if (after.mode !== before.mode) out.push(`mode ${before.mode} → ${after.mode}`);
        if (after.root !== before.root) out.push(`root ${show(before.root)} → ${show(after.root)}`);
        if (after.spa !== before.spa) out.push(`spa ${before.spa} → ${after.spa}`);
        if (after.hostPort !== before.hostPort) out.push(`port ${show(before.hostPort)} → ${show(after.hostPort)}`);
        if ((after.devServer?.command ?? null) !== (before.devServer?.command ?? null)) out.push(`command ${show(before.devServer?.command)} → ${show(after.devServer?.command)}`);
        const pin = (v: string | null | undefined) => (v ? `PHP ${v}` : 'the PHP on PATH');
        if ((after.phpVersion || null) !== (before.phpVersion || null)) out.push(`PHP version ${pin(before.phpVersion)} → ${pin(after.phpVersion)}`);
        return out;
    };
    const SITE_ACTIONS = 'list, status, detect, add, start, stop, restart, logs, open, update, remove';

    const sites: Registration = {
        definition: new ToolDefinition(
            'sites',
            'Your workspace’s sites, served by Genie at https://<name>.gen — `<name>` one or more labels: `web`, or `web.acme` (Genie’s default is `<folder>.<workspace>`). GENIE runs them — the dev server (or the static / PHP server) and the front door — and gives every process the workspace’s service variables; never start a server with `docker`, or keep one running in a terminal, for this. '
                + 'Actions: `list`. '
                + '`status` {site} — the site and each of its processes as Genie sees them now. '
                + '`detect` {repoPath?} — what Genie WOULD serve for a folder (mode, dev server, built directory, default name); nothing is started or written. '
                + '`add` {name?, repoPath? (a folder in this workspace; default its root), mode? proxy | static | php, devCommand? (put {port} where the port goes — Genie picks it), stack? laravel | node | django | go, hostPort? (a server you already run), root? (static/php: the folder to serve), spa?, phpVersion? (php: a PHP version Genie manages, like 8.4 or 8.4.26; absent = the PHP on PATH)} — anything left out takes the defaults Genie detects from the folder, exactly as the Hosting tab’s form does, and it is kept in the workspace’s project.json. '
                + '`start` / `stop` / `restart` {site} — by id, name or host. '
                + '`logs` {site, lines?} — the end of each of its processes’ output (default 200 lines), still there after a crash. '
                + '`open` {site} — opens it in Genie’s browser for the person, and answers its URL. '
                + '`update` {site, and any of name, repoPath, mode, devCommand, stack, hostPort, root, spa, phpVersion ("" = back to the PHP on PATH)} — the Hosting tab’s Edit: the person approves it, then it is written to project.json and served as changed. '
                + '`remove` {site} — the person approves it; the folder and its files are never touched.',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    action: { type: 'string', enum: ['list', 'status', 'detect', 'add', 'start', 'stop', 'restart', 'logs', 'open', 'update', 'remove'] },
                    site: { type: 'string', description: 'status / start / stop / restart / logs / open / update / remove: the site’s id, name or host, from `list`.' },
                    name: { type: 'string', description: 'add / update: one or more hostname labels separated by dots (a-z, 0-9, hyphens); the site is https://<name>.gen.' },
                    repoPath: { type: 'string', description: 'detect / add / update: the folder to serve, inside this workspace (relative to its root, or absolute).' },
                    mode: { type: 'string', enum: ['proxy', 'static', 'php'] },
                    devCommand: { type: 'string', description: 'add / update (proxy): the dev server Genie runs, with {port} where the port goes.' },
                    stack: { type: 'string', enum: ['laravel', 'node', 'django', 'go'] },
                    hostPort: { type: 'number', description: 'add / update (proxy): a port a server you already run listens on; Genie starts nothing. On update, a devCommand replaces it.' },
                    root: { type: 'string', description: 'add / update (static / php): the folder to serve, relative to repoPath (dist, public…).' },
                    spa: { type: 'boolean', description: 'add / update (static): serve index.html for unknown paths.' },
                    phpVersion: { type: 'string', description: 'add / update (php): the PHP version the site runs — one Genie manages (8.4, or exactly 8.4.26); a version it does not manage is refused, nothing asked. Absent on add = the PHP on PATH; on update = kept; "" = back to the PHP on PATH.' },
                    lines: { type: 'number', description: 'logs: how many lines from the end of each process’s output (default 200).' },
                },
                required: ['action'],
            },
            'Sites',
        ),
        handler: withServices(async (s, caller, args) => {
            const action = str(args.action) ?? '';
            const shape = shapeProblem(args);
            if (shape) return err(shape);
            // Its OWN workspace's sites only: another workspace's is "no site" here, refused before anything is asked or done.
            const own = (key: string | undefined): SiteInfo | string => {
                if (!key) return `${action} needs \`site\`; \`sites list\` shows them`;
                const site = s.sites.list(caller.workspaceId).find((x) => x.id === key || x.name === key || x.host === key);
                return site ?? `no site "${key}" in this workspace; \`sites list\` shows them`;
            };
            switch (action) {
                case 'list':
                    return ok({ ok: true, sites: s.sites.list(caller.workspaceId).map(siteView) });
                case 'status': {
                    const site = own(str(args.site));
                    if (typeof site === 'string') return err(site);
                    const st = siteStatus(s, site.id);
                    return ok({ ok: true, site: siteView(st.site), processes: st.processes.map((p) => ({ id: p.id, name: p.name, state: p.state, pid: p.pid, exitCode: p.exitCode, restarts: p.restarts, ...(p.reason ? { reason: p.reason } : {}) })) });
                }
                case 'detect': {
                    const repoPath = folderIn(caller, str(args.repoPath), caller.workspacePath);
                    if (typeof repoPath !== 'string') return err(repoPath.refused);
                    const d = await detectSite(s, { workspaceId: caller.workspaceId, repoPath });
                    const taken = s.sites.list().some((x) => x.host === `${d.name}.gen`);
                    return ok({ ok: true, repoPath, detected: d, host: `${d.name}.gen`, ...(taken ? { note: `${d.name}.gen is already a site; \`add\` needs another \`name\`` } : {}), sideEffects: 'none — nothing was started, written or kept' });
                }
                case 'add': {
                    const repoPath = folderIn(caller, str(args.repoPath), caller.workspacePath);
                    if (typeof repoPath !== 'string') return err(repoPath.refused);
                    // The Hosting tab's defaults for this folder, then what the agent said — and the tab's own validation.
                    const d = await siteDefaultsIn(s, caller.workspaceId, repoPath);
                    const form = formOf(d, args);
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
                case 'restart': {
                    const site = own(str(args.site));
                    if (typeof site === 'string') return err(site);
                    return ok({ ok: true, site: siteView(await restartSite(s, site.id)) });
                }
                case 'logs': {
                    const site = own(str(args.site));
                    if (typeof site === 'string') return err(site);
                    const logs = siteLogs(s, site.id, typeof args.lines === 'number' ? Math.floor(args.lines) : DEFAULT_SITE_LOG_LINES);
                    return ok({
                        ok: true,
                        site: siteView(site),
                        processes: logs.map((l) => ({ id: l.processId, name: l.name, state: l.state, log: l.text, lines: l.lines, dropped: l.dropped })),
                        ...(logs.length === 0 ? { note: site.state === 'external' ? 'a server you run yourself: Genie runs no process for it, so it has no log here' : 'Genie has no output from this site since Genie started: none of its processes has run since then' } : {}),
                    });
                }
                case 'open': {
                    const site = own(str(args.site));
                    if (typeof site === 'string') return err(site);
                    if (!deps.openInBrowser) return err('this Genie has no browser to open it in (doctor mode); nothing was opened', { url: `https://${site.host}/` });
                    const r = await openSite(s, site.id, deps.openInBrowser);
                    return ok({ ok: true, url: r.url, opened: 'in Genie’s browser, in front of the person' });
                }
                case 'update': {
                    const site = own(str(args.site));
                    if (typeof site === 'string') return err(site);
                    const target = siteEditTarget(s, site.id);
                    const given = str(args.repoPath);
                    const repoPath = given ? folderIn(caller, given, target.site.repoPath) : target.site.repoPath;
                    if (typeof repoPath !== 'string') return err(repoPath.refused);
                    const form = formOf(target.form, args);
                    // The Edit form's own validation, BEFORE anyone is asked: a change Genie would refuse is never put to the person.
                    const problems = siteEditProblems(s, site.id, form);
                    if (problems.length > 0) return err(problems.map((p) => p.message).join(' '), { problems, form });
                    const changes = changesOf(target.form, form);
                    if (repoPath !== target.site.repoPath) changes.push(`folder ${target.site.repoPath} → ${repoPath}`);
                    if (changes.length === 0) return ok({ ok: true, site: siteView(site), note: 'nothing to change: the site is already served that way; the person was not asked' });
                    const verdict = await deps.approve(caller, 'sites.update', `${site.host} — ${changes.join('; ')} — written to this workspace’s project.json and served as changed`);
                    if (verdict !== 'allowed') return err(`changing ${site.host} was denied by the person; nothing was done`);
                    const r = await updateSite(s, { siteId: site.id, form, repoPath });
                    if (r.kind === 'problems') return err(r.problems.map((p) => p.message).join(' '), { problems: r.problems, form });
                    return ok({ ok: true, site: siteView(r.site), changed: changes });
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
                    return err(`unknown action ${JSON.stringify(action)}; the actions are ${SITE_ACTIONS}`);
            }
        }),
    };

    return [services, sites];
}
