import { Button, Dropdown, Icon } from '@particle-academy/react-fancy';
import { useLayoutEffect, useRef, useState } from 'react';
import { siteLabel, sitesThatFit } from '../../core/browser-sites.js';

export interface BrowserSitesRowProps {
    readonly sites: readonly string[];
    /** The host on screen, if any: marked in the row, or on the "»" when it is behind it. */
    readonly current: string | null;
    readonly onOpen: (address: string) => void;
    /** Force how many chips show (a render test; the window measures). */
    readonly fit?: number;
}

const GAP = 6;
const MORE_WIDTH = 32;

/**
 * THE GENIE BROWSER'S SITE BAR: EXACTLY ONE ROW (Tynn #709). The sites that fit are chips, labelled by workspace name;
 * the rest are behind a "»" dropdown at the right edge, and picking one navigates. Widths are measured once per set of
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

    const shown = p.sites.slice(0, fit);
    const hidden = p.sites.slice(fit);
    const behind = p.current !== null && hidden.includes(p.current);
    return (
        <div ref={row} data-browser-sites="" className="flex shrink-0 flex-nowrap items-center gap-1.5 overflow-hidden whitespace-nowrap border-b border-[var(--border-1)] px-2 py-1">
            {shown.map((host) => (
                <Button variant="ghost" size="xs" key={host} type="button" data-browser-site={host} title={host} aria-current={p.current === host ? 'page' : undefined} onClick={() => p.onOpen(`https://${host}/`)} className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] hover:bg-[var(--bg-2)] ${p.current === host ? 'bg-[var(--bg-2)] text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}`}>
                    <span>{siteLabel(host)}</span>
                </Button>
            ))}
            {hidden.length > 0 ? (
                <span className="ml-auto shrink-0">
                    <Dropdown placement="bottom-end">
                        <Dropdown.Trigger>
                            <Button variant="ghost" size="xs" labelClassName="contents" type="button" data-browser-sites-more="" {...(behind ? { 'data-current': 'true' } : {})} aria-label={`${hidden.length} more site${hidden.length === 1 ? '' : 's'}`} title={`${hidden.length} more`} className={`flex w-8 items-center justify-center rounded-md px-1 py-0.5 text-[13px] hover:bg-[var(--bg-2)] ${behind ? 'bg-[var(--bg-2)] text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}`}>
                                <span aria-hidden="true">»</span>
                            </Button>
                        </Dropdown.Trigger>
                        <Dropdown.Items>
                            {hidden.map((host) => (
                                <Dropdown.Item key={host} data-browser-site-more={host} aria-current={p.current === host ? 'page' : undefined} onClick={() => p.onOpen(`https://${host}/`)}>
                                    <span className="flex items-center gap-1.5 text-xs">{p.current === host ? <Icon name="check" size="xs" /> : null}{siteLabel(host)}</span>
                                </Dropdown.Item>
                            ))}
                        </Dropdown.Items>
                    </Dropdown>
                </span>
            ) : null}
        </div>
    );
}
