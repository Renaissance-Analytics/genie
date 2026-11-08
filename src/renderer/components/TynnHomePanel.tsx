import { Button, Chart, Icon, Input, Progress, Select, Switch, Tabs, Textarea } from '@particle-academy/react-fancy';
import { useEffect, useState, type ReactNode } from 'react';
import type { LiveState } from '../../core/tynn-board.js';
import { HOME_RANGES, type ChartData, type HomeDashboard, type HomeDetails, type HomeSection, type HomeView, type TynnPageActionInput, type TynnPageQuery, type TynnPageState } from '../../core/tynn-pages.js';
import { LiveMark, OpLine } from './TynnBoardPanel.js';

/**
 * THE TYNN TAB'S HOME (genie#1295 row H1, workspace-ux 0.9.0 surface `home`) — tynn.ai's project Home
 * (Pages/v2/Project/Show.jsx), natively, on the same Fancy charts tynn.ai draws it with.
 *
 * Dashboard: the range (7/30/90 days) and version pickers; the verdict (will the version land?) with its progress, its
 * forecast/target/scope facts and its burndown; the rate of work; the versions side by side; throughput charts; what is
 * waiting (blocked, then QA) and the latest activity, with the story and task breakdowns.
 * Details: identity, vision and AI guidance (edited in place by a person who may manage the project), knowledge,
 * repositories, members, agents, the workflow settings (edited in place), pending approvals and related counts.
 * A save says it is running, then that it worked, or Tynn's reason with Retry. Tynn's text is drawn as text.
 */
export interface TynnHomePanelProps {
    readonly state: TynnPageState<HomeView>;
    readonly onQuery: (query: TynnPageQuery) => void;
    readonly onSave: (input: TynnPageActionInput) => void;
    readonly onRetry?: (() => void) | undefined;
    readonly live?: LiveState | undefined;
}

const TASK_STATUSES = [
    { key: 'backlog', label: 'Backlog', color: '#a1a1aa' }, { key: 'blocked', label: 'Blocked', color: '#f43f5e' },
    { key: 'doing', label: 'Doing', color: '#6366f1' }, { key: 'qa', label: 'QA', color: '#f59e0b' }, { key: 'done', label: 'Done', color: '#10b981' },
];
const STORY_STATUSES = [
    { key: 'backlog', label: 'Backlog', color: '#a1a1aa' }, { key: 'blocked', label: 'Blocked', color: '#f43f5e' },
    { key: 'in_progress', label: 'In Progress', color: '#6366f1' }, { key: 'qa', label: 'QA', color: '#f59e0b' }, { key: 'done', label: 'Done', color: '#10b981' },
];
const VERDICT_TONE: Readonly<Record<string, string>> = { on_track: 'text-[var(--success)]', complete: 'text-[var(--success)]', behind: 'text-[var(--warning)]' };
const VERSION_CHIP: Readonly<Record<string, string>> = { released: 'Shipped', active: 'Active', accepted: 'On deck' };
const CLAIM_TASKS = ['off', 'optional', 'required'];
const CLAIMANT_POLICIES = ['any', 'human', 'agent'];

