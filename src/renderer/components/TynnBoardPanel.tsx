import { Icon, Kanban, useKanban } from '@particle-academy/react-fancy';
import { useCallback, useEffect, useState } from 'react';
import { canDrop, idsOf, type BoardActionInput, type BoardCard, type BoardColumnView, type BoardLevel, type BoardScope, type BoardView, type TynnBoardHost, type TynnBoardState } from '../../core/tynn-board.js';

export type { BoardActionInput, TynnBoardHost };

/**
 * THE TYNN TAB'S BOARD (genie#1295) — tynn.ai's board, natively, on the same Fancy Kanban tynn.ai's board is built on.
 *
 * Versions → a version's stories → a story's tasks; tynn.ai's columns; each card's one-click next step (an icon, named for
 * a screen reader — the owner: icons over words) held back by tynn.ai's guards; drag gated by tynn.ai's transitions, with
 * Shift to drop anywhere; delete. No user menu, no project picker: the board is the workspace's own project. When there
 * is nothing to show it says why. Titles are Tynn's text, drawn as text, never as markup.
 *
 * What a card can do and where it can go are declared in core/tynn-board.ts against the workspace-UX contract.
 */

export interface TynnBoardPanelProps {
    readonly state: TynnBoardState;
    readonly onScope: (scope: BoardScope) => void;
    readonly onAction: (input: BoardActionInput) => void;
    readonly onRefresh?: (() => void) | undefined;
}

const SINGULAR: Record<BoardLevel, string> = { versions: 'versions', stories: 'stories', tasks: 'tasks' };

/** Is Shift held? Tynn's override: a drag held with Shift drops on any column (tynn.ai's board does the same). */
function useShift(): boolean {
    const [held, setHeld] = useState(false);
    useEffect(() => {
        const sync = (e: KeyboardEvent) => setHeld(e.shiftKey);
        const clear = () => setHeld(false);
        window.addEventListener('keydown', sync);
        window.addEventListener('keyup', sync);
        window.addEventListener('blur', clear);
        return () => {
            window.removeEventListener('keydown', sync);
            window.removeEventListener('keyup', sync);
            window.removeEventListener('blur', clear);
        };
    }, []);
    return held;
}

function IconButton({ icon, label, onClick, disabled = false, data }: { icon: string; label: string; onClick: () => void; disabled?: boolean; data: Record<string, string> }) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            className="rounded p-1 text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)] disabled:opacity-40"
            {...data}
        >
            <Icon name={icon} size="xs" />
        </button>
    );
}

function Card({ card, onScope, onAction }: { card: BoardCard; onScope: TynnBoardPanelProps['onScope']; onAction: TynnBoardPanelProps['onAction'] }) {
    const drill = card.drill;
    const remove = () => {
        if (globalThis.confirm?.(`Delete this ${card.kind}? This cannot be undone.`) !== false) onAction({ action: `${card.kind}.delete`, ids: idsOf(card) });
    };
    return (
        <Kanban.Card id={card.id} unstyled className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] p-2 text-[12px]">
            <div data-tynn-card={card.id} data-tynn-card-status={card.status} className="flex flex-col gap-1">
                <div className="flex items-start gap-1.5">
                    {card.number !== null ? <span className="shrink-0 font-mono text-[11px] text-[var(--fg-3)]">{card.number}</span> : null}
                    {drill ? (
                        <button type="button" data-tynn-open={card.id} onClick={() => onScope(drill)} className="min-w-0 flex-1 text-left text-[var(--fg-1)] hover:underline">{card.title}</button>
                    ) : (
                        <span className="min-w-0 flex-1 text-[var(--fg-1)]">{card.title}</span>
                    )}
                </div>
                <div className="flex items-center gap-1 text-[11px] text-[var(--fg-3)]">
                    {card.progress !== null ? <span data-tynn-progress="">{card.progress}</span> : null}
                    {card.claimedBy !== null ? <span className="truncate" title={card.claimedBy}><Icon name="user" size="xs" /> {card.claimedBy}</span> : null}
                    <span className="ml-auto flex items-center">
                        {card.quick ? (
                            <IconButton icon={card.quick.icon} label={card.quick.label} disabled={card.quick.disabled} onClick={() => onAction({ action: card.quick!.actionId, ids: idsOf(card) })} data={{ 'data-tynn-step': card.quick.actionId }} />
                        ) : null}
                        <IconButton icon="trash-2" label="Delete" onClick={remove} data={{ 'data-tynn-delete': card.id }} />
                    </span>
                </div>
            </div>
        </Kanban.Card>
    );
}

function Column({ column, view, override, onScope, onAction }: { column: BoardColumnView; view: BoardView; override: boolean; onScope: TynnBoardPanelProps['onScope']; onAction: TynnBoardPanelProps['onAction'] }) {
    const { draggedCard, dragSource } = useKanban();
    // While a card is dragged, a column it cannot reach reads as off (tynn.ai dims it too); Shift opens them all.
    const illegal = draggedCard !== null && dragSource !== null && !canDrop(view.level, dragSource, column.status, override);
    return (
        <Kanban.Column id={column.status} title={column.label} unstyled className={`flex min-h-0 min-w-[200px] flex-1 basis-0 flex-col gap-2 rounded-md bg-[var(--bg-2)] p-2 ${illegal ? 'opacity-30' : ''}`}>
            {column.cards.length === 0 ? (
                <p data-tynn-empty={column.status} className="py-2 text-center text-[11px] text-[var(--fg-4)]">No {SINGULAR[view.level]}</p>
            ) : column.cards.map((c) => <Card key={c.id} card={c} onScope={onScope} onAction={onAction} />)}
        </Kanban.Column>
    );
}

