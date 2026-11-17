import { Breadcrumbs } from '@particle-academy/react-fancy';
import type { ReactNode } from 'react';

export interface HeaderCrumb {
    readonly label: string;
    readonly title?: string;
    /** A crumb you can go back to; the last one is the page you are on and has none. */
    readonly onClick?: () => void;
    readonly attrs?: Record<string, string>;
}

/**
 * ONE HEADER FOR EVERY VIEW (the owner, 2026-11-16: "the different headers based on the view"). The workspace and the
 * agent draw the same thing: crumbs, then what state it is in, then its path, then its actions on the right.
 *
 * It never spills past its column (beta.33 item 23; the 1024px sweep of 2026-10-14): one 44px line, the title cluster
 * shrinks and clips, the path gives way first, the crumbs truncate but keep a few letters, and the actions never wrap:
 * in a header narrower than 46rem their words hide behind `@max-[46rem]:hidden`, the icon and aria-label staying.
 */
export function ViewHeader({ crumbs, status, path, actions }: { crumbs: readonly HeaderCrumb[]; status?: ReactNode; path?: string | null; actions?: ReactNode }) {
    const last = crumbs.length - 1;
    return (
        <header data-view-header="" className="@container flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-1)] px-5">
            <div data-header-title="" className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
                {/* react-fancy's Breadcrumbs (menus and crumbs are navigation, not Buttons); below md it folds into a menu. */}
                <Breadcrumbs separator={<span className="text-[13px] text-[var(--fg-4)]">/</span>} className="min-w-0 shrink items-center gap-1.5 overflow-hidden">
                    {crumbs.map((c, i) => (i < last ? (
                        <Breadcrumbs.Item key={i} {...c.attrs} onClick={c.onClick} title={c.title ?? c.label} className="min-w-[3rem] max-w-[12rem] shrink truncate whitespace-nowrap text-left text-[13px] text-[var(--fg-3)] hover:text-[var(--fg-1)] dark:text-[var(--fg-3)] dark:hover:text-[var(--fg-1)]">
                            {c.label}
                        </Breadcrumbs.Item>
                    ) : (
                        <Breadcrumbs.Item key={i} active {...c.attrs} title={c.title ?? c.label} className="min-w-[3rem] shrink truncate whitespace-nowrap text-[13px] font-medium text-[var(--fg-1)] dark:text-[var(--fg-1)]">{c.label}</Breadcrumbs.Item>
                    )))}
                </Breadcrumbs>
                {status}
                {path ? <span data-header-path="" className="min-w-0 shrink-[1000] truncate font-mono text-[11px] text-[var(--fg-4)]" title={path}>{path}</span> : null}
            </div>
            <div data-header-actions="" className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
        </header>
    );
}
