import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { usePopover } from '@particle-academy/react-fancy';

/**
 * ONE FRAME FOR EVERY PLAN POPOVER (Tynn #1021; the owner: "plan popovers"). The Dashboard's plan cell (PlanHover) and the
 * chat header's "Working · Plan n/m" (ChatPlanLine) open the same thing: a list of steps that, on a long plan, ran off the
 * screen. Both hold their list in this frame: capped to the room beside the trigger, the steps scrolling inside it, what
 * is not a step (a header, a count) fixed outside the scroll, and the step in progress scrolled into view on open.
 */

/** react-fancy's Popover sits this far from its trigger (its default `offset`). */
const POPOVER_OFFSET = 8;
/** Room kept between the popover and the window's edge. */
const EDGE_MARGIN = 8;
/** The popover's own chrome around the list: `p-3` on each side (24 px) and its 1 px border (2 px). */
const POPOVER_CHROME = 26;
/** Below this a list is no use; a window that small gets this much and the popover overlaps its trigger. */
const MIN_LIST_HEIGHT = 96;

/**
 * THE ROOM A PLAN LIST HAS: the larger of the space below the trigger and the space above it, less the popover's offset,
 * a margin to the window's edge and the popover's chrome. react-fancy opens below and flips above when the popover does
 * not fit below, so a list capped to the larger side always lands whole on the screen.
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
 * THE STEP IN PROGRESS, IN VIEW: scrolls the list so its current step sits in the middle, within the range the list can
 * scroll. Only the list moves, never the page (`scrollIntoView` would scroll every scrollable ancestor). No current step =
 * the list is left where it is. Returns the list's scrollTop.
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
 * THE ROOM, MEASURED, for a list inside a react-fancy Popover.Content: as the popover opens, in its first render (the
 * trigger is on the page before the popover can open), so the list reveals its current step once, at its final height;
 * and again when the window resizes.
 */
export function usePlanPopoverRoom(): number | undefined {
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
    return maxHeight;
}

type DataAttributes = { [key: `data-${string}`]: string | undefined };

/**
 * THE FRAME: `head` and `foot` stay put (give them `shrink-0`), `children` (the steps) scroll between them. Capped at `maxHeight`, or the
 * window's height until the popover has measured its room. `frame` carries the list's own data attributes.
 */
export function PlanScrollFrame({ maxHeight, head, foot, frame, children }: {
    maxHeight?: number | undefined;
    head?: ReactNode;
    foot?: ReactNode;
    frame?: DataAttributes & Pick<HTMLAttributes<HTMLDivElement>, 'role'>;
    children: ReactNode;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (scrollRef.current) revealCurrentStep(scrollRef.current);
    }, [maxHeight]);
    return (
        <div {...frame} data-plan-frame="" className="flex max-w-sm flex-col gap-1.5 text-xs" style={{ maxHeight: maxHeight ?? `calc(100vh - ${2 * EDGE_MARGIN + POPOVER_CHROME}px)` }}>
            {head}
            <div ref={scrollRef} data-plan-scroll="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                {children}
            </div>
            {foot}
        </div>
    );
}
