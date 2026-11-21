import type { ReactNode } from 'react';
import { Icon, Popover } from '@particle-academy/react-fancy';
import type { ChatPlanView } from '../../core/chat-plan.js';

/**
 * THE WHOLE PLAN, LISTED (Tynn #918): every step in order with its status, the current one marked and bold, done ones
 * dimmed with a check. Hook-free, so a test can render it.
 */
/** RED STUB (Tynn #1021): no cap yet. */
export function planListMaxHeight(_anchor: { top: number; bottom: number }, viewportHeight: number): number {
    return viewportHeight;
}

/** RED STUB (Tynn #1021): scrolls nothing yet. */
export function revealCurrentStep(box: { scrollTop: number }): number {
    return box.scrollTop;
}

export function PlanHoverList({ plan }: { plan: ChatPlanView; maxHeight?: number }) {
    return (
        <div data-plan-full="" className="flex max-w-sm flex-col gap-1.5 text-xs">
            <p className="font-mono text-[11px] text-[var(--fg-4)]">{plan.done}/{plan.of}</p>
            <ol className="flex flex-col gap-1">
                {plan.items.map((item, i) => {
                    const done = item.status === 'completed';
                    return (
                        <li
                            key={i}
                            data-plan-item={item.status}
                            {...(item.current ? { 'data-current': 'true' } : {})}
                            className={`flex items-start gap-1.5 ${item.current ? 'font-semibold text-[var(--fg-1)]' : done ? 'text-[var(--fg-3)]' : 'text-[var(--fg-2)]'}`}
                        >
                            <span className={`mt-0.5 shrink-0 ${done ? 'text-[var(--success)]' : item.current ? 'text-[var(--sky-400)]' : 'text-[var(--fg-4)]'}`} title={done ? 'Done' : item.current ? 'In progress' : 'To do'}>
                                <Icon name={done ? 'check' : item.current ? 'circle-dot' : 'circle'} size="xs" />
                            </span>
                            <span className="min-w-0 flex-1">{item.content}</span>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

/**
 * THE DASHBOARD'S PLAN CELL, HOVERED (Tynn #918): the cell as it was, and on hover or focus the whole plan beside it.
 * No plan to list = the cell alone, nothing to open. The trigger takes the cell's own room, so nothing moves.
 */
export function PlanHover({ plan, children }: { plan: ChatPlanView | null; children: ReactNode }) {
    if (!plan) return <>{children}</>;
    return (
        <Popover hover placement="bottom-start">
            <Popover.Trigger className="min-w-0">
                <span data-plan-hover="" tabIndex={0} aria-label="Show the whole plan" className="flex min-w-0 cursor-default items-center gap-2 focus-visible:outline focus-visible:outline-1">
                    {children}
                </span>
            </Popover.Trigger>
            <Popover.Content role="dialog" aria-label="Plan" className="border-[var(--border-1)] bg-[var(--surface-raised)] p-3 text-[var(--fg-1)]">
                <PlanHoverList plan={plan} />
            </Popover.Content>
        </Popover>
    );
}