function Board({ view, refused, onScope, onAction, onRefresh }: { view: BoardView; refused: string | null; onScope: TynnBoardPanelProps['onScope']; onAction: TynnBoardPanelProps['onAction']; onRefresh?: (() => void) | undefined }) {
    const shift = useShift();
    const kind = view.level === 'versions' ? 'version' : view.level === 'stories' ? 'story' : 'task';
    const statusOf = (id: string) => view.columns.find((c) => c.cards.some((card) => card.id === id))?.status ?? null;
    const move = (cardId: string, from: string, to: string, toIndex: number) => {
        if (!view.draggable) return;
        // The board's own gate first (tynn.ai's too); Tynn enforces the same rules either way.
        if (!canDrop(view.level, statusOf(cardId) ?? from, to, shift)) return;
        onAction({ action: `${kind}.move`, ids: idsOf({ id: cardId, kind }), body: { status: to, order: toIndex, ...(shift ? { override: true } : {}) } });
    };
    return (
        <div data-tynn-board={view.level} className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            <div className="flex items-center gap-2 text-[12px]">
                {view.up !== null ? <IconButton icon="chevron-left" label="Up" onClick={() => onScope(view.up!)} data={{ 'data-tynn-up': '' }} /> : null}
                <button type="button" data-tynn-crumb="versions" onClick={() => onScope({})} className="text-[var(--fg-2)] hover:text-[var(--fg-1)]">Versions</button>
                {view.crumbs.map((c) => (
                    <span key={`${c.scope.version ?? ''}:${c.scope.story ?? ''}`} className="flex items-center gap-2">
                        <Icon name="chevron-right" size="xs" />
                        <button type="button" data-tynn-crumb={c.scope.story ?? c.scope.version ?? ''} onClick={() => onScope(c.scope)} className="text-[var(--fg-2)] hover:text-[var(--fg-1)]">{c.label}</button>
                    </span>
                ))}
                {shift && view.draggable ? <span data-tynn-override="" className="text-[var(--warning)]">Shift: drop anywhere</span> : null}
                {onRefresh ? <span className="ml-auto"><IconButton icon="refresh-cw" label="Refresh" onClick={onRefresh} data={{ 'data-tynn-refresh': '' }} /></span> : null}
            </div>
            {refused ? <p data-tynn-board-refused="" role="alert" className="rounded bg-[var(--warning)]/10 px-2 py-1 text-[12px] text-[var(--warning)]">{refused}</p> : null}
            <Kanban onCardMove={move} className="flex min-h-0 flex-1 items-start gap-2 overflow-x-auto">
                {view.columns.map((col) => <Column key={col.status} column={col} view={view} override={shift} onScope={onScope} onAction={onAction} />)}
            </Kanban>
        </div>
    );
}

export function TynnBoardPanel({ state, onScope, onAction, onRefresh }: TynnBoardPanelProps) {
    if (state.state === 'ready') return <Board view={state.view} refused={state.refused ?? null} onScope={onScope} onAction={onAction} onRefresh={onRefresh} />;
    const line = state.state === 'loading'
        ? <><Icon name="loader" size="xs" /> Reading Tynn…</>
        : state.state === 'not-linked'
            ? 'This workspace has no Tynn project.'
            : state.reason;
    return <p data-tynn-board-state={state.state} className="flex items-center gap-1.5 p-4 text-[12px] text-[var(--fg-3)]">{line}</p>;
}

/** The tab: keeps the scope, reads the board, acts, and reads it again — a refused step stays on screen in Tynn's words. */
export function TynnBoardTab({ workspaceId, host }: { workspaceId: string; host: TynnBoardHost }) {
    const [scope, setScope] = useState<BoardScope>({});
    const [state, setState] = useState<TynnBoardState>({ state: 'loading' });
    const read = useCallback(async (at: BoardScope, refused: string | null = null) => {
        const r = await host.read(workspaceId, at);
        if (r.ok) setState({ state: 'ready', view: r.view, refused });
        else setState(r.state === 'not-linked' ? { state: 'not-linked' } : r.state === 'signed-out' ? { state: 'signed-out', reason: r.reason } : { state: 'error', reason: r.reason });
    }, [host, workspaceId]);
    useEffect(() => { void read(scope); }, [read, scope]);
    const act = async (input: BoardActionInput) => {
        const r = await host.act(workspaceId, input);
        if (!r.ok && (r.state === 'not-linked' || r.state === 'signed-out')) {
            setState(r.state === 'not-linked' ? { state: 'not-linked' } : { state: 'signed-out', reason: r.reason });
            return;
        }
        await read(scope, r.ok ? null : r.reason);
    };
    return <TynnBoardPanel state={state} onScope={setScope} onAction={(input) => { void act(input); }} onRefresh={() => { void read(scope); }} />;
}
