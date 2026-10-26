import { useLayoutEffect, useRef, useState } from 'react';
import type { MailSignal } from '../../core/mail-signals.js';

/**
 * THE MAIL BETWEEN AGENTS, DRAWN ON THE BOARD (genie#1209). Each signal is a dot that travels down (or up) the left
 * gutter from the sender's row to the recipient's, over ~1.2 s; once the recipient has read it, the recipient's end shows
 * ✓. Rows are found by their `data-agent`; a signal whose rows are not on screen (another group, hibernated) is kept in
 * the markup for what it says but draws nothing.
 */
export function MailSignalLayer({ signals }: { signals: readonly MailSignal[] }) {
    const layer = useRef<HTMLDivElement | null>(null);
    const [ys, setYs] = useState<Readonly<Record<string, { from: number; to: number }>>>({});
    const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
    useLayoutEffect(() => {
        const host = layer.current?.parentElement;
        if (!host) return;
        const top = host.getBoundingClientRect().top - host.scrollTop;
        const centre = (id: string): number | null => {
            const el = host.querySelector<HTMLElement>(`[data-agent="${CSS.escape(id)}"]`);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return r.top - top + r.height / 2;
        };
        const next: Record<string, { from: number; to: number }> = {};
        for (const s of signals) {
            const from = centre(s.from);
            const to = centre(s.to);
            if (from !== null && to !== null) next[s.id] = { from, to };
        }
        setYs(next);
        // One frame at the sender's row, then the transition carries the dot to the recipient's.
        const raf = requestAnimationFrame(() => setArrived(new Set(signals.map((s) => s.id))));
        return () => cancelAnimationFrame(raf);
    }, [signals]);
    if (signals.length === 0) return null;
    return (
        <div ref={layer} data-mail-signals="" aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
            {signals.map((s) => {
                const y = ys[s.id];
                const at = y ? (arrived.has(s.id) ? y.to : y.from) : null;
                return (
                    <span key={s.id} data-mail-signal={s.id} data-from={s.from} data-to={s.to} data-read={s.readAt !== null ? 'true' : 'false'}>
                        {at !== null ? (
                            <span
                                className="absolute left-2 h-2 w-2 -translate-y-1/2 rounded-full bg-[var(--violet-400)] shadow-[0_0_8px_var(--violet-400)] transition-[top] duration-[1200ms] ease-in-out"
                                style={{ top: at }}
                            />
                        ) : null}
                        {y && s.readAt !== null ? (
                            <span className="absolute left-4 -translate-y-1/2 text-[11px] font-semibold text-[var(--success)]" style={{ top: y.to }} title="read">✓</span>
                        ) : null}
                    </span>
                );
            })}
        </div>
    );
}
