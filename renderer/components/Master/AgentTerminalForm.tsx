import { useMemo, useState } from 'react';
import {
    workspaceSlug,
    type AgentType,
    type WhisperScope,
    type WorkspaceRow,
} from '../../lib/genie';

/**
 * The shared create/edit form for a specialized (AI-agent) terminal's WhisperChat
 * identity — Purpose, accessibility Scope, the workspace multiselect (when scope
 * is `specific`), and a command field for a `custom` agent. Modelled on the inline
 * Add-Process form. Used both by the split-button create popover and the
 * context-menu "Agent settings…" edit modal, so the fields + scope copy + the live
 * `slug:purpose` preview stay identical between create and edit.
 */

export interface AgentFormValues {
    purpose: string;
    scope: WhisperScope;
    scopeWorkspaces: string[];
    /** Only meaningful for a `custom` agent. */
    command: string;
    /** Opt-in: a direct whisper to this agent while it's idle injects a nudge so it
     *  starts a turn and reads the message (issue #9). Default off. */
    wakeOnDm: boolean;
    /** Opt-in: this agent participates in its workspace's IssueWatch pings. Off by
     *  default — no ping is delivered. */
    issuewatchHandle: boolean;
    /** How the agent reacts to an IssueWatch ping — `notify` glows its terminal;
     *  `wake` injects an idle-only nudge. Only meaningful when handling is on. */
    issuewatchAction: 'notify' | 'wake';
}

const SCOPE_OPTIONS: Array<{ value: WhisperScope; label: string; desc: string }> = [
    {
        value: 'none',
        label: 'None — hidden',
        desc: 'Hidden — no other agent can discover or DM this one. It can still join a channel and broadcast.',
    },
    {
        value: 'self',
        label: 'This workspace (default)',
        desc: 'This workspace only — agents in the same workspace can discover and DM it.',
    },
    {
        value: 'specific',
        label: 'Specific workspaces',
        desc: 'Only the workspaces you pick — plus its own workspace.',
    },
    {
        value: 'all',
        label: 'All — whole workstation',
        desc: 'Whole workstation — every agent, in any workspace, can discover and DM it.',
    },
];

/** Live auto-kebab a purpose, capped at 6 words (dash segments). */
function kebabPurpose(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '');
}

function purposeWordCount(kebab: string): number {
    return kebab.split('-').filter(Boolean).length;
}

/** The purpose committed on submit (trailing dashes stripped, defaulted). */
export function normalizePurpose(raw: string): string {
    return kebabPurpose(raw).replace(/-+$/, '') || 'general';
}

