import { Button, Callout, Icon, Input, Modal, Select, Tabs, Textarea } from '@particle-academy/react-fancy';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { LiveState } from '../../core/tynn-board.js';
import { FEATURES_FORMS, REPOSITORY_KINDS, REPOSITORY_PATTERNS, REPOSITORY_PROVIDERS, type DomainRow, type FeatureRow, type FeaturesTab, type FeaturesView, type RepositoryRow } from '../../core/tynn-features.js';
import type { TynnPageActionInput, TynnPageState } from '../../core/tynn-pages.js';
import { LiveMark, OpLine } from './TynnBoardPanel.js';

/**
 * THE TYNN TAB'S FEATURES (genie#1295 row F1, Tynn story #325, workspace-ux 0.10.0 surface `features`) — tynn.ai's
 * Features page (Pages/v2/Project/Features.jsx), natively. Four tabs, each with its count: Features (title, domain, tasks
 * done of total), Domains (description, how many features), Models (table, field count; read only for everyone) and
 * Repositories (label, kind, branch, release cycle, provider). A person who may manage the project adds, edits and
 * deletes features, domains and repositories through the web forms' fields and limits; a workspace with no `.agi`
 * container is offered one, with no URL guessed (tynn.ai#107). A write says it is running, then that it worked, or
 * Tynn's reason with Retry. Tynn's text is drawn as text. react-fancy throughout: Tabs for the tabs, Buttons, Modal.
 */
export interface TynnFeaturesPanelProps {
    readonly state: TynnPageState<FeaturesView>;
    readonly onAct: (input: TynnPageActionInput) => void;
    readonly onRetry?: (() => void) | undefined;
    readonly live?: LiveState | undefined;
    /** The tab open first (Features, as on tynn.ai). */
    readonly initialTab?: FeaturesTab;
}

type FormKind = 'feature' | 'domain' | 'repository';
type Editing = { readonly kind: FormKind; readonly row: FeatureRow | DomainRow | RepositoryRow | null; readonly container?: boolean };

const TAB_LABEL: Readonly<Record<FeaturesTab, string>> = { features: 'Features', domains: 'Domains', models: 'Models', repos: 'Repositories' };
const KIND_LOOK: Readonly<Record<string, { label: string; icon: string }>> = {
    code: { label: 'Code', icon: 'code' },
    knowledge: { label: 'Knowledge', icon: 'book-open' },
    envelope: { label: 'Container', icon: 'package' },
};
const NOUN: Readonly<Record<FormKind, string>> = { feature: 'feature', domain: 'domain', repository: 'repository' };
const DELETE_WORDS: Readonly<Record<FormKind, { ask: string; label: string }>> = {
    feature: { ask: 'Delete this feature? This cannot be undone.', label: 'Delete' },
    domain: { ask: 'Delete this domain? Features keep working but lose this grouping.', label: 'Delete' },
    repository: { ask: 'Remove this repository from the project?', label: 'Remove' },
};

const th = 'px-3 py-2 text-left text-[10px] font-semibold tracking-wide text-[var(--fg-3)] uppercase';
const td = 'px-3 py-2 align-top';

function Empty({ tab, icon, title, hint, add }: { tab: FeaturesTab; icon: string; title: string; hint: string; add?: ReactNode }) {
    return (
        <div data-features-empty={tab} className="flex flex-col items-center gap-2 rounded-lg border border-[var(--border-1)] px-6 py-10 text-center">
            <Icon name={icon} size="lg" />
            <h3 className="text-[15px] font-semibold text-[var(--fg-1)]">{title}</h3>
            <p className="text-[13px] text-[var(--fg-3)]">{hint}</p>
            {add}
        </div>
    );
}

function Toolbar({ hint, add }: { hint?: string; add?: ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--fg-3)]">{hint ?? ''}</span>
            {add}
        </div>
    );
}

function EditButton({ id, label, onClick }: { id: string; label: string; onClick: () => void }) {
    return <Button type="button" size="xs" variant="ghost" icon="pencil" data-features-edit={id} aria-label={`Edit ${label}`} title={`Edit ${label}`} onClick={onClick} />;
}

