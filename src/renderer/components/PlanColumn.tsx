import { useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '@particle-academy/react-fancy';
import { PLAN_WIDTH_DEFAULT, PLAN_WIDTH_MAX, PLAN_WIDTH_MIN, clampPlanWidth, planDragWidth, readPlanWidth, writePlanWidth } from '../../core/plan-column.js';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export interface PlanColumnStep {
    readonly content: string;
    readonly status: string;
    readonly current: boolean;
}

export interface PlanColumnViewProps {
    /** The agent's name, for the sentence before any plan. */
    name: string;
    plan: { step: number; of: number; doing: string } | null;
    steps: readonly PlanColumnStep[] | null;
    width: number;
    /** Talk about a step in this agent's chat (genie#1280). Absent = no chat icon, never a dead one. */
    onDiscuss?: ((step: string) => void) | undefined;
    onResizeStart?: ((e: ReactPointerEvent<HTMLDivElement>) => void) | undefined;
    onResizeKey?: ((e: ReactKeyboardEvent<HTMLDivElement>) => void) | undefined;
    onResetWidth?: (() => void) | undefined;
}

/**
 * THE ACTIVE PLAN COLUMN (the owner, 2026-10-19: "Genie needs to include an Active Plan column in the agent view to the
 * left of the chat"): the Agent view's LAST column, directly left of the docked chat. Before any plan it says so.
 *
 * genie#1280 (the owner, 2026-10-27): its left edge drags to resize it (core/plan-column.ts), and each step has a chat
 * icon, shown on hover and on keyboard focus, that puts the step into this agent's chat as a pill (core/plan-pill.ts).
 *
 * Hook-free, so a test can press its buttons.
 */
export function PlanColumnView({ name, plan, steps, width, onDiscuss, onResizeStart, onResizeKey, onResetWidth }: PlanColumnViewProps) {
    return (
        <aside data-plan-column="" style={{ width }} className="relative flex min-h-0 shrink-0 flex-col border-l border-[var(--border-1)] bg-[var(--bg-1)] text-xs">
            {/* The left edge, outside the scroller so it never scrolls away: drag it or arrow it; a double-click resets it (Genie 1's gutter). */}
            <div
                data-plan-resize=""
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize plan"
                aria-valuemin={PLAN_WIDTH_MIN}
                aria-valuemax={PLAN_WIDTH_MAX}
                aria-valuenow={width}
                tabIndex={0}
                onPointerDown={onResizeStart}
                onKeyDown={onResizeKey}
                onDoubleClick={onResetWidth}
                className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-[var(--accent)]/40 focus-visible:bg-[var(--accent)]/40 focus-visible:outline-none"
            />
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-4">
            <h2 className="text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Active plan</h2>
            {plan ? (
                <>
                    <p className="font-mono text-[11px] text-[var(--fg-3)]">
                        {plan.step}/{plan.of}
                    </p>
                    {steps ? (
                        <ol className="mt-1.5 flex flex-col gap-1">
                            {steps.map((step, i) => (
                                <li key={i} data-plan-step={step.status} {...(step.current ? { 'data-current': 'true' } : {})} className={`group flex items-start gap-1.5 text-[12px] ${step.current ? 'font-semibold text-[var(--fg-1)]' : step.status === 'completed' ? 'text-[var(--fg-3)]' : 'text-[var(--fg-2)]'}`}>
                                    <span className={`w-3 shrink-0 ${step.status === 'completed' ? 'text-[var(--success)]' : step.current ? 'text-[var(--sky-400)]' : 'text-[var(--fg-4)]'}`}>{step.status === 'completed' ? '✓' : step.current ? '◐' : '○'}</span>
                                    <span className="min-w-0 flex-1">{step.content}</span>
                                    {onDiscuss ? (
                                        <button
                                            type="button"
                                            data-plan-discuss={i}
                                            aria-label="Discuss in chat"
                                            title="Discuss in chat"
                                            onClick={() => onDiscuss(step.content)}
                                            className="shrink-0 rounded p-0.5 font-normal text-[var(--fg-3)] opacity-0 hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)] focus-visible:opacity-100 group-hover:opacity-100"
                                        >
                                            <Icon name="message-square" size="xs" />
                                        </button>
                                    ) : null}
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <p className="mt-1 text-[var(--fg-2)]">{plan.doing}</p>
                    )}
                </>
            ) : (
                <p className="text-[12px] leading-normal text-[var(--fg-3)]">{name} has not reported a plan yet.</p>
            )}
            </div>
        </aside>
    );
}

const browserStorage = (): Store | null => {
    try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};

/**
 * The column with its width: read from this device, dragged live, written once when the drag ends (as the chat's edge,
 * ChatFlyout). Dragged well past its floor it collapses (`onCollapse`), the same as its toggle.
 */
export function PlanColumn({ storage: storageProp, onCollapse, ...view }: Omit<PlanColumnViewProps, 'width' | 'onResizeStart' | 'onResizeKey' | 'onResetWidth'> & { storage?: Store | null | undefined; onCollapse?: (() => void) | undefined }) {
    const storage = storageProp === undefined ? browserStorage() : storageProp;
    const [width, setWidth] = useState(() => readPlanWidth(storage));
    const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const startX = e.clientX;
        const from = width;
        let last = from;
        let collapse = false;
        const onMove = (ev: PointerEvent) => {
            const next = planDragWidth(from, ev.clientX - startX);
            collapse = next === 'collapse';
            if (next !== 'collapse') { last = next; setWidth(next); }
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (collapse && onCollapse) {
                // Collapsed: the width it had before the drag is the one it comes back at.
                setWidth(from);
                onCollapse();
                return;
            }
            writePlanWidth(storage, last);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };
    const onResizeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const step = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0;
        if (step === 0) return;
        e.preventDefault();
        const next = clampPlanWidth(width + step);
        setWidth(next);
        writePlanWidth(storage, next);
    };
    const onResetWidth = () => { setWidth(PLAN_WIDTH_DEFAULT); writePlanWidth(storage, PLAN_WIDTH_DEFAULT); };
    return <PlanColumnView {...view} width={width} onResizeStart={onResizeStart} onResizeKey={onResizeKey} onResetWidth={onResetWidth} />;
}
