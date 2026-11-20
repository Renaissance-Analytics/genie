import { Button, ContentRenderer, Icon, Sidebar } from '@particle-academy/react-fancy';
import { SLICE_STATE_LABEL, type SliceState } from '../../core/slice-state.js';
import { startPlan, type BoardActionInput, type BoardClaims, type LiveState } from '../../core/tynn-board.js';
import { WIP_LENSES, wipRef, wipWhen, type TynnPageState, type WipLens, type WipStory, type WipTask, type WipView } from '../../core/tynn-pages.js';
import { genieClipboardWriter } from '../clipboard.js';
import { Avatar, LiveMark, OpLine } from './TynnBoardPanel.js';

/**
 * THE TYNN TAB'S WIP (genie#1295 row W1, workspace-ux 0.6.0) — tynn.ai's WIP page, natively.
 *
 * The same page as tynn.ai's (Pages/v2/Project/Wip.jsx): the active version's banner with its story progress; a rail
 * with the Active / Attention / Done lens chips and their counts, and the lens's stories; the chosen story's
 * description and its tasks, the ones in motion first, each with its ONE next step inline (an icon named for what it
 * does, held back by the web page's own guard with its reason). The Done lens lists what the version delivered. A step
 * says it is running, then that it worked — or Tynn's reason, with Retry. Titles and descriptions are Tynn's text,
 * drawn as text, never as markup.
 */

export interface TynnWipPanelProps {
    readonly state: TynnPageState<WipView>;
    readonly onLens: (lens: WipLens) => void;
    readonly onStory: (slug: string) => void;
    readonly onAction: (input: BoardActionInput) => void;
    readonly onRetry?: (() => void) | undefined;
    readonly live?: LiveState | undefined;
    /** The version the person asked for (an id); when Tynn's answer is about another, the pane says so. */
    readonly version?: string | undefined;
    readonly onVersion?: ((id: string) => void) | undefined;
    /** The clock for "3 h ago" (tests pass one). */
    readonly now?: number | undefined;
}

const LENS_LOOK: Readonly<Record<WipLens, { icon: string; label: string }>> = {
    active: { icon: 'circle-play', label: 'Active' },
    attention: { icon: 'triangle-alert', label: 'Attention' },
    done: { icon: 'check', label: 'Done' },
};

const STATUS_LOOK: Readonly<Record<string, { label: string; className: string }>> = {
    in_progress: { label: 'In Progress', className: 'bg-[var(--accent)]/15 text-[var(--accent)]' },
    doing: { label: 'Doing', className: 'bg-[var(--accent)]/15 text-[var(--accent)]' },
    qa: { label: 'QA', className: 'bg-[var(--warning)]/15 text-[var(--warning)]' },
    blocked: { label: 'Blocked', className: 'bg-[var(--danger,var(--warning))]/15 text-[var(--danger,var(--warning))]' },
    backlog: { label: 'Backlog', className: 'bg-[var(--bg-2)] text-[var(--fg-3)]' },
    done: { label: 'Done', className: 'bg-[var(--success)]/15 text-[var(--success)]' },
};

/** A story is a Slice (Tynn #933): its chip is its Slice state, in the colour its legacy status had. Tasks keep StatusChip. */
const SLICE_LOOK: Readonly<Record<SliceState, string>> = {
    proposed: STATUS_LOOK.backlog!.className, ready: STATUS_LOOK.backlog!.className, running: STATUS_LOOK.in_progress!.className,
    awaiting_review: STATUS_LOOK.qa!.className, accepted: STATUS_LOOK.done!.className, blocked: STATUS_LOOK.blocked!.className,
    rejected: STATUS_LOOK.blocked!.className, failed: STATUS_LOOK.blocked!.className, cancelled: STATUS_LOOK.backlog!.className,
};

function SliceChip({ status, state }: { status: string; state: SliceState | null }) {
    if (state === null) return null;
    return <span data-wip-status={status} data-wip-state={state} className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${SLICE_LOOK[state]}`}>{SLICE_STATE_LABEL[state]}</span>;
}

function StatusChip({ status }: { status: string }) {
    const look = STATUS_LOOK[status];
    if (!look) return null;
    return <span data-wip-status={status} className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${look.className}`}>{look.label}</span>;
}

function Bar({ done, total }: { done: number; total: number }) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return <span className="inline-block h-1 w-16 overflow-hidden rounded bg-[var(--bg-2)]"><i className="block h-full bg-[var(--accent)]" style={{ width: `${pct}%` }} /></span>;
}

