import { Input } from '@particle-academy/react-fancy';
import { workspaceLabel } from '../../core/workspace-label.js';
import type { FlowForm, KnowledgeForm, Problem, ServiceForm, SiteFormDefaults, SiteMode } from '../../core/forms.js';
import { SERVICE_CATALOG } from '../../core/services.js';

/**
 * THE FORMS — "Add a site" and "Add a flow".
 *
 * Defaults are prefilled from disk (core/forms.ts decides them), the hint says what Genie will do,
 * and every problem is shown beside its field at once — the person fixes the form in one pass.
 * Submit and Cancel are the only ways out. These are plain controlled-by-default forms rendered
 * server-side in tests, so they read their values from the DOM on submit rather than from state.
 */

function ProblemLine({ field, problems }: { field: string; problems: readonly Problem[] }) {
    const mine = problems.filter((p) => p.field === field);
    if (mine.length === 0) return null;
    return (
        <div data-problem={field} className="mt-1 text-xs text-[var(--danger)]">
            {mine.map((p) => <div key={p.message}>{p.message}</div>)}
        </div>
    );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{label}</span>
            {children}
        </label>
    );
}

export interface AddSiteFormProps {
    readonly defaults: SiteFormDefaults;
    readonly existingHosts: readonly string[];
    readonly problems: readonly Problem[];
    readonly onSubmit: (form: { name: string; mode: SiteMode; command: string; hostPort: number | null; root: string | null; spa: boolean }) => void;
    readonly onCancel: () => void;
    /** The same form edits a site (`edit-site`, "Save") — one set of fields, one validation, for Add and Edit. */
    readonly formId?: 'add-site' | 'edit-site';
    readonly submitLabel?: string;
}

export function AddSiteForm({ defaults, problems, onSubmit, onCancel, formId = 'add-site', submitLabel = 'Add site' }: AddSiteFormProps) {
    return (
        <form
            data-form={formId}
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const port = String(data.get('hostPort') ?? '').trim();
                onSubmit({
                    name: String(data.get('name') ?? ''),
                    mode: (String(data.get('mode') ?? 'proxy') as SiteMode),
                    command: String(data.get('command') ?? ''),
                    hostPort: port === '' ? null : Number(port),
                    root: String(data.get('root') ?? '') || null,
                    spa: data.get('spa') === 'on',
                });
            }}
        >
            <p className="text-sm text-[var(--fg-3)]">{defaults.hint}</p>
            <Row label="Name">
                <Input name="name" defaultValue={defaults.name} placeholder="web.acme" />
                <ProblemLine field="name" problems={problems} />
            </Row>
            <Row label="Serve mode">
                <select name="mode" defaultValue={defaults.mode} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
                    <option value="proxy">proxy — the repo’s own dev server, or a port you run</option>
                    <option value="static">static — a built directory</option>
                    <option value="php">php — public/ behind a FastCGI worker</option>
                </select>
            </Row>
            <Row label="Dev server command ({port} is the free port Genie picks)">
                <Input name="command" defaultValue={defaults.devServer?.command ?? ''} placeholder="npm run dev -- --port {port}" />
            </Row>
            <Row label="Or a port you already run on">
                <Input name="hostPort" type="number" defaultValue={defaults.hostPort === null ? '' : String(defaults.hostPort)} placeholder="5173" />
                <ProblemLine field="hostPort" problems={problems} />
            </Row>
            <Row label="Root (static: the built directory; php: public)">
                <Input name="root" defaultValue={defaults.root ?? ''} placeholder="dist" />
                <ProblemLine field="root" problems={problems} />
            </Row>
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="spa" defaultChecked={defaults.spa} />
                Single-page app — serve index.html for unknown paths
            </label>
            <div className="flex gap-2">
                <button type="submit" className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white">{submitLabel}</button>
                <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-sm">Cancel</button>
            </div>
        </form>
    );
}

export interface AddFlowFormProps {
    readonly defaults: FlowForm;
    readonly problems: readonly Problem[];
    readonly onSubmit: (form: FlowForm) => void;
    readonly onCancel: () => void;
}

