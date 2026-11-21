import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, Popover, usePopover } from '@particle-academy/react-fancy';
import type { ChatPlanView } from '../../core/chat-plan.js';

/** react-fancy's Popover sits this far from its trigger (its default `offset`). */
const POPOVER_OFFSET = 8;
/** Room kept between the popover and the window's edge. */
const EDGE_MARGIN = 8;
/** The popover's own chrome around the list: `p-3` on each side (24 px) and its 1 px border (2 px). */
const POPOVER_CHROME = 26;
/** Below this a list is no use; a window that small gets this much and the popover overlaps its trigger. */
const MIN_LIST_HEIGHT = 96;

/**
 * THE ROOM THE PLAN LIST HAS (Tynn #1021): the larger of the space below the trigger and the space above it, less the
 * popover's offset, a margin to the window's edge and the popover's chrome. react-fancy opens below and flips above when
 * the popover does not fit below, so a list capped to the larger side always lands whole on the screen.
 */
export function planListMaxHeight(anchor: { top: number; bottom: number }, viewportHeight: number): number {
    const below = viewportHeight - anchor.bottom - POPOVER_OFFSET - EDGE_MARGIN;
    const above = anchor.top - POPOVER_OFFSET - EDGE_MARGIN;
    const room = Math.floor(Math.max(below, above)) - POPOVER_CHROME;
    return Math.max(MIN_LIST_HEIGHT, Math.min(room, viewportHeight - 2 * EDGE_MARGIN - POPOVER_CHROME));
}

interface ScrollBox {
    scrollTop: number;
    readonly clientHeight: number;
    readonly scrollHeight: number;
    getBoundingClientRect(): { top: number; height: number };
    querySelector(selector: string): { getBoundingClientRect(): { top: number; height: number } } | null;
}

/**
 * THE STEP IN PROGRESS, IN VIEW (Tynn #1021): scrolls the list so its current step sits in the middle, within the range
 * the list can scroll. Only the list moves, never the page (`scrollIntoView` would scroll every scrollable ancestor).
 * No current step = the list is left where it is. Returns the list's scrollTop.
 */
export function revealCurrentStep(box: ScrollBox): number {
    const current = box.querySelector('[data-current="true"]');
    if (!current) return box.scrollTop;
    const item = current.getBoundingClientRect();
    const list = box.getBoundingClientRect();
    const centred = box.scrollTop + (item.top - list.top) - (box.clientHeight - item.height) / 2;
    const top = Math.round(Math.max(0, Math.min(centred, box.scrollHeight - box.clientHeight)));
    box.scrollTop = top;
    return top;
}

/**
 * THE WHOLE PLAN, LISTED (Tynn #918): every step in order with its status, the current one marked and bold, done ones
 * dimmed with a check. A long plan (Tynn #1021) never runs off the screen: the list is capped at `maxHeight` (or the
 * window's height until the popover has measured its room), the "n/m" header stays put and the steps scroll beneath it,
 * opened on the step in progress.
 */
export function PlanHoverList({ plan, maxHeight }: { plan: ChatPlanView; maxHeight?: number | undefined }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (scrollRef.current) revealCurrentStep(scrollRef.current);
    }, [maxHeight]);
    return (
        <div data-plan-full="" className="flex max-w-sm flex-col gap-1.5 text-xs" style={{ maxHeight: maxHeight ?? `calc(100vh - ${2 * EDGE_MARGIN + POPOVER_CHROME}px)` }}>
            <p data-plan-head="" className="shrink-0 font-mono text-[11px] text-[var(--fg-4)]">{plan.done}/{plan.of}</p>
            <div ref={scrollRef} data-plan-scroll="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
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
        </div>
    );
}

/**
 * The popover's body: the list, capped to the room beside the trigger. Measured as it opens, in its first render (the
 * trigger is on the page before the popover can open), so the list reveals its current step once, at its final height;
 * measured again when the window resizes.
 */
function PlanHoverBody({ plan }: { plan: ChatPlanView }) {
    const { anchorRef } = usePopover();
    const room = () => {
        const anchor = anchorRef.current;
        return anchor ? planListMaxHeight(anchor.getBoundingClientRect(), window.innerHeight) : undefined;
    };
    const [maxHeight, setMaxHeight] = useState<number | undefined>(room);
    useLayoutEffect(() => {
        const measure = () => setMaxHeight(room());
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
        // `room` reads the ref at call time; the listener is set once per open.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anchorRef]);
    return <PlanHoverList plan={plan} maxHeight={maxHeight} />;
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
                <PlanHoverBody plan={plan} />
            </Popover.Content>
        </Popover>
    );
}
