/**
 * GENIE'S OWN ALERT TOASTS, BOTTOM-LEFT (genie#1211; the owner, 2026-10-26: "move this toast to the left side. it's
 * annoying when it covers the chat"). While Genie's window has focus an alert shows here, clear of the docked chat; the
 * OS notification is only for when Genie is behind another app (App.tsx, core/alerts.ts alertDelivery).
 */
export interface AlertToast {
    readonly id: string;
    readonly title: string;
    readonly body: string;
}

export function AlertToasts({ toasts, onDismiss }: { toasts: readonly AlertToast[]; onDismiss: (id: string) => void }) {
    if (toasts.length === 0) return null;
    return (
        <div data-alert-toasts="" role="status" aria-live="polite" className="pointer-events-none fixed bottom-4 left-4 z-40 flex w-[340px] flex-col gap-2">
            {toasts.map((t) => (
                <div key={t.id} data-alert-toast={t.id} className="pointer-events-auto flex items-start gap-2 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] px-3 py-2 text-[13px] shadow-lg">
                    <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{t.title}</p>
                        <p className="line-clamp-3 text-[var(--fg-3)]">{t.body}</p>
                    </div>
                    <button type="button" data-alert-toast-dismiss={t.id} aria-label="Dismiss" className="shrink-0 text-[var(--fg-4)] hover:text-[var(--fg-2)]" onClick={() => onDismiss(t.id)}>×</button>
                </div>
            ))}
        </div>
    );
}
