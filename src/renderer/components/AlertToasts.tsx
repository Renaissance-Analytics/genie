import { Button } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { WorkspaceSwatch } from '../workspace-colors.js';
import { personText } from '../../core/person-text.js';
import { limitStack } from '../../core/approval-toasts.js';

/**
 * GENIE'S OWN ALERT TOASTS, BOTTOM-LEFT (genie#1211; the owner, 2026-10-26: "move this toast to the left side. it's
 * annoying when it covers the chat"). While Genie's window has focus an alert shows here, clear of the docked chat; the
 * OS notification is only for when Genie is behind another app (App.tsx, core/alerts.ts alertDelivery).
 *
 * Since Tynn #730 it is drawn in the SAME column as the approval toasts (ToastColumn), above them, so the two never overlap,
 * with the same rule: three drawn, the rest "+N more", which expands. Newest nearest the corner.
 */
export interface AlertToast {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    /** The alerting agent's workspace colour (genie#1300), beside its address. Absent = none (Genie's own, or not known). */
    readonly color?: string | undefined;
    /** One click that does the thing the toast is about (Tynn #722: Show terminal). Absent = the toast only informs. */
    readonly action?: { readonly label: string; readonly run: () => void } | undefined;
}

export function AlertToasts({ toasts, onDismiss }: { toasts: readonly AlertToast[]; onDismiss: (id: string) => void }) {
    const [expanded, setExpanded] = useState(false);
    if (toasts.length === 0) return null;
    const { shown, more, expanded: open } = limitStack([...toasts].reverse(), expanded);
    return (
        <div data-alert-toasts="" role="status" aria-live="polite" className="pointer-events-none flex flex-col-reverse gap-2">
            {shown.map((t) => (
                <div key={t.id} data-alert-toast={t.id} className="pointer-events-auto flex items-start gap-2 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] px-3 py-2 text-[13px] shadow-lg">
                    <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate font-medium"><WorkspaceSwatch color={t.color} /><span className="truncate">{personText(t.title)}</span></p>
                        <p className="line-clamp-3 text-[var(--fg-3)]">{personText(t.body)}</p>
                        {t.action ? <Button size="xs" type="button" data-alert-toast-action={t.id} className="mt-1" onClick={() => { t.action?.run(); onDismiss(t.id); }}>{t.action.label}</Button> : null}
                    </div>
                    <Button size="xs" type="button" data-alert-toast-dismiss={t.id} aria-label="Dismiss" className="shrink-0 text-[var(--fg-4)] hover:text-[var(--fg-2)]" onClick={() => onDismiss(t.id)}>×</Button>
                </div>
            ))}
            {more > 0 ? (
                <Button type="button" size="xs" data-alert-more={more} className="pointer-events-auto self-start rounded-full border border-[var(--border-1)] bg-[var(--bg-1)] px-3 shadow-lg" onClick={() => setExpanded(true)}>
                    {`+${more} more`}
                </Button>
            ) : open ? (
                <Button type="button" size="xs" data-alert-fewer="" className="pointer-events-auto self-start rounded-full border border-[var(--border-1)] bg-[var(--bg-1)] px-3 shadow-lg" onClick={() => setExpanded(false)}>
                    Show fewer
                </Button>
            ) : null}
        </div>
    );
}
