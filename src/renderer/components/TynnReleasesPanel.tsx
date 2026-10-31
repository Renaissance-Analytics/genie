import { Icon } from '@particle-academy/react-fancy';
import type { LiveState } from '../../core/tynn-board.js';
import type { Release, ReleasesView, TynnPageState } from '../../core/tynn-pages.js';
import { LiveMark } from './TynnBoardPanel.js';

/**
 * THE TYNN TAB'S RELEASES (genie#1295 row R1) — tynn.ai's Releases page (Pages/v2/Project/Releases.jsx), natively: the
 * totals, then each release card (number, title, Released, its PR, the date, the description, its stories by number,
 * "+ n more"); "No releases yet" when there are none. Read only. Tynn's text is drawn as text, never as markup.
 */
export interface TynnReleasesPanelProps {
    readonly state: TynnPageState<ReleasesView>;
    readonly live?: LiveState | undefined;
}

function Card({ release: r }: { release: Release }) {
    return (
        <div data-release={r.id} className="flex flex-col gap-2 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-[var(--bg-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--fg-2)]">{r.number}</span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--fg-1)]">{r.title}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]"><Icon name="rocket" size="xs" /> Released</span>
                {r.pr ? <span data-release-pr="" className="inline-flex items-center gap-0.5 text-[11px] text-[var(--fg-3)]"><Icon name="git-pull-request" size="xs" />{`#${r.pr}`}</span> : null}
                {r.date ? <span className="text-right text-[11px] text-[var(--fg-3)]"><span className="block text-[9px] tracking-wide uppercase">Released</span>{r.date}</span> : null}
            </div>
            {r.description ? <p className="text-[12px] whitespace-pre-wrap text-[var(--fg-2)]">{r.description}</p> : null}
            {r.top.length > 0 || r.storyCount > 0 ? (
                <div className="flex flex-col gap-1 border-t border-[var(--border-1)] pt-2">
                    <div className="text-[10px] font-semibold tracking-wide text-[var(--fg-3)] uppercase">{`${r.storyCount} ${r.storyCount === 1 ? 'story' : 'stories'}`}</div>
                    {r.top.map((s) => (
                        <div key={s.id} className="flex items-center gap-2 text-[12px]">
                            <span className="font-mono text-[10px] text-[var(--fg-3)]">{s.number ?? ''}</span>
                            <span className="text-[var(--fg-1)]">{s.title}</span>
                        </div>
                    ))}
                    {r.more > 0 ? <div className="text-[11px] text-[var(--fg-3)]">{`+ ${r.more} more ${r.more === 1 ? 'story' : 'stories'}`}</div> : null}
                </div>
            ) : null}
        </div>
    );
}

export function TynnReleasesPanel({ state, live }: TynnReleasesPanelProps) {
    if (state.state !== 'ready') {
        const line = state.state === 'loading' ? <><Icon name="loader" size="xs" /> Reading Tynn…</> : state.state === 'not-linked' ? 'This workspace has no Tynn project.' : state.reason;
        return <p data-tynn-page-state={state.state} className="flex items-center gap-1.5 p-4 text-[12px] text-[var(--fg-3)]">{line}</p>;
    }
    const { view } = state;
    return (
        <div data-tynn-page="releases" className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <div className="flex flex-wrap items-end gap-6">
                <div className="min-w-0 flex-1">
                    <h1 className="text-[18px] font-semibold text-[var(--fg-1)]">Releases</h1>
                    <div className="text-[12px] text-[var(--fg-3)]">Showcase of completed and released versions.</div>
                </div>
                <div className="text-center"><div data-releases-total="releases" className="text-[18px] font-semibold text-[var(--fg-1)]">{view.releases.length}</div><div className="text-[10px] text-[var(--fg-3)]">Total releases</div></div>
                <div className="text-center"><div data-releases-total="stories" className="text-[18px] font-semibold text-[var(--fg-1)]">{view.totalStories}</div><div className="text-[10px] text-[var(--fg-3)]">Stories delivered</div></div>
                <LiveMark live={live} />
            </div>
            {view.releases.length === 0 ? (
                <div data-releases-state="empty" className="rounded-lg border border-[var(--border-1)] px-6 py-12 text-center">
                    <Icon name="rocket" size="lg" />
                    <h3 className="mt-3 text-[15px] font-semibold text-[var(--fg-1)]">No releases yet</h3>
                    <p className="mt-1 text-[13px] text-[var(--fg-3)]">Released versions appear here once you ship them.</p>
                </div>
            ) : view.releases.map((r) => <Card key={r.id} release={r} />)}
        </div>
    );
}
