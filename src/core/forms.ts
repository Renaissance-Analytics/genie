import { basename } from 'node:path';
import { parseCron } from './cron.js';
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

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function labelFromFolder(repoPath: string): string {
    return basename(repoPath.replace(/[\\/]+$/, ''))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63);
}

const STACK_LABEL: Record<DevServer['stack'], string> = { laravel: 'Laravel', node: 'A Node dev script', django: 'Django', go: 'Go' };
const STACK_HINT: Record<DevServer['stack'], string> = {
    laravel: 'Genie will run `php artisan serve` on a free port.',
    node: 'Genie will run the dev script with a free port.',
    django: 'Genie will run `manage.py runserver` on a free port.',
    go: 'Genie will run `go run .`; make sure it reads PORT.',
};

export function siteFormDefaults(input: RepoFacts & { repoPath: string }): SiteFormDefaults {
    const name = labelFromFolder(input.repoPath);
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

export function validateSiteForm(form: SiteForm, existingHosts: readonly string[]): Problem[] {
    const problems: Problem[] = [];
    const label = form.name.toLowerCase();
    if (form.name.trim().length === 0) problems.push({ field: 'name', message: 'A site needs a name — one hostname label (a-z, 0-9, hyphens).' });
    else if (!LABEL.test(label)) problems.push({ field: 'name', message: `"${form.name}" is not a hostname label — use a-z, 0-9 and hyphens.` });
    else if (existingHosts.includes(`${label}.gen`)) problems.push({ field: 'name', message: `${label}.gen is already a site.` });

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

/** "Add an engine": which engine, which major, dedicated to the workspace or shared by the workstation. */
export interface ServiceForm {
    readonly workspaceId: string;
    readonly engine: string;
    readonly major: string;
    readonly scope: ServiceScopeKind;
}

export function serviceFormDefaults(input: { workspaceId: string }): ServiceForm {
    const def = SERVICE_CATALOG[0]!;
    return { workspaceId: input.workspaceId, engine: def.engine, major: def.majors[def.majors.length - 1]!, scope: 'dedicated' };
}

export function validateServiceForm(form: ServiceForm): Problem[] {
    const problems: Problem[] = [];
    const def = SERVICE_CATALOG.find((e) => e.engine === form.engine);
    if (!def) {
        problems.push({ field: 'engine', message: `${form.engine} is not an engine Genie manages.` });
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
