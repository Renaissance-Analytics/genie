import { Icon } from '@particle-academy/react-fancy';
import type { IssueWatchPanelView } from '../../core/issue-watch.js';

/**
 * A WORKSPACE'S GITHUB, THROUGH ISSUEWATCH (Tynn #806; Genie 1's IssueWatch flyout — "open issues, PRs and security alerts
 * in one feed, without leaving Genie"). The state said plainly; the counts; what is open, by family, security first, each
 * linked out to GitHub; what happened lately. Titles are GitHub's: shown as text, never as markup.
 */
const TONE: Record<IssueWatchPanelView['line']['tone'], string> = {
    ok: 'text-[var(--accent)]',
    warn: 'text-[var(--warning)]',
    muted: 'text-[var(--fg-3)]',
};

const COUNTS: ReadonlyArray<{ key: 'security' | 'prs' | 'issues' | 'feedback'; label: string }> = [
    { key: 'security', label: 'security' },
    { key: 'prs', label: 'PRs' },
    { key: 'issues', label: 'issues' },
    { key: 'feedback', label: 'feedback' },
];

export function IssueWatchPanel({ view }: { view: IssueWatchPanelView }) {
    return (
        <section data-issue-watch-panel="" className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-5 text-[13px]">
            <header className="flex items-center gap-2">
                <Icon name="git-pull-request" size="sm" />
                <h2 className="text-[14px] font-semibold">GitHub</h2>
                <span data-issue-watch-line={view.line.tone} className={`ml-2 text-[12px] ${TONE[view.line.tone]}`}>{view.line.text}</span>
            </header>

            {view.counts ? (
                <div className="flex gap-2">
                    {COUNTS.map((c) => (
                        <span key={c.key} data-issue-watch-count={c.key} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 font-mono text-[12px] text-[var(--fg-2)]">
                            {view.counts![c.key]} {c.label}
                        </span>
                    ))}
                </div>
            ) : null}

            {view.empty ? <p data-issue-watch-empty="" className="text-[var(--fg-3)]">{view.empty}</p> : null}

            {view.groups.map((g) => (
                <div key={g.family} data-issue-watch-group={g.family}>
                    <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">{g.label}</h3>
                    <ul className="flex flex-col gap-0.5">
                        {g.items.map((i) => (
                            <li key={i.url || i.ref}>
                                <a data-issue-watch-item="" href={i.url} target="_blank" rel="noreferrer" className="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-[var(--bg-2)]">
                                    <span className="shrink-0 font-mono text-[12px] text-[var(--fg-3)]">{i.ref}</span>
                                    {i.severity ? <span data-issue-watch-severity={i.severity} className="shrink-0 rounded-sm bg-[var(--warning)]/15 px-1 font-mono text-[10px] text-[var(--warning)]">{i.severity}</span> : null}
                                    <span className="min-w-0 truncate">{i.title}</span>
                                </a>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}

            {view.recent.length > 0 ? (
                <div data-issue-watch-recent="">
                    <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Lately</h3>
                    <ul className="flex flex-col gap-0.5 text-[12px] text-[var(--fg-2)]">
                        {view.recent.map((r, n) => (
                            <li key={`${n}:${r.text}`} className="truncate">
                                {r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">{r.text}</a> : r.text}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </section>
    );
}
