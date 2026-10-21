import { Icon } from '@particle-academy/react-fancy';
import type { IssueWatchPanelView, IssueWatchRepo, IssueWatchRow } from '../../core/issue-watch.js';

/**
 * A WORKSPACE'S GITHUB, THROUGH ISSUEWATCH (Tynn #806; Genie 1's IssueWatch flyout — "open issues, PRs and security alerts
 * in one feed, without leaving Genie"). Readable (the owner, 2026-10-21: "very messy and hard to read"): by repo, its name
 * once with its counts; each row its kind, `#N`, the title, who opened it and how long ago; a repo's Dependabot alerts are
 * one line. Honest about its age: the line says when Tynn last sent the list, and Refresh asks for it now. Titles and
 * logins are GitHub's: shown as text, never as markup.
 */
const TONE: Record<IssueWatchPanelView['line']['tone'], string> = {
    ok: 'text-[var(--accent)]',
    warn: 'text-[var(--warning)]',
    muted: 'text-[var(--fg-3)]',
};

const KIND_ICON: Record<IssueWatchRow['kind'], string> = {
    security: 'shield-alert',
    pr: 'git-pull-request',
    issue: 'circle-dot',
    feedback: 'message-square',
};

const KIND_LABEL: Record<IssueWatchRow['kind'], string> = {
    security: 'Security alert',
    pr: 'Pull request',
    issue: 'Issue',
    feedback: 'Tynn feedback',
};

function Severity({ value }: { value: string | null }) {
    if (!value) return null;
    return <span data-issue-watch-severity={value} className="shrink-0 rounded-sm bg-[var(--warning)]/15 px-1 font-mono text-[10px] text-[var(--warning)]">{value}</span>;
}

function Row({ row }: { row: IssueWatchRow }) {
    return (
        <li>
            <a data-issue-watch-item="" data-issue-watch-kind={row.kind} href={row.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--bg-2)]">
                <span className="shrink-0 text-[var(--fg-3)]" title={KIND_LABEL[row.kind]}><Icon name={KIND_ICON[row.kind]} size="xs" /></span>
                <span className="w-12 shrink-0 font-mono text-[12px] text-[var(--fg-3)]">{row.number !== null ? `#${row.number}` : ''}</span>
                <Severity value={row.severity} />
                <span className="min-w-0 flex-1 truncate">{row.title}</span>
                <span className="shrink-0 text-[11px] text-[var(--fg-4)]">{[row.author, row.age].filter(Boolean).join(' · ')}</span>
            </a>
        </li>
    );
}

function counts(r: IssueWatchRepo): string {
    const parts = [
        r.counts.security > 0 ? `${r.counts.security} security` : null,
        r.counts.prs > 0 ? `${r.counts.prs} PR${r.counts.prs === 1 ? '' : 's'}` : null,
        r.counts.issues > 0 ? `${r.counts.issues} issue${r.counts.issues === 1 ? '' : 's'}` : null,
    ];
    return parts.filter(Boolean).join(' · ');
}

export function IssueWatchPanel({ view, onRefresh }: { view: IssueWatchPanelView; onRefresh?: () => void }) {
    return (
        <section data-issue-watch-panel="" className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-5 text-[13px]">
            <header className="flex items-center gap-2">
                <Icon name="git-pull-request" size="sm" />
                <h2 className="text-[14px] font-semibold">GitHub</h2>
                <span data-issue-watch-line={view.line.tone} className={`ml-2 min-w-0 flex-1 truncate text-[12px] ${TONE[view.line.tone]}`}>{view.line.text}</span>
                {onRefresh ? (
                    <button type="button" data-issue-watch-refresh="" onClick={onRefresh} className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-1)] px-2 py-0.5 text-[12px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]">
                        <Icon name="refresh-cw" size="xs" /> Refresh
                    </button>
                ) : null}
            </header>

            {view.empty ? <p data-issue-watch-empty="" className="text-[var(--fg-3)]">{view.empty}</p> : null}

            {view.repos.map((r) => (
                <div key={r.repo} data-issue-watch-repo={r.repo} className="flex flex-col gap-1">
                    <div className="flex items-baseline gap-2 border-b border-[var(--border-1)] pb-1">
                        <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer" className="font-semibold hover:underline">{r.repo}</a>
                        <span className="text-[11px] text-[var(--fg-4)]">{counts(r)}</span>
                    </div>
                    <ul className="flex flex-col">
                        {r.dependabot ? (
                            <li>
                                <a data-issue-watch-dependabot="" href={r.dependabot.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--bg-2)]">
                                    <span className="shrink-0 text-[var(--fg-3)]" title="Dependabot alerts"><Icon name="shield-alert" size="xs" /></span>
                                    <span className="w-12 shrink-0" />
                                    <Severity value={r.dependabot.worst} />
                                    <span className="min-w-0 flex-1 truncate">{r.dependabot.count} Dependabot alert{r.dependabot.count === 1 ? '' : 's'}{r.dependabot.worst ? ` — worst ${r.dependabot.worst}` : ''}</span>
                                </a>
                            </li>
                        ) : null}
                        {r.rows.map((row) => <Row key={row.url || `${row.kind}:${row.number}`} row={row} />)}
                    </ul>
                </div>
            ))}

            {view.feedback.length > 0 ? (
                <div data-issue-watch-feedback="" className="flex flex-col gap-1">
                    <div className="border-b border-[var(--border-1)] pb-1 font-semibold">Tynn feedback</div>
                    <ul className="flex flex-col">{view.feedback.map((row) => <Row key={row.url || `fb:${row.number}`} row={row} />)}</ul>
                </div>
            ) : null}

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
