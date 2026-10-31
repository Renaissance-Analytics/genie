import { ContentRenderer, Icon } from '@particle-academy/react-fancy';
import { memo, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BoardFollower, type LiveState } from '../../core/tynn-board.js';
import {
    applyIssueChanges,
    ISSUE_PRIORITIES,
    ISSUE_TYPE_LOOK,
    ISSUES_FORM,
    issueEditBody,
    normalizeIssueFilters,
    performIssueAction,
    PRIORITY_LABEL,
    triageOf,
    type IssueActionInput,
    type IssueChanges,
    type IssueFilters,
    type IssueOp,
    type IssueQueueView,
    type IssueRow,
    type TynnIssuesHost,
    type TynnIssuesState,
} from '../../core/tynn-issues.js';
import { LiveMark } from './TynnBoardPanel.js';
import { genieClipboardWriter } from '../clipboard.js';

/**
 * THE TYNN TAB'S ISSUES (genie#1295 row I1) — tynn.ai's Issues page, natively.
 *
 * The project's one intake queue, as tynn.ai draws it: status tabs (Open, Converted, Resolved, Discarded, All), a source
 * filter (Any source / From people), a search; a grid of cards — number, title, a short body, the type (its icon, its
 * colour on the card's edge), who raised it, its GitHub repo and number, its status when it is not open; "No issues
 * match" when nothing does. A card opens into its form beside the queue: who raised it and where; Delete, Resolve,
 * Discard and Convert only on an open issue for a person who may triage; Resolve and Discard ask why first. No user menu,
 * no project picker: the queue is the workspace's own project's.
 *
 * Genie's rules on top (the owner): icons over words, each named for a screen reader; every action a real button that
 * says it is running, then that it worked, or Tynn's reason with Retry; live while it follows Tynn (the queue's own
 * channel), redrawing only the cards that changed. Titles are Tynn's text, drawn as text; a body is Markdown, sanitised.
 */

const STATUS_TABS: readonly { id: string; label: string }[] = [
    { id: 'open', label: 'Open' },
    { id: 'converted', label: 'Converted' },
    { id: 'resolved', label: 'Resolved' },
    { id: 'discarded', label: 'Discarded' },
    { id: 'all', label: 'All' },
];
/** Resolved and Discarded are both closed and deliberately different: answered, or turned down (tynn.ai IssueStatus). */
const STATUS_CHIP: Readonly<Record<string, string>> = { converted: 'Converted', resolved: 'Resolved', discarded: 'Discarded' };

const OP_WORDS: Readonly<Record<string, { running: string; done: string }>> = {
    'issue.create': { running: 'Raising issue…', done: 'Issue raised' },
    'issue.update': { running: 'Saving…', done: 'Saved' },
    'issue.delete': { running: 'Deleting…', done: 'Deleted' },
    'issue.convert': { running: 'Converting…', done: 'Converted to a story' },
    'issue.resolve': { running: 'Resolving…', done: 'Resolved' },
    'issue.discard': { running: 'Discarding…', done: 'Discarded' },
};

const CLOSE_ASK: Readonly<Record<string, string>> = {
    'issue.resolve': 'How was this dealt with?',
    'issue.discard': 'Why is this not being done?',
};

const inputClass = 'w-full rounded border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--fg-1)]';

