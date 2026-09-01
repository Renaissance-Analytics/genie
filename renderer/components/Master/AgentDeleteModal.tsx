import { useEffect, useState } from 'react';
import { IconAlert } from './icons';
import {
    AGENT_DELETE_CHOICES,
    agentDeleteConfirmLabel,
    type AgentDeleteMode,
} from '../../lib/agent-delete-prompt';

export interface AgentDeleteDecision {
    mode: AgentDeleteMode;
    removeFromTynn: boolean;
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
 */
export default function AgentDeleteModal({
    agent,
    tynnLinked,
    busy = false,
    error = null,
    note = null,
    onCancel,
    onConfirm,
    onDone,
}: {
    agent: { name: string };
    /** Whether this agent's workspace carries a live Tynn link — the opt-in
     *  to remove it there is offered only when there is something for it to
     *  plausibly mean. */
    tynnLinked: boolean;
    busy?: boolean;
    error?: string | null;
    /** Set once the delete has actually happened and there is something left
     *  to tell the human (e.g. the Tynn opt-in did not do anything). Showing
     *  it keeps this modal open one more beat instead of closing silently. */
    note?: string | null;
    onCancel: () => void;
    onConfirm: (decision: AgentDeleteDecision) => void;
    onDone: () => void;
}) {
    const [mode, setMode] = useState<AgentDeleteMode>('unmount');
    const [removeFromTynn, setRemoveFromTynn] = useState(false);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') (note ? onDone : onCancel)();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onCancel, onDone, note]);

    // The action already happened — this is just telling the human the one
    // thing the confirm couldn't have known yet (whether Tynn had anything to
    // remove). Never a silent close: see the module comment.
    if (note) {
        return (
            <div className="prompt-scrim" onMouseDown={onDone}>
                <div
                    className="prompt-card agent-delete-card"
                    role="dialog"
                    aria-modal="true"
                    aria-label={`${agent.name} deleted`}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <div className="prompt-title">{agent.name} — done</div>
                    <div className="prompt-body">{note}</div>
                    <div className="prompt-actions">
                        <button type="button" className="prompt-btn prompt-btn-primary" onClick={onDone}>
                            OK
                        </button>
                    </div>
                </div>
            </div>
        );
    }

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

                {mode === 'delete' && tynnLinked && (
                    <label className="agent-form-wake">
                        <input
                            type="checkbox"
                            checked={removeFromTynn}
                            disabled={busy}
                            onChange={(e) => setRemoveFromTynn(e.target.checked)}
                        />
                        <span className="agent-form-wake-text">
                            <span className="agent-form-label">Also remove it from Tynn</span>
                            <span className="agent-form-scope-desc">
                                This workspace is linked to Tynn. Left unchecked, nothing
                                changes there.
                            </span>
                        </span>
                    </label>
                )}

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
                        onClick={() =>
                            onConfirm({ mode, removeFromTynn: mode === 'delete' && removeFromTynn })
                        }
                    >
                        {busy ? 'Working…' : agentDeleteConfirmLabel(mode)}
                    </button>
                </div>
            </div>
        </div>
    );
}
