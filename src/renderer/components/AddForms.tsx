import { PathBrowse } from './HostPathPicker.js';
import { useState } from 'react';
import { Input } from '@particle-academy/react-fancy';
import { flowFields, flowFormFromFields, type FlowStep } from '../../core/flow-form.js';
import { SCHEDULE_PRESETS, nextRunWords } from '../../core/flow-schedule.js';
import { workspaceLabel } from '../../core/workspace-label.js';
import type { FlowForm, KnowledgeForm, Problem, ServiceForm, SiteFormDefaults, SiteMode } from '../../core/forms.js';
import { CUSTOM_KINDS, DEFAULT_CUSTOM_NAME, parseEnvLines, SERVICE_CATALOG } from '../../core/services.js';

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
    readonly onSubmit: (form: { name: string; mode: SiteMode; command: string; hostPort: number | null; root: string | null; spa: boolean; phpVersion: string | null }) => void;
    readonly onCancel: () => void;
    /** The PHP versions Genie manages here (newest first) — a php site may be pinned to one; none = the PHP on your PATH. */
    readonly phpVersions?: readonly string[];
    /** The same form edits a site (`edit-site`, "Save") — one set of fields, one validation, for Add and Edit. */
    readonly formId?: 'add-site' | 'edit-site';
    readonly submitLabel?: string;
    /** The folder the root is relative to (the site's repo) — Browse picks inside it (Tynn #835); absent = typed only. */
    readonly root?: string | undefined;
}

export function AddSiteForm({ defaults, problems, onSubmit, onCancel, phpVersions = [], formId = 'add-site', submitLabel = 'Add site', root }: AddSiteFormProps) {
    // An Edit opens on the site's pin; a pin to a version not installed here is shown as that, never swapped.
    const pinned = defaults.phpVersion ?? '';
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
                    phpVersion: String(data.get('phpVersion') ?? '') || null,
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
                <PathBrowse name="root" root={root ?? null} />
                <ProblemLine field="root" problems={problems} />
            </Row>
            <Row label="PHP version (php sites)">
                <select name="phpVersion" data-php-version-select="" defaultValue={pinned} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
                    <option value="">The PHP on your PATH</option>
                    {phpVersions.map((v) => <option key={v} value={v}>PHP {v} — managed by Genie</option>)}
                    {/* A pin to a version that is not installed stays visible as what it is, never silently swapped. */}
                    {/* A LINE pin (`8.4`, Genie 1's shape) runs the newest managed 8.4.x — say so rather than "not installed". */}
                    {pinned && !phpVersions.includes(pinned) ? <option value={pinned}>{phpVersions.some((v) => v.startsWith(`${pinned}.`)) ? `PHP ${pinned} — the newest ${pinned} Genie manages` : `PHP ${pinned} — not installed`}</option> : null}
                </select>
                <ProblemLine field="phpVersion" problems={problems} />
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
    /** The workspace's folder — a command's folder is relative to it, and Browse picks inside it (Tynn #835). */
    readonly root?: string | undefined;
    /** Editing an existing flow (genie#1204): Save instead of Add, and no Arm-now (arming stays its own choice). */
    readonly editing?: boolean | undefined;
}

const STEP_CHOICES: ReadonlyArray<{ value: FlowStep['kind']; label: string }> = [
    { value: 'command', label: 'Run a command in the workspace' },
    { value: 'agent', label: 'Prompt an agent' },
    { value: 'log', label: 'Only note that it fired' },
];
/** A file flow's own step (genie#1204): offered only when a file starts the flow — it moves THAT file. */
const MOVE_CHOICE = { value: 'move' as const, label: 'Move the file into a folder' };
const TRIGGER_CHOICES = [
    { value: 'schedule' as const, label: 'On a schedule' },
    { value: 'file' as const, label: 'When a file is added to the workspace' },
];

