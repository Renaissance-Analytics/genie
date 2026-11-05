import { Button, Icon } from '@particle-academy/react-fancy';

/** What a page can do now, as its <webview> or view reports it. */
export interface SiteState {
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
    readonly loading: boolean;
}

export const NO_SITE_STATE: SiteState = { canGoBack: false, canGoForward: false, loading: false };

export interface SingleSiteBarProps {
    readonly host: string;
    readonly state: SiteState;
    /** Where this bar is: a workspace tab's panel, or the browser's own `--single` window. */
    readonly where: 'panel' | 'window';
    readonly onBack: () => void;
    readonly onForward: () => void;
    readonly onReload: () => void;
    readonly onPop: () => void;
}

const button = 'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)] disabled:opacity-40 disabled:hover:bg-transparent';

/**
 * THE GENIE BROWSER'S UX FOR ONE SITE (the host split, P2b; the owner, 2026-11-03). One bar, in a workspace tab's panel and
 * in the browser's `--single` window: no tabs and no other sites. Moving between the two reloads the page (a page can't
 * cross processes; measured on Electron 45.2.2), and the button says so.
 */
export function SingleSiteBar(p: SingleSiteBarProps) {
    const inPanel = p.where === 'panel';
    const label = inPanel ? 'Pop out' : 'Back to the panel';
    return (
        <div data-site-bar={p.where} className="flex h-7 shrink-0 items-center gap-1 border-b border-[var(--border-1)] px-2 text-[11px]">
            <Button size="xs" labelClassName="contents" type="button" data-site-action="back" aria-label="Back" title="Back" disabled={!p.state.canGoBack} className={button} onClick={p.onBack}>
                <Icon name="chevron-left" size="xs" />
            </Button>
            <Button size="xs" labelClassName="contents" type="button" data-site-action="forward" aria-label="Forward" title="Forward" disabled={!p.state.canGoForward} className={button} onClick={p.onForward}>
                <Icon name="chevron-right" size="xs" />
            </Button>
            <Button size="xs" labelClassName="contents" type="button" data-site-action="reload" aria-label={`Reload ${p.host}`} title="Reload" className={button} onClick={p.onReload}>
                <Icon name="rotate-cw" size="xs" />
            </Button>
            {p.state.loading ? <span data-site-loading="" className="contents"><Icon name="loader" size="xs" className="animate-spin text-[var(--fg-3)]" /></span> : <Icon name="lock" size="xs" className="text-[var(--success)]" />}
            <span className="truncate font-mono text-[var(--fg-2)]">{p.host}</span>
            <span className="ml-auto flex items-center gap-1">
                <Button size="xs" labelClassName="contents" type="button" data-site-action="pop" title={`${label}: the page reloads there`} className={button} onClick={p.onPop}>
                    <Icon name="external-link" size="xs" />
                    {label}
                </Button>
            </span>
        </div>
    );
}