function cronOf(form: FlowForm): string {
    const doc = form.document as { nodes?: Array<{ kind: string; config?: Record<string, unknown> }> };
    const trigger = doc.nodes?.find((n) => /(^|\/)schedule_trigger$/.test(n.kind));
    return typeof trigger?.config?.cron === 'string' ? trigger.config.cron : '';
}

function withCron(form: FlowForm, cron: string): FlowForm {
    const doc = structuredClone(form.document) as { nodes?: Array<{ kind: string; config?: Record<string, unknown> }> };
    for (const n of doc.nodes ?? []) if (/(^|\/)schedule_trigger$/.test(n.kind)) n.config = { ...(n.config ?? {}), cron };
    return { ...form, document: doc };
}

export function AddFlowForm({ defaults, problems, onSubmit, onCancel }: AddFlowFormProps) {
    return (
        <form
            data-form="add-flow"
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                onSubmit({ ...withCron(defaults, String(data.get('cron') ?? '')), name: String(data.get('name') ?? ''), armed: data.get('armed') === 'on' });
            }}
        >
            <p className="text-sm text-[var(--fg-3)]">A schedule and the work it runs. You can edit the full graph on the canvas afterwards.</p>
            <Row label="Name">
                <Input name="name" defaultValue={defaults.name} />
                <ProblemLine field="name" problems={problems} />
            </Row>
            <Row label="Schedule (cron, five fields, UTC)">
                <Input name="cron" defaultValue={cronOf(defaults)} placeholder="0 * * * *" />
                <ProblemLine field="cron" problems={problems} />
                <ProblemLine field="timezone" problems={problems} />
            </Row>
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="armed" defaultChecked={defaults.armed} />
                Arm now — the schedule starts firing. Off by default; an agent can create a flow but only you can arm it.
            </label>
            <div className="flex gap-2">
                <button type="submit" className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white">Add flow</button>
                <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-sm">Cancel</button>
            </div>
        </form>
    );
}

export interface AddServiceFormProps {
    readonly defaults: ServiceForm;
    readonly problems: readonly Problem[];
    /** The driver's answer when the image is not on this machine: the person pulls it, or cancels. */
    readonly consent: { image: string; note: string; form: ServiceForm } | null;
    /** The workspace's name as a person reads it; the id is shown only when no name was given. */
    readonly workspaceName?: string | undefined;
    readonly onSubmit: (form: ServiceForm, consent: boolean) => void;
    readonly onCancel: () => void;
}

/**
 * "Add an engine". A pull is a download the person should know about, so when the driver asks for
 * consent the form shows the note, names the image, and the pull is its OWN labelled submit — the
 * plain "Add engine" never pulls.
 */
export function AddServiceForm({ defaults, problems, consent, workspaceName, onSubmit, onCancel }: AddServiceFormProps) {
    return (
        <form
            data-form="add-service"
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const pull = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'pull';
                onSubmit(
                    {
                        workspaceId: defaults.workspaceId,
                        engine: String(data.get('engine') ?? ''),
                        major: String(data.get('major') ?? '').trim(),
                        scope: data.get('scope') === 'shared' ? 'shared' : 'dedicated',
                    },
                    pull,
                );
            }}
        >
            <p className="text-sm text-[var(--fg-3)]">An engine in a container on this machine, reached over 127.0.0.1 on a port Genie picks. Its credentials go into the workspace’s environment.</p>
            <Row label="Engine">
                <select name="engine" defaultValue={defaults.engine} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
                    {SERVICE_CATALOG.filter((d) => !d.adoptOnly).map((d) => (
                        <option key={d.engine} value={d.engine}>
                            {d.engine} — {d.sharing === 'shared-only' ? 'shared, one per workstation' : `versions ${d.majors.join(', ')}`}
                        </option>
                    ))}
                </select>
                <ProblemLine field="engine" problems={problems} />
            </Row>
            <Row label="Version (major)">
                <Input name="major" defaultValue={defaults.major} placeholder="17" />
                <ProblemLine field="major" problems={problems} />
            </Row>
            <fieldset className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Scope</span>
                <label className="flex items-center gap-2">
                    <input type="radio" name="scope" value="dedicated" defaultChecked={defaults.scope === 'dedicated'} />
                    Dedicated to {workspaceName ?? defaults.workspaceId} — its own data and port
                </label>
                <label className="flex items-center gap-2">
                    <input type="radio" name="scope" value="shared" defaultChecked={defaults.scope === 'shared'} />
                    Shared — one per workstation, every workspace reaches it
                </label>
                <ProblemLine field="scope" problems={problems} />
            </fieldset>
            {consent ? (
                <div data-consent className="rounded-xl border border-[var(--warning)] p-3 text-sm">
                    <p>{consent.note}</p>
                    <button type="submit" name="consent" value="pull" className="mt-2 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white">
                        Pull {consent.image} and add
                    </button>
                </div>
            ) : null}
            <div className="flex gap-2">
                <button type="submit" value="add" className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white">Add engine</button>
                <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-sm">Cancel</button>
            </div>
        </form>
    );
}