const hasData = (c: ChartData) => c.labels.length > 0 && c.series.some((s) => s.data.some((v) => v > 0));
const withColors = (c: ChartData, colors: readonly string[]) => c.series.map((s, i) => ({ label: s.label, data: [...s.data], color: colors[i % colors.length] ?? '#10b981' }));
/** tynn.ai's thinLabels: drop the year, keep about eight labels (every point stays). */
function thinLabels(labels: readonly string[], max = 8): string[] {
    const short = labels.map((l) => l.replace(/^\d{4}-/, ''));
    if (short.length <= max) return short;
    const step = Math.ceil(short.length / max);
    return short.map((l, i) => (i % step === 0 || i === short.length - 1 ? l : ''));
}
/** A YYYY-MM-DD date as tynn.ai shows it (`Nov 10`), read as a calendar day, never shifted by the time zone. */
function shortDate(iso: string | null): string {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return iso;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const sum = (b: Readonly<Record<string, number>>) => Object.values(b).reduce((a, n) => a + n, 0);
const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function Panel({ title, note, children, data }: { title: string; note?: string | null; children: ReactNode; data?: Record<string, string> }) {
    return (
        <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-3" {...data}>
            <div className="flex items-center gap-2"><h3 className="text-[12px] font-semibold text-[var(--fg-1)]">{title}</h3>{note ? <span className="text-[11px] text-[var(--fg-3)]">{note}</span> : null}</div>
            {children}
        </section>
    );
}
const Empty = ({ children }: { children: ReactNode }) => <p className="py-4 text-center text-[12px] text-[var(--fg-3)]">{children}</p>;
const Eyebrow = ({ label, aside }: { label: string; aside?: string }) => (
    <div className="mt-2 flex items-center gap-2 text-[10px] font-semibold tracking-wide text-[var(--fg-3)] uppercase"><span>{label}</span><span className="h-px flex-1 bg-[var(--border-1)]" />{aside ? <span className="font-normal normal-case">{aside}</span> : null}</div>
);
const Fact = ({ label, value, warn = false }: { label: string; value: ReactNode; warn?: boolean }) => (
    <div className="min-w-0"><div className={`text-[15px] font-semibold ${warn ? 'text-[var(--warning)]' : 'text-[var(--fg-1)]'}`}>{value}</div><div className="text-[10px] text-[var(--fg-3)]">{label}</div></div>
);

function Bar({ label, done, total }: { label: string; done: number; total: number }) {
    return (
        <div className="min-w-0">
            <div className="flex justify-between text-[11px] text-[var(--fg-2)]"><span>{label}</span><b>{`${done} / ${total}`}</b></div>
            <Progress value={done} max={Math.max(total, 1)} size="sm" />
        </div>
    );
}

function Donut({ data, statuses, empty }: { data: Readonly<Record<string, number>>; statuses: typeof TASK_STATUSES; empty: string }) {
    const slices = statuses.map((s) => ({ label: s.label, value: data[s.key] ?? 0, color: s.color })).filter((s) => s.value > 0);
    return slices.length === 0 ? <Empty>{empty}</Empty> : <Chart.Donut data={slices} size={150} strokeWidth={16} showLegend />;
}

/** Pills that pick one of a few (the section, the range): react-fancy Tabs, never Buttons pretending to be a menu. */
function Pills({ label, value, items, attr, onPick }: { label: string; value: string; items: ReadonlyArray<{ value: string; label: string }>; attr: string; onPick: (v: string) => void }) {
    return (
        <Tabs activeTab={value} onTabChange={onPick} variant="pills">
            <Tabs.List aria-label={label} className="gap-1 bg-transparent p-0 dark:bg-transparent">
                {items.map((i) => (
                    <Tabs.Tab key={i.value} value={i.value} {...{ [attr]: i.value }} className={`rounded-md px-2.5 py-1 text-[12px] shadow-none ${i.value === value ? 'bg-[var(--bg-2)] font-medium text-[var(--fg-1)] dark:bg-[var(--bg-2)] dark:text-[var(--fg-1)]' : 'font-normal text-[var(--fg-3)] hover:bg-[var(--bg-2)] dark:text-[var(--fg-3)]'}`}>
                        {i.label}
                    </Tabs.Tab>
                ))}
            </Tabs.List>
        </Tabs>
    );
}

function verdictLine(f: NonNullable<HomeDashboard['version']>['forecast'], velocity: number): string {
    if (f.tone === 'complete') return 'Every task in this version is done.';
    return [
        `${f.remaining} ${f.remaining === 1 ? 'task' : 'tasks'} left`,
        velocity > 0 ? ` at the current ${velocity} / day` : '',
        f.daysDelta !== null && f.targetDate ? (f.daysDelta === 0 ? ` — landing exactly on the ${shortDate(f.targetDate)} target.` : ` — ${Math.abs(f.daysDelta)} ${Math.abs(f.daysDelta) === 1 ? 'day' : 'days'} ${f.daysDelta > 0 ? 'inside' : 'past'} the ${shortDate(f.targetDate)} target.`) : '',
        f.daysDelta === null && f.tone === 'no_target' ? ' — no target date is set for this version.' : '',
        f.daysDelta === null && f.tone === 'unknown' ? ' — no completed work yet, so there is nothing to forecast from.' : '',
    ].join('');
}

function Dashboard({ d, onQuery }: { d: HomeDashboard; onQuery: TynnHomePanelProps['onQuery'] }) {
    const v = d.version;
    const f = v?.forecast;
    const velocity = Number(d.metrics.velocity_avg ?? d.metrics.velocity ?? 0);
    const trend = d.metrics.velocity_trend;
    const change = d.metrics.velocity_change_percent;
    const daily = d.charts.velocity.series[0]?.data ?? [];
    const query = (over: TynnPageQuery) => onQuery({ section: 'dashboard', range: String(d.range), ...(v ? { version: v.id } : {}), ...over });
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <Pills label="Period" value={String(d.range)} items={HOME_RANGES.map((r) => ({ value: r, label: `${r} days` }))} attr="data-home-range" onPick={(r) => query({ range: r })} />
                <span className="flex-1" />
                {d.versions.length > 0 ? (
                    <span data-home-version="" className="min-w-48">
                        <Select aria-label="Version" value={v?.id ?? d.versions[0]!.id} onValueChange={(id) => query({ version: id })} list={d.versions.map((x) => ({ value: x.id, label: `v${x.number ?? ''} — ${x.title || 'Untitled'}` }))} />
                    </span>
                ) : null}
            </div>

            <Eyebrow label={v ? `Will v${v.number ?? ''} land?` : 'Delivery'} aside={v?.window.endsAt ? `target ${shortDate(v.window.endsAt)}` : 'no target set'} />
            {v && f ? (
                <div data-home-verdict="" className="grid gap-4 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-3 md:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-2">
                        <span className={`text-[11px] font-medium ${VERDICT_TONE[f.tone] ?? 'text-[var(--fg-3)]'}`}>{f.label}</span>
                        <h2 className="text-[18px] font-semibold text-[var(--fg-1)]">{f.tone === 'complete' ? 'All work delivered' : f.etaDate ? `Lands ${shortDate(f.etaDate)}` : 'No forecast yet'}</h2>
                        <p className="text-[12px] text-[var(--fg-2)]">{verdictLine(f, velocity)}</p>
                        <Bar label="Tasks" done={v.completedTasks} total={v.totalTasks} />
                        <Bar label="Stories" done={v.completedStories} total={v.totalStories} />
                        <div className="grid grid-cols-3 gap-2">
                            <Fact label="Forecast" value={f.etaDate ? shortDate(f.etaDate) : '—'} />
                            <Fact label="Target" value={v.window.endsAt ? shortDate(v.window.endsAt) : '—'} />
                            <Fact label="Scope added" value={v.creep?.addedAfter ? `+${v.creep.addedAfter}` : '—'} warn={(v.creep?.addedAfter ?? 0) > 0} />
                        </div>
                    </div>
                    <div className="min-w-0">
                        <div className="text-[12px] font-semibold text-[var(--fg-1)]">Burndown</div>
                        <div className="text-[11px] text-[var(--fg-3)]">Remaining work against the scope it is measured from.</div>
                        {hasData(v.burndown)
                            ? <Chart.Line labels={thinLabels(v.burndown.labels)} series={withColors(v.burndown, ['#f43f5e', '#a1a1aa', '#71717a', '#10b981'])} height={210} curve="monotone" showDots={false} xAxis={{ tickCount: 6 }} yAxis grid={{ horizontal: true, vertical: false }} tooltip responsive />
                            : <Empty>Burndown begins once the version is activated and work starts.</Empty>}
                    </div>
                </div>
            ) : <Panel title="Delivery"><Empty>Activate a version to forecast a delivery date.</Empty></Panel>}

            <Eyebrow label="Rate of work" aside={`last ${d.range} days`} />
            <div data-home-rate="" className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-3 md:grid-cols-4">
                <Fact label="Velocity · tasks / day" value={<span className="inline-flex items-center gap-1">{d.metrics.velocity ?? 0}{trend && trend !== 'stable' && typeof change === 'number' ? <span className={`inline-flex items-center text-[10px] ${trend === 'up' ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}><Icon name={trend === 'up' ? 'trending-up' : 'trending-down'} size="xs" />{`${Math.abs(Math.round(change))}%`}</span> : null}</span>} />
                <Fact label="Cycle time · story start → done" value={v?.cycleTimeDays != null ? `${v.cycleTimeDays} d` : '—'} />
                <Fact label={v?.creep ? `Scope change · ${v.creep.atActivation} at activation` : 'Scope change'} value={v?.creep?.addedAfter != null ? `+${v.creep.addedAfter}` : '—'} warn={(v?.creep?.addedAfter ?? 0) > 0} />
                <Fact label={`Corrections · last ${d.range} days`} value={d.metrics.corrections ?? 0} />
                {daily.some((n) => n > 0) ? <div className="col-span-full"><Chart.Sparkline data={[...daily]} width={280} height={28} color="#10b981" className="w-full" /></div> : null}
            </div>

            {d.comparison.length > 0 ? (
                <>
                    <Eyebrow label="Versions" aside="shipped · active · on deck" />
                    <div data-home-comparison="" className="overflow-x-auto rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)]">
                        <table className="w-full text-[12px]">
                            <thead><tr><th />{d.comparison.map((r) => <th key={r.id} className="p-2 text-left font-normal"><span className="block text-[10px] text-[var(--fg-3)]">{VERSION_CHIP[r.status] ?? r.status}</span><b>{`v${text(r.number)}`}</b> <span className="text-[var(--fg-3)]">{text(r.title) || 'Untitled'}</span></th>)}</tr></thead>
                            <tbody>
                                {([
                                    ['Tasks', (r) => `${text(r.tasks_done) || '0'} / ${text(r.tasks_total) || '0'}`],
                                    ['Stories', (r) => `${text(r.stories_done) || '0'} / ${text(r.stories_total) || '0'}`],
                                    ['Scope change', (r) => (typeof r.scope_added === 'number' ? (r.scope_added > 0 ? `+${r.scope_added}` : String(r.scope_added)) : '—')],
                                    ['Cycle time', (r) => (typeof r.cycle_time_days === 'number' ? `${r.cycle_time_days} d` : '—')],
                                    ['Window', (r) => (r.starts_at || r.ends_at ? `${r.starts_at ? shortDate(text(r.starts_at)) : '—'} → ${r.ends_at ? shortDate(text(r.ends_at)) : '—'}` : '—')],
                                ] as Array<[string, (r: Readonly<Record<string, unknown>>) => string]>).map(([label, cell]) => (
                                    <tr key={label} className="border-t border-[var(--border-1)]"><td className="p-2 text-[var(--fg-3)]">{label}</td>{d.comparison.map((r) => <td key={r.id} className={`p-2 ${r.status === 'active' ? 'bg-[var(--accent)]/5' : ''}`}>{cell(r)}</td>)}</tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            ) : null}

            <Eyebrow label="Throughput" />
            <div className="grid gap-3 md:grid-cols-2">
                <Panel title="Tasks closed per day" note={d.metrics.velocity_avg != null ? `avg ${d.metrics.velocity_avg}` : null}>
                    {hasData(d.charts.velocity) ? <Chart.Line labels={thinLabels(d.charts.velocity.labels)} series={withColors(d.charts.velocity, ['#10b981', '#6366f1'])} height={190} curve="monotone" showDots={false} fill fillOpacity={0.14} xAxis={{ tickCount: 6 }} yAxis grid={{ horizontal: true, vertical: false }} tooltip responsive /> : <Empty>Velocity fills in as tasks are completed.</Empty>}
                </Panel>
                <Panel title="Agent activity">
                    {hasData(d.charts.agentActivity) ? <Chart.Area labels={thinLabels(d.charts.agentActivity.labels)} series={withColors(d.charts.agentActivity, ['#06b6d4', '#f59e0b'])} height={190} curve="monotone" showDots={false} xAxis={{ tickCount: 6 }} yAxis grid={{ horizontal: true, vertical: false }} tooltip responsive /> : <Empty>Agent activity appears here as agents create and complete work.</Empty>}
                </Panel>
            </div>

            <Eyebrow label="What moved · what's waiting" />
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Panel title="Recent activity" data={{ 'data-home-activity': '' }}>
                    {d.activity.length === 0 ? <Empty>No recent activity.</Empty> : (
                        <ul className="flex flex-col gap-2">
                            {d.activity.map((a) => (
                                <li key={a.id} className="text-[12px]">
                                    <span className={`font-medium ${a.agent ? 'text-[var(--accent)]' : 'text-[var(--fg-1)]'}`}>{a.actor}</span>{' '}<span className="text-[var(--fg-2)]">{a.action}</span>
                                    {a.subject ? <div className="text-[11px] text-[var(--fg-3)]">{a.subject}</div> : null}
                                    {a.when ? <div className="text-[10px] text-[var(--fg-3)]">{a.when}</div> : null}
                                </li>
                            ))}
                        </ul>
                    )}
                </Panel>
                <div className="flex min-w-0 flex-col gap-3">
                    <Panel title="Waiting on you" note={d.attention.length > 0 ? String(d.attention.length) : null} data={{ 'data-home-attention': '' }}>
                        {d.attention.length === 0 ? <Empty>Nothing is blocked or waiting on review.</Empty> : (
                            <ul className="flex flex-col gap-1">
                                {d.attention.map((s) => (
                                    <li key={s.id} className="flex items-center gap-2 text-[12px]">
                                        <Icon name={s.status === 'blocked' ? 'octagon-alert' : 'clipboard-check'} size="sm" />
                                        <span className="min-w-0 flex-1"><span className="block truncate text-[var(--fg-1)]">{s.title}</span><span className="text-[11px] text-[var(--fg-3)]">{`${s.status === 'blocked' ? 'Blocked' : 'QA review'}${s.openTasks > 0 ? ` · ${s.openTasks} open ${s.openTasks === 1 ? 'task' : 'tasks'}` : ''}`}</span></span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Panel>
                    <Panel title="Stories · all versions" note={`${sum(d.storyBreakdown)} total`}><Donut data={d.storyBreakdown} statuses={STORY_STATUSES} empty="No stories yet." /></Panel>
                    <Panel title="Tasks by status" note={`${sum(d.taskBreakdown)} total`}><Donut data={d.taskBreakdown} statuses={TASK_STATUSES} empty="No tasks yet." /></Panel>
                    <Panel title="Activity" note={`${d.sparkline.reduce((a, b) => a + b, 0)} events · 14d`}>
                        {d.sparkline.some((n) => n > 0) ? <Chart.Sparkline data={[...d.sparkline]} width={280} height={44} color="#10b981" className="w-full" /> : <Empty>No activity in the last 14 days.</Empty>}
                    </Panel>
                </div>
            </div>
        </div>
    );
}

/** A text field shown as text, and edited in place by a person who may manage the project. */
function Editable({ field, title, value, canEdit, busy, onSave }: { field: 'vision' | 'ai_guidance'; title: string; value: string; canEdit: boolean; busy: boolean; onSave: TynnHomePanelProps['onSave'] }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);
    useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
    return (
        <Panel title={title} data={{ 'data-home-field': field }}>
            {editing ? (
                <form onSubmit={(e) => { e.preventDefault(); onSave({ action: 'details.update', body: { [field]: draft } }); setEditing(false); }} className="flex flex-col gap-2">
                    <Textarea aria-label={title} rows={6} value={draft} onValueChange={setDraft} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                        <Button type="submit" size="xs" icon="check" data-tynn-submit="" disabled={busy}>Save</Button>
                    </div>
                </form>
            ) : (
                <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 text-[12px] whitespace-pre-wrap text-[var(--fg-2)]">{value || 'Not set yet.'}</p>
                    {canEdit ? <Button type="button" size="xs" variant="ghost" icon="pencil" data-home-edit={field} aria-label={`Edit ${title}`} title={`Edit ${title}`} disabled={busy} onClick={() => setEditing(true)} /> : null}
                </div>
            )}
        </Panel>
    );
}

const KNOWLEDGE_LABEL: Readonly<Record<string, string>> = {
    personas: 'Personas', strategic_themes: 'Strategic themes', constraints: 'Constraints', risk_register: 'Risks', technologies: 'Technologies',
    scripts: 'Scripts', integration_catalog: 'Integrations', servers: 'Servers', design_tokens: 'Design tokens',
};
/** A knowledge row as one line: a string, or the first of its telling keys. */
function rowText(r: unknown): string {
    if (typeof r === 'string') return r;
    if (typeof r !== 'object' || r === null) return String(r ?? '');
    const o = r as Record<string, unknown>;
    const main = ['name', 'risk', 'description', 'environment', 'command'].map((k) => o[k]).find((v) => typeof v === 'string' && v !== '') as string | undefined;
    const extra = ['role', 'severity', 'version', 'host', 'value', 'kind'].map((k) => o[k]).find((v) => typeof v === 'string' && v !== '') as string | undefined;
    return [main ?? JSON.stringify(o), extra].filter(Boolean).join(' · ');
}

function Workflow({ d, busy, onSave }: { d: HomeDetails; busy: boolean; onSave: TynnHomePanelProps['onSave'] }) {
    const w = d.workflow;
    const save = (body: Record<string, unknown>) => onSave({ action: 'details.update', body });
    const [max, setMax] = useState(String(w.maxActiveVersions));
    useEffect(() => { setMax(String(w.maxActiveVersions)); }, [w.maxActiveVersions]);
    const off = !d.canEdit || busy;
    const row = (label: string, field: string, control: ReactNode) => <div data-home-workflow={field} className="flex items-center justify-between gap-3 text-[12px] text-[var(--fg-2)]"><span>{label}</span>{control}</div>;
    const patterns = w.patterns.length > 0 ? w.patterns : [{ key: w.versioningPattern, label: w.versioningPattern }];
    return (
        <Panel title="Workflow" data={{ 'data-home-section-workflow': '' }}>
            {row('Versioning', 'versioning_pattern', <Select aria-label="Versioning" disabled={off} value={w.versioningPattern} onValueChange={(v) => save({ versioning_pattern: v })} list={patterns.map((p) => ({ value: p.key, label: p.label }))} />)}
            {row('Active versions at once', 'max_active_versions', <Input aria-label="Active versions at once" type="number" min={1} max={25} disabled={off} value={max} onValueChange={setMax} onBlur={() => { const n = Number(max); if (Number.isInteger(n) && n !== w.maxActiveVersions) save({ max_active_versions: n }); }} className="w-16" />)}
            {row('Auto-number versions', 'auto_version_number', <Switch aria-label="Auto-number versions" disabled={off} checked={w.autoVersionNumber} onCheckedChange={(on) => save({ auto_version_number: on })} />)}
            {row('Feature locking', 'feature_locking', <Switch aria-label="Feature locking" disabled={off} checked={w.featureLocking} onCheckedChange={(on) => save({ feature_locking: on })} />)}
            {row('Claim tasks', 'claim_tasks', <Select aria-label="Claim tasks" disabled={off} value={w.claimTasks} onValueChange={(v) => save({ claim_tasks: v })} list={CLAIM_TASKS.map((m) => ({ value: m, label: m }))} />)}
            {row('Who may claim', 'claimant_policy', <Select aria-label="Who may claim" disabled={off} value={w.claimantPolicy} onValueChange={(v) => save({ claimant_policy: v })} list={CLAIMANT_POLICIES.map((m) => ({ value: m, label: m }))} />)}
        </Panel>
    );
}

function Details({ d, busy, onSave }: { d: HomeDetails; busy: boolean; onSave: TynnHomePanelProps['onSave'] }) {
    const id = d.identity;
    const knowledge = Object.entries(d.knowledge).filter(([, rows]) => rows.length > 0);
    return (
        <div data-home-details="" className="grid gap-3 md:grid-cols-2">
            <Panel title="Overview">
                <div className="grid grid-cols-2 gap-2 text-[12px]">
                    <div><div className="text-[10px] text-[var(--fg-3)]">Name</div><div className="text-[var(--fg-1)]">{text(id.name)}</div></div>
                    <div><div className="text-[10px] text-[var(--fg-3)]">Status</div><div className="text-[var(--fg-1)] capitalize">{text(id.status)}</div></div>
                    <div><div className="text-[10px] text-[var(--fg-3)]">Owner</div><div className="text-[var(--fg-1)]">{[text(id.owner_name), text(id.owner_type)].filter(Boolean).join(' · ')}</div></div>
                    <div><div className="text-[10px] text-[var(--fg-3)]">Visibility</div><div className="text-[var(--fg-1)]">{text(id.visibility)}</div></div>
                    <div className="col-span-2"><div className="text-[10px] text-[var(--fg-3)]">MCP</div><div className="font-mono text-[11px] text-[var(--fg-1)]">{[text(id.mcp_slug), text(id.mcp_url)].filter(Boolean).join(' · ')}</div></div>
                </div>
                <div className="grid grid-cols-3 gap-2 border-t border-[var(--border-1)] pt-2">
                    <Fact label="Versions" value={d.related.versions} />
                    <Fact label="Stories done" value={`${d.related.counts.stories_done ?? 0}/${d.related.counts.stories ?? 0}`} />
                    <Fact label="Tasks done" value={`${d.related.counts.tasks_done ?? 0}/${d.related.counts.tasks ?? 0}`} />
                    <Fact label="Features" value={d.related.counts.features ?? 0} />
                    <Fact label="Issues" value={d.related.counts.issues ?? 0} />
                </div>
            </Panel>
            <Workflow d={d} busy={busy} onSave={onSave} />
            <Editable field="vision" title="Vision" value={d.vision} canEdit={d.canEdit} busy={busy} onSave={onSave} />
            <Editable field="ai_guidance" title="AI guidance" value={d.aiGuidance} canEdit={d.canEdit} busy={busy} onSave={onSave} />
            <Panel title="Knowledge" data={{ 'data-home-knowledge': '' }}>
                {knowledge.length === 0 ? <Empty>No knowledge recorded yet.</Empty> : knowledge.map(([k, rows]) => (
                    <div key={k}><div className="text-[10px] font-semibold tracking-wide text-[var(--fg-3)] uppercase">{KNOWLEDGE_LABEL[k] ?? k}</div><ul className="text-[12px] text-[var(--fg-2)]">{rows.map((r, i) => <li key={i}>{rowText(r)}</li>)}</ul></div>
                ))}
            </Panel>
            <Panel title="Repositories" note={String(d.repositories.length)}>
                {d.repositories.length === 0 ? <Empty>No repositories linked.</Empty> : <ul className="text-[12px]">{d.repositories.map((r, i) => <li key={text(r.id) || i} className="flex items-center gap-2"><Icon name="git-branch" size="xs" /><span className="text-[var(--fg-1)]">{text(r.short) || text(r.url)}</span>{r.is_primary === true ? <span className="text-[10px] text-[var(--fg-3)]">primary</span> : null}<span className="text-[10px] text-[var(--fg-3)]">{text(r.default_branch)}</span></li>)}</ul>}
            </Panel>
            <Panel title="Members" note={String(d.members.length)}>
                {d.members.length === 0 ? <Empty>No members.</Empty> : <ul className="text-[12px]">{d.members.map((m, i) => <li key={text(m.id) || i} className="flex items-center gap-2"><span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg-2)] text-[9px] font-semibold">{text(m.initials)}</span><span className="text-[var(--fg-1)]">{text(m.name)}</span><span className="text-[10px] text-[var(--fg-3)]">{text(m.role)}</span></li>)}</ul>}
            </Panel>
            <Panel title="Agents" note={String(d.agents.length)}>
                {d.agents.length === 0 ? <Empty>No agents yet.</Empty> : <ul className="text-[12px]">{d.agents.map((a, i) => <li key={text(a.id) || i} className="flex items-center gap-2"><Icon name="bot" size="xs" /><span className="text-[var(--fg-1)]">{text(a.name)}</span><span className="text-[10px] text-[var(--fg-3)]">{text(a.persona_role)}</span><span className="text-[10px] text-[var(--fg-3)]">{text(a.status)}</span></li>)}</ul>}
            </Panel>
            <Panel title="Approvals" note={d.approvals.length > 0 ? String(d.approvals.length) : null}>
                {d.approvals.length === 0 ? <Empty>Nothing waiting for approval.</Empty> : <ul className="text-[12px]">{d.approvals.map((a, i) => <li key={text(a.id) || i} className="flex items-center gap-2"><Icon name="shield-check" size="xs" /><span className="text-[var(--fg-1)]">{[text(a.surface), text(a.action)].filter(Boolean).join(' ')}</span><span className="text-[var(--fg-2)]">{text(a.subject_label)}</span><span className="text-[10px] text-[var(--fg-3)]">{text(a.created_at)}</span></li>)}</ul>}
            </Panel>
        </div>
    );
}

const SECTIONS: ReadonlyArray<{ value: HomeSection; label: string }> = [{ value: 'dashboard', label: 'Dashboard' }, { value: 'details', label: 'Details' }];

export function TynnHomePanel({ state, onQuery, onSave, onRetry, live }: TynnHomePanelProps) {
    if (state.state !== 'ready') {
        const line = state.state === 'loading' ? <><Icon name="loader" size="xs" className="animate-spin" /> Reading Tynn…</> : state.state === 'not-linked' ? 'This workspace has no Tynn project.' : state.reason;
        return <p data-tynn-page-state={state.state} className="flex items-center gap-1.5 p-4 text-[12px] text-[var(--fg-3)]">{line}</p>;
    }
    const { view, op = null } = state;
    const busy = op?.action === 'details.update' && op.phase === 'running';
    return (
        <div data-tynn-page="home" className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
            <div className="flex items-center gap-1">
                <Pills label="Home" value={view.section} items={SECTIONS} attr="data-home-section" onPick={(s) => onQuery({ section: s })} />
                <span className="flex-1" />
                <LiveMark live={live} />
            </div>
            {op ? <OpLine op={op} onRetry={op.phase === 'failed' ? onRetry : undefined} /> : null}
            {view.section === 'dashboard' && view.dashboard ? <Dashboard d={view.dashboard} onQuery={onQuery} /> : null}
            {view.section === 'details' && view.details ? <Details d={view.details} busy={busy} onSave={onSave} /> : null}
        </div>
    );
}