/**
 * "Add a flow": a schedule and what it RUNS — a command in the workspace (its output kept like a background
 * process's log), a prompt to an agent (held back while the agent is mid-turn), or only a note that it fired.
 * Only the chosen step's fields are drawn; the document is built from the fields on submit (core/flow-form.ts).
 */
export function AddFlowForm({ defaults, problems, onSubmit, onCancel, root, editing = false }: AddFlowFormProps) {
    const initial = flowFields(defaults.document);
    const [cron, setCron] = useState(initial.cron);
    const [step, setStep] = useState<FlowStep['kind']>(initial.step.kind);
    const [trigger, setTrigger] = useState<'schedule' | 'file'>(initial.trigger.kind);
    const file = initial.trigger.kind === 'file' ? initial.trigger : { folder: '', extensions: '', minSizeMb: '' };
    const moveTo = initial.step.kind === 'move' ? initial.step.to : '.untracked';
    const choices = trigger === 'file' ? [...STEP_CHOICES, MOVE_CHOICE] : STEP_CHOICES;
    const command = initial.step.kind === 'command' ? initial.step : { command: '', folder: '' };
    const agent = initial.step.kind === 'agent' ? initial.step : { agent: '', prompt: '' };
    return (
        <form
            data-form="add-flow"
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const fields: Record<string, string> = {};
                data.forEach((value, key) => { if (typeof value === 'string') fields[key] = value; });
                onSubmit(flowFormFromFields(defaults, fields));
            }}
        >
            <p className="text-sm text-[var(--fg-3)]">What starts it, and the work it runs. A flow with more than one step is edited by an agent until the canvas editor lands.</p>
            <Row label="Name">
                <Input name="name" defaultValue={defaults.name} />
                <ProblemLine field="name" problems={problems} />
            </Row>
            <fieldset data-flow-trigger={trigger} className="flex flex-col gap-2">
                <legend className="text-sm font-medium">What starts it</legend>
                {TRIGGER_CHOICES.map((c) => (
                    <label key={c.value} className="flex items-center gap-2 text-sm">
                        <input type="radio" name="trigger" value={c.value} checked={trigger === c.value} onChange={() => { setTrigger(c.value); if (c.value === 'schedule' && step === 'move') setStep('log'); }} />
                        {c.label}
                    </label>
                ))}
            </fieldset>
            {trigger === 'file' ? (
                <>
                    <Row label="Folder to watch (optional — empty means anywhere in the workspace; never .git, node_modules or vendor)">
                        <Input name="watchFolder" defaultValue={file.folder} placeholder="uploads" />
                        <PathBrowse name="watchFolder" root={root ?? null} />
                        <ProblemLine field="watchFolder" problems={problems} />
                    </Row>
                    <Row label="File kinds (optional, comma-separated)">
                        <Input name="extensions" defaultValue={file.extensions} placeholder="png, jpg" />
                    </Row>
                    <Row label="Only files of at least (MB, optional)">
                        <Input name="minSizeMb" defaultValue={file.minSizeMb} placeholder="5" />
                        <ProblemLine field="minSizeMb" problems={problems} />
                    </Row>
                </>
            ) : null}
            {trigger === 'schedule' ? (
            <Row label="Schedule (cron, five fields, this machine's local time)">
                <select
                    data-schedule-preset=""
                    aria-label="Schedule presets"
                    value={SCHEDULE_PRESETS.some((p) => p.cron === cron.trim()) ? cron.trim() : ''}
                    onChange={(e) => { if (e.target.value) setCron(e.target.value); }}
                    className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm"
                >
                    <option value="">Custom…</option>
                    {SCHEDULE_PRESETS.map((p) => <option key={p.cron} value={p.cron}>{p.label}</option>)}
                </select>
                <Input name="cron" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 * * * *" />
                <span data-next-run="" className="text-xs text-[var(--fg-3)]">{nextRunWords(cron, Date.now())}</span>
                <ProblemLine field="cron" problems={problems} />
                <ProblemLine field="timezone" problems={problems} />
            </Row>
            ) : null}
            {/* the schedule row ends here */}
            <fieldset data-flow-step={step} className="flex flex-col gap-2">
                <legend className="text-sm font-medium">What it runs</legend>
                {choices.map((c) => (
                    <label key={c.value} className="flex items-center gap-2 text-sm">
                        <input type="radio" name="step" value={c.value} checked={step === c.value} onChange={() => setStep(c.value)} />
                        {c.label}
                    </label>
                ))}
            </fieldset>
            {step === 'command' ? (
                <>
                    <Row label="Command">
                        <Input name="command" defaultValue={command.command} placeholder="php artisan schedule:run" />
                        <ProblemLine field="command" problems={problems} />
                    </Row>
                    <Row label="Folder in the workspace (optional)">
                        <Input name="folder" defaultValue={command.folder} placeholder="repos/app" />
                        <PathBrowse name="folder" root={root ?? null} />
                        <ProblemLine field="folder" problems={problems} />
                    </Row>
                </>
            ) : null}
            {step === 'agent' ? (
                <>
                    <Row label="Agent">
                        <Input name="agent" defaultValue={agent.agent} placeholder="claude:atlas" />
                        <ProblemLine field="agent" problems={problems} />
                    </Row>
                    <Row label="Prompt">
                        <textarea name="prompt" defaultValue={agent.prompt} rows={3} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm" />
                        <ProblemLine field="prompt" problems={problems} />
                    </Row>
                </>
            ) : null}
            {step === 'move' && trigger === 'file' ? (
                <Row label="Move it into (a folder in the workspace; nothing is ever overwritten)">
                    <Input name="moveTo" defaultValue={moveTo} placeholder=".untracked" />
                    <PathBrowse name="moveTo" root={root ?? null} />
                    <ProblemLine field="moveTo" problems={problems} />
                </Row>
            ) : null}
            {editing ? null : (
                <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="armed" defaultChecked={defaults.armed} />
                    Arm now — it starts running on its own. Off by default; an agent can create a flow but only you can arm it.
                </label>
            )}
            <div className="flex gap-2">
                <button type="submit" className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm text-white">{editing ? 'Save flow' : 'Add flow'}</button>
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
    // Which engine is picked decides which fields there are: a custom image has no version, and needs its image and port.
    const [engine, setEngine] = useState(defaults.engine);
    const custom = engine === 'custom';
    // An engine that is never shared (Redis, the owner's D2): the choice is not offered, and the form says why.
    const onlyDedicated = SERVICE_CATALOG.find((d) => d.engine === engine)?.sharing === 'dedicated-only';
    // An engine with variants (postgres → pgvector) offers them; the engine's own image is the first choice.
    const variants = Object.entries(SERVICE_CATALOG.find((d) => d.engine === engine)?.variants ?? {});
    return (
        <form
            data-form="add-service"
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const pull = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'pull';
                const picked = String(data.get('engine') ?? '');
                const port = String(data.get('port') ?? '').trim();
                const variant = String(data.get('variant') ?? '').trim();
                const kind = String(data.get('kind') ?? '').trim();
                onSubmit(
                    {
                        workspaceId: defaults.workspaceId,
                        engine: picked,
                        major: String(data.get('major') ?? '').trim(),
                        scope: data.get('scope') === 'shared' ? 'shared' : 'dedicated',
                        ...(picked !== 'custom' && variant !== '' ? { variant } : {}),
                        ...(picked === 'custom'
                            ? {
                                custom: {
                                    name: String(data.get('name') ?? '').trim() || DEFAULT_CUSTOM_NAME,
                                    image: String(data.get('image') ?? '').trim(),
                                    port: port === '' ? null : Number(port),
                                    env: parseEnvLines(String(data.get('env') ?? '')),
                                    ...(kind !== '' ? { kind } : {}),
                                },
                            }
                            : {}),
                    },
                    pull,
                );
            }}
        >
            <p className="text-sm text-[var(--fg-3)]">An engine in a container on this machine, reached over 127.0.0.1 on a port Genie picks. Its credentials go into the workspace’s environment.</p>
            <Row label="Engine">
                <select name="engine" defaultValue={defaults.engine} onChange={(e) => setEngine(e.currentTarget.value)} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
                    {SERVICE_CATALOG.filter((d) => !d.adoptOnly).map((d) => (
                        <option key={d.engine} value={d.engine}>
                            {d.engine} — {d.custom ? 'an image you name, dedicated to this workspace' : d.sharing === 'shared-only' ? 'shared, one per workstation' : `versions ${d.majors.join(', ')}`}
                        </option>
                    ))}
                </select>
                <ProblemLine field="engine" problems={problems} />
            </Row>
            {custom ? (
                <div data-custom-fields className="flex flex-col gap-4">
                    <Row label="Image">
                        <Input name="image" defaultValue={defaults.custom?.image ?? ''} placeholder="registry.example/team/app:1" />
                        <ProblemLine field="image" problems={problems} />
                    </Row>
                    <Row label="Port it listens on (inside its container)">
                        <Input name="port" type="number" defaultValue={defaults.custom?.port != null ? String(defaults.custom.port) : ''} placeholder="8080" />
                        <ProblemLine field="port" problems={problems} />
                    </Row>
                    <Row label="Name">
                        <Input name="name" defaultValue={defaults.custom?.name ?? DEFAULT_CUSTOM_NAME} />
                        <ProblemLine field="name" problems={problems} />
                    </Row>
                    <Row label="Environment (NAME=value, one per line) — the container gets it, and so does the workspace">
                        <textarea name="env" rows={3} defaultValue={Object.entries(defaults.custom?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 font-mono text-sm" />
                        <ProblemLine field="env" problems={problems} />
                    </Row>
                    <Row label="It is a… (the workspace then gets that engine’s variables from it, with its live port and the credentials in its environment)">
                        <select name="kind" data-custom-kind defaultValue={defaults.custom?.kind ?? ''} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
                            <option value="">something else — only GENIE_SERVICE_CUSTOM_* and its own environment</option>
                            {CUSTOM_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                        </select>
                        <ProblemLine field="kind" problems={problems} />
                    </Row>
                </div>
            ) : (
                <>
                    <Row label="Version (major)">
                        <Input name="major" defaultValue={defaults.major} placeholder="17" />
                        <ProblemLine field="major" problems={problems} />
                    </Row>
                    {variants.length > 0 ? (
                        <Row label="Image">
                            <select name="variant" data-service-variant defaultValue={defaults.variant ?? ''} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
                                <option value="">{engine} — the official image</option>
                                {variants.map(([name, v]) => <option key={name} value={name}>{name} — {v.summary}</option>)}
                            </select>
                            <ProblemLine field="variant" problems={problems} />
                        </Row>
                    ) : null}
                </>
            )}
            <fieldset className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Scope</span>
                <label className="flex items-center gap-2">
                    <input type="radio" name="scope" value="dedicated" defaultChecked={defaults.scope === 'dedicated' || onlyDedicated} />
                    Dedicated to {workspaceName ?? defaults.workspaceId} — its own data and port
                </label>
                <label className="flex items-center gap-2">
                    <input type="radio" name="scope" value="shared" defaultChecked={defaults.scope === 'shared' && !onlyDedicated} disabled={onlyDedicated} />
                    Shared — one per workstation, every workspace reaches it
                </label>
                {onlyDedicated && !custom ? <span data-dedicated-only="" className="text-xs text-[var(--fg-3)]">{engine} is always its own: {SERVICE_CATALOG.find((d) => d.engine === engine)?.dedicatedBecause}.</span> : null}
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