function FeaturesTable({ view, onEdit, add }: { view: FeaturesView; onEdit: (row: FeatureRow) => void; add: ReactNode }) {
    if (view.features.length === 0) return <Empty tab="features" icon="puzzle" title="No features defined yet" hint="Features tag tasks across the project. Add one to organize work by domain." add={add} />;
    return (
        <>
            <Toolbar add={add} />
            <table className="w-full text-[12px]">
                <thead><tr><th className={th}>Feature</th><th className={th}>Domain</th><th className={th}>Tasks done</th>{view.canManage ? <th className={th} /> : null}</tr></thead>
                <tbody>
                    {view.features.map((f) => (
                        <tr key={f.id} data-feature={f.id} className="border-t border-[var(--border-1)]">
                            <td className={td}>
                                <div className="font-medium text-[var(--fg-1)]">{f.title}</div>
                                {f.description ? <div className="text-[11px] text-[var(--fg-3)]">{f.description}</div> : null}
                                {f.docsUrl ? <Button href={f.docsUrl} target="_blank" rel="noreferrer" size="xs" variant="ghost" icon="external-link" className="mt-1 w-fit">Docs</Button> : null}
                            </td>
                            <td className={`${td} text-[var(--fg-3)]`}>{f.domain ?? '—'}</td>
                            <td className={`${td} tabular-nums ${f.tasks === 0 ? 'text-[var(--fg-3)]' : 'text-[var(--fg-1)]'}`}>{`${f.done} of ${f.tasks}`}</td>
                            {view.canManage ? <td className={`${td} text-right`}><EditButton id={f.id} label={f.title} onClick={() => onEdit(f)} /></td> : null}
                        </tr>
                    ))}
                </tbody>
            </table>
        </>
    );
}

function DomainsTable({ view, onEdit, add }: { view: FeaturesView; onEdit: (row: DomainRow) => void; add: ReactNode }) {
    const hint = 'Domains group features into areas of the product. A feature belongs to one domain.';
    if (view.domains.length === 0) return <Empty tab="domains" icon="layout-grid" title="No domains yet" hint="Add a domain to group related features." add={add} />;
    return (
        <>
            <Toolbar hint={hint} add={add} />
            <table className="w-full text-[12px]">
                <thead><tr><th className={th}>Domain</th><th className={th}>Description</th><th className={th}>Features</th>{view.canManage ? <th className={th} /> : null}</tr></thead>
                <tbody>
                    {view.domains.map((d) => (
                        <tr key={d.id} data-domain={d.id} className="border-t border-[var(--border-1)]">
                            <td className={`${td} font-medium text-[var(--fg-1)]`}>{d.name}</td>
                            <td className={`${td} text-[var(--fg-3)]`}>{d.description ?? '—'}</td>
                            <td className={`${td} tabular-nums`}>{d.features}</td>
                            {view.canManage ? <td className={`${td} text-right`}><EditButton id={d.id} label={d.name} onClick={() => onEdit(d)} /></td> : null}
                        </tr>
                    ))}
                </tbody>
            </table>
        </>
    );
}