function Versions({ view, version, onVersion }: { view: WipView; version: string | undefined; onVersion: TynnWipPanelProps['onVersion'] }) {
    if (view.versions.length < 2) return null;
    const chosen = version ?? view.version?.id;
    return (
        <div role="group" aria-label="Active versions" data-wip-versions="" className="flex flex-wrap items-center gap-1 border-b border-[var(--border-1)] px-3 py-1.5">
            {view.versions.map((v) => {
                const on = v.id === chosen;
                return (
                    <Button variant="ghost" size="xs" labelClassName="contents"
                        key={v.id}
                        type="button"
                        data-wip-version={v.id}
                        aria-pressed={on}
                        title={v.title}
                        onClick={() => onVersion?.(v.id)}
                        className={`inline-flex min-w-0 items-center justify-start gap-1.5 rounded-md px-2 py-1 text-[11px] ${on ? 'bg-[var(--accent)] text-[var(--accent-fg,white)]' : 'text-[var(--fg-2)] hover:bg-[var(--bg-2)]'}`}
                    >
                        <Icon name="circle-play" size="xs" />
                        <span className="font-mono">{v.number ?? ''}</span>
                        <span className="max-w-[160px] truncate">{v.title}</span>
                        {v.total !== null ? <span data-wip-version-progress="" className="text-[10px] opacity-80">{`${v.done ?? 0}/${v.total}`}</span> : null}
                    </Button>
                );
            })}
        </div>
    );
}

function Banner({ view, live }: { view: WipView; live: LiveState | undefined }) {
    return (
        <div data-wip-banner="" className="flex flex-wrap items-center gap-2 border-b border-[var(--border-1)] px-3 py-2 text-[12px]">
            {view.version ? (
                <>
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]"><Icon name="circle-play" size="xs" /> Active</span>
                    <span className="font-mono text-[var(--fg-2)]">{view.version.number}</span>
                    <span className="min-w-0 truncate font-medium text-[var(--fg-1)]">{view.version.title}</span>
                    {view.progress.total > 0 ? (
                        <>
                            <span className="inline-block h-1.5 w-32 overflow-hidden rounded bg-[var(--bg-2)]"><i className="block h-full bg-[var(--accent)]" style={{ width: `${view.progress.percent}%` }} /></span>
                            <span className="text-[var(--fg-3)]">{`${view.progress.done} / ${view.progress.total} stories`}</span>
                        </>
                    ) : null}
                </>
            ) : (
                <span data-wip-state="no-active-version" className="rounded-full bg-[var(--bg-2)] px-2 py-0.5 text-[10px] text-[var(--fg-3)]">No active version</span>
            )}
            <span className="ml-auto"><LiveMark live={live} /></span>
        </div>
    );
}

/** A list card's last line: the PR (a chip, not a link: the card is itself a button) and when the story last changed. */
function CardMeta({ story, now }: { story: WipStory; now: number }) {
    const pr = wipRef(story.pr, story.prUrl);
    const when = wipWhen(story.updatedAt, now);
    if (pr === null && when === null) return null;
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-[var(--fg-3)]">
            {pr ? <span data-wip-card-pr="" className="inline-flex items-center gap-0.5 rounded-full bg-[var(--bg-2)] px-1.5 font-mono"><Icon name="git-pull-request" size="xs" />{pr.label}</span> : null}
            {when ? <time data-wip-card-changed="" dateTime={story.updatedAt ?? undefined}>{when}</time> : null}
        </span>
    );
}

