import type { WorkspaceDashboardView } from '../../core/workspace-dashboard.js';
import { FidelityDot } from './Dashboard.js';

/**
 * THE WORKSPACE DASHBOARD — the workspace's first tab (the owner, 2026-10-19; the design approved in q_09d1f4a0).
 *
 * Top to bottom: what waits on YOU in this workspace (a row per question or approval; it opens on the Deck); a card per
 * running or waiting agent — name, state word, what it was asked, the tool it is in now, its plan step and what the step
 * is, how long — a card opens its agent; then the last finished turns with their handoffs. No file changes. Every rule
 * is in `core/workspace-dashboard.ts`; a line with nothing reported is not drawn.
 */

const TONE = {
    ok: 'text-[var(--success)]',
    warn: 'text-[var(--warning)]',
    bad: 'text-[var(--danger)]',
    muted: 'text-[var(--fg-3)]',
} as const;

const HEADING = 'text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]';

export interface WorkspaceDashboardProps {
    /** The workspace's display name, for the sentences. */
    name: string;
    workspaceId: string;
    view: WorkspaceDashboardView;
    onOpenAgent: (agentId: string) => void;
    onOpenDeckItem: (itemId: string) => void;
    onAddAgent: () => void;
}

export function WorkspaceDashboard({ name, workspaceId, view, onOpenAgent, onOpenDeckItem, onAddAgent }: WorkspaceDashboardProps) {
    return (
        <div data-workspace-dashboard={workspaceId} className="flex h-full min-w-0 flex-1 flex-col gap-5 overflow-y-auto bg-[var(--bg-1)] px-5 py-4">
            {view.waiting.length > 0 ? (
                <section>
                    <h2 className={HEADING}>Waiting on you</h2>
                    <ul className="mt-2 flex flex-col gap-1">
                        {view.waiting.map((w) => (
                            <li key={w.id}>
                                <button type="button" data-dash-waiting={w.id} onClick={() => onOpenDeckItem(w.id)} className="flex w-full items-center gap-2 rounded-lg border border-[var(--border-1)] px-3 py-2 text-left text-[13px] hover:bg-[var(--bg-2)]">
                                    <span className="size-1.5 shrink-0 rounded-full bg-[var(--warning)]" />
                                    <span className="min-w-0 flex-1 truncate text-[var(--fg-1)]">{w.title}</span>
                                    {w.agentName ? <span className="shrink-0 text-[11px] text-[var(--fg-3)]">{w.agentName}</span> : null}
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            <section>
                <h2 className={HEADING}>Working in {name}</h2>
                {view.noAgents ? (
                    <div className="mt-3 flex flex-col items-start gap-2 text-[13px] text-[var(--fg-3)]">
                        <p>No agents in {name}.</p>
                        <button type="button" data-add-agent={workspaceId} onClick={onAddAgent} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)]">+ Add agent</button>
                    </div>
                ) : view.quiet ? (
                    <p className="mt-3 text-[13px] text-[var(--fg-3)]">Nothing is running in {name}.</p>
                ) : (
                    <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2">
                        {view.cards.map((c) => (
                            <li key={c.id}>
                                <button type="button" data-dash-card={c.id} data-state={c.state} onClick={() => onOpenAgent(c.id)} className="flex h-full w-full flex-col gap-1.5 rounded-lg border border-[var(--border-1)] px-3 py-2.5 text-left hover:bg-[var(--bg-2)]">
                                    <span className="flex w-full items-center gap-2">
                                        <FidelityDot fidelity={c.fidelity} state={c.state} />
                                        <span className="text-[13px] font-medium text-[var(--fg-1)]">{c.name}</span>
                                        <span className="font-mono text-[11px] text-[var(--fg-4)]">{c.provider}</span>
                                        <span className={`ml-auto text-[11px] ${TONE[c.tone]}`}>{c.word}{c.duration ? ` · ${c.duration}` : ''}</span>
                                    </span>
                                    {c.ask ? <span data-dash-ask="" className="text-[12px] text-[var(--warning)]">Asks: {c.ask}</span> : null}
                                    {c.asked ? <span data-dash-asked="" className="line-clamp-2 text-[12px] text-[var(--fg-2)]">{c.asked}</span> : null}
                                    {c.tool ? (
                                        <span data-dash-tool="" className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--fg-3)]">
                                            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--success)]" />
                                            <span className="truncate font-mono">{c.tool}</span>
                                        </span>
                                    ) : null}
                                    {c.step || c.doing ? (
                                        <span data-dash-step="" className="truncate text-[12px] text-[var(--fg-3)]">
                                            {c.step ? <span className="font-mono text-[var(--fg-2)]">{c.step}</span> : null}
                                            {c.step && c.doing ? ' · ' : null}
                                            {c.doing}
                                        </span>
                                    ) : null}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {view.handoffs.length > 0 ? (
                <section>
                    <h2 className={HEADING}>Last finished</h2>
                    <ul className="mt-2 flex flex-col gap-1">
                        {view.handoffs.map((h) => (
                            <li key={h.agentId}>
                                <button type="button" data-dash-handoff={h.agentId} onClick={() => onOpenAgent(h.agentId)} className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-[var(--bg-2)]">
                                    <span className="shrink-0 font-medium text-[var(--fg-1)]">{h.name}</span>
                                    <span className="min-w-0 flex-1 truncate text-[var(--fg-2)]">{h.text}</span>
                                    {h.age ? <span className="shrink-0 text-[11px] text-[var(--fg-4)]">{h.age}</span> : null}
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
        </div>
    );
}
