import type { CSSProperties, ReactNode } from 'react';

/**
 * THE ONE BAR ON TOP OF EVERY VIEW (the owner on beta.64, 2026-11-17: "agents should not have a different header UX than
 * workspaces, the only difference is the main content. I prefer the tabs along the top layout."). A workspace's views and
 * an agent's page draw the same bar: the workspace's tabs on the left, scrolling sideways when there are many; what is
 * selected puts its status, its own views and its actions, as icons, at the right end (`trailing`). No row of crumbs, no
 * path column (the path is the selected tab's tooltip), no second row of tabs: the content starts right under it.
 *
 * One line, 32px, while it fits. The tabs give way first (they scroll); in a column too narrow for the right end beside a
 * few tabs (800px with the chat pinned leaves the page 72px), the right end moves to a line of its own and wraps there
 * rather than spill behind the chat. It is the view's header for the dock (`data-view-header`), the surface's first child.
 */
export function TopBar({ children, trailing, color = null, style, attrs }: {
    children: ReactNode;
    trailing?: ReactNode;
    /** The workspace's colour: the bar's left edge (genie#1300). */
    color?: string | null;
    style?: CSSProperties | undefined;
    attrs?: Record<string, string>;
}) {
    return (
        <nav
            data-view-header=""
            data-top-bar=""
            {...attrs}
            style={style}
            className={`@container flex min-h-8 shrink-0 flex-wrap items-stretch border-b border-[var(--border-1)] bg-[var(--bg-1)] pl-3${color ? ' border-l-4 border-l-[var(--ws)]' : ''}`}
        >
            <div data-bar-tabs="" className="flex h-8 min-w-[6rem] flex-1 basis-0 items-stretch overflow-x-auto">{children}</div>
            {trailing ? <div data-bar-trailing="" className="ml-auto flex h-8 min-w-0 max-w-full shrink-0 items-center gap-1 pl-2 pr-2">{trailing}</div> : null}
        </nav>
    );
}

/** An icon action in the bar: a react-fancy Button, named for a screen reader and on hover; no words beside the icon. */
export const BAR_ACTION = 'flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]';
