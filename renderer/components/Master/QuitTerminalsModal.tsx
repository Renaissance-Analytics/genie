import { useEffect, useMemo, useState } from 'react';
import type { TerminalSpec, WorkspaceRow } from '../../lib/genie';
import { IconAlert } from './icons';

/**
 * Manual-quit terminal confirmation (T3). Shown when the user quits Genie while
 * the detached pty-host is active and ≥1 terminal would keep running in the
 * background. Warns that those terminals SURVIVE the quit and lets the user pick,
 * per-terminal, which to KEEP RUNNING vs SHUT DOWN.
 *
 * DEFAULT: every terminal kept running (that's the point of T3 — detached
 * terminals outlive a quit). The user unchecks the ones they want shut down.
 *
 * Buttons:
 *   - "Quit, keep checked running" (primary) → confirm with the checked ids.
 *   - "Cancel"                               → abort the quit, stay open.
 *   - "Shut all down & quit" (convenience)   → confirm with NO kept ids.
 *
 * Presentational only: the parent (master.tsx) owns the IPC — it feeds the live
 * terminals + the spec join, and handles the decision via app.quitDecision().
 * Mirrors the Prompt.tsx dark-chrome modal styling (prompt-scrim / prompt-card).
 */

/** One live host terminal as broadcast by main. */
export interface QuitTerminal {
    id: string;
    pid: number;
    shell: string;
}

interface QuitTerminalsModalProps {
    terminals: QuitTerminal[];
    specs: TerminalSpec[];
    workspacesById: Map<string, WorkspaceRow>;
    /** confirm=false → cancel (abort quit). confirm=true → keep `keepIds` running. */
    onDecision: (decision: { confirmed: boolean; keepIds: string[] }) => void;
}

/** A row joined to its spec (when one matches) for a rich label/workspace/shell. */
interface Row {
    id: string;
    pid: number;
    shell: string;
    label: string;
    workspace: string | null;
}

function shellName(shell: string): string {
    // Last path segment, sans extension — "C:\…\git-bash.exe" → "git-bash".
    const seg = shell.split(/[\\/]/).pop() ?? shell;
    return seg.replace(/\.(exe|cmd|bat)$/i, '');
}

export default function QuitTerminalsModal({
    terminals,
    specs,
    workspacesById,
    onDecision,
}: QuitTerminalsModalProps) {
    // Default: all kept running (checked). Uncheck → shut down on quit.
    const [keep, setKeep] = useState<Set<string>>(
        () => new Set(terminals.map((t) => t.id)),
    );

    // If the terminal list changes identity (re-broadcast), reset to all-keep.
    useEffect(() => {
        setKeep(new Set(terminals.map((t) => t.id)));
    }, [terminals]);

    const rows: Row[] = useMemo(() => {
        const specById = new Map(specs.map((s) => [s.id, s]));
        return terminals.map((t) => {
            const spec = specById.get(t.id);
            const ws =
                spec?.workspace_id != null
                    ? (workspacesById.get(spec.workspace_id)?.project_name ?? null)
                    : null;
            return {
                id: t.id,
                pid: t.pid,
                shell: shellName(t.shell),
                // Fall back to the id/pid when no spec matches (e.g. a scratch
                // terminal with no saved spec row).
                label: spec?.label ?? `terminal ${t.pid}`,
                workspace: ws,
            };
        });
    }, [terminals, specs, workspacesById]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onDecision({ confirmed: false, keepIds: [] });
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onDecision]);

    const toggle = (id: string) => {
        setKeep((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const cancel = () => onDecision({ confirmed: false, keepIds: [] });
    const confirmKeep = () =>
        onDecision({ confirmed: true, keepIds: [...keep] });
    const shutAll = () => onDecision({ confirmed: true, keepIds: [] });

    const keptCount = keep.size;
    const total = rows.length;

    return (
        <div className="prompt-scrim" onMouseDown={cancel}>
            <div
                className="prompt-card quit-terms-card"
                role="dialog"
                aria-modal="true"
                aria-label="Genie is closing — background terminals"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="prompt-title quit-terms-title">
                    <IconAlert size={15} />
                    Genie is closing — background terminals
                </div>
                <div className="prompt-body">
                    These terminals will keep running in the background after Genie
                    closes. Uncheck any you want to shut down.
                </div>

                <div className="quit-terms-list" role="group">
                    {rows.map((r) => {
                        const kept = keep.has(r.id);
                        return (
                            <label
                                key={r.id}
                                className={`quit-term-row${kept ? '' : ' shutting'}`}
                            >
                                <input
                                    type="checkbox"
                                    checked={kept}
                                    onChange={() => toggle(r.id)}
                                />
                                <span className="quit-term-main">
                                    <span className="quit-term-label">{r.label}</span>
                                    <span className="quit-term-meta">
                                        {r.workspace ? `${r.workspace} · ` : ''}
                                        {r.shell} · pid {r.pid}
                                    </span>
                                </span>
                                <span className="quit-term-state">
                                    {kept ? 'keep running' : 'shut down'}
                                </span>
                            </label>
                        );
                    })}
                </div>

                <div className="prompt-actions quit-terms-actions">
                    <button type="button" className="prompt-btn" onClick={cancel}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="prompt-btn prompt-btn-destructive"
                        onClick={shutAll}
                        title="Shut down every terminal, then quit"
                    >
                        Shut all down &amp; quit
                    </button>
                    <button
                        type="button"
                        className="prompt-btn prompt-btn-primary"
                        onClick={confirmKeep}
                    >
                        {keptCount === total
                            ? 'Quit, keep all running'
                            : keptCount === 0
                              ? 'Quit, shut all down'
                              : `Quit, keep ${keptCount} running`}
                    </button>
                </div>
            </div>
        </div>
    );
}
