import { Icon } from '@particle-academy/react-fancy';
import { useState, type FormEvent } from 'react';
import type { BoardActionInput, LiveState } from '../../core/tynn-board.js';
import { VIP_MOVE_ORDER, type TynnPageActionInput, type TynnPageState, type VipStory, type VipView } from '../../core/tynn-pages.js';
import { LiveMark, OpLine } from './TynnBoardPanel.js';

/**
 * THE TYNN TAB'S VIP LANE (genie#1295 row V1) — tynn.ai's VIP page (Pages/v2/Project/Vip.jsx), natively.
 *
 * Idle: what VIP is for, Start VIP (a title and why it cannot wait) for a person who may manage the project, or who can.
 * In flight: the rose banner (number, title, task progress) with Release, held back until every story is done; the five
 * columns with each story's one-click move to its next column. The past VIPs below. Every action says it is running,
 * then that it worked — or Tynn's reason, with Retry. Tynn's text is drawn as text, never as markup.
 */
export interface TynnVipPanelProps {
    readonly state: TynnPageState<VipView>;
    readonly onAction: (input: BoardActionInput) => void;
    readonly onStart: (input: TynnPageActionInput) => void;
    readonly onRetry?: (() => void) | undefined;
    readonly live?: LiveState | undefined;
}

const inputClass = 'w-full rounded border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--fg-1)]';

function StartVip({ onStart, busy }: { onStart: TynnVipPanelProps['onStart']; busy: boolean }) {
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState('');
    const [why, setWhy] = useState('');
    if (!open) {
        return (
            <button type="button" data-vip-start="" onClick={() => setOpen(true)} className="mt-4 inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90">
                <Icon name="flame" size="xs" /> Start VIP
            </button>
        );
    }
    const submit = (e: FormEvent) => { e.preventDefault(); onStart({ action: 'vip.create', body: { title, why } }); };
    return (
        <form data-vip-start-form="" onSubmit={submit} className="mt-4 flex flex-col gap-2 text-left">
            <input aria-label="What broke" placeholder="What broke" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} disabled={busy} />
            <textarea aria-label="Why it cannot wait" placeholder="Why it cannot wait" rows={3} value={why} onChange={(e) => setWhy(e.target.value)} className={inputClass} disabled={busy} />
            <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2.5 py-1 text-[12px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]">Cancel</button>
                <button type="submit" data-tynn-submit="" disabled={busy || title.trim() === '' || why.trim() === ''} className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50">
                    <Icon name={busy ? 'loader' : 'flame'} size="xs" className={busy ? 'animate-spin' : ''} />{busy ? 'Starting VIP…' : 'Start VIP'}
                </button>
            </div>
        </form>
    );
}