function Pill({ on, label, onClick, data, icon }: { on: boolean; label: string; onClick: () => void; data: Record<string, string>; icon?: string }) {
    return (
        <button
            type="button"
            aria-pressed={on}
            aria-label={label}
            title={label}
            onClick={onClick}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] ${on ? 'bg-[var(--bg-2)] font-medium text-[var(--fg-1)]' : 'text-[var(--fg-3)] hover:text-[var(--fg-1)]'}`}
            {...data}
        >
            {icon ? <Icon name={icon} size="xs" /> : null}
            {icon ? null : label}
        </button>
    );
}

function IconButton({ icon, label, onClick, disabled = false, data, tone }: { icon: string; label: string; onClick: () => void; disabled?: boolean; data: Record<string, string>; tone?: 'danger' }) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            className={`inline-flex items-center gap-1 rounded-md border border-[var(--border-1)] px-2 py-1 text-[12px] hover:bg-[var(--bg-2)] disabled:opacity-40 ${tone === 'danger' ? 'text-[var(--danger,var(--warning))]' : 'text-[var(--fg-2)]'}`}
            {...data}
        >
            <Icon name={icon} size="xs" />
        </button>
    );
}

/** A real button that looks like one, with its own in-progress label while it runs. */
function PrimaryButton({ icon, label, busyLabel, busy, disabled, data, type = 'button', onClick }: { icon: string; label: string; busyLabel: string; busy: boolean; disabled: boolean; data: Record<string, string>; type?: 'button' | 'submit'; onClick?: () => void }) {
    return (
        <button
            type={type}
            disabled={busy || disabled}
            onClick={onClick}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--accent-fg,white)] hover:opacity-90 disabled:opacity-50"
            {...data}
        >
            <Icon name={busy ? 'loader' : icon} size="xs" className={busy ? 'animate-spin' : ''} />
            {busy ? busyLabel : label}
        </button>
    );
}

function OpLine({ op, onRetry }: { op: IssueOp; onRetry?: (() => void) | undefined }) {
    const words = OP_WORDS[op.action] ?? { running: 'Working…', done: 'Done' };
    if (op.phase === 'running') return <p data-issue-op="running" aria-live="polite" className="flex items-center gap-1.5 text-[12px] text-[var(--fg-2)]"><Icon name="loader" size="xs" className="animate-spin" /> {words.running}</p>;
    if (op.phase === 'done') return <p data-issue-op="done" aria-live="polite" className="flex items-center gap-1.5 text-[12px] text-[var(--success,var(--fg-2))]"><Icon name="circle-check" size="xs" /> {words.done}</p>;
    return (
        <p data-issue-op="failed" role="alert" className="flex items-center gap-1.5 rounded bg-[var(--warning)]/10 px-2 py-1 text-[12px] text-[var(--warning)]">
            <Icon name="circle-alert" size="xs" />
            <span className="min-w-0 flex-1">{op.reason ?? 'It did not work.'}</span>
            {onRetry ? (
                <button type="button" data-issue-retry="" onClick={onRetry} className="inline-flex items-center gap-1 rounded border border-current px-1.5 py-0.5 text-[11px] font-medium">
                    <Icon name="rotate-ccw" size="xs" /> Retry
                </button>
            ) : null}
        </p>
    );
}

const IssueCard = memo(function IssueCard({ issue, onOpen }: { issue: IssueRow; onOpen: (id: string) => void }) {
    const type = issue.type !== null ? ISSUE_TYPE_LOOK[issue.type] : undefined;
    const chip = STATUS_CHIP[issue.status];
    return (
        <button
            type="button"
            data-issue-card={issue.id}
            onClick={() => onOpen(issue.id)}
            style={type?.border ? { borderLeftColor: type.border } : undefined}
            className="flex min-w-0 flex-col gap-1.5 rounded-md border border-l-4 border-[var(--border-1)] bg-[var(--bg-1)] p-2.5 text-left hover:bg-[var(--bg-2)]"
        >
            <span className="text-[13px] font-medium text-[var(--fg-1)]">{issue.title}</span>
            {issue.description ? <div className="line-clamp-3 text-[12px] text-[var(--fg-3)]"><ContentRenderer value={issue.description} format="markdown" clipboardWriter={genieClipboardWriter} /></div> : null}
            <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--fg-3)]">
                <span className="rounded bg-[var(--bg-2)] px-1.5 py-0.5 font-mono font-semibold text-[var(--fg-2)]">{issue.number}</span>
                {type ? <span data-issue-type={issue.type ?? ''} role="img" aria-label={type.label} title={type.label} className="inline-flex"><Icon name={type.icon} size="xs" /></span> : null}
                {issue.from ? <span className="inline-flex items-center gap-1"><Icon name="user" size="xs" />{issue.from}</span> : null}
                {issue.github ? <span className="rounded bg-[var(--bg-2)] px-1.5 py-0.5 text-[10px]">{issue.github.repo}#{issue.github.number}</span> : null}
                {chip ? <span data-issue-status-chip={issue.status} className="rounded bg-[var(--bg-2)] px-1.5 py-0.5 text-[10px]">{chip}</span> : null}
            </span>
        </button>
    );
});

function FeaturePicks({ features, value, onChange, disabled }: { features: IssueQueueView['features']; value: readonly string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
    if (features.length === 0) return null;
    return (
        <fieldset className="grid grid-cols-2 gap-1 text-[12px]" disabled={disabled}>
            <legend className="mb-1 text-[11px] font-medium text-[var(--fg-3)]">Features</legend>
            {features.map((f) => (
                <label key={f.id} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={value.includes(f.id)} onChange={(e) => onChange(e.target.checked ? [...value, f.id] : value.filter((x) => x !== f.id))} />
                    <span>{f.title}</span>
                </label>
            ))}
        </fieldset>
    );
}

interface FormValue { title: string; description: string; type: string; priority: string; feature_ids: string[] }

/** The open issue (or a new one): the web form's fields, and — on an open issue, for a person who may — its triage. */
function IssueForm({ view, issue, op, closing, onClosing, onAction, onClose, onRetry }: {
    view: IssueQueueView; issue: IssueRow | null; op: IssueOp | null; closing: string | null; onClosing: (action: string | null) => void;
    onAction: (input: IssueActionInput) => void; onClose: () => void; onRetry?: (() => void) | undefined;
}) {
    const isNew = issue === null;
    const [form, setForm] = useState<FormValue>(() => ({
        title: issue?.title ?? '',
        description: issue?.description ?? '',
        type: issue?.type ?? ISSUES_FORM.defaults.type,
        priority: issue?.priority ?? ISSUES_FORM.defaults.priority,
        feature_ids: [...(issue?.featureIds ?? [])],
    }));
    const [versionId, setVersionId] = useState(view.versions[0]?.id ?? '');
    const [reason, setReason] = useState('');
    const busy = op?.phase === 'running';
    const mayTriage = issue !== null && triageOf(view, issue);
    const maySave = isNew || view.canTriage;
    const set = <K extends keyof FormValue>(key: K, value: FormValue[K]) => setForm((f) => ({ ...f, [key]: value }));
    const save = (e?: FormEvent) => {
        e?.preventDefault();
        if (busy || form.title.trim() === '') return;
        if (isNew) { onAction({ action: 'issue.create', issueId: null, body: form as unknown as Record<string, unknown> }); return; }
        const changed = issueEditBody(issue, form);
        if (changed) onAction({ action: 'issue.update', issueId: issue.id, body: changed });
    };
    const id = issue?.id ?? null;
    return (
        <aside data-issue-form={issue?.id ?? 'new'} className="flex w-[380px] shrink-0 flex-col gap-2 overflow-y-auto border-l border-[var(--border-1)] bg-[var(--bg-1)] p-3">
            <div className="flex items-center gap-2">
                <h3 className="text-[13px] font-semibold text-[var(--fg-1)]">{isNew ? 'New issue' : `Issue ${issue.number}`}</h3>
                <span className="ml-auto"><IconButton icon="x" label="Close" onClick={onClose} data={{ 'data-issue-close-form': '' }} /></span>
            </div>
            {issue?.from ? (
                <p className="text-[11px] text-[var(--fg-3)]">
                    Raised by {issue.from}{issue.versionNumber ? ` on v${issue.versionNumber}` : ''}{issue.contextUrl ? ` — ${issue.contextUrl}` : ''}
                </p>
            ) : null}
            {issue?.convertedStoryNumber != null ? <p className="text-[11px] text-[var(--fg-3)]">Converted to story #{issue.convertedStoryNumber}</p> : null}
            <form onSubmit={save} className="flex flex-col gap-2">
                <input aria-label="Title" placeholder="Title" required value={form.title} disabled={busy || !maySave} onChange={(e) => set('title', e.target.value)} className={inputClass} />
                <div className="grid grid-cols-2 gap-2">
                    <select aria-label="Type" value={form.type} disabled={busy || !maySave} onChange={(e) => set('type', e.target.value)} className={inputClass}>
                        {Object.entries(ISSUE_TYPE_LOOK).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
                    </select>
                    <select aria-label="Priority" value={form.priority} disabled={busy || !maySave} onChange={(e) => set('priority', e.target.value)} className={inputClass}>
                        {ISSUE_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                    </select>
                </div>
                <textarea aria-label="Description" placeholder="What happened, or what should exist…" rows={5} value={form.description} disabled={busy || !maySave} onChange={(e) => set('description', e.target.value)} className={inputClass} />
                <FeaturePicks features={view.features} value={form.feature_ids} onChange={(ids) => set('feature_ids', ids)} disabled={busy || !maySave} />
                {op ? <OpLine op={op} onRetry={onRetry} /> : null}
                {closing !== null && id !== null ? (
                    <div data-issue-close-reason={closing} className="flex flex-col gap-1.5 rounded-md border border-[var(--border-1)] p-2">
                        <textarea aria-label={CLOSE_ASK[closing]} placeholder={CLOSE_ASK[closing]} rows={2} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} className={inputClass} autoFocus />
                        <div className="flex items-center justify-end gap-1">
                            <IconButton icon="x" label="Cancel" onClick={() => { setReason(''); onClosing(null); }} disabled={busy} data={{ 'data-issue-cancel-close': '' }} />
                            <PrimaryButton
                                icon={closing === 'issue.resolve' ? 'check' : 'ban'}
                                label={closing === 'issue.resolve' ? 'Resolve' : 'Discard'}
                                busyLabel={OP_WORDS[closing]!.running}
                                busy={busy && op?.action === closing}
                                disabled={reason.trim() === ''}
                                data={{ 'data-issue-confirm-close': closing }}
                                onClick={() => onAction({ action: closing, issueId: id, body: { reason } })}
                            />
                        </div>
                    </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-1.5">
                    {mayTriage && id !== null ? (
                        <>
                            <IconButton icon="trash-2" label="Delete" tone="danger" disabled={busy} onClick={() => onAction({ action: 'issue.delete', issueId: id })} data={{ 'data-issue-action': 'delete' }} />
                            <IconButton icon="check" label="Resolve" disabled={busy} onClick={() => onClosing('issue.resolve')} data={{ 'data-issue-action': 'resolve' }} />
                            <IconButton icon="ban" label="Discard" disabled={busy} onClick={() => onClosing('issue.discard')} data={{ 'data-issue-action': 'discard' }} />
                            {view.versions.length > 0 ? (
                                <span className="inline-flex items-center gap-1">
                                    <select aria-label="Convert to a story on" value={versionId} disabled={busy} onChange={(e) => setVersionId(e.target.value)} className={`${inputClass} w-auto`}>
                                        {view.versions.map((v) => <option key={v.id} value={v.id}>v{v.number} {v.title} ({v.status})</option>)}
                                    </select>
                                    <IconButton icon="rocket" label="Convert" disabled={busy || versionId === ''} onClick={() => onAction({ action: 'issue.convert', issueId: id, body: { version_id: versionId } })} data={{ 'data-issue-action': 'convert' }} />
                                </span>
                            ) : null}
                        </>
                    ) : null}
                    {maySave ? (
                        <span className="ml-auto">
                            <PrimaryButton
                                type="submit"
                                icon={isNew ? 'plus' : 'check'}
                                label={isNew ? 'Raise issue' : 'Save'}
                                busyLabel={isNew ? 'Raising issue…' : 'Saving…'}
                                busy={busy && (op?.action === 'issue.create' || op?.action === 'issue.update')}
                                disabled={form.title.trim() === ''}
                                data={{ 'data-issue-action': isNew ? 'create' : 'save' }}
                            />
                        </span>
                    ) : null}
                </div>
            </form>
        </aside>
    );
}

export interface TynnIssuesPanelProps {
    readonly state: TynnIssuesState;
    readonly onFilters: (filters: IssueFilters) => void;
    readonly onAction: (input: IssueActionInput) => void;
    /** The open issue's id, `new` for a new one, or nothing. */
    readonly open?: string | null;
    readonly onOpen?: (id: string | null) => void;
    /** Resolve or discard, asking why. */
    readonly closing?: string | null;
    readonly onClosing?: (action: string | null) => void;
    readonly op?: IssueOp | null;
    readonly onRetry?: (() => void) | undefined;
    readonly onRefresh?: (() => void) | undefined;
    readonly live?: LiveState | undefined;
}

export function TynnIssuesPanel({ state, onFilters, onAction, open = null, onOpen, closing = null, onClosing, op = null, onRetry, onRefresh, live }: TynnIssuesPanelProps) {
    const [q, setQ] = useState(state.state === 'ready' ? state.view.filters.q : '');
    if (state.state !== 'ready') {
        const line = state.state === 'loading' ? <><Icon name="loader" size="xs" /> Reading Tynn…</> : state.state === 'not-linked' ? 'This workspace has no Tynn project.' : state.reason;
        return <p data-tynn-issues-state={state.state} className="flex items-center gap-1.5 p-4 text-[12px] text-[var(--fg-3)]">{line}</p>;
    }
    const { view } = state;
    const f = view.filters;
    const go = (next: Partial<IssueFilters>) => onFilters(normalizeIssueFilters({ ...f, q, ...next }));
    const openIssue = open !== null && open !== 'new' ? view.issues.find((i) => i.id === open) ?? null : null;
    const setOpen = (id: string | null) => onOpen?.(id);
    return (
        <div className="flex min-h-0 flex-1">
            <div data-tynn-issues="" className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-0.5" role="group" aria-label="Status">
                        {STATUS_TABS.map((t) => <Pill key={t.id} on={f.status === t.id} label={t.label} onClick={() => go({ status: t.id })} data={{ 'data-issues-status': t.id }} />)}
                    </div>
                    <div className="flex items-center gap-0.5" role="group" aria-label="Source">
                        <Pill on={f.source === null} label="Any source" onClick={() => go({ source: null })} data={{ 'data-issues-source': 'any' }} />
                        <Pill on={f.source === 'feedback'} label="From people" icon="users" onClick={() => go({ source: 'feedback' })} data={{ 'data-issues-source': 'feedback' }} />
                    </div>
                    <form className="min-w-[200px] flex-1" onSubmit={(e) => { e.preventDefault(); go({}); }}>
                        <label className="flex items-center gap-1.5 rounded border border-[var(--border-1)] bg-[var(--bg-1)] px-2">
                            <Icon name="search" size="xs" />
                            <input aria-label="Search issues" placeholder="Search issues…" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => { if (q.trim() !== f.q) go({}); }} className="w-full bg-transparent py-1 text-[12px] text-[var(--fg-1)] outline-none" />
                        </label>
                    </form>
                    <span className="ml-auto flex items-center gap-1">
                        {op && open === null ? <OpLine op={op} onRetry={onRetry} /> : null}
                        <LiveMark live={live} />
                        {onRefresh ? <IconButton icon="refresh-cw" label="Refresh" onClick={onRefresh} data={{ 'data-issues-refresh': '' }} /> : null}
                        <button type="button" aria-label="New issue" title="New issue" data-issues-new="" onClick={() => setOpen('new')} className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-1 text-[12px] font-medium text-[var(--accent-fg,white)] hover:opacity-90">
                            <Icon name="plus" size="xs" />
                        </button>
                    </span>
                </div>
                {view.issues.length === 0 ? (
                    <div data-issues-empty="" className="flex flex-col items-center gap-1 rounded-md border border-[var(--border-1)] p-10 text-center">
                        <Icon name="sparkles" size="md" />
                        <p className="text-[13px] font-semibold text-[var(--fg-1)]">No issues match</p>
                        <p className="text-[12px] text-[var(--fg-3)]">Try another filter, clear the search, or raise a new issue.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
                        {view.issues.map((i) => <IssueCard key={i.id} issue={i} onOpen={setOpen} />)}
                    </div>
                )}
            </div>
            {open === 'new' ? (
                <IssueForm key="new" view={view} issue={null} op={op} closing={null} onClosing={() => {}} onAction={onAction} onClose={() => setOpen(null)} onRetry={onRetry} />
            ) : open !== null && openIssue !== null ? (
                <IssueForm key={openIssue.id} view={view} issue={openIssue} op={op} closing={closing} onClosing={(a) => onClosing?.(a)} onAction={onAction} onClose={() => setOpen(null)} onRetry={onRetry} />
            ) : open !== null ? (
                <aside data-issue-form="missing" className="flex w-[380px] shrink-0 flex-col gap-2 border-l border-[var(--border-1)] p-3 text-[12px]">
                    <p className="font-semibold text-[var(--fg-1)]">Issue not found</p>
                    <p className="text-[var(--fg-3)]">This issue may have been deleted.</p>
                    <span><IconButton icon="x" label="Close" onClick={() => setOpen(null)} data={{ 'data-issue-close-form': '' }} /></span>
                </aside>
            ) : null}
        </div>
    );
}

/** An action that ends the form: a create, a delete, a conversion or a close closes it once it worked. */
const ENDS_FORM = /^issue\.(create|delete|convert|resolve|discard)$/;

/**
 * The tab: keeps the filters, reads the queue, acts and says so, and follows Tynn live — a ring asks what changed since
 * the cursor and redraws only that. A filter change reads again (it is a different queue).
 */
export function TynnIssuesTab({ workspaceId, host }: { workspaceId: string; host: TynnIssuesHost }) {
    const [filters, setFilters] = useState<IssueFilters>(() => normalizeIssueFilters({}));
    const [state, setState] = useState<TynnIssuesState>({ state: 'loading' });
    const [open, setOpen] = useState<string | null>(null);
    const [closing, setClosing] = useState<string | null>(null);
    const [op, setOp] = useState<IssueOp | null>(null);
    const [lastInput, setLastInput] = useState<IssueActionInput | null>(null);
    const [live, setLive] = useState<LiveState | undefined>(undefined);
    const cursorRef = useRef<string | null>(null);
    const filtersRef = useRef(filters);
    filtersRef.current = filters;
    const read = useCallback(async (at: IssueFilters) => {
        const r = await host.read(workspaceId, at);
        if (r.ok) { cursorRef.current = r.view.cursor; setState({ state: 'ready', view: r.view }); }
        else setState(r.state === 'not-linked' ? { state: 'not-linked' } : r.state === 'signed-out' ? { state: 'signed-out', reason: r.reason } : { state: 'error', reason: r.reason });
    }, [host, workspaceId]);
    useEffect(() => { void read(filters); }, [read, filters]);
    useEffect(() => {
        const { watch, changes } = host;
        if (!watch || !changes) return undefined;
        const follower = new BoardFollower<IssueChanges>({
            cursor: () => cursorRef.current,
            fetch: async (cursor, ids) => {
                const r = await changes(workspaceId, filtersRef.current, cursor, ids);
                return r.ok ? { ok: true, changes: r.changes } : { ok: false, state: r.state, reason: r.reason };
            },
            apply: (answer) => {
                cursorRef.current = answer.cursor;
                setState((s) => (s.state === 'ready' ? { ...s, view: applyIssueChanges(s.view, answer) } : s));
                return [];
            },
            refused: (refusal) => { if (refusal.state !== 'error') void read(filtersRef.current); },
            schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
        });
        const stop = watch(workspaceId, (signal) => {
            if ('state' in signal) setLive(signal.state);
            else follower.ring(signal.ring.ids, signal.ring.catchUp);
        });
        return () => { stop(); follower.stop(); setLive(undefined); };
    }, [host, workspaceId, read]);
    const act = async (input: IssueActionInput) => {
        setLastInput(input);
        const r = await performIssueAction(host, workspaceId, input, setOp);
        if (!r.ok && (r.state === 'not-linked' || r.state === 'signed-out')) {
            setState(r.state === 'not-linked' ? { state: 'not-linked' } : { state: 'signed-out', reason: r.reason });
            return;
        }
        if (r.ok && ENDS_FORM.test(input.action)) { setOpen(null); setClosing(null); }
        // Read again: a write lands in the queue as Tynn has it (a create among the newest, a close out of Open).
        if (r.ok) await read(filtersRef.current);
    };
    return (
        <TynnIssuesPanel
            state={state}
            onFilters={(next) => { setOp(null); setFilters(next); }}
            onAction={(input) => { void act(input); }}
            open={open}
            onOpen={(id) => { setOp(null); setClosing(null); setOpen(id); }}
            closing={closing}
            onClosing={setClosing}
            op={op}
            onRetry={lastInput ? () => { void act(lastInput); } : undefined}
            onRefresh={() => { void read(filters); }}
            live={live}
        />
    );
}
