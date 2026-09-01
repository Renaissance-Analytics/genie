import { useEffect, useState } from 'react';
import { IconAlert } from './icons';
import {
    AGENT_DELETE_CHOICES,
    agentDeleteConfirmLabel,
    type AgentDeleteMode,
} from '../../lib/agent-delete-prompt';

export interface AgentDeleteDecision {
    mode: AgentDeleteMode;
}

/**
 * The DELETE confirm dialog for an agent square (genie#311).
 *
 * Deliberately not a single destructive button: the issue is explicit that
 * "unmount" vs "delete" is a distinction a user cannot recover from if it is
 * guessed wrong, so this makes the human pick which one is meant before
 * anything happens. Copy comes from `agent-delete-prompt.ts` — a PURE model,
 * the same split `agent-card-menu.ts` uses for the menu itself — so what each
 * choice claims to keep and remove is testable without a DOM.
 *
 * Presentational only, mirroring `QuitTerminalsModal`: the parent owns the
 * IPC call and passes back `busy`/`error`. Reuses the shared
 * `prompt-scrim` / `prompt-card` / `prompt-btn` chrome rather than hand-rolling
 * another modal shell.
 *
 * Says nothing about Tynn. Genie has no per-agent Tynn record to act on, and a
 * control that cannot do what its label says is worse than no control at all
 * — a checkbox offering to "remove it from Tynn" was tried here and pulled
 * for exactly that reason (genie#311). A future issue can add it back once a
 * real per-agent Tynn link exists to act on.
 */
export default function AgentDeleteModal({
    agent,
    busy = false,
    error = null,
    onCancel,
    onConfirm,
}: {
    agent: { name: string };
    busy?: boolean;
    error?: string | null;
    onCancel: () => void;
    onConfirm: (decision: AgentDeleteDecision) => void;
}) {
    const [mode, setMode] = useState<AgentDeleteMode>('unmount');

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onCancel]);

    return (
        <div className="prompt-scrim" onMouseDown={onCancel}>
            <div
                className="prompt-card agent-delete-card"
                role="dialog"
                aria-modal="true"
                aria-label={`Delete ${agent.name}`}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="prompt-title">
                    <IconAlert size={15} />
                    Delete {agent.name}?
                </div>
                <div className="prompt-body">
                    Either way, every TUI for this agent is shut down and its terminal is
                    killed. The difference below is what happens to its files.
                </div>

                <div
                    className="agent-delete-choices"
                    role="radiogroup"
                    aria-label="How to delete this agent"
                >
                    {AGENT_DELETE_CHOICES.map((choice) => (
                        <label key={choice.mode} className="agent-form-wake agent-delete-choice">
                            <input
                                type="radio"
                                name="agent-delete-mode"
                                checked={mode === choice.mode}
                                disabled={busy}
                                onChange={() => setMode(choice.mode)}
                            />
                            <span className="agent-form-wake-text">
                                <span className="agent-form-label">{choice.label}</span>
                                <span className="agent-form-scope-desc">{choice.body}</span>
                            </span>
                        </label>
                    ))}
                </div>

                {error && <div className="agent-form-error">{error}</div>}

                <div className="prompt-actions">
                    <button
                        type="button"
                        className="prompt-btn"
                        onClick={onCancel}
                        disabled={busy}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className={`prompt-btn ${
                            mode === 'delete' ? 'prompt-btn-destructive' : 'prompt-btn-primary'
                        }`}
                        disabled={busy}
                        onClick={() => onConfirm({ mode })}
                    >
                        {busy ? 'Working…' : agentDeleteConfirmLabel(mode)}
                    </button>
                </div>
            </div>
        </div>
    );
}
