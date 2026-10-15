import { basename, relative } from 'node:path';
import { parseCron } from './cron.js';
import { defaultSiteName, normalizeSiteName, siteNameProblem } from './gen-name.js';
import { SERVICE_CATALOG } from './services.js';
import { detectDevServer, detectStaticServe, type DevServer, type RepoFacts } from './serve-config.js';

/**
 * THE FORMS BEHIND "Add a site" AND "Add a flow" — pure models.
 *
 * Defaults are DERIVED from what is on disk and never guessed when nothing is: a repo with no
 * recognisable dev server gets an empty command and a hint, not an invented one. Validation names
 * every problem at once so the person fixes the form in one pass — a form that errors one field at a
 * time is a form that gets abandoned.
 */

export type SiteMode = 'proxy' | 'static' | 'php';

export interface SiteForm {
    readonly name: string;
    readonly mode: SiteMode;
    readonly devServer: DevServer | null;
    readonly hostPort: number | null;
    readonly root: string | null;
    readonly spa: boolean;
}

export interface SiteFormDefaults extends SiteForm {
    readonly hint: string;
}

export interface Problem {
    readonly field: string;
    readonly message: string;
}

function labelFromFolder(repoPath: string): string {
    return basename(repoPath.replace(/[\\/]+$/, ''))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63);
}

/** Where a site is, for its default name. Both absent = the folder's label alone (what a caller with no workspace gets). */
export interface SiteWhere {
    /** The workspace's name (its project.json `name`, else its folder) — the `<workspace>` of Genie 1's `<site>.<workspace>`. */
    readonly workspaceName?: string | null;
    /** The workspace's folder: a site AT it is named for the workspace alone. */
    readonly workspacePath?: string | null;
}

/**
 * The default name: Genie 1's `<site>.<workspace>` (gen-name.ts `defaultSiteName`) when the workspace is known — a site
 * at the workspace's own folder is the workspace's name alone — else the folder's label, as before.
 */
function defaultName(repoPath: string, where: SiteWhere): string {
    const workspace = where.workspaceName ?? null;
    if (workspace === null) return labelFromFolder(repoPath);
    const atRoot = typeof where.workspacePath === 'string' && relative(where.workspacePath, repoPath) === '';
    return defaultSiteName({ folder: atRoot ? null : labelFromFolder(repoPath), workspace });
}

const STACK_LABEL: Record<DevServer['stack'], string> = { laravel: 'Laravel', node: 'A Node dev script', django: 'Django', go: 'Go' };
const STACK_HINT: Record<DevServer['stack'], string> = {
    laravel: 'Genie will run `php artisan serve` on a free port.',
    node: 'Genie will run the dev script with a free port.',
    django: 'Genie will run `manage.py runserver` on a free port.',
    go: 'Genie will run `go run .`; make sure it reads PORT.',
};

export function siteFormDefaults(input: RepoFacts & { repoPath: string } & SiteWhere): SiteFormDefaults {
    const name = defaultName(input.repoPath, input);
    const dev = detectDevServer(input);
    if (dev) {
        return { name, mode: 'proxy', devServer: dev, root: null, spa: false, hostPort: null, hint: `${STACK_LABEL[dev.stack]} detected — ${STACK_HINT[dev.stack]}` };
    }
    const stat = detectStaticServe(input);
    if (stat && stat.mode === 'static') {
        return { name, mode: 'static', devServer: null, root: stat.root, spa: stat.spa, hostPort: null, hint: `A built ${stat.root}/ was found — Genie will serve it as a static site.` };
    }
    return { name, mode: 'proxy', devServer: null, root: null, spa: false, hostPort: null, hint: 'No dev server was recognised — give the port you already run on, or a command Genie should run.' };
}

/**
 * Every problem with a site form at once — the ONE validation for Add and for Edit, the Hosting tab's and the agents'.
 * `existingHosts` are the hosts the name may not take: every site's for an Add; every site's but its own for an Edit.
 */
