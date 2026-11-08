import { Button, Icon, Input, Textarea } from '@particle-academy/react-fancy';
import { useState, type FormEvent } from 'react';
import type { BoardActionInput, LiveState } from '../../core/tynn-board.js';
import { vipColumnLabel, VIP_MOVE_ORDER, type TynnPageActionInput, type TynnPageState, type VipStory, type VipView } from '../../core/tynn-pages.js';
import { LiveMark, OpLine } from './TynnBoardPanel.js';

/**
 * THE TYNN TAB'S VIP LANE (genie#1295 row V1, Tynn story #321, workspace-ux 0.11.0 surface `vip`) — tynn.ai's VIP page
 * (Pages/v2/Project/Vip.jsx), natively.
 *
 * Idle: what VIP is for, Start VIP (a title and why it cannot wait) for a person who may manage the project, or who can.
 * In flight: the rose banner (number, title, task progress) with Release, held back until every story is done; the five
 * columns with each story's one-click move to its next column. The past VIPs below. Every action says it is running,
 * then that it worked, or Tynn's reason with Retry. Tynn's text is drawn as text, never as markup. react-fancy throughout.
 */
export interface TynnVipPanelProps {
    readonly state: TynnPageState<VipView>;
    /** A board verb (a story's move, the Release), through the board's door. */
    readonly onAction: (input: BoardActionInput) => void;
    /** Start VIP, the lane's own write. */
    readonly onStart: (input: TynnPageActionInput) => void;
    readonly onRetry?: (() => void) | undefined;
    readonly live?: LiveState | undefined;
}

function StartVip({ onStart, busy }: { onStart: TynnVipPanelProps['onStart']; busy: boolean }) {
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState('');
    const [why, setWhy] = useState('');
    if (!open) {
        return <Button type="button" size="sm" color="red" icon="flame" data-vip-start="" className="mt-4" onClick={() => setOpen(true)}>Start VIP</Button>;
    }
    const submit = (e: FormEvent) => { e.preventDefault(); onStart({ action: 'vip.create', body: { title, why } }); };
    return (
        <form data-vip-start-form="" onSubmit={submit} className="mt-4 flex flex-col gap-2 text-left">
            <Input aria-label="What broke" placeholder="What broke" value={title} onValueChange={setTitle} disabled={busy} required />
            <Textarea aria-label="Why it cannot wait" placeholder="Why it cannot wait" rows={3} value={why} onValueChange={setWhy} disabled={busy} required />
            <div className="flex justify-end gap-2">
                <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" size="xs" color="red" icon="flame" data-tynn-submit="" loading={busy} disabled={busy || title.trim() === '' || why.trim() === ''}>{busy ? 'Starting VIP…' : 'Start VIP'}</Button>
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
    const label = story.next ? `Move to ${vipColumnLabel(story.next)}` : 'No next step';
    return (
        <div data-vip-story={story.id} className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-2.5">
            <div className="text-[12px] text-[var(--fg-1)]">{story.title}</div>
            {story.description ? <p className="line-clamp-3 text-[11px] whitespace-pre-wrap text-[var(--fg-3)]">{story.description}</p> : null}
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--fg-3)]">
                <span className="rounded bg-[var(--bg-2)] px-1.5 font-mono">{story.number}</span>
                {story.progress ? <span className="inline-flex items-center gap-0.5"><Icon name="list-checks" size="xs" />{story.progress}</span> : null}
                <span className="flex-1" />
                {story.status === 'done' ? <Icon name="circle-check" size="xs" /> : null}
                {story.next ? (
                    <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        icon="chevrons-right"
                        data-tynn-step="story.move"
                        aria-label={label}
                        title={label}
                        onClick={() => { if (story.next) onAction({ action: 'story.move', ids: { storyId: story.id }, body: { status: story.next, order: VIP_MOVE_ORDER } }); }}
                    />
                ) : null}
            </div>
        </div>
    );
}

export function TynnVipPanel({ state, onAction, onStart, onRetry, live }: TynnVipPanelProps) {
    if (state.state !== 'ready') {
        const line = state.state === 'loading' ? <><Icon name="loader" size="xs" className="animate-spin" /> Reading Tynn…</> : state.state === 'not-linked' ? 'This workspace has no Tynn project.' : state.reason;
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
                    <span className="text-[var(--rose-300)]"><Icon name="flame" size="xl" /></span>
                    <h2 className="mt-3 text-[18px] font-semibold text-[var(--fg-1)]">No VIP in flight</h2>
                    <p className="mt-1.5 text-[13px] leading-normal text-[var(--fg-3)]">VIP is the lane for critical, unscoped work: the thing that makes everything else wait. One at a time, patched off the last release.</p>
                    {view.canStart
                        ? <StartVip onStart={onStart} busy={op?.action === 'vip.create' && op.phase === 'running'} />
                        : <p className="mt-4 text-[12px] text-[var(--fg-3)]">Someone who can manage this project can start VIP work here.</p>}
                </div>
                <Past view={view} />
            </div>
        );
    }
    const version = view.version;
    const releaseTitle = view.allDone ? 'Release this VIP version' : 'All stories must be Done to release the VIP';
    return (
        <div data-tynn-page="vip" data-vip-state="in-flight" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
            <div data-vip-banner="" className="flex flex-wrap items-center gap-2 border-b border-[var(--rose-500)]/30 bg-[var(--rose-500)]/10 px-3 py-2 text-[12px]">
                <span className="text-[var(--rose-500)]"><Icon name="flame" size="sm" /></span>
                <span className="font-mono text-[var(--fg-2)]">{version.number}</span>
                <span className="rounded-full bg-[var(--rose-500)]/20 px-2 py-0.5 text-[10px] font-medium text-[var(--rose-500)]">{`VIP ${version.number ?? ''}`}</span>
                <span className="min-w-0 truncate font-medium text-[var(--fg-1)]">{version.title}</span>
                <span className="text-[var(--fg-3)]">Progress</span>
                <span className="inline-block h-1.5 w-32 overflow-hidden rounded bg-[var(--bg-2)]"><i className="block h-full bg-[var(--rose-500)]" style={{ width: `${view.progress.percent}%` }} /></span>
                <span className="text-[var(--fg-3)]">{`${view.progress.done}/${view.progress.total}`}</span>
                <span className="ml-auto flex items-center gap-2">
                    <LiveMark live={live} />
                    {view.allDone ? null : <span className="text-[11px] text-[var(--fg-3)]">{releaseTitle}</span>}
                    <Button
                        type="button"
                        size="xs"
                        color="red"
                        icon="rocket"
                        data-tynn-step="version.release"
                        title={releaseTitle}
                        disabled={!view.allDone}
                        onClick={() => { if (view.allDone) onAction({ action: 'version.release', ids: { versionId: version.id } }); }}
                    >
                        Release
                    </Button>
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
                            ? <div className="py-4 text-center text-[11px] text-[var(--fg-3)]">Empty</div>
                            : col.stories.map((s) => <Card key={s.id} story={s} onAction={onAction} />)}
                    </section>
                ))}
            </div>
            <div className="px-3 pb-4"><Past view={view} /></div>
        </div>
    );
}
