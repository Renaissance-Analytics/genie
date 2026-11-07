import { Button } from '@particle-academy/react-fancy';
import type { ReattachState } from '../reattach.js';

/**
 * THE WORKSPACE'S TERMINALS COMING BACK (the host split, P2.1): re-attaching… (busy), then how many came back, or why
 * none could with Retry. Nothing at all when there is nothing to say (idle, or no terminal was running).
 */
export function ReattachBanner({ state, onRetry }: { state: ReattachState; onRetry: () => void }) {
    if (state.phase === 'idle' || (state.phase === 'attached' && state.count === 0)) return null;
    if (state.phase === 'reattaching') {
        return (
            <div role="status" aria-busy="true" data-reattach="reattaching" className="flex items-center gap-2 px-2 py-1 text-[11px] text-[var(--fg-3)]">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" aria-hidden="true" />
                Re-attaching terminals…
            </div>
        );
    }
    if (state.phase === 'attached') {
        return (
            <div role="status" data-reattach="attached" className="px-2 py-1 text-[11px] text-[var(--fg-3)]">
                Re-attached {state.count} {state.count === 1 ? 'terminal' : 'terminals'}
            </div>
        );
    }
    return (
        <div role="alert" data-reattach="failed" className="flex items-center gap-2 px-2 py-1 text-[11px] text-[var(--danger,#d33)]">
            <span>Could not re-attach terminals: {state.reason}</span>
            <Button type="button" size="xs" data-action="reattach-retry" onClick={onRetry}>Retry</Button>
        </div>
    );
}
