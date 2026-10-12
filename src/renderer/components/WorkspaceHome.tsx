import type { WorkspaceHomeView } from '../../core/workspace-home.js';
import { FidelityDot } from './Dashboard.js';

/**
 * THE AGENTS RAIL — the board's "AGENTS IN <workspace>" (320px), then "CHANGES THIS SESSION".
 *
 * One card per agent: the fidelity dot (filled = declared, ring = observed, dashed = remote; colour = state), the
 * name at 500, the provider in mono, the state word on the right in its tone, and ONE second line — the question,
 * the failure, the target, or the last delivery (`core/workspace-home.ts` decides which). Clicking a card opens
 * the agent. With no agents the rail says so and offers "+ Add agent" rather than drawing an empty list.
 *
 * Changes: file in mono, who in colour (`you` blue; an agent in violet; a change nobody reported in `--fg-4` as
 * "on disk · not attributed" — Genie does not guess the author, §4.3). No time, no `+n −m`: the host reports
 * neither, and a number Genie cannot see renders as nothing (§5). The whole section is absent when nothing changed.
 */

const TONE = {
    ok: 'text-emerald-500',
    warn: 'text-amber-500',
    bad: 'text-red-500',
    muted: 'text-[var(--fg-3)]',
} as const;

export interface WorkspaceHomeProps {
    /** The workspace's display name, for the headings. */
    name: string;
    view: WorkspaceHomeView;
    onOpenAgent: (agentId: string) => void;
    onAddAgent: () => void;
    /** The workspace id, for the add-agent control's attribute; defaults to the name. */
    workspaceId?: string | undefined;
    /** With no file panel beside it the rail takes the full width (the board's popped-out state); else 320px. */
    wide?: boolean | undefined;
}

export function WorkspaceHome({ name, view, onOpenAgent, onAddAgent, workspaceId, wide = false }: WorkspaceHomeProps) {
    const id = workspaceId ?? name;
    return (
        <aside data-workspace-home={id} className={`flex h-full flex-col overflow-y-auto bg-[var(--bg-1)] ${wide ? 'flex-1' : 'w-80 shrink-0 border-l border-[var(--border-1)]'}`}>
            <section className="px-4 pt-3">
                <h2 className="text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Agents in {name}</h2>
                {view.noAgents ? (
                    <div className="mt-3 flex flex-col items-start gap-2 text-[13px] text-[var(--fg-3)]">
                        <p>No agents in {name}.</p>
                        <button type="button" data-add-agent={id} onClick={onAddAgent} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]">+ Add agent</button>
                    </div>
                ) : (
                    <ul className="mt-2 flex flex-col gap-1">
                        {view.agents.map((a) => (
                            <li key={a.id}>
                                <button
                                    type="button"
                                    data-home-agent={a.id}
                                    data-state={a.state}
                                    onClick={() => onOpenAgent(a.id)}
                                    className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--bg-2)]"
                                >
                                    <span className="flex w-full items-center gap-2">
                                        <FidelityDot fidelity={a.fidelity} state={a.state} />
                                        <span className="text-[13px] font-medium text-[var(--fg-1)]">{a.name}</span>
                                        <span className="font-mono text-[11px] text-[var(--fg-4)]">{a.provider}</span>
                                        <span className={`ml-auto text-[11px] ${TONE[a.tone]}`}>{a.word.toLowerCase()}</span>
                                    </span>
                                    {a.doing !== null ? <span className="truncate pl-4 text-[12px] text-[var(--fg-3)]">{a.doing}</span> : null}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            {view.changes !== null ? (
                <section data-home-changes="" className="mt-4 border-t border-[var(--border-1)] px-4 pt-3">
                    <h2 className="text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Changes this session</h2>
                    <ul className="mt-2 flex flex-col gap-1">
                        {view.changes.map((c) => (
                            <li key={`${c.who}:${c.file}`} data-home-change={c.file} data-change-who={c.who} className="flex items-center gap-2 text-[12px]">
                                <span className="truncate font-mono text-[var(--fg-2)]">{c.file}</span>
                                {c.who === '?' ? (
                                    <span className="ml-auto shrink-0 text-[11px] text-[var(--fg-4)]">on disk · not attributed</span>
                                ) : (
                                    <span className={`ml-auto shrink-0 text-[11px] ${c.who === 'you' ? 'text-blue-500' : 'text-violet-500'}`}>{c.who}</span>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
        </aside>
    );
}
