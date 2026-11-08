import { Button } from '@particle-academy/react-fancy';

/**
 * WHAT THE HOST REFUSED (Tynn #529). A window driving another machine sends most writes as fire-and-forget; the host's
 * refusal had nowhere to show, so a click with no baton did nothing the person could see. The last refusal is said here,
 * under the title bar, and one for lack of the baton has Take control right beside it.
 */
export function RemoteRefusalBar({ refusal, needsBaton, driver, onTakeControl, onDismiss }: {
    readonly refusal: string | null;
    readonly needsBaton: boolean;
    readonly driver: string | null;
    readonly onTakeControl: () => void;
    readonly onDismiss: () => void;
}) {
    if (!refusal) return null;
    return (
        <div data-remote-refusal="" role="status" className="flex shrink-0 items-center gap-3 border-b border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-1.5 text-[12px] text-[var(--fg-1)]">
            <span className="min-w-0 flex-1 truncate">{refusal}</span>
            {needsBaton ? (
                <Button size="xs" type="button" data-action="take-control" onClick={onTakeControl} className="rounded border border-[var(--warning)]/40 px-2 py-0.5 text-[12px] font-medium text-[var(--warning)] hover:bg-[var(--warning)]/20">
                    {driver ? `Take control from ${driver}` : 'Take control'}
                </Button>
            ) : null}
            <Button size="xs" variant="ghost" type="button" data-action="dismiss-refusal" onClick={onDismiss} className="rounded px-2 py-0.5 text-[12px] text-[var(--fg-3)] hover:bg-[var(--bg-2)]">Dismiss</Button>
        </div>
    );
}