export function validateSiteForm(form: SiteForm, existingHosts: readonly string[]): Problem[] {
    const problems: Problem[] = [];
    const name = normalizeSiteName(form.name);
    const nameProblem = siteNameProblem(form.name);
    if (form.name.trim().length === 0) problems.push({ field: 'name', message: 'A site needs a name — one or more hostname labels separated by dots (a-z, 0-9, hyphens), like web or web.acme.' });
    else if (nameProblem !== null) problems.push({ field: 'name', message: `"${form.name}" is not a site name: ${nameProblem}. Use labels of a-z, 0-9 and hyphens, separated by dots.` });
    else if (existingHosts.includes(`${name}.gen`)) problems.push({ field: 'name', message: `${name}.gen is already a site.` });

    if (form.mode === 'proxy') {
        if (form.hostPort !== null && !(Number.isInteger(form.hostPort) && form.hostPort >= 1 && form.hostPort <= 65535)) {
            problems.push({ field: 'hostPort', message: 'A port is a number from 1 to 65535.' });
        } else if (form.devServer === null && form.hostPort === null) {
            problems.push({ field: 'hostPort', message: 'A proxy site needs either a dev server command or a port you already run.' });
        }
    } else if (!form.root || form.root.trim().length === 0) {
        problems.push({ field: 'root', message: form.mode === 'static' ? 'A static site needs the built directory to serve (for example dist).' : 'A PHP site needs its public directory (usually public).' });
    }
    return problems;
}

export interface FlowForm {
    readonly workspaceId: string;
    readonly name: string;
    readonly document: unknown;
    readonly armed: boolean;
}