export default function AgentTerminalForm({
    agent,
    workspaces,
    ownWorkspaceId,
    initial,
    submitLabel,
    busy,
    error,
    onSubmit,
    onCancel,
    customPlaceholder,
}: {
    agent: AgentType;
    workspaces: WorkspaceRow[];
    ownWorkspaceId: string | null;
    initial?: Partial<AgentFormValues>;
    submitLabel: string;
    busy?: boolean;
    error?: string | null;
    onSubmit: (v: AgentFormValues) => void;
    onCancel: () => void;
    customPlaceholder?: string;
}) {
    const [purpose, setPurpose] = useState(() => initial?.purpose ?? '');
    const [scope, setScope] = useState<WhisperScope>(() => initial?.scope ?? 'self');
    const [scopeWorkspaces, setScopeWorkspaces] = useState<string[]>(
        () => initial?.scopeWorkspaces ?? [],
    );
    const [command, setCommand] = useState(() => initial?.command ?? '');
    const [wakeOnDm, setWakeOnDm] = useState(() => initial?.wakeOnDm ?? false);
    const [issuewatchHandle, setIssuewatchHandle] = useState(
        () => initial?.issuewatchHandle ?? false,
    );
    const [issuewatchAction, setIssuewatchAction] = useState<'notify' | 'wake'>(
        () => initial?.issuewatchAction ?? 'notify',
    );

    const ownWorkspace = useMemo(
        () => workspaces.find((w) => w.id === ownWorkspaceId),
        [workspaces, ownWorkspaceId],
    );
    // Other workspaces the `specific` scope can add (its own is always in scope).
    const otherWorkspaces = useMemo(
        () => workspaces.filter((w) => w.id !== ownWorkspaceId),
        [workspaces, ownWorkspaceId],
    );

    const slug = ownWorkspace ? workspaceSlug(ownWorkspace) : 'workspace';
    const previewPurpose = normalizePurpose(purpose);
    const scopeDesc = SCOPE_OPTIONS.find((o) => o.value === scope)?.desc ?? '';

    const onPurposeChange = (raw: string) => {
        const k = kebabPurpose(raw);
        // Block the 7th word rather than silently truncating mid-type.
        if (purposeWordCount(k) > 6) return;
        setPurpose(k);
    };

    const toggleWorkspace = (id: string) => {
        setScopeWorkspaces((prev) =>
            prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id],
        );
    };

    const commandRequired = agent === 'custom';
    const canSubmit = !busy && (!commandRequired || command.trim().length > 0);

    const submit = () => {
        if (!canSubmit) return;
        onSubmit({
            purpose: previewPurpose,
            scope,
            scopeWorkspaces: scope === 'specific' ? scopeWorkspaces : [],
            command: command.trim(),
            wakeOnDm,
            issuewatchHandle,
            issuewatchAction,
        });
    };

    return (
        <div className="agent-form">
            <label className="agent-form-field">
                <span className="agent-form-label">Purpose</span>
                <input
                    className="input"
                    autoFocus
                    value={purpose}
                    onChange={(e) => onPurposeChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') submit();
                        if (e.key === 'Escape') onCancel();
                    }}
                    placeholder="general"
                    spellCheck={false}
                />
            </label>

            <label className="agent-form-field">
                <span className="agent-form-label">Who can reach this agent</span>
                <select
                    className="input"
                    value={scope}
                    onChange={(e) => setScope(e.target.value as WhisperScope)}
                >
                    {SCOPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
            </label>
            <div className="agent-form-scope-desc">{scopeDesc}</div>

            {scope === 'specific' && (
                <div className="agent-form-ws">
                    {ownWorkspace && (
                        <label className="agent-form-ws-row is-own">
                            <input type="checkbox" checked disabled />
                            <span>
                                {ownWorkspace.project_name}
                                <span className="agent-form-ws-note"> (this workspace)</span>
                            </span>
                        </label>
                    )}
                    {otherWorkspaces.length === 0 ? (
                        <div className="agent-form-scope-desc">No other workspaces.</div>
                    ) : (
                        otherWorkspaces.map((w) => (
                            <label key={w.id} className="agent-form-ws-row">
                                <input
                                    type="checkbox"
                                    checked={scopeWorkspaces.includes(w.id)}
                                    onChange={() => toggleWorkspace(w.id)}
                                />
                                <span>{w.project_name}</span>
                            </label>
                        ))
                    )}
                </div>
            )}

            {commandRequired && (
                <label className="agent-form-field">
                    <span className="agent-form-label">Command</span>
                    <input
                        className="input"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') submit();
                            if (e.key === 'Escape') onCancel();
                        }}
                        placeholder={customPlaceholder || 'e.g. my-agent --interactive'}
                        spellCheck={false}
                    />
                </label>
            )}

            <label className="agent-form-wake">
                <input
                    type="checkbox"
                    checked={wakeOnDm}
                    onChange={(e) => setWakeOnDm(e.target.checked)}
                />
                <span className="agent-form-wake-text">
                    <span className="agent-form-label">Wake on direct whisper</span>
                    <span className="agent-form-scope-desc">
                        When this agent is idle, a direct whisper injects a one-line nudge so it
                        starts a turn and reads it — no manual check needed. Only ever fires when
                        it's provably idle at its prompt, so it can't interrupt a running turn.
                    </span>
                </span>
            </label>

            <label className="agent-form-wake">
                <input
                    type="checkbox"
                    checked={issuewatchHandle}
                    onChange={(e) => setIssuewatchHandle(e.target.checked)}
                />
                <span className="agent-form-wake-text">
                    <span className="agent-form-label">Handle IssueWatch pings</span>
                    <span className="agent-form-scope-desc">
                        When a watched GitHub issue, PR, or alert changes in this workspace, ping
                        this agent so it can react. If the workspace designates specific handlers,
                        only those are pinged; otherwise every agent that handles pings is.
                    </span>
                </span>
            </label>

            {issuewatchHandle && (
                <label className="agent-form-field">
                    <span className="agent-form-label">On a ping</span>
                    <select
                        className="input"
                        value={issuewatchAction}
                        onChange={(e) =>
                            setIssuewatchAction(e.target.value as 'notify' | 'wake')
                        }
                    >
                        <option value="notify">Notify — glow this terminal</option>
                        <option value="wake">Wake — nudge a turn when idle</option>
                    </select>
                    <span className="agent-form-scope-desc">
                        {issuewatchAction === 'wake'
                            ? 'Injects a one-line nudge so an idle agent starts a turn and looks — only when it is provably idle, never mid-turn.'
                            : 'Glows this terminal in the sidebar so you (or the agent) notice on the next turn — nothing is injected.'}
                    </span>
                </label>
            )}

            <div className="agent-form-preview">
                Channel: <code>{`${slug}:${previewPurpose}`}</code>
            </div>

            {error && <div className="agent-form-error">{error}</div>}

            <div className="agent-form-actions">
                <button
                    type="button"
                    className="agent-form-btn"
                    onClick={onCancel}
                    disabled={busy}
                >
                    Cancel
                </button>
                <button
                    type="button"
                    className="agent-form-btn agent-form-go"
                    onClick={submit}
                    disabled={!canSubmit}
                >
                    {busy ? 'Working…' : submitLabel}
                </button>
            </div>
        </div>
    );
}