function ModelsTable({ view }: { view: FeaturesView }) {
    if (view.models.length === 0) return <Empty tab="models" icon="database" title="No models yet" hint="Models are recorded by the project's agents; they are read only here." />;
    return (
        <table className="w-full text-[12px]">
            <thead><tr><th className={th}>Model</th><th className={th}>Table</th><th className={th}>Description</th><th className={th}>Fields</th></tr></thead>
            <tbody>
                {view.models.map((m) => (
                    <tr key={m.id} data-model={m.id} className="border-t border-[var(--border-1)]">
                        <td className={`${td} font-medium text-[var(--fg-1)]`}>{m.name}</td>
                        <td className={`${td} font-mono text-[11px]`}>{m.table ?? '—'}</td>
                        <td className={`${td} text-[var(--fg-3)]`}>{m.description ?? '—'}</td>
                        <td className={`${td} tabular-nums`}>{m.fields}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function ReposTable({ view, onEdit, onContainer, add }: { view: FeaturesView; onEdit: (row: RepositoryRow) => void; onContainer: () => void; add: ReactNode }) {
    return (
        <>
            <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[13px] font-semibold text-[var(--fg-1)]"><Icon name="folder-git-2" size="sm" />Products &amp; repositories</span>
                {add}
            </div>
            <p className="text-[11px] text-[var(--fg-3)]">Each product repository is its own release line with its own versioning pattern. The envelope container repo lists the products but has no version line of its own.</p>
            {/* An OFFER, not a warning (tynn.ai's own wording): a workspace without a container is complete. No URL is guessed. */}
            {view.envelope === 'none' && view.canManage ? (
                <div data-features-envelope-offer="">
                    <Callout color="zinc" icon={<Icon name="package" size="sm" />}>
                        <div className="text-[12px] font-medium text-[var(--fg-1)]">Add an <code>.agi</code> container repository</div>
                        <div className="text-[11px] text-[var(--fg-2)]">Optional. A container repository lets Genie clone this whole workspace (its product repos and shared notes) in one step. Everything else works without one.</div>
                        <div className="mt-2"><Button type="button" size="xs" icon="plus" data-features-add="container" onClick={onContainer}>Register container repository</Button></div>
                    </Callout>
                </div>
            ) : null}
            {view.repositories.length === 0 ? <Empty tab="repos" icon="folder-git-2" title="No repositories connected" hint="Connect a repository so its product gets a release line." /> : (
                <table className="w-full text-[12px]">
                    <thead><tr><th className={th}>Repository</th><th className={th}>Kind</th><th className={th}>Branch</th><th className={th}>Release cycle</th><th className={th}>Provider</th>{view.canManage ? <th className={th} /> : null}</tr></thead>
                    <tbody>
                        {view.repositories.map((r) => {
                            const look = KIND_LOOK[r.kind] ?? KIND_LOOK.code!;
                            return (
                                <tr key={r.id} data-repository={r.id} className="border-t border-[var(--border-1)]">
                                    <td className={td}>
                                        {r.githubUrl ? <Button href={r.githubUrl} target="_blank" rel="noreferrer" size="xs" variant="ghost" className="w-fit font-mono">{r.label}</Button> : <span className="font-mono text-[11px] text-[var(--fg-1)]">{r.label}</span>}
                                        {r.label !== r.url ? <div className="font-mono text-[10px] text-[var(--fg-3)]">{r.url}</div> : null}
                                    </td>
                                    <td className={td}><span className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-2)] px-2 py-0.5 text-[11px]"><Icon name={look.icon} size="xs" />{look.label}</span></td>
                                    <td className={`${td} font-mono text-[11px]`}>{r.branch ?? '—'}</td>
                                    <td className={`${td} text-[11px]`} title={r.isProduct ? `Pattern: ${r.patternLabel ?? r.pattern ?? '—'}${r.gitLinkage ? ` · linkage: ${r.gitLinkage}` : ''}` : undefined}>
                                        {r.isProduct ? (r.releaseCycle ?? '—').replace(/_/g, ' ') : <span className="text-[var(--fg-3)]">no version line</span>}
                                    </td>
                                    <td className={`${td} text-[11px]`}>{r.provider ?? '—'}</td>
                                    {view.canManage ? <td className={`${td} text-right`}><EditButton id={r.id} label={r.label} onClick={() => onEdit(r)} /></td> : null}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </>
    );
}

/** A row's values as the web form starts from them (tynn.ai's useForm defaults). */
function initialValues(kind: FormKind, row: Editing['row'], container: boolean): Record<string, string> {
    if (kind === 'feature') {
        const f = row as FeatureRow | null;
        return { title: f?.title ?? '', description: f?.description ?? '', domain_id: f?.domainId ?? '', docs_url: f?.docsUrl ?? '' };
    }
    if (kind === 'domain') {
        const d = row as DomainRow | null;
        return { name: d?.name ?? '', description: d?.description ?? '' };
    }
    const r = row as RepositoryRow | null;
    return {
        url: r?.url ?? '', default_branch: r?.branch ?? 'main', scm_provider: r?.provider ?? 'github', repo_mode: r?.repoMode ?? '',
        ci_provider: r?.ciProvider ?? '', ci_config_path: r?.ciConfigPath ?? '', codeowners_path: r?.codeownersPath ?? '',
        kind: container ? 'envelope' : r?.kind ?? 'code', versioning_pattern: r?.pattern ?? '',
    };
}

export interface TynnFeaturesFormProps {
    readonly kind: FormKind;
    readonly row: Editing['row'];
    readonly view: FeaturesView;
    /** The container offer: a repository form that starts as the envelope, with no URL guessed. */
    readonly container?: boolean;
    readonly onSubmit: (body: Record<string, string>) => void;
    readonly onCancel: () => void;
    /** Present for an existing row: deleting asks once more, in tynn.ai's words. */
    readonly onDelete?: () => void;
}

/** The web form for a feature, a domain or a repository, with its fields and limits (workspace-ux `features.data.forms`). */
export function TynnFeaturesForm({ kind, row, view, container = false, onSubmit, onCancel, onDelete }: TynnFeaturesFormProps) {
    const [values, setValues] = useState<Record<string, string>>(() => initialValues(kind, row, container));
    const [confirming, setConfirming] = useState(false);
    const set = (field: string) => (v: string) => setValues((x) => ({ ...x, [field]: v }));
    const field = (name: string) => ({ 'data-features-field': name, value: values[name] ?? '', onValueChange: set(name) });
    const max = (FEATURES_FORMS[kind].max as Readonly<Record<string, number>>);
    const submit = (e: FormEvent) => { e.preventDefault(); onSubmit(values); };
    const isNew = row === null;
    const submitLabel = isNew ? (kind === 'repository' ? 'Add repository' : `Create ${NOUN[kind]}`) : 'Save';
    return (
        <form onSubmit={submit} data-features-form={kind} className="flex flex-col gap-3">
            {kind === 'feature' ? (
                <>
                    <Input label="Title" description="Short: at most 24 characters (drives the slug)." maxLength={max.title} required {...field('title')} />
                    <Textarea label="Description" rows={4} required {...field('description')} />
                    <Select label="Domain" list={[{ value: '', label: 'No domain' }, ...view.domains.map((d) => ({ value: d.id, label: d.name }))]} {...field('domain_id')} />
                    <Input label="Docs URL (optional)" placeholder="https://…" {...field('docs_url')} />
                </>
            ) : kind === 'domain' ? (
                <>
                    <Input label="Name" description="Short: at most 24 characters (drives the slug)." maxLength={max.name} required {...field('name')} />
                    <Textarea label="Description (optional)" rows={3} {...field('description')} />
                </>
            ) : (
                <>
                    <Input label="Repository URL" placeholder="https://github.com/owner/repo" required {...field('url')} />
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Select label="Kind" description="Products get a version line; the container repo does not." list={REPOSITORY_KINDS.map((k) => ({ value: k.value, label: k.label }))} {...field('kind')} />
                        {values.kind !== 'envelope' ? <Select label="Versioning pattern" description="This product's own release cycle." list={REPOSITORY_PATTERNS.map((p) => ({ value: p.value, label: p.label }))} {...field('versioning_pattern')} /> : null}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Input label="Default branch" placeholder="main" {...field('default_branch')} />
                        <Select label="Provider" list={REPOSITORY_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))} {...field('scm_provider')} />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Input label="CI provider (optional)" placeholder="github-actions" {...field('ci_provider')} />
                        <Input label="CI config path (optional)" placeholder=".github/workflows/ci.yml" {...field('ci_config_path')} />
                    </div>
                    <Input label="CODEOWNERS path (optional)" placeholder=".github/CODEOWNERS" {...field('codeowners_path')} />
                </>
            )}
            <div className="flex items-center gap-2">
                {onDelete && !isNew ? (
                    confirming ? (
                        <span className="flex items-center gap-2 text-[12px] text-[var(--warning)]">
                            {DELETE_WORDS[kind].ask}
                            <Button type="button" size="xs" color="red" icon="trash-2" data-features-delete="confirm" onClick={onDelete}>{DELETE_WORDS[kind].label}</Button>
                            <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
                        </span>
                    ) : <Button type="button" size="xs" variant="ghost" color="red" icon="trash-2" data-features-delete="" onClick={() => setConfirming(true)}>{DELETE_WORDS[kind].label}</Button>
                ) : null}
                <span className="flex-1" />
                <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
                <Button type="submit" size="sm" data-tynn-submit="">{submitLabel}</Button>
            </div>
        </form>
    );
}

const TITLE: Readonly<Record<FormKind, { add: string; edit: (row: Editing['row']) => string }>> = {
    feature: { add: 'New Feature', edit: (r) => `Edit ${(r as FeatureRow).title}` },
    domain: { add: 'New Domain', edit: (r) => `Edit ${(r as DomainRow).name}` },
    repository: { add: 'Add Repository', edit: () => 'Edit Repository' },
};

export function TynnFeaturesPanel({ state, onAct, onRetry, live, initialTab = 'features' }: TynnFeaturesPanelProps) {
    const [tab, setTab] = useState<FeaturesTab>(initialTab);
    const [editing, setEditing] = useState<Editing | null>(null);
    if (state.state !== 'ready') {
        const line = state.state === 'loading' ? <><Icon name="loader" size="xs" className="animate-spin" /> Reading Tynn…</> : state.state === 'not-linked' ? 'This workspace has no Tynn project.' : state.reason;
        return <p data-tynn-page-state={state.state} className="flex items-center gap-1.5 p-4 text-[12px] text-[var(--fg-3)]">{line}</p>;
    }
    const { view, op = null } = state;
    const counts: Readonly<Record<FeaturesTab, number>> = { features: view.features.length, domains: view.domains.length, models: view.models.length, repos: view.repositories.length };
    const add = (kind: FormKind, label: string) => (view.canManage ? <Button type="button" size="xs" icon="plus" data-features-add={kind} onClick={() => setEditing({ kind, row: null })}>{label}</Button> : null);
    const close = () => setEditing(null);
    const submit = (body: Record<string, string>) => {
        if (!editing) return;
        const action = `${editing.kind}.${editing.row ? 'update' : 'create'}`;
        onAct({ action, ...(editing.row ? { id: editing.row.id } : {}), body });
        close();
    };
    const remove = () => {
        if (!editing?.row) return;
        onAct({ action: `${editing.kind}.delete`, id: editing.row.id });
        close();
    };
    return (
        <div data-tynn-page="features" className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <div className="flex items-center gap-2">
                <Tabs activeTab={tab} onTabChange={(t) => setTab(t as FeaturesTab)} variant="pills">
                    <Tabs.List aria-label="Features" className="gap-1 bg-transparent p-0 dark:bg-transparent">
                        {(Object.keys(TAB_LABEL) as FeaturesTab[]).map((t) => (
                            <Tabs.Tab key={t} value={t} data-features-tab={t} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] shadow-none ${t === tab ? 'bg-[var(--bg-2)] font-medium text-[var(--fg-1)] dark:bg-[var(--bg-2)] dark:text-[var(--fg-1)]' : 'font-normal text-[var(--fg-3)] hover:bg-[var(--bg-2)] dark:text-[var(--fg-3)]'}`}>
                                {TAB_LABEL[t]}
                                <span data-features-count={counts[t]} className="rounded-full bg-[var(--bg-3)] px-1.5 text-[10px] tabular-nums">{counts[t]}</span>
                            </Tabs.Tab>
                        ))}
                    </Tabs.List>
                </Tabs>
                <span className="flex-1" />
                <LiveMark live={live} />
            </div>
            {op ? <OpLine op={op} onRetry={op.phase === 'failed' ? onRetry : undefined} /> : null}
            {tab === 'features' ? <FeaturesTable view={view} onEdit={(row) => setEditing({ kind: 'feature', row })} add={add('feature', 'Add Feature')} /> : null}
            {tab === 'domains' ? <DomainsTable view={view} onEdit={(row) => setEditing({ kind: 'domain', row })} add={add('domain', 'Add Domain')} /> : null}
            {tab === 'models' ? <ModelsTable view={view} /> : null}
            {tab === 'repos' ? <ReposTable view={view} onEdit={(row) => setEditing({ kind: 'repository', row })} onContainer={() => setEditing({ kind: 'repository', row: null, container: true })} add={add('repository', 'Add Repository')} /> : null}
            {editing ? (
                <Modal open onClose={close} size={editing.kind === 'domain' ? 'md' : 'lg'}>
                    <Modal.Header>{editing.row ? TITLE[editing.kind].edit(editing.row) : editing.container ? 'Register container repository' : TITLE[editing.kind].add}</Modal.Header>
                    <Modal.Body>
                        <TynnFeaturesForm kind={editing.kind} row={editing.row} view={view} container={editing.container === true} onSubmit={submit} onCancel={close} {...(editing.row ? { onDelete: remove } : {})} />
                    </Modal.Body>
                </Modal>
            ) : null}
        </div>
    );
}
