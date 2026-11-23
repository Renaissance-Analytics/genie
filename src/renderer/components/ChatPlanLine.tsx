import { Icon, Popover } from '@particle-academy/react-fancy';
import type { ChatPlanView } from '../../core/chat-plan.js';
import { PlanScrollFrame, usePlanPopoverRoom } from './PlanPopoverFrame.js';

/**
 * THE POPOVER'S CONTENT (Tynn #703): the open items of the active plan in the plan's order, each with its status, the
 * current one marked. Done items are one count, never rows. A long plan (Tynn #1021) never runs off the screen: the list
 * sits in the plan popovers' shared frame (PlanPopoverFrame), capped at `maxHeight`, the items scrolling and the done
 * count fixed beneath them, opened on the item in progress.
 */
export function ChatPlanList({ plan, maxHeight }: { plan: ChatPlanView; maxHeight?: number | undefined }) {
    return (
        <PlanScrollFrame
            maxHeight={maxHeight}
            frame={{ 'data-plan-popover': '' }}
            foot={plan.done > 0 ? (
                <p data-plan-done={plan.done} className="flex shrink-0 items-center gap-1 text-[var(--fg-4)]">
                    <Icon name="check" size="xs" />
                    {plan.done} done
                </p>
            ) : undefined}
        >
            <ol className="flex flex-col gap-1">
                {plan.items.map((item, i) => (
                    <li
                        key={i}
                        data-plan-item={item.status}
                        {...(item.current ? { 'data-current': 'true' } : {})}
                        className={`flex items-start gap-1.5 ${item.current ? 'font-semibold text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}`}
                    >
                        <span className={`mt-0.5 shrink-0 ${item.current ? 'text-[var(--sky-400)]' : 'text-[var(--fg-4)]'}`} title={item.current ? 'In progress' : 'To do'}>
                            <Icon name={item.current ? 'circle-dot' : 'circle'} size="xs" />
                        </span>
                        <span className="min-w-0 flex-1">{item.content}</span>
                    </li>
                ))}
            </ol>
        </PlanScrollFrame>
    );
}

/** The popover's body: the list, capped to the room beside the line (usePlanPopoverRoom). */
function ChatPlanBody({ plan }: { plan: ChatPlanView }) {
    return <ChatPlanList plan={plan} maxHeight={usePlanPopoverRoom()} />;
}

/**
 * THE "Working · Plan n/m" LINE'S TEXT (Tynn #703): hovering it, or focusing it, opens the plan's open items. With no plan
 * to list it is the text alone, nothing to open.
 */
export function ChatPlanLine({ text, plan }: { text: string; plan: ChatPlanView | undefined }) {
    if (!plan) return <>{text}</>;
    return (
        <Popover hover placement="bottom-start">
            <Popover.Trigger>
                <span data-plan-line="" tabIndex={0} aria-label={`${text}. Show the open plan items`} className="min-w-0 cursor-default truncate underline decoration-dotted underline-offset-2 focus-visible:outline focus-visible:outline-1">
                    {text}
                </span>
            </Popover.Trigger>
            <Popover.Content role="dialog" aria-label="Open plan items" className="border-[var(--border-1)] bg-[var(--surface-raised)] p-3 text-[var(--fg-1)]">
                <ChatPlanBody plan={plan} />
            </Popover.Content>
        </Popover>
    );
}
