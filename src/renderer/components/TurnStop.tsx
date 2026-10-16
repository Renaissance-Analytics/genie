import { Icon } from '@particle-academy/react-fancy';

/**
 * `STOP THIS TURN` — the one turn Stop, drawn where the running turn is shown: beside the Agent view's state pill
 * (`Turn 14 · running`) and on the chat's context line (`Working · …`). It ends the TURN; the agent keeps running and the
 * next message goes to the same session. Ending the agent is "Stop agent" in the agent's operations menu, and nothing
 * here reaches it.
 *
 * It used to be a `[Stop]` under the composer's Send that ended the whole session (the owner, 2026-10-15: "it killed the
 * agent, not stopping the chat" — and the placement was "bad UX"). Fancy's `PromptInput` has no stop or abort
 * affordance to swap its send button for (react-fancy 5.37.0 and 5.38.0: no such prop), so the Stop sits with the
 * turn's status instead of under the composer.
 *
 * Hook-free, so a test presses it without a DOM. Only drawn when `turnStopOffered` says the turn CAN be stopped.
 */
export function TurnStop({ onStop, agentName, className }: { onStop: () => void; agentName?: string | undefined; className?: string | undefined }) {
    return (
        <button
            type="button"
            data-action="stop-turn"
            title={`Stop this turn — ${agentName ?? 'the agent'} keeps running`}
            onClick={() => onStop()}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs text-[var(--fg-1)] hover:bg-[var(--bg-2)] ${className ?? ''}`}
        >
            <Icon name="square" size="xs" />
            Stop this turn
        </button>
    );
}