export function flowFormDefaults(input: { workspaceId: string }): FlowForm {
    return {
        workspaceId: input.workspaceId,
        name: `${input.workspaceId} hourly`,
        document: {
            version: 1,
            nodes: [
                { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 * * * *', timezone: 'UTC' } },
                { id: 'l', kind: 'log', position: { x: 240, y: 0 }, config: { message: 'tick' } },
            ],
            edges: [{ id: 'e1', source: 't', target: 'l' }],
        },
        armed: false,
    };
}

export function validateFlowForm(form: FlowForm): Problem[] {
    const problems: Problem[] = [];
    if (form.name.trim().length === 0) problems.push({ field: 'name', message: 'A flow needs a name.' });
    const doc = form.document as { nodes?: Array<{ id: string; kind: string; config?: Record<string, unknown> }> } | null;
    for (const n of doc?.nodes ?? []) {
        if (!/(^|\/)schedule_trigger$/.test(n.kind)) continue;
        const cron = typeof n.config?.cron === 'string' ? n.config.cron : '';
        const tz = typeof n.config?.timezone === 'string' ? n.config.timezone : undefined;
        if (parseCron(cron) === null) problems.push({ field: 'cron', message: `Node ${n.id}: "${cron}" is not a cron expression Genie can evaluate (five fields: minute hour day month weekday).` });
        if (tz !== undefined && tz !== 'UTC' && tz !== 'Etc/UTC') problems.push({ field: 'timezone', message: `Node ${n.id}: timezone ${tz} is not supported yet; schedules are evaluated in UTC.` });
    }
    return problems;
}

export type ServiceScopeKind = 'dedicated' | 'shared';

/** A custom image, as the person (or an agent, through the person's approval) names it — Genie 1's custom escape hatch. */
export interface CustomServiceForm {
    /** One per name per workspace; the container is `genie-<workspace>-custom-<name>` and the env `GENIE_SERVICE_CUSTOM_<NAME>_*`. */
    readonly name: string;
    readonly image: string;
    /** The port the image listens on inside its container; `null` = not given yet. */
    readonly port: number | null;
    /** The container's env, and the workspace's (Genie 1 gave both). */
    readonly env: Readonly<Record<string, string>>;
}

/** "Add an engine": which engine, which major, dedicated to the workspace or shared by the workstation. */
export interface ServiceForm {
    readonly workspaceId: string;
    readonly engine: string;
    /** The major; ignored for `custom`, which has none. */
    readonly major: string;
    readonly scope: ServiceScopeKind;
    /** `custom` only. */
    readonly custom?: CustomServiceForm;
}

export function serviceFormDefaults(input: { workspaceId: string }): ServiceForm {
    const def = SERVICE_CATALOG[0]!;
    return { workspaceId: input.workspaceId, engine: def.engine, major: def.majors[def.majors.length - 1]!, scope: 'dedicated' };
}

/** Genie 1's validation of a custom image (services-config.ts IMAGE_REF / ENV_NAME): what goes onto `docker create`'s argv. */
const IMAGE_REF = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CUSTOM_NAME = /^[a-z][a-z0-9-]{0,30}$/;

function validateCustom(form: ServiceForm, problems: Problem[]): void {
    const c = form.custom;
    if (form.scope !== 'dedicated') problems.push({ field: 'scope', message: 'A custom image is always dedicated to its workspace — an arbitrary image has no multi-tenant story to share.' });
    if (!c) {
        problems.push({ field: 'image', message: 'A custom engine needs its image and the port it listens on.' });
        return;
    }
    if (!CUSTOM_NAME.test(c.name)) problems.push({ field: 'name', message: `"${c.name}" is not a name Genie can give a container: lowercase letters, digits and hyphens, starting with a letter, at most 31.` });
    if (!IMAGE_REF.test(c.image)) problems.push({ field: 'image', message: c.image.trim() === '' ? 'Name the image to run (for example registry.example/team/app:1).' : `"${c.image}" is not an image reference Genie will run.` });
    if (c.port === null || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535) problems.push({ field: 'port', message: 'The port the image listens on inside its container: a whole number from 1 to 65535.' });
    const badNames = Object.keys(c.env).filter((k) => !ENV_NAME.test(k));
    if (badNames.length > 0) problems.push({ field: 'env', message: `Not environment variable names: ${badNames.map((k) => JSON.stringify(k)).join(', ')} (one NAME=value per line).` });
    if (Object.values(c.env).some((v) => typeof v !== 'string' || v.includes('\0'))) problems.push({ field: 'env', message: 'An environment value cannot hold a NUL byte.' });
}

export function validateServiceForm(form: ServiceForm): Problem[] {
    const problems: Problem[] = [];
    const def = SERVICE_CATALOG.find((e) => e.engine === form.engine);
    // An adopt-only engine (MinIO: its images are gone) is one Genie runs when Genie 1 left it, never one a person adds.
    if (def?.adoptOnly) {
        problems.push({ field: 'engine', message: `${form.engine} can only be taken over from Genie 1 — its images are no longer published.` });
        return problems;
    }
    if (!def) {
        problems.push({ field: 'engine', message: `${form.engine} is not an engine Genie manages.` });
        return problems;
    }
    if (def.custom) {
        validateCustom(form, problems);
        return problems;
    }
    if (!def.majors.includes(form.major)) problems.push({ field: 'major', message: `${form.engine} ${form.major} is not a version Genie knows (${def.majors.join(', ')}).` });
    if (def.sharing === 'shared-only' && form.scope === 'dedicated') problems.push({ field: 'scope', message: `${form.engine} is a shared service — one per workstation, never per workspace.` });
    return problems;
}

export type KnowledgeClass = 'profile' | 'episodic' | 'procedural' | 'knowledge';
export type KnowledgeScope = { readonly kind: 'system' } | { readonly kind: 'workspace'; readonly id: string };

/** "Add a memory": a title, a body (wikilinks welcome), a class, and where it files. */
export interface KnowledgeForm {
    readonly title: string;
    readonly body: string;
    readonly class: KnowledgeClass;
    readonly scope: KnowledgeScope;
}

export function knowledgeFormDefaults(input: { workspaceId?: string }): KnowledgeForm {
    return { title: '', body: '', class: 'knowledge', scope: input.workspaceId ? { kind: 'workspace', id: input.workspaceId } : { kind: 'system' } };
}

export function validateKnowledgeForm(form: KnowledgeForm): Problem[] {
    const problems: Problem[] = [];
    if (form.title.trim().length === 0) problems.push({ field: 'title', message: 'A memory needs a title.' });
    return problems;
}