export interface AddKnowledgeFormProps {
    readonly defaults: KnowledgeForm;
    readonly problems: readonly Problem[];
    /** Where a memory can file besides this machine. */
    readonly workspaces: readonly { id: string; path: string; name?: string | undefined }[];
    readonly onSubmit: (form: KnowledgeForm) => void;
    readonly onCancel: () => void;
}

const KNOWLEDGE_CLASSES: ReadonlyArray<{ value: KnowledgeForm['class']; label: string }> = [
    { value: 'knowledge', label: 'knowledge — a fact about the world or the code' },
    { value: 'procedural', label: 'procedural — how to do something here' },
    { value: 'episodic', label: 'episodic — what happened, when' },
    { value: 'profile', label: 'profile — about a person or an agent' },
];

const scopeTag = (s: KnowledgeForm['scope']): string => (s.kind === 'system' ? 'system' : `workspace:${s.id}`);
const scopeOf = (tag: string): KnowledgeForm['scope'] => (tag.startsWith('workspace:') ? { kind: 'workspace', id: tag.slice('workspace:'.length) } : { kind: 'system' });

/** "Add a memory". `[[wikilinks]]` in the body become edges; the surface reports the ones that did not resolve. */
export function AddKnowledgeForm({ defaults, problems, workspaces, onSubmit, onCancel }: AddKnowledgeFormProps) {
    return (
        <form
            data-form="add-memory"
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                onSubmit({
                    title: String(data.get('title') ?? ''),
                    body: String(data.get('body') ?? ''),
                    class: (String(data.get('class') ?? 'knowledge') as KnowledgeForm['class']),
                    scope: scopeOf(String(data.get('scope') ?? 'system')),
                });
            }}
        >
            <p className="text-sm text-[var(--fg-3)]">A memory agents and you can find later. Link other memories with [[their title]].</p>
            <Row label="Title">
                <Input name="title" defaultValue={defaults.title} placeholder="Caddy replace breaks h2 websockets" />
                <ProblemLine field="title" problems={problems} />
            </Row>
            <Row label="Body">
                <textarea name="body" defaultValue={defaults.body} rows={6} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 font-mono text-sm" />
            </Row>
            <Row label="Class">
                <select name="class" defaultValue={defaults.class} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
                    {KNOWLEDGE_CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
            </Row>
            <Row label="Where it files">
                <select name="scope" defaultValue={scopeTag(defaults.scope)} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
                    <option value="system">This machine — every workspace’s agents can find it</option>
                    {workspaces.map((w) => <option key={w.id} value={`workspace:${w.id}`}>{workspaceLabel(workspaces, w.id)} — this workspace only</option>)}
                </select>
            </Row>
            <div className="flex gap-2">
                <button type="submit" className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white">Add memory</button>
                <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-sm">Cancel</button>
            </div>
        </form>
    );
}
