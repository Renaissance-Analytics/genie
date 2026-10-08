import { Text } from '@particle-academy/react-fancy';
import type { ToolCall } from '../../../main/agentsession/model';
import { inspectorFor } from '../../lib/tool-inspector';

/**
 * THE INSPECTOR — a fixed pane showing one tool call's arguments and result.
 *
 * §5.2's *"every tool call with its arguments and result"*, and the structural half of the
 * no-content-jumping rule: expansion happens HERE, never in the stream. Opening a row fills
 * this pane and the stream's scroll position does not move. That is the actual cure — the
 * usual one, "collapse long things", fails because the collapsed thing still reflows as it
 * grows.
 *
 * FIXED HEIGHT, deliberately. A pane that grew with its content would push the stream around
 * on every selection, which is the same defect arriving from below instead of above.
 *
 * ## The diff is supported and unproven
 *
 * The board draws a selected edit opening as a diff. `lib/tool-inspector.ts` reads ACP's `diff`
 * content variant when it arrives, and claude sent one in none of the captured turns — it sends
 * a text confirmation. So this renders the diff when there is one and says what it has
 * otherwise, rather than implying a diff is missing when none was ever sent.
 */
export function ToolInspector({
    call,
    onClose,
}: {
    /** The selected call, or null when nothing is selected. */
    call: ToolCall | null;
    onClose?: () => void;
}): React.JSX.Element | null {
    if (!call) return null;
    const view = inspectorFor(call);

    return (
        <div className="tool-inspector" data-kind={call.kind ?? undefined}>
            <div className="tool-inspector-head">
                <Text size="xs" className="tool-inspector-name">
                    {call.name}
                </Text>
                {/* The status, because a pane showing a failed call's arguments without saying
                    it failed invites reading them as what succeeded. */}
                <Text size="xs" className="tool-inspector-status" data-status={call.status}>
                    {call.status}
                </Text>
                <div className="tool-inspector-spacer" />
                {onClose ? (
                    <button type="button" className="tool-inspector-close" onClick={onClose} aria-label="Close inspector">
                        ×
                    </button>
                ) : null}
            </div>

            <div className="tool-inspector-body">
                {view.diff ? (
                    <section className="tool-inspector-pane">
                        <Text size="xs" className="tool-inspector-label">
                            {view.diff.path}
                        </Text>
                        <pre className="tool-inspector-pre">{view.diff.newText}</pre>
                    </section>
                ) : null}

                {view.args ? (
                    <section className="tool-inspector-pane">
                        <Text size="xs" className="tool-inspector-label">
                            Arguments
                        </Text>
                        <pre className="tool-inspector-pre">{view.args}</pre>
                    </section>
                ) : null}

                {view.result ? (
                    <section className="tool-inspector-pane">
                        <Text size="xs" className="tool-inspector-label">
                            Result
                        </Text>
                        <pre className="tool-inspector-pre">{view.result}</pre>
                    </section>
                ) : null}

                {/* NOT "nothing to show". A pending call genuinely has no result yet, and a
                    completed one may report none — both are facts about the call, and saying
                    which is the difference between a fact and a shrug. */}
                {!view.args && !view.result && !view.diff ? (
                    <Text size="xs" className="tool-inspector-empty">
                        {call.status === 'pending'
                            ? 'Running — no arguments or result reported yet.'
                            : 'This call reported no arguments and no result.'}
                    </Text>
                ) : null}
            </div>
        </div>
    );
}
