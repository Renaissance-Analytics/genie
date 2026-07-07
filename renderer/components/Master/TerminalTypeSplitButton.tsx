import { useEffect, useRef, useState } from 'react';
import { IconChevronDown, IconCode } from './icons';
import AgentTerminalForm, { type AgentFormValues } from './AgentTerminalForm';
import {
    api,
    type AgentType,
    type TerminalSpec,
    type ViewType,
    type WorkspaceRow,
} from '../../lib/genie';
import {
    TERMINAL_TYPES,
    terminalTypeById,
    type TerminalTypeId,
} from '../../lib/terminal-types';

/**
 * The split "Add Terminal" button — generalizes the old AddViewButton. The MAIN
 * button repeats the LAST-USED terminal type (`settings.last_terminal_type`,
 * default `regular`); the caret opens the full type registry (Regular / Claude
 * Code / Codex / Custom). Picking a plain terminal creates it straight away;
 * picking a SPECIALIZED type opens an inline WhisperChat form (purpose / scope /
 * command) that calls `terminalSpec.createAgent`. "Add Files…" (an editor) stays a
 * DISTINCT action — in the toolbar it rides in this menu (`includeFiles`), and in
 * the sidebar it keeps its own adjacent button. Closes on outside-click / Escape.
 */
export default function TerminalTypeSplitButton({
    disabled,
    disabledReason,
    workspaceId,
    workspaces,
    lastType,
    onLastTypeChange,
    onAddView,
    onAgentCreated,
    customCommand,
    includeFiles,
    variant = 'toolbar',
}: {
    disabled: boolean;
    disabledReason?: string;
    /** The workspace new terminals are created into. */
    workspaceId: string | null;
    /** All workspaces (for the `specific`-scope multiselect + slug preview). */
    workspaces: WorkspaceRow[];
    /** Persisted last-used type id (drives the main button). */
    lastType: TerminalTypeId;
    /** Persist a new last-used type. */
    onLastTypeChange: (id: TerminalTypeId) => void;
    /** Create a plain view — 'terminal' (regular) or 'code' (Add Files…). */
    onAddView: (type: ViewType) => void;
    /** A specialized agent spec was created — select it into view. */
    onAgentCreated: (spec: TerminalSpec) => void;
    /** The configured custom-agent command (placeholder for the command field). */
    customCommand?: string;
    /** Include an "Add Files…" (editor) entry in the dropdown (toolbar only). */
    includeFiles?: boolean;
    variant?: 'toolbar' | 'row';
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [formAgent, setFormAgent] = useState<AgentType | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const ref = useRef<HTMLDivElement>(null);

    const open = menuOpen || formAgent !== null;
    useEffect(() => {
        if (!open) return;
        const onAway = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) {
                setMenuOpen(false);
                setFormAgent(null);
            }
        };
        const onEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setMenuOpen(false);
                setFormAgent(null);
            }
        };
        document.addEventListener('mousedown', onAway);
        document.addEventListener('keydown', onEsc);
        return () => {
            document.removeEventListener('mousedown', onAway);
            document.removeEventListener('keydown', onEsc);
        };
    }, [open]);

    const lastDef = terminalTypeById(lastType);

    /** Act on a picked terminal type: plain → create now, specialized → open form. */
    const pickType = (id: TerminalTypeId) => {
        setMenuOpen(false);
        const def = terminalTypeById(id);
        if (def.specialized && def.agent) {
            setError(null);
            setFormAgent(def.agent);
        } else {
            onAddView('terminal');
            onLastTypeChange('regular');
        }
    };

    const addFiles = () => {
        setMenuOpen(false);
        onAddView('code');
    };

    const submitForm = async (agent: AgentType, values: AgentFormValues) => {
        setBusy(true);
        setError(null);
        try {
            const res = await api().terminalSpec.createAgent({
                workspace_id: workspaceId,
                agent,
                // custom REQUIRES a command; for claude/codex an explicit command
                // overrides the server-resolved default when the user typed one.
                command: values.command || undefined,
                purpose: values.purpose,
                scope: values.scope,
                scope_workspaces:
                    values.scope === 'specific' ? values.scopeWorkspaces : undefined,
            });
            if (res.ok && res.spec) {
                onAgentCreated(res.spec);
                onLastTypeChange(agent);
                setFormAgent(null);
            } else {
                setError(res.error || 'Could not create the agent terminal.');
            }
        } catch {
            setError('Could not create the agent terminal.');
        } finally {
            setBusy(false);
        }
    };

    const LastIcon = lastDef.icon;

    return (
        <div
            className={`addview-split${variant === 'row' ? ' addview-row' : ''}`}
            ref={ref}
            title={disabled ? disabledReason : undefined}
        >
            <button
                type="button"
                className="gbtn accent addview-main"
                onClick={() => pickType(lastDef.id)}
                disabled={disabled}
                title={disabled ? disabledReason : `Add ${lastDef.label}`}
            >
                <LastIcon size={14} /> Add {lastDef.label}
            </button>
            <button
                type="button"
                className="gbtn accent addview-caret"
                onClick={() => {
                    setFormAgent(null);
                    setMenuOpen((o) => !o);
                }}
                disabled={disabled}
                title="Choose a terminal type"
                aria-label="Choose a terminal type"
            >
                <IconChevronDown size={13} />
            </button>

            {menuOpen && (
                <div
                    className={`addview-menu addview-type-menu${
                        variant === 'row' ? ' anchor-left' : ''
                    }`}
                    role="menu"
                >
                    {TERMINAL_TYPES.map((t) => {
                        const Ico = t.icon;
                        return (
                            <button
                                key={t.id}
                                type="button"
                                role="menuitem"
                                className="addview-type-item"
                                onClick={() => pickType(t.id)}
                            >
                                <Ico size={14} />
                                <span className="addview-type-main">
                                    <span className="addview-type-label">{t.label}</span>
                                    {t.hint && (
                                        <span className="addview-type-hint">{t.hint}</span>
                                    )}
                                </span>
                            </button>
                        );
                    })}
                    {includeFiles && (
                        <>
                            <div className="addview-menu-divider" />
                            <button
                                type="button"
                                role="menuitem"
                                className="addview-type-item"
                                onClick={addFiles}
                            >
                                <IconCode size={14} />
                                <span className="addview-type-main">
                                    <span className="addview-type-label">Add Files…</span>
                                    <span className="addview-type-hint">
                                        Open a file editor
                                    </span>
                                </span>
                            </button>
                        </>
                    )}
                </div>
            )}

            {formAgent && (
                <div
                    className={`addview-menu addview-form-pop${
                        variant === 'row' ? ' anchor-left' : ''
                    }`}
                    role="dialog"
                    aria-label={`New ${terminalTypeById(formAgent).label}`}
                >
                    <div className="addview-form-title">
                        New {terminalTypeById(formAgent).label}
                    </div>
                    <AgentTerminalForm
                        agent={formAgent}
                        workspaces={workspaces}
                        ownWorkspaceId={workspaceId}
                        submitLabel="Create"
                        busy={busy}
                        error={error}
                        customPlaceholder={customCommand}
                        onSubmit={(v) => void submitForm(formAgent, v)}
                        onCancel={() => setFormAgent(null)}
                    />
                </div>
            )}
        </div>
    );
}
