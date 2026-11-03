import { Button } from '@particle-academy/react-fancy';

/** A git read that failed, and the way to try it again: never an empty list that reads as "nothing changed". */
export function GitReadProblem({ reason, onRetry }: { reason: string; onRetry: () => void }) {
    return (
        <div data-git-read-problem role="alert" className="flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--danger)]">
            <span>{reason}</span>
            <Button type="button" size="xs" icon="rotate-ccw" data-git-read-retry="" onClick={onRetry}>Retry</Button>
        </div>
    );
}
