import { Icon } from '@particle-academy/react-fancy';
import { startPlan, type BoardActionInput, type BoardClaims, type LiveState } from '../../core/tynn-board.js';
import { WIP_LENSES, type TynnPageState, type WipLens, type WipStory, type WipTask, type WipView } from '../../core/tynn-pages.js';
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

function StatusChip({ status }: { status: string }) {
    const look = STATUS_LOOK[status];
    if (!look) return null;
    return <span data-wip-status={status} className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${look.className}`}>{look.label}</span>;
}

function Bar({ done, total }: { done: number; total: number }) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return <span className="inline-block h-1 w-16 overflow-hidden rounded bg-[var(--bg-2)]"><i className="block h-full bg-[var(--accent)]" style={{ width: `${pct}%` }} /></span>;
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

function Rail({ view, onLens, onStory }: { view: WipView; onLens: TynnWipPanelProps['onLens']; onStory: TynnWipPanelProps['onStory'] }) {
    return (
        <aside className="flex w-[300px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--border-1)] p-2">
            <div role="group" aria-label="Lens" className="mb-1 flex gap-1">
                {(Object.keys(WIP_LENSES) as WipLens[]).map((lens) => {
                    const look = LENS_LOOK[lens];
                    const on = view.lens === lens;
                    return (
                        <button
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
                        </button>
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
                        <button
                            type="button"
                            data-wip-story={story.id}
                            aria-current={selected ? 'true' : undefined}
                            onClick={() => onStory(story.slug)}
                            className={`flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left ${selected ? 'bg-[var(--bg-2)]' : 'hover:bg-[var(--bg-2)]'}`}
                        >
                            <span className="flex items-center gap-1.5"><span className="font-mono text-[10px] text-[var(--fg-3)]">{story.number}</span><StatusChip status={story.status} /></span>
                            <span className="text-[12px] text-[var(--fg-1)]">{story.title}</span>
                            {story.progress ? <span className="flex items-center gap-1.5 text-[10px] text-[var(--fg-3)]"><Bar done={story.tasksDone} total={story.taskCount} />{story.progress}</span> : null}
                        </button>
                    </div>
                );
            })}
        </aside>
    );
}

function StepButton({ icon, label, title, disabled, step, onClick }: { icon: string; label: string; title: string; disabled: boolean; step: string; onClick: () => void }) {
    return (
        <button
            type="button"
            data-tynn-step={step}
            aria-label={label}
            title={title}
            disabled={disabled}
            onClick={onClick}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-[var(--border-1)] px-2 py-1 text-[11px] text-[var(--fg-1)] hover:bg-[var(--bg-2)] disabled:opacity-40"
        >
            <Icon name={icon} size="xs" />
        </button>
    );
}

function TaskCard({ task, claims, onAction }: { task: WipTask; claims: BoardClaims | null; onAction: TynnWipPanelProps['onAction'] }) {
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
        <div data-wip-task={task.id} className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-2.5">
            <div className="flex items-center gap-1.5"><span className="font-mono text-[10px] text-[var(--fg-3)]">{task.number}</span><StatusChip status={task.status} /></div>
            <div className="text-[12px] text-[var(--fg-1)]">{task.title}</div>
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

function Tasks({ story, view, onAction }: { story: WipStory; view: WipView; onAction: TynnWipPanelProps['onAction'] }) {
    return (
        <div data-wip-state="story-selected" className="flex flex-col gap-3">
            <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-[var(--fg-1)]"><Icon name="book-open" size="sm" />{story.title}</h2>
            {story.description ? <p className="text-[12px] whitespace-pre-wrap text-[var(--fg-2)]">{story.description}</p> : null}
            <div className="text-[10px] font-semibold tracking-wide text-[var(--fg-3)] uppercase">{`Tasks · ${view.doneTasks} of ${view.tasks.length} done`}</div>
            {view.tasks.length === 0 ? (
                <p data-wip-state="no-tasks" className="rounded-lg border border-[var(--border-1)] p-6 text-center text-[12px] text-[var(--fg-3)]">No tasks in this story yet.</p>
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
                    {view.tasks.map((t) => <TaskCard key={t.id} task={t} claims={view.claims} onAction={onAction} />)}
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
                            <div className="flex items-center gap-1.5"><span className="font-mono text-[10px] text-[var(--fg-3)]">{s.number}</span><StatusChip status="done" /></div>
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
            <button type="button" data-wip-open-first="" onClick={() => onStory(first.slug)} className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--accent-fg,white)]">
                <Icon name="arrow-right" size="xs" /> Open first story
            </button>
        </div>
    );
}

export function TynnWipPanel({ state, onLens, onStory, onAction, onRetry, live }: TynnWipPanelProps) {
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
            <Banner view={view} live={live} />
            {op && op.phase !== 'done' ? <div className="px-3 pt-2"><OpLine op={op} onRetry={onRetry} /></div> : null}
            {op && op.phase === 'done' ? <div className="px-3 pt-2"><OpLine op={op} /></div> : null}
            <div className="flex min-h-0 flex-1">
                <Rail view={view} onLens={onLens} onStory={onStory} />
                <main className="min-w-0 flex-1 overflow-y-auto p-4">
                    {view.lens === 'done' ? <DoneSummary view={view} /> : view.selected ? <Tasks story={view.selected} view={view} onAction={onAction} /> : <Empty view={view} onStory={onStory} />}
                </main>
            </div>
        </div>
    );
}