function Rail({ view, onLens, onStory, now }: { view: WipView; onLens: TynnWipPanelProps['onLens']; onStory: TynnWipPanelProps['onStory']; now: number }) {
    return (
        <Sidebar embedded className="w-[300px] shrink-0 gap-1 overflow-y-auto border-r border-[var(--border-1)] p-2">
            <div role="group" aria-label="Lens" className="mb-1 flex gap-1">
                {(Object.keys(WIP_LENSES) as WipLens[]).map((lens) => {
                    const look = LENS_LOOK[lens];
                    const on = view.lens === lens;
                    return (
                        <Button variant="ghost" size="xs" labelClassName="contents"
                            key={lens}
                            type="button"
                            data-wip-lens={lens}
                            aria-pressed={on}
                            aria-label={look.label}
                            title={look.label}
                            onClick={() => onLens(lens)}
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${on ? 'bg-[var(--accent)] text-[var(--accent-fg,white)]' : 'text-[var(--fg-2)] hover:bg-[var(--bg-2)]'}`}
                        >
                            <Icon name={look.icon} size="xs" />
                            <span data-wip-count={lens} className={`rounded-full px-1.5 text-[10px] font-semibold ${on ? '' : 'bg-[var(--bg-2)] text-[var(--fg-3)]'}`}>{view.counts[lens]}</span>
                        </Button>
                    );
                })}
            </div>
            {view.stories.length === 0 ? (
                <p data-wip-state="empty-lens" className="px-2 py-5 text-center text-[12px] text-[var(--fg-4,var(--fg-3))]">
                    {view.lens === 'attention' ? 'Nothing needs attention.' : 'No stories in this view.'}
                </p>
            ) : view.stories.map((story, i) => {
                const prev = view.stories[i - 1];
                const backlogStarts = view.lens === 'active' && prev?.status === 'in_progress' && story.status === 'backlog';
                const selected = view.selected?.id === story.id;
                return (
                    <div key={story.id}>
                        {backlogStarts ? <div className="mt-3 mb-1 px-2 text-[10px] font-semibold tracking-wide text-[var(--fg-3)] uppercase">Backlog</div> : null}
                        <Sidebar.Item
                            data-wip-story={story.id}
                            active={selected}
                            onClick={() => onStory(story.slug)}
                            className={`flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left ${selected ? 'bg-[var(--bg-2)]' : 'hover:bg-[var(--bg-2)]'}`}
                        >
                            <span className="flex min-w-0 flex-col gap-1 whitespace-normal">
                                <span className="flex items-center gap-1.5"><span className="font-mono text-[10px] text-[var(--fg-3)]">{story.number}</span><SliceChip status={story.status} state={story.state} /></span>
                                <span className="text-[12px] text-[var(--fg-1)]">{story.title}</span>
                                {story.progress ? <span className="flex items-center gap-1.5 text-[10px] text-[var(--fg-3)]"><Bar done={story.tasksDone} total={story.taskCount} />{story.progress}</span> : null}
                                <CardMeta story={story} now={now} />
                            </span>
                        </Sidebar.Item>
                    </div>
                );
            })}
        </Sidebar>
    );
}

function StepButton({ icon, label, title, disabled, step, onClick }: { icon: string; label: string; title: string; disabled: boolean; step: string; onClick: () => void }) {
    return (
        <Button variant="ghost" size="xs" labelClassName="contents"
            type="button"
            data-tynn-step={step}
            aria-label={label}
            title={title}
            disabled={disabled}
            onClick={onClick}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-[var(--border-1)] px-2 py-1 text-[11px] text-[var(--fg-1)] hover:bg-[var(--bg-2)] disabled:opacity-40"
        >
            <Icon name={icon} size="xs" />
        </Button>
    );
}

function TaskCard({ task, claims, onAction, now }: { task: WipTask; claims: BoardClaims | null; onAction: TynnWipPanelProps['onAction']; now: number }) {
    const when = wipWhen(task.updatedAt, now);
    const step = task.step;
    const ids = { taskId: task.id };
    let next = null;
    if (step) {
        const title = step.disabled && step.why ? step.why : step.label;
        const plan = step.verb === 'start' ? startPlan({ claim: task.claim }, claims) : 'start';
        next = plan === 'choose' ? (
            <>
                <StepButton icon="hand" label="Claim + Start" title={step.disabled && step.why ? step.why : 'Claim + Start'} disabled={step.disabled} step="task.claim-start" onClick={() => onAction({ action: 'task.claim-start', ids })} />
                <StepButton icon="play" label="Start" title={title} disabled={step.disabled} step="task.start" onClick={() => onAction({ action: 'task.start', ids })} />
            </>
        ) : plan === 'claim-then-start' ? (
            <StepButton icon="hand" label="Claim + Start" title={step.disabled && step.why ? step.why : 'Claim + Start'} disabled={step.disabled} step="task.claim-start" onClick={() => onAction({ action: 'task.claim-start', ids })} />
        ) : (
            <StepButton icon={step.icon} label={step.label} title={title} disabled={step.disabled} step={step.actionId} onClick={() => onAction({ action: step.actionId, ids })} />
        );
    }
    return (
        <div data-wip-task={task.id} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-2.5 transition-colors duration-300">
            <div className="flex items-center gap-1.5"><span className="font-mono text-[10px] text-[var(--fg-3)]">{task.number}</span><StatusChip status={task.status} /></div>
            <div className="text-[12px] break-words text-[var(--fg-1)] [overflow-wrap:anywhere]">{task.title}</div>
            {when ? <time dateTime={task.updatedAt ?? undefined} className="text-[10px] text-[var(--fg-3)]">{when}</time> : null}
            {task.claim ? <div><Avatar who={task.claim} /></div> : null}
            {task.features.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                    {task.features.slice(0, 2).map((f) => <span key={f} className="rounded-full bg-[var(--accent)]/10 px-1.5 text-[10px] text-[var(--accent)]">{f}</span>)}
                    {task.features.length > 2 ? <span className="text-[10px] text-[var(--fg-3)]">{`+${task.features.length - 2}`}</span> : null}
                </div>
            ) : null}
            {next ? <div className="mt-1 flex gap-1.5 border-t border-[var(--border-1)] pt-2">{next}</div> : null}
        </div>
    );
}

function RefLink({ value, url, icon, kind }: { value: string | null; url: string | null; icon: string; kind: string }) {
    const ref = wipRef(value, url);
    if (ref === null) return null;
    const label = <><Icon name={icon} size="xs" /><span className="font-mono">{ref.label}</span></>;
    return ref.href !== null
        ? <Button variant="ghost" size="xs" labelClassName="contents" data-wip-ref={kind} href={ref.href} target="_blank" rel="noreferrer" title={ref.href} className="inline-flex w-fit items-center justify-start gap-1 rounded-full border border-[var(--border-1)] px-2 py-0.5 text-[11px] text-[var(--accent)]">{label}<Icon name="external-link" size="xs" /></Button>
        : <span data-wip-ref={kind} className="inline-flex w-fit items-center gap-1 rounded-full border border-[var(--border-1)] px-2 py-0.5 text-[11px] text-[var(--fg-2)]">{label}</span>;
}

/** When the story started, went to QA and finished (Tynn's activity log); a step with no time is left out. */
function Timeline({ story, now }: { story: WipStory; now: number }) {
    const steps = ([['started', 'Started', story.startedAt], ['qa', 'Went to QA', story.qaAt], ['done', 'Finished', story.doneAt]] as const)
        .flatMap(([key, label, at]) => { const when = wipWhen(at, now); return when === null ? [] : [{ key, label, when, at }]; });
    if (steps.length === 0) return null;
    return (
        <ol data-wip-timeline="" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--fg-3)]">
            {steps.map((s) => <li key={s.key} data-wip-time={s.key}>{`${s.label} `}<time dateTime={s.at ?? undefined}>{s.when}</time></li>)}
        </ol>
    );
}

function Tasks({ story, view, onAction, now }: { story: WipStory; view: WipView; onAction: TynnWipPanelProps['onAction']; now: number }) {
    const when = wipWhen(story.updatedAt, now);
    return (
        <div data-wip-state="story-selected" className="flex min-w-0 flex-col gap-3">
            <h2 className="flex min-w-0 items-start gap-1.5 text-[15px] font-semibold break-words text-[var(--fg-1)] [overflow-wrap:anywhere]"><Icon name="book-open" size="sm" />{story.title}</h2>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--fg-3)]">
                <SliceChip status={story.status} state={story.state} />
                <RefLink value={story.pr} url={story.prUrl} icon="git-pull-request" kind="pr" />
                <RefLink value={story.commit} url={story.commitUrl} icon="git-commit-horizontal" kind="commit" />
                {when ? <span data-wip-changed="" className="inline-flex items-center gap-1"><Icon name="clock" size="xs" /><time dateTime={story.updatedAt ?? undefined}>{`Changed ${when}`}</time></span> : null}
            </div>
            <Timeline story={story} now={now} />
            {story.description ? (
                <div data-wip-description="" className="min-w-0 text-[12px] break-words text-[var(--fg-2)] [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto">
                    <ContentRenderer value={story.description} format="markdown" lineSpacing={1.5} clipboardWriter={genieClipboardWriter} />
                </div>
            ) : null}
            {story.criteria.length > 0 ? (
                <section data-wip-criteria="" className="flex min-w-0 flex-col gap-1">
                    <div className="text-[10px] font-semibold tracking-wide text-[var(--fg-3)] uppercase">Acceptance criteria</div>
                    <ul className="flex flex-col gap-1">
                        {story.criteria.map((c, i) => (
                            <li key={i} data-wip-criterion="" className="flex min-w-0 items-start gap-1.5 text-[12px] break-words text-[var(--fg-1)] [overflow-wrap:anywhere]">
                                <span className={`mt-0.5 shrink-0 ${story.status === 'done' ? 'text-[var(--success)]' : 'text-[var(--fg-3)]'}`}><Icon name={story.status === 'done' ? 'square-check' : 'circle'} size="xs" /></span>
                                <span className="min-w-0">{c}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
            <div className="text-[10px] font-semibold tracking-wide text-[var(--fg-3)] uppercase">{`Tasks · ${view.doneTasks} of ${view.tasks.length} done`}</div>
            {view.tasks.length === 0 ? (
                <p data-wip-state="no-tasks" className="text-[12px] text-[var(--fg-3)]">No tasks in this story yet.</p>
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
                    {view.tasks.map((t) => <TaskCard key={t.id} task={t} claims={view.claims} onAction={onAction} now={now} />)}
                </div>
            )}
        </div>
    );
}

function DoneSummary({ view }: { view: WipView }) {
    const n = view.stories.length;
    return (
        <div data-wip-state="done-summary" className="flex flex-col gap-3">
            <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-[var(--fg-1)]"><Icon name="check" size="sm" />Completed Stories</h2>
            <p className="text-[12px] text-[var(--fg-2)]">{`${n} ${n === 1 ? 'story' : 'stories'} delivered in this version.`}</p>
            {n === 0 ? (
                <p className="rounded-lg border border-[var(--border-1)] p-6 text-center text-[12px] text-[var(--fg-3)]">No completed stories yet — get the first one across the line.</p>
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
                    {view.stories.map((s) => (
                        <div key={s.id} data-wip-done={s.id} className="flex flex-col gap-1 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-2.5">
                            <div className="flex items-center gap-1.5"><span className="font-mono text-[10px] text-[var(--fg-3)]">{s.number}</span><SliceChip status="done" state="accepted" /></div>
                            <div className="text-[12px] text-[var(--fg-1)]">{s.title}</div>
                            <div className="text-[11px] text-[var(--fg-3)]">{`${s.taskCount} ${s.taskCount === 1 ? 'task' : 'tasks'} completed`}</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function Empty({ view, onStory }: { view: WipView; onStory: TynnWipPanelProps['onStory'] }) {
    const first = view.stories[0];
    if (!first) {
        return (
            <div data-wip-state="empty-lens" className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <Icon name="inbox" size="lg" />
                <div className="text-[15px] font-semibold text-[var(--fg-2)]">{view.lens === 'attention' ? 'Nothing needs attention.' : 'No stories in this view.'}</div>
                <div className="max-w-[320px] text-[13px] text-[var(--fg-3)]">
                    {view.lens === 'active' ? 'When you accept a story for the active version, it shows up here.' : 'Switch views above or open the board to pick up new work.'}
                </div>
            </div>
        );
    }
    return (
        <div className="flex h-full flex-col items-center justify-center gap-2.5 text-center">
            <Icon name="arrow-left" size="lg" />
            <div className="text-[15px] font-semibold text-[var(--fg-2)]">Pick a story to focus on</div>
            <Button size="xs" labelClassName="contents" type="button" data-wip-open-first="" onClick={() => onStory(first.slug)} className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--accent-fg,white)]">
                <Icon name="arrow-right" size="xs" /> Open first story
            </Button>
        </div>
    );
}

export function TynnWipPanel({ state, onLens, onStory, onAction, onRetry, live, version, onVersion, now = Date.now() }: TynnWipPanelProps) {
    if (state.state !== 'ready') {
        const line = state.state === 'loading'
            ? <><Icon name="loader" size="xs" /> Reading Tynn…</>
            : state.state === 'not-linked'
                ? 'This workspace has no Tynn project.'
                : state.reason;
        return <p data-tynn-page-state={state.state} className="flex items-center gap-1.5 p-4 text-[12px] text-[var(--fg-3)]">{line}</p>;
    }
    const { view, op = null } = state;
    return (
        <div data-tynn-page="wip" className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Versions view={view} version={version} onVersion={onVersion} />
            <Banner view={view} live={live} />
            {version !== undefined && view.version !== null && version !== view.version.id ? (
                <p data-wip-state="version-unserved" className="border-b border-[var(--border-1)] px-3 py-1.5 text-[12px] text-[var(--warning)]">
                    {`Tynn's WIP page answered for ${view.version.number ?? 'another version'}, not the one you chose: it does not yet open another active version's stories.`}
                </p>
            ) : null}
            {op && op.phase !== 'done' ? <div className="px-3 pt-2"><OpLine op={op} onRetry={onRetry} /></div> : null}
            {op && op.phase === 'done' ? <div className="px-3 pt-2"><OpLine op={op} /></div> : null}
            <div className="flex min-h-0 flex-1">
                <Rail view={view} onLens={onLens} onStory={onStory} now={now} />
                <main className="min-w-0 flex-1 overflow-y-auto p-4">
                    {view.lens === 'done' ? <DoneSummary view={view} /> : view.selected ? <Tasks story={view.selected} view={view} onAction={onAction} now={now} /> : <Empty view={view} onStory={onStory} />}
                </main>
            </div>
        </div>
    );
}
