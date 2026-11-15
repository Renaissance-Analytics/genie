import { useEffect, useState } from 'react';
import { Button, Icon, Popover } from '@particle-academy/react-fancy';
import { flowPills, NARROW_BAR_PX, NARROW_PILLS_SHOWN, PILLS_SHOWN, type EndedFlow, type FlowPill, type LiveFlow } from '../../core/flow-pills.js';
import { useWorkspaceColor, wsStyle } from '../workspace-colors.js';

export interface FlowPillsProps {
    readonly live: readonly LiveFlow[];
    readonly ended: readonly EndedFlow[];
    /** The clock the lingering failed/held pills are measured against. */
    readonly now: number;
    /** A workspace-share window: only this workspace's flows. `null` = every flow. */
    readonly workspaceId?: string | null | undefined;
    /** Opens the flow (and its run). */
    readonly onOpen: (flowId: string) => void;
}

const STATE_WORDS: Record<FlowPill['state'], string> = { running: 'running', failed: 'failed', held: 'held' };

/** The state's icon: a spinner while it runs, a cross for a failure, a pause for a held run. */
function StateIcon({ state }: { state: FlowPill['state'] }) {
    if (state === 'running') return <span data-flow-light="" className="text-[var(--success)]"><Icon name="loader-circle" size="xs" className="animate-spin motion-reduce:animate-none" /></span>;
    if (state === 'failed') return <span className="text-[var(--danger)]"><Icon name="circle-x" size="xs" /></span>;
    return <span className="text-[var(--warning)]"><Icon name="pause" size="xs" /></span>;
}

/** One pill: the flow's name, its state's icon, the workspace colour as the edge. A button that opens the flow. */
function Pill({ pill, onOpen, row }: { pill: FlowPill; onOpen: (flowId: string) => void; row?: boolean }) {
    const color = useWorkspaceColor(pill.workspaceId);
    return (
        <Button
            size="xs"
            type="button"
            data-flow-pill={pill.flowId}
            data-flow-state={pill.state}
            {...(color ? { 'data-workspace-color': color } : {})}
            style={wsStyle(color)}
            title={`${pill.name} · ${STATE_WORDS[pill.state]}`}
            aria-label={`${pill.name}, ${STATE_WORDS[pill.state]}. Open the run`}
            onClick={() => onOpen(pill.flowId)}
            className={`[-webkit-app-region:no-drag] flex min-w-0 items-center gap-1 whitespace-nowrap rounded-full border border-l-[3px] border-[var(--border-1)] border-l-[var(--ws,var(--border-2))] bg-[var(--bg-1)] px-2 py-0 text-[11px] text-[var(--fg-2)] hover:bg-[var(--bg-2)] ${row ? 'w-full justify-start' : 'max-w-40 shrink-0'}`}
        >
            <StateIcon state={pill.state} />
            <span className="truncate">{pill.name}</span>
        </Button>
    );
}

/** A window too narrow for two pills beside the palette box: the rest go behind "+N". Static render = wide. */
function useNarrow(): boolean {
    const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < NARROW_BAR_PX);
    useEffect(() => {
        const on = (): void => setNarrow(window.innerWidth < NARROW_BAR_PX);
        window.addEventListener('resize', on);
        return () => window.removeEventListener('resize', on);
    }, []);
    return narrow;
}

/**
 * THE HEADER'S RUNNING FLOWS (Tynn #707): a pill per running flow, a failed or held end for a few seconds, and the rest
 * as "+N" with a list. Nothing running draws nothing.
 */
export function FlowPills({ live, ended, now, workspaceId, onOpen }: FlowPillsProps) {
    const [open, setOpen] = useState(false);
    const narrow = useNarrow();
    const { shown, more } = flowPills({ live, ended, now, workspaceId, max: narrow ? NARROW_PILLS_SHOWN : PILLS_SHOWN });
    if (shown.length === 0) return null;
    return (
        <div data-flow-pills="" role="group" aria-label="Running flows" className="[-webkit-app-region:no-drag] flex shrink-0 items-center gap-1">
            {shown.map((p) => <Pill key={p.flowId} pill={p} onOpen={onOpen} />)}
            {more.length > 0 ? (
                <Popover placement="bottom-end" open={open} onOpenChange={setOpen}>
                    <Popover.Trigger>
                        <Button size="xs" type="button" data-flow-more={more.length} aria-label={`${more.length} more flows`} className="[-webkit-app-region:no-drag] shrink-0 rounded-full border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-0 text-[11px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]">
                            +{more.length}
                        </Button>
                    </Popover.Trigger>
                    <Popover.Content role="dialog" aria-label="More running flows" className="flex w-56 flex-col gap-1 border-[var(--border-1)] bg-[var(--surface-raised)] p-2 text-[var(--fg-1)]">
                        {more.map((p) => <Pill key={p.flowId} pill={p} onOpen={(id) => { setOpen(false); onOpen(id); }} row />)}
                    </Popover.Content>
                </Popover>
            ) : null}
        </div>
    );
}