function Past({ view }: { view: VipView }) {
    if (view.past.length === 0) return null;
    return (
        <div data-vip-past="" className="mx-auto mt-6 w-full max-w-[720px] rounded-lg border border-[var(--border-1)] p-3">
            <div className="mb-2 text-[12px] font-semibold text-[var(--fg-2)]">Past VIP work</div>
            <ul className="flex flex-col gap-1">
                {view.past.map((v) => (
                    <li key={v.id} className="flex items-center gap-2 text-[12px]">
                        <span className="rounded bg-[var(--bg-2)] px-1.5 font-mono text-[10px] text-[var(--fg-2)]">{v.number}</span>
                        <span className="min-w-0 flex-1 truncate text-[var(--fg-1)]">{v.title}</span>
                        <span className="text-[var(--fg-3)]">{`${v.storyCount} ${v.storyCount === 1 ? 'story' : 'stories'}`}</span>
                        <span className="text-[var(--fg-3)] capitalize">{v.status}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function Card({ story, onAction }: { story: VipStory; onAction: TynnVipPanelProps['onAction'] }) {
    const label = story.next ? `Move to ${story.next.replace('_', ' ')}` : 'No next step';
    return (
        <div data-vip-story={story.id} className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-2.5">
            <div className="text-[12px] text-[var(--fg-1)]">{story.title}</div>
            {story.description ? <p className="line-clamp-3 text-[11px] whitespace-pre-wrap text-[var(--fg-3)]">{story.description}</p> : null}
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--fg-3)]">
                <span className="rounded bg-[var(--bg-2)] px-1.5 font-mono">{story.number}</span>
                {story.progress ? <span className="inline-flex items-center gap-0.5"><Icon name="list-checks" size="xs" />{story.progress}</span> : null}
                <span className="flex-1" />
                {story.status === 'done' ? <Icon name="circle-check" size="xs" /> : null}
                <button
                    type="button"
                    data-tynn-step="story.move"
                    aria-label={label}
                    title={label}
                    disabled={!story.next}
                    onClick={() => { if (story.next) onAction({ action: 'story.move', ids: { storyId: story.id }, body: { status: story.next, order: VIP_MOVE_ORDER } }); }}
                    className="rounded p-1 text-[var(--fg-2)] hover:bg-[var(--bg-2)] disabled:opacity-40"
                >
                    <Icon name="chevrons-right" size="xs" />
                </button>
            </div>
        </div>
    );
}

export function TynnVipPanel({ state, onAction, onStart, onRetry, live }: TynnVipPanelProps) {
    if (state.state !== 'ready') {
        const line = state.state === 'loading' ? <><Icon name="loader" size="xs" /> Reading Tynn…</> : state.state === 'not-linked' ? 'This workspace has no Tynn project.' : state.reason;
        return <p data-tynn-page-state={state.state} className="flex items-center gap-1.5 p-4 text-[12px] text-[var(--fg-3)]">{line}</p>;
    }
    const { view, op = null } = state;
    const opLine = op ? <div className="px-3 pt-2"><OpLine op={op} onRetry={op.phase === 'failed' ? onRetry : undefined} /></div> : null;
    if (!view.version) {
        return (
            <div data-tynn-page="vip" data-vip-state="idle" className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
                <div className="flex justify-end"><LiveMark live={live} /></div>
                {opLine}
                <div className="mx-auto mt-6 w-full max-w-[520px] rounded-lg border border-[var(--border-1)] px-8 pt-12 pb-10 text-center">
                    <Icon name="flame" size="xl" className="text-rose-300" />
                    <h2 className="mt-3 text-[18px] font-semibold text-[var(--fg-1)]">No VIP in flight</h2>
                    <p className="mt-1.5 text-[13px] leading-normal text-[var(--fg-3)]">VIP is the lane for critical, unscoped work — the thing that makes everything else wait. One at a time, patched off the last release.</p>
                    {view.canStart
                        ? <StartVip onStart={onStart} busy={op?.action === 'vip.create' && op.phase === 'running'} />
                        : <p className="mt-4 text-[12px] text-[var(--fg-3)]">Someone who can manage this project can start VIP work here.</p>}
                </div>
                <Past view={view} />
            </div>
        );
    }
    const releaseTitle = view.allDone ? 'Release this VIP version' : 'All stories must be Done to release the VIP';
    return (
        <div data-tynn-page="vip" data-vip-state="in-flight" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
            <div data-vip-banner="" className="flex flex-wrap items-center gap-2 border-b border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px]">
                <span className="text-rose-500"><Icon name="flame" size="sm" /></span>
                <span className="font-mono text-[var(--fg-2)]">{view.version.number}</span>
                <span className="rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] font-medium text-rose-500">{`VIP ${view.version.number ?? ''}`}</span>
                <span className="min-w-0 truncate font-medium text-[var(--fg-1)]">{view.version.title}</span>
                <span className="text-[var(--fg-3)]">Progress</span>
                <span className="inline-block h-1.5 w-32 overflow-hidden rounded bg-[var(--bg-2)]"><i className="block h-full bg-rose-500" style={{ width: `${view.progress.percent}%` }} /></span>
                <span className="text-[var(--fg-3)]">{`${view.progress.done}/${view.progress.total}`}</span>
                <span className="ml-auto flex items-center gap-1">
                    <LiveMark live={live} />
                    <button
                        type="button"
                        data-tynn-step="version.release"
                        aria-label="Release"
                        title={releaseTitle}
                        disabled={!view.allDone}
                        onClick={() => { if (view.version && view.allDone) onAction({ action: 'version.release', ids: { versionId: view.version.id } }); }}
                        className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                    >
                        <Icon name="rocket" size="xs" />
                    </button>
                </span>
            </div>
            {opLine}
            <div className="flex min-h-0 gap-2 overflow-x-auto p-3">
                {view.columns.map((col) => (
                    <section key={col.status} data-vip-column={col.status} className="flex w-[240px] shrink-0 flex-col gap-2 rounded-lg bg-[var(--bg-2)]/40 p-2">
                        <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--fg-2)]">
                            <span>{col.label}</span>
                            <span className="rounded-full bg-[var(--bg-2)] px-1.5 text-[10px] text-[var(--fg-3)]">{col.stories.length}</span>
                        </div>
                        {col.stories.length === 0
                            ? <div className="py-4 text-center text-[11px] text-[var(--fg-4,var(--fg-3))]">Empty</div>
                            : col.stories.map((s) => <Card key={s.id} story={s} onAction={onAction} />)}
                    </section>
                ))}
            </div>
            <div className="px-3 pb-4"><Past view={view} /></div>
        </div>
    );
}
