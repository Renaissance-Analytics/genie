import { Button } from '@particle-academy/react-fancy';
import { useLayoutEffect, useRef, useState } from 'react';
import { siteLabel, sitesThatFit } from '../../core/browser-sites.js';

export interface BrowserSitesRowProps {
    readonly sites: readonly string[];
    /** The host on screen, if any: marked in the row, or on the "»" when it is behind it. */
    readonly current: string | null;
    readonly onOpen: (address: string) => void;
    /** Force how many chips show (a render test; the window measures). */
    readonly fit?: number;
    /** Each host's label from main (workspace name, and the site); a host without one falls back to a safe label. */
    readonly labels?: Readonly<Record<string, string>>;
    /**
     * The "»": main shows a NATIVE menu of these hosts at `at` (window content coordinates) and answers the one picked, or
     * null when it was dismissed (Esc, a click away). Native because main places the page (a native view) over the box
     * below this row, and a menu drawn in this page's DOM would sit under it (Tynn #900).
     */
    readonly onMore: (hosts: readonly string[], at: { x: number; y: number }) => Promise<string | null>;
}

const GAP = 6;
const MORE_WIDTH = 32;

/**
 * THE GENIE BROWSER'S SITE BAR: EXACTLY ONE ROW (Tynn #709). The sites that fit are chips, labelled by workspace name;
 * the rest are behind a "»" at the right edge, whose menu is main's native one (Tynn #900), and picking one navigates. Widths are measured once per set of
 * sites and the count is re-worked whenever the row is resized.
 */
export function BrowserSitesRow(p: BrowserSitesRowProps) {
    const row = useRef<HTMLDivElement | null>(null);
    const widths = useRef(new Map<string, number>());
    const [measured, setMeasured] = useState<number | null>(null);
    const key = p.sites.join('|');
    const forced = p.fit;
    const fit = forced ?? measured ?? p.sites.length;

    useLayoutEffect(() => {
        if (forced !== undefined) return;
        const el = row.current;
        if (!el) return;
        widths.current = new Map();
        setMeasured(null);
        const settle = () => {
            const chips = el.querySelectorAll<HTMLElement>('[data-browser-site]');
            chips.forEach((c) => { const h = c.getAttribute('data-browser-site'); if (h) widths.current.set(h, c.getBoundingClientRect().width); });
            if (!p.sites.every((h) => widths.current.has(h))) return false;
            const cs = getComputedStyle(el);
            const available = el.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
            setMeasured(sitesThatFit({ widths: p.sites.map((h) => widths.current.get(h) ?? 0), available, moreWidth: MORE_WIDTH, gap: GAP }));
            return true;
        };
        // First pass: every chip is drawn, so every width is read; later passes work from what is known.
        settle();
        const ro = new ResizeObserver(() => { if (!settle()) setMeasured(null); });
        ro.observe(el);
        return () => ro.disconnect();
    }, [key, forced]);

    // A chip drawn for the first time after a resize has no width yet: draw everything once, read, settle.
    useLayoutEffect(() => {
        if (forced !== undefined || measured !== null) return;
        const el = row.current;
        if (!el) return;
        el.querySelectorAll<HTMLElement>('[data-browser-site]').forEach((c) => { const h = c.getAttribute('data-browser-site'); if (h) widths.current.set(h, c.getBoundingClientRect().width); });
        if (!p.sites.every((h) => widths.current.has(h))) return;
        const cs = getComputedStyle(el);
        const available = el.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
        setMeasured(sitesThatFit({ widths: p.sites.map((h) => widths.current.get(h) ?? 0), available, moreWidth: MORE_WIDTH, gap: GAP }));
    }, [measured, forced, key]);

    const label = (host: string): string => p.labels?.[host] ?? siteLabel(host);
    const shown = p.sites.slice(0, fit);
    const hidden = p.sites.slice(fit);
    const behind = p.current !== null && hidden.includes(p.current);
    // Under the », at its left edge: the native menu opens there and the OS keeps it on screen.
    const more = async (button: HTMLElement) => {
        const r = button.getBoundingClientRect();
        const picked = await p.onMore(hidden, { x: r.left, y: r.bottom });
        if (picked !== null && hidden.includes(picked)) p.onOpen(`https://${picked}/`);
    };
    return (
        <div ref={row} data-browser-sites="" className="flex shrink-0 flex-nowrap items-center gap-1.5 overflow-hidden whitespace-nowrap border-b border-[var(--border-1)] px-2 py-1">
            {shown.map((host) => (
                <span key={host} data-browser-site={host} aria-current={p.current === host ? 'page' : undefined} className="shrink-0">
                    <Button variant="ghost" size="xs" type="button" title={label(host)} onClick={() => p.onOpen(`https://${host}/`)} className={`rounded-md px-2 py-0.5 text-[11px] hover:bg-[var(--bg-2)] ${p.current === host ? 'bg-[var(--bg-2)] text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}`}>
                        <span>{label(host)}</span>
                    </Button>
                </span>
            ))}
            {hidden.length > 0 ? (
                <span data-browser-sites-more="" {...(behind ? { 'data-current': 'true' } : {})} role="group" aria-label={`${hidden.length} more site${hidden.length === 1 ? '' : 's'}`} className="ml-auto shrink-0">
                    <Button variant="ghost" size="xs" labelClassName="contents" type="button" aria-haspopup="menu" aria-label={`${hidden.length} more site${hidden.length === 1 ? '' : 's'}`} title={`${hidden.length} more`} onClick={(e) => { void more(e.currentTarget); }} className={`flex w-8 items-center justify-center rounded-md px-1 py-0.5 text-[13px] hover:bg-[var(--bg-2)] ${behind ? 'bg-[var(--bg-2)] text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}`}>
                        <span aria-hidden="true">»</span>
                    </Button>
                </span>
            ) : null}
        </div>
    );
}
